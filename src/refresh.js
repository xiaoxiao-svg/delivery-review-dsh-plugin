// refresh_review_material 工具：编排者（或任何 agent）可手动兜底刷新审查材料。
// 对应原编排流程「先刷新审查材料（兜底，不依赖 hook）」一步——Claude 版用
// powershell 直接跑脚本，DSH 版把兜底做成一个正式工具，编排者可直接调用。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { refreshReviewMaterial } from "./material.js";

const name = "delivery-review-refresh";
const inject = ["tools"];

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "refresh_review_material",
    description: "手动刷新 .delivery-review/review_material.md（改动清单 / 完整 diff / 新建文件清单）。通常由插件在 write/edit/pwsh/bash 调用后自动刷新；当材料缺失、过时或需要兜底时调用本工具。",
    parameters: {
      cwd: {
        type: "string",
        description: "git 仓库内任意目录（相对或绝对路径）；默认使用当前 agent 的工作目录。非 git 仓库返回错误。"
      },
      reason: {
        type: "string",
        description: "触发原因，仅写入 .delivery-review/hook.log 便于排障。"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          refreshed: { type: "boolean" },
          repoRoot: { type: "string" },
          path: { type: "string" },
          truncated: { type: "boolean" },
          reason: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [{ type: "text", text: renderSummary(value) }]
    },
    async execute(args, exec) {
      const cwd = args.cwd ?? exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        return { ok: false, error: "无法解析工作目录：请显式传 cwd（仓库内任意目录）" };
      }
      const result = await refreshReviewMaterial(cwd, {
        trigger: "refresh_review_material",
        reason: args.reason
      });
      return { ok: result.error === undefined, ...result };
    }
  }));
}

function renderSummary(value) {
  if (!value.ok) return `❌ 材料刷新失败：${value.error ?? "未知错误"}`;
  if (!value.refreshed) return `材料无需刷新（${value.reason ?? "工作区无变化"}）：${value.path}`;
  return `✅ 材料已刷新${value.truncated ? "（diff 超过 800 行已截断）" : ""}：${value.path}（repo: ${value.repoRoot}）`;
}

export { apply, inject, name };
