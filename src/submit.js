// 结构化结论通道：delivery_submit_review 工具。
// 对应移植版「子代理自由文本最终回复 → 编排者解析」的架构缺陷——
// 本工具把 reviewer 的审查结论（risk 数组 / score / 存疑清单 / 未知清单 /
// dispute 回应）用 schema 强校验后直接写入轮次记录并驱动状态机，
// 编排者不再从自由文本猜结论。
//
// reviewer 的 subagent 工具行 toolFilter.allow 扩展为：
//   read / read_image / glob / grep / delivery_submit_review
// （前四个只读工具 + 本提交工具；提交工具只写 .delivery-review/ 下的
// 状态文件，不影响工作区代码，保持审查者「只读代码」的语义）。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { advance, isFormalRisk, isP0Allowed, riskFingerprint } from "./state.js";
import { resolveRepoRoot, readState, writeState, appendRound, withLock } from "./store.js";
import { listChangedFileFingerprints, setLastActiveRepo } from "./material.js";

const name = "delivery-review-submit";
const inject = ["tools"];

/** risk 条目 schema（结构化枚举，替代自由文本）。 */
const RISK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", required: true, enum: ["P0", "P1", "P2"], description: "P0-阻塞（需已验证/可复现证据）/ P1-重要 / P2-建议" },
    evidence: { type: "string", required: true, enum: ["verified", "reproducible", "code-inference", "guess"], description: "证据等级：verified 实际运行观察 / reproducible 可复现步骤 / code-inference 代码推断 / guess 经验猜测（guess 不算正式 risk）" },
    location: { type: "string", required: true, description: "文件:行号（如 src/foo.ts:42）" },
    summary: { type: "string", required: true, description: "问题描述（一句话）" },
    goal_relation: { type: "string", required: true, description: "与目标的关系：这条不修，目标的哪一条不达成。填不出 = 非本质问题，降 P2 或只进存疑清单" },
    reason: { type: "string", description: "原因分析" },
    fix_direction: { type: "string", description: "修改方向" }
  }
};

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "delivery_submit_review",
    description: "【审查者专用】提交本轮审查结论：risk 数组（带证据等级与优先级）、质量分、存疑清单、未知清单、dispute 回应。结论经 schema 强校验后写入 .delivery-review/rounds/ 并自动推进状态机（收敛/质量门/震荡/上限判定），返回新状态与退出原因。审查者必须用本工具提交结论，不要只用最终回复文本。",
    parameters: {
      repo_root: {
        type: "string",
        description: "仓库根目录绝对路径（编排者提供的 REPO_ROOT）。缺省时从当前会话工作目录解析。"
      },
      score: {
        type: "number",
        required: true,
        description: "质量分 0-10：>=7 且无 P0/P1 表示本轮可接受；<7 表示必须再修"
      },
      risks: {
        type: "array",
        description: "正式 risk 列表（evidence 为 guess 的条目不计入状态机统计，只进存疑清单）",
        items: RISK_SCHEMA
      },
      doubts: {
        type: "array",
        description: "存疑清单：看了但拿不准的点（含全部 guess 级问题），不触发修复，人工验收时判断",
        items: { type: "string" }
      },
      unknowns: {
        type: "array",
        description: "未知清单：没看 / 无法确认的维度（人工验收时补查）",
        items: { type: "string" }
      },
      dispute_response: {
        type: "object",
        additionalProperties: false,
        description: "对 fixer dispute 的回应（仅当上轮存在 dispute 时提供）",
        properties: {
          action: { type: "string", required: true, enum: ["confirm", "withdraw"], description: "confirm=仍坚持原 risk（将触发 dispute 退出交人工裁决）；withdraw=撤回原 risk（继续 loop）" },
          risk_id: { type: "string", description: "被回应的 risk 标识（R<N>-<K> 或指纹）" },
          reason: { type: "string", description: "自我核查过程与原因" }
        }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          round: { type: "number" },
          exit_reason: { type: "string" },
          formal_risks: { type: "number" },
          new_risks: { type: "number" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? `✅ 结论已提交（Round ${value.round}）：正式 risk ${value.formal_risks} 条（新增 ${value.new_risks}）${value.exit_reason ? `，退出原因：${value.exit_reason}` : "，继续下一轮"}`
          : `❌ 提交失败：${value.error}`
      }]
    },
    async execute(args, exec) {
      let repoRoot;
      try {
        repoRoot = args.repo_root ?? exec.agent?.session?.header?.cwd;
        if (typeof repoRoot !== "string" || repoRoot.length === 0) throw new Error("无法解析仓库根目录");
        repoRoot = await resolveRepoRoot(repoRoot);
        setLastActiveRepo(repoRoot);
      } catch (error) {
        return { ok: false, error: `resolve repo root: ${error.message}` };
      }

      try {
        const risks = Array.isArray(args.risks) ? args.risks : [];
        // P0 证据门禁（R1-1）：违规 P0 硬拒绝、不推进状态机——否则 reviewer 报违规
        // P0 + 高分时质量门可同轮放行，门禁形同虚设（审查 P1）
        const rejectedP0 = risks.filter((r) => r.severity === "P0" && !isP0Allowed(r));
        if (rejectedP0.length > 0) {
          return { ok: false, error: `P0 证据不足被拦 ${rejectedP0.length} 条（实际证据：${rejectedP0[0].evidence}）：P0 必须带 verified/reproducible 证据，请降级为 P1 或补证据后重提（本轮未推进状态机）` };
        }
        const disputeUnresolved = args.dispute_response?.action === "confirm";

        const changedFiles = await listChangedFileFingerprints(repoRoot);
        const result = await withLock(async () => {
          const state = await readState(repoRoot);
          const prevIds = new Set(state.last_round_risk_ids);
          const next = advance(state, {
            risks,
            score: args.score,
            changedFiles,
            disputeUnresolved
          });
          const formal = risks.filter((r) => isFormalRisk(r) && isP0Allowed(r));
          const newRisks = formal.filter((r) => !prevIds.has(riskFingerprint(r))).length;
          await writeState(repoRoot, next);
          await appendRound(repoRoot, next.round, {
            score: args.score,
            risks,
            doubts: args.doubts ?? [],
            unknowns: args.unknowns ?? [],
            dispute_response: args.dispute_response ?? null,
            exit_reason: next.exit_reason,
            formal_risks: formal.length,
            new_risks: newRisks
          });
          return { ...next, _newRisks: newRisks };
        });

        return {
          ok: true,
          round: result.round,
          exit_reason: result.exit_reason,
          formal_risks: risks.filter((r) => isFormalRisk(r) && isP0Allowed(r)).length,
          new_risks: result._newRisks
        };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
  }));
}

export { apply, inject, name };
