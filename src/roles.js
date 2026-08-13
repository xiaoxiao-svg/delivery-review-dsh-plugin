// delivery_review_role 工具：spawn 子代理前按角色取回角色指令文本。
// 对应 Claude 版 agents/*.md（子代理定义文件）。DSH 中子代理角色由编排者每次
// spawn 时经 prompt 传入，本工具把插件自带的角色文件按需交给编排者：
//   - 不依赖 fs 沙箱对插件安装目录（$DSH_HOME/profiles/.../node_modules）的读权限
//   - 按需拉取，不会在命令注入时把三个角色全文一次性塞进上下文
//   - 可重复调用，抗上下文压缩（压缩后重新取回即可）

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "delivery-review-roles";
const inject = ["tools"];

const here = dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = join(here, "..", "roles");

const ROLES = Object.freeze({
  fixer: "fixer.md",
  reviewer: "reviewer.md",
  planner: "planner.md"
});

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "delivery_review_role",
    description: "返回 delivery-review 工作流某个子代理角色的完整指令文本（fixer=修复工程师 / reviewer=资深审查者，只读 / planner=方案审查者，只读）。spawn 对应子代理前调用本工具，把返回的角色指令全文并入子代理 prompt。",
    parameters: {
      role: {
        type: "string",
        required: true,
        enum: ["fixer", "reviewer", "planner"],
        description: "角色名：fixer / reviewer / planner。"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", required: true },
          text: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.text }]
    },
    async execute(args) {
      const file = ROLES[args.role];
      if (!file) return { role: args.role, text: "" };
      const path = join(ROLES_DIR, file);
      try {
        const text = await readFile(path, "utf8");
        return { role: args.role, text: text.trim() };
      } catch (error) {
        return {
          role: args.role,
          text: `（delivery-review: 读取角色文件失败 ${path}: ${error.message}。请直接按工作流中的角色职责说明 spawn。）`
        };
      }
    }
  }));
}

export { apply, inject, name };
