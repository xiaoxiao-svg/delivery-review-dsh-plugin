// /delivery-review 命令插件。
// 对应 Claude 版 commands/delivery-review.md：确定性入口。
// DSH 中命令 handler 是 JS 函数（command/run、command/done 为日志事件，不进模型），
// 因此 handler 把编排指令作为一条用户消息 followup 注入当前会话并唤醒主 agent
// （编排者），由编排者按工作流指令执行 Step 0–5。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "delivery-review-command";
const inject = ["commands"];

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(here, "..", "workflow", "delivery-review.md");

function apply(ctx) {
  ctx.commands.register({
    name: "delivery-review",
    description: "启动 delivery-review 双 Agent 交付协作 loop（修复 ↔ 审查隔离子代理迭代，直到收敛后人工验收）。用法：/delivery-review <对改动的一句话描述，可留空后面补>",
    input: { hint: "<对改动的一句话描述，可留空后面补>" },
    handler: async (invocation) => {
      let workflow;
      try {
        workflow = await readFile(WORKFLOW_PATH, "utf8");
      } catch (error) {
        return {
          kind: "error",
          text: `delivery-review: 无法读取工作流指令 ${WORKFLOW_PATH}：${error.message}`
        };
      }
      const initialDescription = (invocation.rawInput ?? "").trim();
      const instruction = [
        workflow.trim(),
        "",
        "---",
        "# 本次运行参数（由 /delivery-review 命令注入，勿修改）",
        `- 用户初始描述：${initialDescription || "（未提供，需在 Step 0 向用户询问）"}`,
        "- 通信协议：本轮运行起，双 Agent 之间与状态推进不再使用 git notes；子代理结论由最终回复承载，编排者解析后驱动状态机（见工作流「通信机制」一节）"
      ].join("\n");

      invocation.agent.followup(createUserMessage({
        // DSH 消息契约要求 content 是块数组（ContentBlock[]），不能是裸字符串：
        // 字符串 content 会通过持久化写入，但冷加载时被 assertMessageEventShape 拒绝
        // （SessionPersistenceCorruptionError），且 LLM 序列化时在 contentHasImage
        // 处抛 TypeError，被包装成误导性的 TRANSPORT "DeepSeek API stream ... failed"。
        content: [{ type: "text", text: instruction }],
        source: { kind: "plugin", plugin: "delivery-review/command" }
      }));
      return {
        kind: "success",
        text: "delivery-review 工作流已启动：编排指令已注入会话，编排者将按 Step 0 向你确认上下文。"
      };
    }
  });
}

export { apply, inject, name };
