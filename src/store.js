// 状态存储层：.delivery-review/state.json 与 rounds/R<N>.json 的读写。
// 纯 Node，无 DSH 依赖。路径纪律与移植版一致：.delivery-review 固定在
// 仓库根目录（git rev-parse --show-toplevel），不在子目录创建。
// 并发纪律：写入串行化（进程内队列），避免 hook 刷新与提交工具交错写坏。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeState } from "./state.js";

const execFileAsync = promisify(execFile);

/** 解析仓库根目录；非 git 仓库抛错。 */
export async function resolveRepoRoot(cwd) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const root = stdout.trim();
  if (!root) throw new Error("not inside a git repository");
  return root;
}

/** .delivery-review 目录路径（相对仓库根）。 */
export function reviewDir(repoRoot) {
  return join(repoRoot, ".delivery-review");
}

// ── 状态读写（串行化） ────────────────────────────────────────────────────

let queue = Promise.resolve();
/** 进程内串行化写入（简单互斥，防止并发写坏 state.json）。 */
export function withLock(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** 读当前状态机；文件缺失返回初始状态（不创建）。 */
export async function readState(repoRoot) {
  try {
    const raw = JSON.parse(await readFile(join(reviewDir(repoRoot), "state.json"), "utf8"));
    return normalizeState(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeState({});
    throw error;
  }
}

/** 写状态机（创建目录、原子写）。 */
export async function writeState(repoRoot, state) {
  const dir = reviewDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const text = JSON.stringify(state);
  const path = join(dir, "state.json");
  // 先写临时文件再改名，避免读端看到半截 JSON
  await writeFile(`${path}.tmp`, text, { encoding: "utf8" });
  await import("node:fs/promises").then(({ rename }) => rename(`${path}.tmp`, path));
}

// ── 轮次记录（rounds/R<N>.json） ──────────────────────────────────────────

/** 追加一轮提交记录。 */
export async function appendRound(repoRoot, roundNumber, payload) {
  const dir = join(reviewDir(repoRoot), "rounds");
  await mkdir(dir, { recursive: true });
  const record = { round: roundNumber, submitted_at: new Date().toISOString(), ...payload };
  await writeFile(join(dir, `R${roundNumber}.json`), JSON.stringify(record, null, 2), { encoding: "utf8" });
  return record;
}

/** 读取全部轮次记录（按轮次升序）。 */
export async function readRounds(repoRoot) {
  const dir = join(reviewDir(repoRoot), "rounds");
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const rounds = [];
  for (const name of entries) {
    const m = /^R(\d+)\.json$/.exec(name);
    if (!m) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8"));
      rounds.push(record);
    } catch {
      // 损坏的单条记录跳过，不阻断整体读取
    }
  }
  rounds.sort((a, b) => a.round - b.round);
  return rounds;
}
