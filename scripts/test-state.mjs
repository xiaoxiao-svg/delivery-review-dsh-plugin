// src/state.js 纯函数单测（开发期工具，node scripts/test-state.mjs 运行）。
// 覆盖：指纹稳定性/去重、正式 risk 过滤、P0 证据门禁、退出四级判定、
// 振荡检测、normalizeState 归一化、纯函数无副作用。
import { strict as assert } from "node:assert";
import {
  advance, initialState, normalizeState, riskFingerprint,
  isFormalRisk, isP0Allowed, EXIT_REASONS, DEFAULT_MAX_ROUNDS
} from "../src/state.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✓ ${name}`); };

// ── 1. 指纹稳定性与跨轮去重 ──────────────────────────────────────────────
{
  const r1 = { location: "src/a.ts:10", summary: "未处理空指针，可能崩溃" };
  const r2 = { location: "src/a.ts:10", summary: "未处理空指针，可能崩溃。" }; // 仅标点差异
  const r3 = { location: "src/a.ts:11", summary: "未处理空指针" };             // 位置不同
  assert.equal(riskFingerprint(r1), riskFingerprint(r2), "标点差异应同指纹");
  assert.notEqual(riskFingerprint(r1), riskFingerprint(r3), "位置不同应异指纹");
  ok("指纹稳定：同问题同指纹、不同位置异指纹");
}

// ── 2. 正式 risk 过滤（猜测级不算） ──────────────────────────────────────
{
  const guesses = [{ summary: "x", evidence: "guess" }, { summary: "y" }];
  assert.equal(guesses.filter(isFormalRisk).length, 0, "guess/缺省不算正式 risk");
  const formal = [{ summary: "x", evidence: "verified" }, { summary: "y", evidence: "code-inference" }];
  assert.equal(formal.filter(isFormalRisk).length, 2, "verified/code-inference 算正式 risk");
  ok("正式 risk 过滤：猜测级排除");
}

// ── 3. P0 证据门禁 ───────────────────────────────────────────────────────
{
  assert.ok(isP0Allowed({ severity: "P0", evidence: "verified" }), "P0+verified 允许");
  assert.ok(isP0Allowed({ severity: "P0", evidence: "reproducible" }), "P0+reproducible 允许");
  assert.ok(!isP0Allowed({ severity: "P0", evidence: "code-inference" }), "P0+code-inference 禁止");
  assert.ok(!isP0Allowed({ severity: "P0", evidence: "guess" }), "P0+guess 禁止");
  assert.ok(isP0Allowed({ severity: "P2", evidence: "guess" }), "P2 无证据门禁");
  ok("P0 证据门禁：仅 verified/reproducible 可报 P0");
}

// ── 4. 收敛：连续两轮无新增正式 risk ─────────────────────────────────────
{
  const risk = { location: "src/b.ts:5", summary: "缓存未失效", evidence: "code-inference", severity: "P2" };
  let s = initialState();
  s = advance(s, { risks: [risk], score: 6, changedFiles: ["src/b.ts"] });
  assert.equal(s.exit_reason, "", "第一轮有新增 risk 不应退出");
  assert.equal(s.consecutive_clean, 0);
  // 第二轮同一条 risk（指纹相同 → 无新增）→ 收敛计数 1；score=6 低于质量门，不退出
  s = advance(s, { risks: [risk], score: 6, changedFiles: [] });
  assert.equal(s.consecutive_clean, 1, "同风险重复出现不算新增");
  assert.equal(s.exit_reason, "", "连续 1 轮干净且 score<7 不退出");
  // 第三轮同一条 risk → 连续 2 轮干净 → converged
  s = advance(s, { risks: [risk], score: 6, changedFiles: [] });
  assert.equal(s.consecutive_clean, 2);
  assert.equal(s.exit_reason, EXIT_REASONS.CONVERGED, "连续两轮无新增 → converged");
  ok("收敛判定：跨轮同风险去重后连续两轮干净 → converged（修复 R1-7）");
}

// ── 4c. 收敛不豁免 P0/P1：未修的 P1 连续上报不算收敛（修复 P2-2） ────────
{
  const p1risk = { location: "src/b.ts:5", summary: "缓存未失效", evidence: "code-inference", severity: "P1" };
  let s = initialState();
  s = advance(s, { risks: [p1risk], score: 6, changedFiles: ["src/b.ts"] });
  s = advance(s, { risks: [p1risk], score: 6, changedFiles: [] });
  s = advance(s, { risks: [p1risk], score: 6, changedFiles: [] });
  assert.equal(s.consecutive_clean, 2, "无新增连续 2 轮");
  assert.equal(s.exit_reason, EXIT_REASONS.MAX_ROUNDS, "存在未修 P1 → 不报 converged，走到上限兜底");
  ok("收敛不豁免 P0/P1：未修 P1 连续上报不触发 converged（修复 P2-2）");
}

// ── 4b. 质量门优先于收敛：score≥7 时第二轮即退出 ─────────────────────────
{
  const risk = { location: "src/b.ts:5", summary: "缓存未失效", evidence: "code-inference", severity: "P2" };
  let s = initialState();
  s = advance(s, { risks: [risk], score: 6, changedFiles: ["src/b.ts"] });
  s = advance(s, { risks: [risk], score: 8, changedFiles: [] });
  assert.equal(s.exit_reason, EXIT_REASONS.QUALITY_GATE, "score≥7 无新增时质量门优先于等收敛");
  ok("质量门优先：score≥7 且无 P0/P1 时不必等满连续两轮");
}

// ── 5. 质量门：score≥7 且无 P0/P1 ────────────────────────────────────────
{
  let s = initialState();
  s = advance(s, { risks: [], score: 8, changedFiles: [] });
  assert.equal(s.exit_reason, EXIT_REASONS.QUALITY_GATE, "score≥7 无 risk → quality_gate");
  s = initialState();
  s = advance(s, { risks: [{ location: "a", summary: "x", evidence: "verified", severity: "P1" }], score: 8, changedFiles: [] });
  assert.equal(s.exit_reason, "", "有 P1 时 score≥7 不满足质量门");
  ok("质量门：score≥7 且无 P0/P1");
}

// ── 6. 振荡检测：文件级指纹对比（修复审查 P1） ──────────────────────────
{
  // 正常 loop：同一文件跨轮未提交、内容未再修改 → 指纹不变 → 不计数，
  // 不会系统性误触发 OSCILLATION（修复 P1：git diff --name-only 是累计集合）
  let s = initialState(6); // 上限放大，避免 max_rounds 干扰振荡断言
  const fp = "abc123";
  s = advance(s, { risks: [{ location: "src/c.ts", summary: "问题甲", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "src/c.ts", fingerprint: fp }] });
  s = advance(s, { risks: [{ location: "src/c.ts", summary: "问题乙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "src/c.ts", fingerprint: fp }] });
  s = advance(s, { risks: [{ location: "src/c.ts", summary: "问题丙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "src/c.ts", fingerprint: fp }] });
  assert.equal(s.file_mod_counts["src/c.ts"], 1, "指纹不变只计 1 次（文件被再次修改才算振荡）");
  assert.equal(s.exit_reason, "", "指纹不变不触发振荡");
  // 真正振荡：每轮内容都变（指纹变化）→ 3 次触发
  let s2 = initialState();
  s2 = advance(s2, { risks: [{ location: "x", summary: "问题甲", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f1" }] });
  s2 = advance(s2, { risks: [{ location: "x", summary: "问题乙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f2" }] });
  assert.equal(s2.exit_reason, "", "修改 2 次未触发");
  s2 = advance(s2, { risks: [{ location: "x", summary: "问题丙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f3" }] });
  assert.equal(s2.exit_reason, EXIT_REASONS.OSCILLATION, "指纹变化 3 次触发震荡");
  assert.equal(s2.file_mod_counts["d.ts"], 3, "file_mod_counts 机器计数");
  // 新文件（上轮无指纹）→ +1
  let s3 = initialState();
  s3 = advance(s3, { risks: [], score: 5, changedFiles: [{ file: "new.ts", fingerprint: "n1" }] });
  assert.equal(s3.file_mod_counts["new.ts"], 1, "新文件首现计 1");
  ok("振荡检测：文件级指纹对比（指纹不变不计、指纹变化计、新文件计）——修复 P1");
}

// ── 7. dispute 未解决 ────────────────────────────────────────────────────
{
  let s = initialState();
  s = advance(s, { risks: [], score: 9, changedFiles: [], disputeUnresolved: true });
  assert.equal(s.exit_reason, EXIT_REASONS.DISPUTE, "dispute 未解决优先于质量门");
  ok("dispute 未解决 → 强制退出");
}

// ── 8. 轮次上限 ──────────────────────────────────────────────────────────
{
  let s = initialState(2);
  s = advance(s, { risks: [{ location: "a", summary: "x", evidence: "verified", severity: "P1" }], score: 3, changedFiles: [] });
  assert.equal(s.exit_reason, "", "第 1 轮不退出");
  s = advance(s, { risks: [{ location: "a", summary: "x", evidence: "verified", severity: "P1" }], score: 3, changedFiles: [] });
  assert.equal(s.exit_reason, EXIT_REASONS.MAX_ROUNDS, "达到 max_rounds → max_rounds");
  assert.equal(s.max_rounds, 2);
  ok("轮次上限：round >= max_rounds → max_rounds");
}

// ── 9. 退出优先级：震荡 > dispute > 收敛 > 质量门 > 上限 ──────────────────
{
  // 每轮新增 risk + score 低 + 指纹每轮变化，排除质量门/收敛干扰，验证震荡优先
  let s = initialState();
  s = advance(s, { risks: [{ location: "d.ts", summary: "问题甲", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f1" }] });
  s = advance(s, { risks: [{ location: "d.ts", summary: "问题乙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f2" }] });
  s = advance(s, { risks: [{ location: "d.ts", summary: "问题丙", evidence: "verified", severity: "P1" }], score: 5, changedFiles: [{ file: "d.ts", fingerprint: "f3" }], disputeUnresolved: true });
  assert.equal(s.exit_reason, EXIT_REASONS.OSCILLATION, "震荡优先级最高");
  ok("退出优先级：震荡 > dispute > 收敛 > 质量门 > 上限");
}

// ── 10. normalizeState：坏数据归一化、未知字段丢弃 ───────────────────────
{
  const s = normalizeState({ round: -5, last_score: "abc", file_mod_counts: { a: 99, b: 0 }, junk: true, last_round_risk_ids: [1, "x"], last_round_file_fingerprints: { f: "fp1", bad: 7 } });
  assert.equal(s.round, 0, "负数 round 归 0");
  assert.equal(s.last_score, 0, "非数字 score 归 0");
  assert.deepEqual(s.file_mod_counts, { a: 99 }, "0 计数剔除");
  assert.deepEqual(s.last_round_risk_ids, ["x"], "非字符串 id 剔除");
  assert.deepEqual(s.last_round_file_fingerprints, { f: "fp1" }, "非字符串指纹剔除");
  assert.equal(s.junk, undefined, "未知字段丢弃");
  assert.equal(s.max_rounds, DEFAULT_MAX_ROUNDS, "缺省 max_rounds 回默认");
  ok("normalizeState 归一化：坏数据回退、未知字段丢弃");
}

// ── 11. 纯函数无副作用：入参对象不被修改 ─────────────────────────────────
{
  const s = initialState();
  const before = JSON.stringify(s);
  const risks = [{ location: "a", summary: "x", evidence: "verified", severity: "P1" }];
  advance(s, { risks, score: 5, changedFiles: ["e.ts"] });
  assert.equal(JSON.stringify(s), before, "输入状态不被修改");
  assert.equal(JSON.stringify(risks), JSON.stringify([{ location: "a", summary: "x", evidence: "verified", severity: "P1" }]), "risk 输入不被修改");
  ok("纯函数：输入无副作用");
}

console.log(`\n全部通过 ✅（${passed} 项）`);
