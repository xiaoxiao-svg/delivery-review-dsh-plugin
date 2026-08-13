// 审查材料生成核心（纯 Node，无 DSH 依赖，可独立测试）。
// 移植自 delivery-review-plugin/hooks/update-review-material.ps1，逻辑与格式保持一致：
//   - 材料三部分：改动清单 / 完整 diff（>800 行截断）/ 新建文件清单（untracked）
//   - 纪律：任何失败不抛出，只写 .delivery-review/hook.log，绝不干扰被钩住的工具调用
//   - 落位：.delivery-review 固定在仓库根目录（git rev-parse --show-toplevel），
//     无论在哪个子目录触发，材料都写到根目录，不在子目录创建
//
// 相比 PS1 版的改进：
//   - 免去 PS 5.1 的编码坑（BOM/OutputEncoding/stdin 乱码），UTF-8 全程直出
//   - 触发工具名由调用方显式传入（hook 传 exec.name，refresh 工具传自身名）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const execFileAsync = promisify(execFile);

/** 触发材料刷新的工具名集合（对应原插件 PostToolUse matcher：Write|Edit|Bash）。 */
export const MUTATING_TOOLS = new Set(["write", "edit", "pwsh", "bash", "run_code"]);
/** diff 超过该行数即截断（与原脚本一致）。 */
export const DIFF_MAX_LINES = 800;

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
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
 * 刷新审查材料。
 * @param {string} cwd 触发目录（git 仓库内任意位置）。
 * @param {{trigger?: string, reason?: string}} [options] trigger 写入材料头部，reason 写入 hook.log。
 * @returns {Promise<{refreshed: boolean, repoRoot: string, path: string, truncated?: boolean, reason?: string, error?: string}>}
 *   永不抛出：任何失败写 hook.log 并返回 {refreshed:false, error}。
 */
export async function refreshReviewMaterial(cwd, options = {}) {
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
      lines.push("", "> diff 超过 800 行已省略，请按改动清单 Read 具体文件核实");
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
