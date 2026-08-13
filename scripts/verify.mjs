// 静态校验：语法检查所有 src/*.js、解析 cordis.patch.yml（含 !!js 表达式节点）、
// 校验角色/技能/工作流文件存在且 frontmatter 可解析。
// 用法：node scripts/verify.mjs [--modules <node_modules 目录>]
// js-yaml 从 DSH 安装树的 node_modules 解析（env DSH_NODE_MODULES 或默认 npx 缓存路径）。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const modulesArg = process.argv.indexOf("--modules");
const defaultModules = "C:/Users/30788/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules";
const MODULES = process.env.DSH_NODE_MODULES ?? (modulesArg >= 0 ? process.argv[modulesArg + 1] : defaultModules);
const yamlPath = resolve(MODULES, "js-yaml");
if (!existsSync(yamlPath)) {
  console.error(`✗ js-yaml not found at ${yamlPath}（用 --modules 指定含 js-yaml 的 node_modules）`);
  process.exit(1);
}
const yaml = await import(`file://${yamlPath.replaceAll("\\", "/")}/index.js`);

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`✗ ${message}`);
};
const ok = (message) => console.log(`✓ ${message}`);

// ── 1. JS 语法 ──────────────────────────────────────────────────────────────
const srcFiles = ["material.js", "hook.js", "refresh.js", "roles.js", "command.js", "skills.js"];
for (const file of srcFiles) {
  const path = join(ROOT, "src", file);
  const check = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (check.status === 0) ok(`语法 ${file}`);
  else {
    fail(`语法 ${file}\n${check.stderr}`);
  }
}

// ── 2. cordis.patch.yml ─────────────────────────────────────────────────────
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data })
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);
const patchText = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
let patch;
try {
  patch = yaml.load(patchText, { schema });
  ok("cordis.patch.yml 可解析（含 !!js 节点）");
} catch (error) {
  fail(`cordis.patch.yml 解析失败: ${error.message}`);
  patch = [];
}

const insert = Array.isArray(patch) && patch[0]?.insert;
if (!Array.isArray(insert) || insert.length === 0) {
  fail("cordis.patch.yml 顶层应为 [{- insert: [...]}]");
} else {
  ok(`insert 行数 = ${insert.length}`);
  const byId = new Map(insert.map((row) => [row.id, row]));
  const expected = [
    "delivery-review-command",
    "delivery-review-hook",
    "delivery-review-refresh",
    "delivery-review-roles",
    "delivery-review-skills",
    "delivery-review-subagent-fixer",
    "delivery-review-subagent-reviewer",
    "delivery-review-subagent-planner"
  ];
  for (const id of expected) {
    if (byId.has(id) && typeof byId.get(id).name === "string") ok(`行 ${id}`);
    else fail(`行 ${id} 缺失或 name 非法`);
  }
  for (const row of ["delivery-review-subagent-reviewer", "delivery-review-subagent-planner"]) {
    const allow = byId.get(row)?.config?.toolFilter?.allow;
    if (!Array.isArray(allow) || allow.length !== 4) fail(`${row} toolFilter.allow 应为 4 项只读工具（read/read_image/glob/grep）`);
    else ok(`${row} toolFilter.allow = ${allow.join(", ")}`);
  }
}

// ── 3. 资源文件存在性 ──────────────────────────────────────────────────────
for (const rel of [
  "workflow/delivery-review.md",
  "roles/fixer.md",
  "roles/reviewer.md",
  "roles/planner.md",
  "skills/delivery-review/SKILL.md"
]) {
  const path = join(ROOT, rel);
  if (existsSync(path)) ok(`资源 ${rel}`);
  else fail(`资源缺失 ${rel}`);
}

const skillText = readFileSync(join(ROOT, "skills/delivery-review/SKILL.md"), "utf8");
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText);
if (!fm || !/^name:\s*\S+$/m.test(fm[1]) || !/^description:\s*\S+/m.test(fm[1])) {
  fail("SKILL.md frontmatter 应含单行 name/description");
} else {
  ok("SKILL.md frontmatter（name/description 单行）");
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
