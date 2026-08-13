// 方法论技能注册插件：把插件自带 skills/delivery-review/SKILL.md 注册进 ctx.skills。
// 对应 Claude 插件 skills/ 目录的发现机制——DSH 的技能发现根（项目 .dsh/skills、
// 用户 ~/.dsh/skills 等）无法覆盖插件安装目录，因此随 bundle 直接运行时注册，
// 安装即用，无需用户复制技能文件。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const name = "delivery-review-skills";
const inject = ["skills"];

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "skills", "delivery-review", "SKILL.md");

/** 解析 YAML frontmatter 的极简实现（本插件只读 name/description/whenToUse 三个单行字段）。 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv && kv[2] !== undefined) frontmatter[kv[1]] = kv[2];
  }
  return { frontmatter, body: match[2].trim() };
}

function apply(ctx) {
  let frontmatter;
  let body;
  try {
    const text = readFileSync(SKILL_PATH, "utf8");
    ({ frontmatter, body } = parseFrontmatter(text));
  } catch (error) {
    ctx.logger.warn(`delivery-review-skills: 无法读取 ${SKILL_PATH}: ${error.message}`);
    return;
  }
  ctx.skills.register({
    name: frontmatter.name || "delivery-review",
    description: frontmatter.description || "双 Agent 交付协作工作流（loop 模式）方法论与数据模型",
    ...(frontmatter.whenToUse ? { whenToUse: frontmatter.whenToUse } : {}),
    // DSH 技能契约要求 source 是字符串（dsh-skill 的 validateDefinition 强制），
    // 缺省会抛 TypeError："loaded skill ... source must be a string"。
    // "bundled" 表示技能随插件 bundle 分发（与 dsh-skill-filesystem 的分类惯例一致）。
    source: "bundled",
    content: body
  });
}

export { apply, inject, name };
