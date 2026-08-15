// /dsh-delivery 命令插件（DSH 专属版）。
// 对应移植版 /delivery-review：确定性入口，但注入的是「决策指引」而非
// 284 行全量工作流——状态计算全部由工具承载（delivery_status /
// delivery_submit_review），编排者只做决策。
//
// 命令启动时自动做任务分级探测（改动规模 → 建议流程档位），
// 与决策指引一起注入，供编排者在 Step 0 呈现给用户确认。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveRepoRoot, readState } from "./store.js";
import { setLastActiveRepo } from "./material.js";

const execFileAsync = promisify(execFile);

const name = "delivery-review-command";
const inject = ["commands"];

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(here, "..", "workflow", "delivery-review.md");

/** 任务分级：按改动规模给流程档位建议（自动判定 + 用户可改）。 */
async function suggestTier(cwd) {
  try {
    const repoRoot = await resolveRepoRoot(cwd);
    const [diffName, untracked, diffStat] = await Promise.all([
      execFileAsync("git", ["-c", "core.quotePath=false", "diff", "HEAD", "--name-only"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }),
      execFileAsync("git", ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }),
      execFileAsync("git", ["-c", "core.quotePath=false", "diff", "HEAD", "--stat"], { cwd: repoRoot, encoding: "utf8", windowsHide: true })
    ]);
    const files = new Set([
      ...diffName.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
      ...untracked.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
    ]);
    const diffLines = diffStat.stdout.trim().split("\n").filter((l) => /^\s*\d+ files? changed/.test(l))[0] ?? "";
    const m = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(diffLines);
    const fileCount = files.size;
    const insertions = m ? Number(m[2] ?? 0) : 0;
    const deletions = m ? Number(m[3] ?? 0) : 0;
    const changedLines = insertions + deletions;

    let tier;
    if (fileCount >= 5 || changedLines >= 300) tier = "heavy";       // 大范围：加 planner 方案审查 + 多轮 loop
    else if (fileCount >= 2 || changedLines >= 50) tier = "standard"; // 常规：loop 至多 3 轮
    else tier = "light";                                              // 轻量：单轮 fixer→reviewer→验收

    return {
      tier,
      repo_root: repoRoot,
      file_count: fileCount,
      changed_lines: changedLines,
      untracked: untracked.stdout.trim().split("\n").filter(Boolean).length
    };
  } catch {
    return { tier: "unknown", error: "无法解析 git 仓库（/dsh-delivery 依赖 git 仓库）" };
  }
}

function apply(ctx) {
  ctx.commands.register({
    name: "dsh-delivery",
    description: "启动 DSH 专属交付协作流程（修复 ↔ 只读审查，按任务规模自动分级，Web 面板实时显示进度；人工验收裁决权归用户）。用法：/dsh-delivery <对改动的一句话描述，可留空后面补>",
    input: { hint: "<对改动的一句话描述，可留空后面补>" },
    handler: async (invocation) => {
      let workflow;
      try {
        workflow = await readFile(WORKFLOW_PATH, "utf8");
      } catch (error) {
        return {
          kind: "error",
          text: `dsh-delivery: 无法读取工作流指令 ${WORKFLOW_PATH}：${error.message}`
        };
      }
      const initialDescription = (invocation.rawInput ?? "").trim();
      const cwd = invocation.agent?.session?.header?.cwd;
      const tier = cwd ? await suggestTier(cwd) : { tier: "unknown", error: "无法定位工作目录" };
      if (tier.repo_root) setLastActiveRepo(tier.repo_root);

      const instruction = [
        workflow.trim(),
        "",
        "---",
        "# 本次运行参数（由 /dsh-delivery 命令注入，勿修改）",
        `- 用户初始描述：${initialDescription || "（未提供，需在 Step 0 向用户询问）"}`,
        `- 自动分级建议：${tier.tier}${tier.file_count !== undefined ? `（改动 ${tier.file_count} 个文件 / ${tier.changed_lines} 行${tier.untracked ? ` / ${tier.untracked} 个新文件` : ""}）` : ""}${tier.error ? `（${tier.error}）` : ""}`,
        "- 交互协议：状态查询用 delivery_status 工具；reviewer 结论经 delivery_submit_review 结构化提交并自动推进状态机；确认/选择用 ask_user_question；结论不再依赖自由文本解析"
      ].join("\n");

      invocation.agent.followup(createUserMessage({
        content: [{ type: "text", text: instruction }],
        source: { kind: "plugin", plugin: "delivery-review/command" }
      }));
      return {
        kind: "success",
        text: `dsh-delivery 已启动：决策指引已注入会话（分级建议：${tier.tier}），编排者将按 Step 0 向你确认上下文。`
      };
    }
  });
}

export { apply, inject, name };
