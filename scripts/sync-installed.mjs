// 一键把工作区插件源码同步到 harness 实际加载的安装位置。
//
// 背景（为什么需要它）：bundle 安装（dsh plugin --profile web add）是**实体拷贝**，
// harness 启动时从 %DSH_HOME%/profiles/<profile>/node_modules/delivery-review-plugin
// 加载插件代码。改工作区源码不会自动生效——这是「改了三次 /delivery-review 都崩
// 溃」事故的根因：修复只落在工作区，安装副本一直是旧代码。
//
// 不要用 junction/symlink 替代拷贝：Node 默认对链接做 realpath 解析，插件内部
// import 的 @deepseek-ai/* 依赖会从真实路径（工作区）向上查找而失败（见
// docs/porting-notes.md 第五节与 docs/pitfalls.md「Junction 陷阱」）。
//
// 用法：node scripts/sync-installed.mjs [--profile web]
//   同步范围 = package.json 的 files 字段（cordis.patch.yml、src/、workflow/、
//   roles/、skills/）加 package.json 本身。同步后重启 web profile 生效。
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));

const profileArg = process.argv.indexOf("--profile");
const profile = profileArg >= 0 ? process.argv[profileArg + 1] : "web";
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PACKAGE = "delivery-review-plugin";
const dest = join(dshHome, "profiles", profile, "node_modules", PACKAGE);

if (!existsSync(dest)) {
  console.error(`✗ 未找到安装位置 ${dest}`);
  console.error("  确认 profile 已安装该插件（dsh plugin --profile <name> add delivery-review-plugin）");
  process.exit(1);
}

// 与 package.json 的 files 字段保持一致（发布内容 = 同步范围）。
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const entries = [...manifest.files, "package.json"];

let copied = 0;
let failed = 0;
for (const entry of entries) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) {
    console.error(`✗ 源缺失（工作区）：${entry}`);
    failed++;
    continue;
  }
  cpSync(src, join(dest, entry), { recursive: true, force: true });
  console.log(`✓ ${entry}`);
  copied++;
}

console.log(`\n同步完成：${copied} 项，失败 ${failed} 项`);
console.log(`目标：${dest}`);
if (failed === 0) {
  console.log("请重启 web profile（关闭当前 dsh web 进程后重新启动）使新代码生效。");
  process.exit(0);
} else {
  process.exit(1);
}
