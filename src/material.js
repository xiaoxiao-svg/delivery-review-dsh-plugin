// 审查材料生成核心（纯 Node，无 DSH 依赖，可独立测试）。
// 移植自 delivery-review-plugin/hooks/update-review-material.ps1，逻辑与格式保持一致：
//   - 材料三部分：改动清单 / 完整 diff（>800 行截断）/ 新建文件清单（untracked）
//   - 纪律：任何失败不抛出，只写 .delivery-review/hook.log，绝不干扰被钩住的工具调用
//   - 落位：.delivery-review 固定在仓库根目录（git rev-parse --show-toplevel），
//     无论在哪个子目录触发，材料都写到根目录，不在子目录创建
//
// 相对 PS1 版的改进：
//   - 免去 PS 5.1 的编码坑（BOM/OutputEncoding/stdin 乱码），UTF-8 全程直出
//   - 触发工具名由调用方显式传入（hook 传 exec.name，refresh 工具传自身名）
//   - R1-1 修复：截断时写入 diff 前 800 行（原版只写「已省略」注释，截断分支为死代码）
//   - R1-4 修复：模块级串行队列统一所有刷新入口（hook / refresh 工具 / 其他），
//     不再各自并发写材料
//   - R1-6 修复：新增 listChangedFiles() 输出 git diff --name-only 机器可解析清单，
//     状态机振荡检测不再依赖 LLM 解析自由文本

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const execFileAsync = promisify(execFile);

/** 触发材料刷新的工具名集合（对应原插件 PostToolUse matcher：Write|Edit|Bash）。 */
export const MUTATING_TOOLS = new Set(["write", "edit", "pwsh", "bash", "run_code"]);
/** diff 超过该行数即截断（与原脚本一致）。 */
export const DIFF_MAX_LINES = 800;

// 模块级串行队列（R1-4 修复）：所有刷新入口统一排队，杜绝并发写坏材料
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function runGit(cwd, args) {
  // core.quotePath=false：中文/非 ASCII 文件名不转义（R1-3），
  // 否则 diff --name-only 输出 "\344\270\255..."，逐文件 diff 匹配失败、指纹恒空
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

/** 解析 git 仓库根目录（归一化为本机路径分隔符）；非 git 仓库抛错。 */
export async function resolveRepoRoot(cwd) {
  const out = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const root = out.trim();
  if (!root) throw new Error("not inside a git repository");
  // git 在 Windows 上输出正斜杠路径（C:/...），归一化为本机形式便于 join/显示
  return normalize(root);
}

/**
 * 列出工作区改动文件（机器可解析，R1-6 修复）。
 * 输出 = git diff --name-only（tracked 改动）+ untracked 文件，供状态机
 * 振荡检测使用，不再依赖 LLM 解析 git diff --stat 自由文本。
 * @param {string} cwd git 仓库内任意目录
 * @returns {Promise<string[]>} 改动文件清单（相对仓库根）；非 git 仓库返回 []
 */
export async function listChangedFiles(cwd) {
  try {
    const repoRoot = await resolveRepoRoot(cwd);
    const [diff, untracked] = await Promise.all([
      runGit(repoRoot, ["diff", "HEAD", "--name-only"]),
      runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"])
    ]);
    return [...new Set([
      ...diff.split("\n").map((s) => s.trim()).filter(Boolean),
      ...untracked.split("\n").map((s) => s.trim()).filter(Boolean)
    ])];
  } catch {
    return [];
  }
}

/** FNV-1a 32 位短哈希（与 state.js 的 riskFingerprint 同族，无依赖）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 文件级改动指纹（振荡检测的机器可解析输入，修复审查 P1）。
 * 返回 [{file, fingerprint}]：fingerprint 反映「该文件相对 HEAD 的当前 diff 内容」。
 * 语义：同一文件两轮之间指纹变化 = 内容被再次修改（振荡信号）；
 * 指纹相同 = 没有新的修改（上轮遗留未提交，不算本轮改动）。
 * untracked 文件以内容哈希为指纹（无 diff 可对比）。
 *
 * @param {string} cwd git 仓库内任意目录
 * @returns {Promise<Array<{file: string, fingerprint: string}>>} 非 git 仓库返回 []
 */
export async function listChangedFileFingerprints(cwd) {
  try {
    const repoRoot = await resolveRepoRoot(cwd);
    // 逐文件 diff（--no-ext-diff 避免外部 diff 工具干扰）。
    // 指纹对「该文件相对 HEAD 的完整 diff 文本」取哈希——语义：两轮之间
    // 内容再次变化则指纹变化。上下文行的存在不影响正确性（只影响指纹值），
    // 稳定性由「同一内容必得同一 diff」保证。
    const diff = await runGit(repoRoot, ["diff", "HEAD", "--name-only"]);
    const tracked = diff.split("\n").map((s) => s.trim()).filter(Boolean);
    const untracked = (await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n").map((s) => s.trim()).filter(Boolean);

    const out = [];
    for (const file of tracked) {
      const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", "diff", "HEAD", "--no-ext-diff", "--", file], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      });
      out.push({ file, fingerprint: fnv1a(stdout) });
    }
    for (const file of untracked) {
      // 文件内容哈希；读取失败（如目录）退化为「空内容」指纹，仍能体现文件出现/消失
      let content = "";
      try {
        content = await readFile(join(repoRoot, file), "utf8");
      } catch {
        content = "";
      }
      out.push({ file, fingerprint: fnv1a(content) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 刷新审查材料（R1-4 修复：经模块级串行队列执行，任何入口都排队）。
 * @param {string} cwd 触发目录（git 仓库内任意位置）。
 * @param {{trigger?: string, reason?: string}} [options] trigger 写入材料头部，reason 写入 hook.log。
 * @returns {Promise<{refreshed: boolean, repoRoot: string, path: string, truncated?: boolean, reason?: string, error?: string}>}
 *   永不抛出：任何失败写 hook.log 并返回 {refreshed:false, error}。
 */
export function refreshReviewMaterial(cwd, options = {}) {
  return enqueue(() => refreshReviewMaterialInner(cwd, options));
}

async function refreshReviewMaterialInner(cwd, options = {}) {
  let repoRoot;
  try {
    repoRoot = await resolveRepoRoot(cwd);
  } catch (error) {
    return { refreshed: false, repoRoot: "", path: "", error: `resolve repo root: ${error.message}` };
  }
  const dir = join(repoRoot, ".delivery-review");
  const materialPath = join(dir, "review_material.md");
  const log = async (message) => {
    try {
      await appendFile(join(dir, "hook.log"), `${new Date().toISOString()} ${message}\n`, { encoding: "utf8" });
    } catch {
      /* 日志失败不阻断 */
    }
  };
  try {
    await mkdir(dir, { recursive: true });

    // 工作区有变化才刷新材料（含 untracked）；无变化保留旧材料不动
    const changed = (await runGit(repoRoot, ["status", "--porcelain"])).trim();
    if (!changed) return { refreshed: false, repoRoot, path: materialPath, reason: "no-changes" };

    const headHash = (await runGit(repoRoot, ["rev-parse", "--short", "HEAD"])).trim();
    const stat = (await runGit(repoRoot, ["diff", "HEAD", "--stat"])).trim();
    const rawDiff = (await runGit(repoRoot, ["diff", "HEAD"])).trim();
    const untracked = (await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"])).trim();

    const diffLines = rawDiff.split("\n");
    const truncated = diffLines.length > DIFF_MAX_LINES;
    const diff = truncated ? diffLines.slice(0, DIFF_MAX_LINES).join("\n") : rawDiff;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const lines = [
      "# 审查材料（自动生成，请勿手改）",
      "",
      `- 生成时间：${stamp}`,
      `- 基线 HEAD：${headHash}`,
      `- 触发工具：${options.trigger ?? "hook"}`,
      "- 覆盖范围：Write/Edit/Bash 工具调用后的工作区变化；MCP 等其他工具的写入不在材料中，请人工核对",
      "",
      "## 改动清单",
      "```",
      stat,
      "```"
    ];
    if (truncated) {
      lines.push("", "## 完整 diff（前 800 行，超过部分已省略，请按改动清单 Read 具体文件核实）", "```diff", diff, "```");
    } else {
      lines.push("", "## 完整 diff", "```diff", diff, "```");
    }
    if (untracked) {
      lines.push("", "## 新建文件（untracked，不在 diff 中，请 Read 原文核实）", "```", untracked, "```");
    }
    await writeFile(materialPath, lines.join("\n") + "\n", { encoding: "utf8" });
    if (options.reason) await log(`refreshed (${options.reason})`);
    return { refreshed: true, repoRoot, path: materialPath, truncated };
  } catch (error) {
    await log(`refresh failed: ${error.message}`);
    return { refreshed: false, repoRoot, path: materialPath, error: error.message };
  }
}

// ── 最近活动仓库（Web 面板定位用） ──────────────────────────────────────────
// 仅由显式启动信号写入（/dsh-delivery 启动、delivery_submit_review 提交），
// 不在 hook 刷新路径记录——普通开发的写文件不应让面板误判为交付进行中。
let lastActiveRepo = null;
/** 记录最近启动交付流程的仓库根目录。 */
export function setLastActiveRepo(repoRoot) {
  lastActiveRepo = repoRoot;
}
/** 读取最近活动仓库；无则返回 null（面板据此显示"未在运行"）。 */
export function getLastActiveRepo() {
  return lastActiveRepo;
}
