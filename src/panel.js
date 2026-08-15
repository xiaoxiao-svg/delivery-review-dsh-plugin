// Web 活动面板（第一期：状态摘要浮层）。
// 技术路径（免构建，契合插件纯 JS 形态）：
//   - webServer.register() 注册状态路由 /plugins/delivery-review/state
//     （JSON：当前阶段 / 轮次 / 风险摘要 / 质量分 / 退出原因）
//   - webServer.tapIndex() 在 index.html 注入浮层脚本（原生 JS，
//     1s 轮询状态路由渲染右上角浮层；无 React、无构建步骤）
//   - webServer/httpServer 双键探测，兼容 rc 版本漂移（dsh-agent-teams 同款）
//
// 浮层最小职责：让用户在 Web GUI 里一眼看到「流程走到哪、下一步是什么」，
// 解决移植版「只有文本流、不直观」的核心痛点。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveRepoRoot, readState, readRounds } from "./store.js";
import { getLastActiveRepo, setLastActiveRepo } from "./material.js";

const name = "delivery-review-panel";
const inject = ["tools"];

const here = dirname(fileURLToPath(import.meta.url));
const FLOATER_JS = join(here, "..", "web", "floater.js");

/** webServer 服务键候选（新版本优先）。 */
const WEB_SERVER_KEYS = ["webServer", "httpServer"];

/** 单一状态路由：浮层轮询的数据源。 */
function stateHandler(ctx) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const repoRoot = url.searchParams.get("repo") ?? getLastActiveRepo() ?? "";
    try {
      const root = repoRoot ? await resolveRepoRoot(repoRoot) : null;
      const body = root
        ? await buildStatePayload(root)
        : { active: false, error: "no repo" };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ active: false, error: error.message }));
    }
  };
}

/** 汇总状态：state.json + 轮次记录 → 面板可渲染的摘要。 */
async function buildStatePayload(repoRoot) {
  const [state, rounds] = await Promise.all([readState(repoRoot), readRounds(repoRoot)]);
  const last = rounds[rounds.length - 1] ?? null;
  const riskCount = (last?.risks ?? []).filter((r) => r.evidence !== "guess").length;
  return {
    active: true,
    repo: repoRoot,
    state: {
      round: state.round,
      consecutive_clean: state.consecutive_clean,
      last_score: state.last_score,
      exit_reason: state.exit_reason,
      max_rounds: state.max_rounds
    },
    last_round: last ? {
      round: last.round,
      score: last.score,
      formal_risks: riskCount,
      doubts: (last.doubts ?? []).length,
      unknowns: (last.unknowns ?? []).length,
      exit_reason: last.exit_reason,
      risks: (last.risks ?? []).map((r) => ({
        severity: r.severity,
        evidence: r.evidence,
        location: r.location,
        summary: r.summary
      }))
    } : null
  };
}

function apply(ctx) {
  // 状态查询工具：编排者/任何 agent 可读当前状态机与最近轮次（决策用）
  ctx.tools.register(defineTool({
    name: "delivery_status",
    description: "读取当前 delivery-review 状态机：轮次 / 连续收敛 / 质量分 / 退出原因 / 最近一轮风险摘要。编排者在每轮决策前调用本工具确认状态。",
    parameters: {
      repo_root: {
        type: "string",
        description: "仓库根目录绝对路径；缺省时从当前会话工作目录解析。"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const cwd = args.repo_root ?? exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) return { ok: false, error: "无法解析工作目录" };
      try {
        const root = await resolveRepoRoot(cwd);
        setLastActiveRepo(root);
        return { ok: true, repo_root: root, ...(await buildStatePayload(root)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
  }));

  // Web 面板（仅 Web profile 有 webServer；headless 等 profile 自动跳过）
  const registerSurface = () => {
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (!webServer?.register || !webServer?.tapIndex) return;

    ctx.effect(() => webServer.register({
      kind: "exact",
      path: "/plugins/delivery-review/state",
      handler: stateHandler(ctx)
    }), "delivery-review: state route");

    // 浮层脚本注入：index.html 末尾追加 <script>，脚本自行挂载右上角浮层
    ctx.effect(() => webServer.tapIndex((html) => {
      // 只注入一次（幂等：已含标记则原样返回）
      if (html.includes("data-delivery-review-floater")) return html;
      return html + `\n<script src="/plugins/delivery-review/floater.js" data-delivery-review-floater></script>`;
    }), "delivery-review: floater inject");

    ctx.effect(() => webServer.register({
      kind: "exact",
      path: "/plugins/delivery-review/floater.js",
      handler: async (req, res) => {
        try {
          const js = await readFile(FLOATER_JS, "utf8");
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
          res.end(js);
        } catch (error) {
          ctx.logger.warn(`delivery-review: floater read failed: ${error.message}`);
          res.writeHead(404);
          res.end();
        }
      }
    }), "delivery-review: floater asset");
  };

  registerSurface();
  ctx.on("internal/service", (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerSurface();
  });
}

export { apply, inject, name };
