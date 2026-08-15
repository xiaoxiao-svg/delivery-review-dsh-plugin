// 集成测试（开发期工具，临时）：在临时 git 仓库验证
// material.js（刷新/清单/截断/竞态） + store.js（状态读写/轮次） +
// state.js（advance）全链路。运行后自动清理临时目录。
// 用法：node scripts/test-integration.mjs
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { refreshReviewMaterial, listChangedFiles, listChangedFileFingerprints, DIFF_MAX_LINES } from "../src/material.js";
import { resolveRepoRoot, readState, writeState, appendRound, readRounds, withLock } from "../src/store.js";
import { advance, initialState, EXIT_REASONS } from "../src/state.js";

const execFileAsync = promisify(execFile);
const git = (cwd, args) => execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✓ ${name}`); };

const tmp = await mkdtemp(join(tmpdir(), "dr-int-"));
try {
  // ── 准备临时仓库 ────────────────────────────────────────────────────────
  await git(tmp, ["init", "-q"]);
  await git(tmp, ["config", "user.email", "test@test.local"]);
  await git(tmp, ["config", "user.name", "test"]);
  await writeFile(join(tmp, "a.txt"), "line1\nline2\n");
  await git(tmp, ["add", "."]);
  await git(tmp, ["commit", "-qm", "init"]);
  const repoRoot = await resolveRepoRoot(tmp);
  assert.equal(repoRoot.replaceAll("/", "\\"), tmp, "repo root 解析");

  // ── 1. 无变化时刷新 → no-changes ───────────────────────────────────────
  {
    const r = await refreshReviewMaterial(tmp, { trigger: "test" });
    assert.equal(r.refreshed, false, "无变化不刷新");
    assert.equal(r.reason, "no-changes");
    ok("材料刷新：工作区无变化 → no-changes");
  }

  // ── 2. 改动后刷新 → 材料含改动清单与 diff ───────────────────────────────
  {
    await writeFile(join(tmp, "a.txt"), "line1\nline2\nline3\n");
    const r = await refreshReviewMaterial(tmp, { trigger: "write" });
    assert.equal(r.refreshed, true);
    const material = await readFile(join(repoRoot, ".delivery-review", "review_material.md"), "utf8");
    assert.ok(material.includes("a.txt"), "改动清单含 a.txt");
    assert.ok(material.includes("+line3"), "diff 含新增行");
    assert.ok(material.includes("触发工具：write"), "材料头部含触发工具");
    ok("材料刷新：改动后材料含清单+diff+触发信息");
  }

  // ── 3. listChangedFiles 机器可解析清单（R1-6） ─────────────────────────
  {
    await writeFile(join(tmp, "new.txt"), "new\n");
    const files = await listChangedFiles(tmp);
    assert.ok(files.includes("a.txt"), "清单含改动的 a.txt");
    assert.ok(files.includes("new.txt"), "清单含 untracked new.txt");
    ok(`listChangedFiles：机器可解析清单（${files.length} 个文件）`);
  }

  // ── 3b. 文件级指纹：跨轮累计集合不误报振荡（审查 P1 回归） ─────────────
  {
    await writeFile(join(tmp, "a.txt"), "line1\nline2\nline3\nline4\n");
    const fps1 = await listChangedFileFingerprints(tmp);
    const a1 = fps1.find((e) => e.file === "a.txt");
    assert.ok(a1 && a1.fingerprint.length > 0, "指纹非空");
    // 未再修改：同一内容 → 指纹不变（模拟 fixer 上轮遗留未提交）
    const fps2 = await listChangedFileFingerprints(tmp);
    const a2 = fps2.find((e) => e.file === "a.txt");
    assert.equal(a2.fingerprint, a1.fingerprint, "内容未变 → 指纹不变");
    // 再次修改 → 指纹变化
    await writeFile(join(tmp, "a.txt"), "line1\nline2\nline3\nline4\nline5\n");
    const fps3 = await listChangedFileFingerprints(tmp);
    const a3 = fps3.find((e) => e.file === "a.txt");
    assert.notEqual(a3.fingerprint, a1.fingerprint, "内容变化 → 指纹变化");
    ok("文件级指纹：内容不变指纹稳定、内容变化指纹更新（跨轮振荡判定输入）");
  }

  // ── 3c. 中文文件名指纹非空（R1-3 回归） ────────────────────────────────
  {
    await writeFile(join(tmp, "中文测试.md"), "内容一\n");
    await git(tmp, ["add", "."]);
    await git(tmp, ["commit", "-qm", "add 中文"]);
    await writeFile(join(tmp, "中文测试.md"), "内容一\n内容二\n");
    const fps = await listChangedFileFingerprints(tmp);
    const hit = fps.find((f) => f.file === "中文测试.md");
    assert.ok(hit && hit.fingerprint.length > 0, "中文文件名指纹非空（R1-3）");
    ok("中文文件名指纹：原样识别且指纹非空（R1-3 回归）");
  }

  // ── 4. 并发刷新不写坏材料（R1-4 串行队列） ──────────────────────────────
  {
    const results = await Promise.all([
      refreshReviewMaterial(tmp, { trigger: "write", reason: "c1" }),
      refreshReviewMaterial(tmp, { trigger: "edit", reason: "c2" }),
      refreshReviewMaterial(tmp, { trigger: "pwsh", reason: "c3" })
    ]);
    const material = await readFile(join(repoRoot, ".delivery-review", "review_material.md"), "utf8");
    assert.ok(material.startsWith("# 审查材料"), "材料头部完整（无并发写坏）");
    assert.ok(results.every((r) => r.refreshed === true), "三次刷新全部成功");
    ok("并发刷新：3 路并发后材料仍完整（R1-4 串行队列）");
  }

  // ── 5. 大 diff 截断：写入前 800 行（R1-1 修复） ─────────────────────────
  {
    const big = Array.from({ length: 900 }, (_, i) => `big line ${i}`).join("\n");
    await writeFile(join(tmp, "big.txt"), big);
    await git(tmp, ["add", "big.txt"]); // untracked 不进 git diff，先 add 使其进入 diff
    const r = await refreshReviewMaterial(tmp, { trigger: "write" });
    assert.equal(r.truncated, true, "900 行触发截断");
    const material = await readFile(join(repoRoot, ".delivery-review", "review_material.md"), "utf8");
    const diffIdx = material.indexOf("## 完整 diff");
    assert.ok(diffIdx >= 0, "截断时仍有完整 diff 小节");
    assert.ok(material.includes("big line 0"), "截断内容含前 800 行开头");
    assert.ok(material.includes("已省略"), "截断有省略说明");
    const diffSection = material.slice(diffIdx);
    const inFence = diffSection.split("```")[1] ?? "";
    assert.ok(inFence.split("\n").length <= DIFF_MAX_LINES + 2, "fence 内行数 ≤ 800+2");
    ok("大 diff 截断：写入前 800 行 + 省略说明（R1-1 修复）");
  }

  // ── 6. store：状态读写 + 轮次追加读取 ──────────────────────────────────
  {
    await writeState(repoRoot, initialState(3));
    let s = await readState(repoRoot);
    assert.equal(s.round, 0);
    s = advance(s, { risks: [{ location: "a.txt", summary: "问题A", evidence: "verified", severity: "P1" }], score: 5, changedFiles: ["a.txt"] });
    await writeState(repoRoot, s);
    const s2 = await readState(repoRoot);
    assert.equal(s2.round, 1);
    assert.equal(s2.exit_reason, "", "第一轮不退出");

    const rec = await appendRound(repoRoot, 1, { score: 5, risks: [], doubts: [], unknowns: [] });
    assert.equal(rec.round, 1);
    const rounds = await readRounds(repoRoot);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].score, 5);
    ok("store：状态读写 + 轮次记录（rounds/R1.json）");
  }

  // ── 7. withLock 串行写不交错 ────────────────────────────────────────────
  {
    // 串行队列保证两个任务依次执行：round 先 +100 再 +1
    const results = await Promise.all([
      withLock(async () => { const st = await readState(repoRoot); st.round += 100; await writeState(repoRoot, st); return st.round; }),
      withLock(async () => { const st = await readState(repoRoot); st.round += 1; await writeState(repoRoot, st); return st.round; })
    ]);
    assert.ok(results[1] === results[0] + 1, "第二个任务读到第一个任务的写入（串行）");
    const final = await readState(repoRoot);
    assert.equal(final.round, results[1], "最终状态 = 最后一次写入");
    ok("withLock：串行队列读写不交错");
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n集成测试全部通过 ✅（${passed} 项）`);
