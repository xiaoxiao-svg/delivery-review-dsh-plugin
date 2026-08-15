// 确定性状态机（纯函数，无 DSH 依赖，可独立单测）。
// 对应原版/移植版由编排者（LLM）手写的 state.json 更新逻辑——本模块把
// 状态推进、risk 差集、振荡检测、退出判定全部下沉为确定性代码，
// 编排者只做决策（spawn 谁、是否接受），不做计算。
//
// 相对移植版的两处关键修复（对应 R1-6 / R1-7）：
//   - risk 去重：用 risk 内容指纹而非「轮次号+序号」标识，跨轮同一问题
//     不算新增 risk（移植版标识 R<N>-<K> 跨轮必不同，「新增==0」分支
//     实际不可达，收敛条件退化为只认零 risk）；
//   - 文件计数：由调用方传入机器可解析的改动文件清单（git diff --name-only），
//     不再由 LLM 解析 git diff --stat 自由文本（漏计/错位）。

/** 退出原因常量。 */
export const EXIT_REASONS = Object.freeze({
  OSCILLATION: "oscillation",   // 同一文件反复修改 ≥3 次
  DISPUTE: "dispute",           // dispute 未解决（reviewer confirm 后仍坚持）
  CONVERGED: "converged",       // 连续两轮无新增正式 risk
  QUALITY_GATE: "quality_gate", // 质量分 ≥7 且无 P0/P1
  MAX_ROUNDS: "max_rounds"      // 达到轮次上限
});

/** 证据等级（结构化枚举，替代自由文本）。 */
export const EVIDENCE = Object.freeze({
  VERIFIED: "verified",         // 实际运行/测试观察到的
  REPRODUCIBLE: "reproducible", // 给出了复现步骤（未实际运行）
  CODE_INFERENCE: "code-inference", // 读代码推断的
  GUESS: "guess"                // 经验猜测，不算正式 risk
});

/** 正式 risk 的证据等级集合（猜测级不算 risk，只进存疑清单）。 */
const FORMAL_EVIDENCE = new Set([EVIDENCE.VERIFIED, EVIDENCE.REPRODUCIBLE, EVIDENCE.CODE_INFERENCE]);

/** 风险级别。 */
export const SEVERITY = Object.freeze({
  P0: "P0", // 阻塞：安全漏洞/数据丢失/功能不可用（必须带 verified/reproducible 证据）
  P1: "P1", // 重要：逻辑错误/性能退化/边界缺失
  P2: "P2"  // 建议：风格/命名/可维护性，可 defer
});

/** 默认轮次上限。 */
export const DEFAULT_MAX_ROUNDS = 3;
/** 振荡阈值：同一文件被修改 ≥ 该次数即判定震荡。 */
export const OSCILLATION_THRESHOLD = 3;

/**
 * 初始状态。
 * @param {number} [maxRounds=DEFAULT_MAX_ROUNDS]
 */
export function initialState(maxRounds = DEFAULT_MAX_ROUNDS) {
  return {
    round: 0,
    consecutive_clean: 0,
    last_score: 0,
    exit_reason: "",
    max_rounds: maxRounds,
    file_mod_counts: {},
    last_round_risk_ids: [],
    last_round_file_fingerprints: {}
  };
}

/**
 * 从任意 JSON 对象构造一个合法状态（用于读取持久化文件后归一化）。
 * 未知字段丢弃，缺失字段回退默认值。
 */
export function normalizeState(raw = {}) {
  return {
    round: Number.isSafeInteger(raw.round) && raw.round >= 0 ? raw.round : 0,
    consecutive_clean: Number.isSafeInteger(raw.consecutive_clean) && raw.consecutive_clean >= 0 ? raw.consecutive_clean : 0,
    last_score: Number.isFinite(raw.last_score) && raw.last_score >= 0 ? raw.last_score : 0,
    exit_reason: typeof raw.exit_reason === "string" ? raw.exit_reason : "",
    max_rounds: Number.isSafeInteger(raw.max_rounds) && raw.max_rounds > 0 ? raw.max_rounds : DEFAULT_MAX_ROUNDS,
    file_mod_counts: raw.file_mod_counts && typeof raw.file_mod_counts === "object" && !Array.isArray(raw.file_mod_counts)
      ? Object.fromEntries(Object.entries(raw.file_mod_counts).filter(([, v]) => Number.isSafeInteger(v) && v > 0))
      : {},
    last_round_risk_ids: Array.isArray(raw.last_round_risk_ids) ? raw.last_round_risk_ids.filter((x) => typeof x === "string") : [],
    last_round_file_fingerprints: raw.last_round_file_fingerprints && typeof raw.last_round_file_fingerprints === "object" && !Array.isArray(raw.last_round_file_fingerprints)
      ? Object.fromEntries(Object.entries(raw.last_round_file_fingerprints).filter(([, v]) => typeof v === "string"))
      : {}
  };
}

/**
 * 计算 risk 的内容指纹（稳定标识，跨轮去重）。
 * 同一问题的指纹必须跨轮稳定：取「位置 + 归一化问题描述」的短哈希。
 * @param {object} risk { location: string, summary: string }
 * @returns {string} 形如 `f3a1` 的短指纹
 */
export function riskFingerprint(risk) {
  const location = String(risk?.location ?? "").trim().toLowerCase();
  const summary = String(risk?.summary ?? "")
    .trim().toLowerCase()
    // 归一化：折叠空白、去除标点差异，让同一问题的不同措辞命中同一指纹
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const text = `${location}|${summary}`;
  // FNV-1a 32 位哈希，稳定且无依赖
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 判定一条 risk 是否为正式 risk（证据等级合格）。
 * @param {object} risk
 * @returns {boolean}
 */
export function isFormalRisk(risk) {
  return FORMAL_EVIDENCE.has(risk?.evidence);
}

/**
 * 判定 risk 是否允许报 P0：P0 必须带 verified / reproducible 证据。
 * @param {object} risk
 * @returns {boolean}
 */
export function isP0Allowed(risk) {
  return risk?.severity !== SEVERITY.P0
    || risk?.evidence === EVIDENCE.VERIFIED
    || risk?.evidence === EVIDENCE.REPRODUCIBLE;
}

/**
 * 状态机单步推进（一轮审查结论输入 → 新状态）。
 * 纯函数：不读写文件、不产生副作用。
 *
 * @param {object} state 当前状态（normalizeState 过的对象）
 * @param {object} roundResult 本轮输入：
 * @param {Array<object>} roundResult.risks 本轮 reviewer 输出的全部 risk 条目
 *   （含证据等级；内部会过滤出正式 risk 参与统计）
 * @param {number} roundResult.score 本轮质量分 0-10
 * @param {Array<string>|Array<{file: string, fingerprint: string}>} [roundResult.changedFiles]
 *   本轮改动文件清单。两种形态：
 *   - 字符串数组：兼容旧调用，全部按「本轮修改」计数（不推荐，见下）
 *   - 对象数组 {file, fingerprint}：文件级内容指纹（推荐，机器可解析）。
 *     振荡语义 = 该文件相对上轮的 diff 指纹**变化**（内容被再次修改）才计数 +1；
 *     指纹相同（上轮遗留未提交、本轮未动）不计数。修复审查 P1：
 *     `git diff HEAD --name-only` 是跨轮累计集合，直接计数会让正常 loop
 *     第 3 轮系统性误触发 OSCILLATION。
 * @param {boolean} [roundResult.disputeUnresolved=false] 是否存在未解决的 dispute
 *   （reviewer confirm 后仍坚持）
 * @returns {object} 新状态
 */
export function advance(state, roundResult) {
  const next = normalizeState(state);
  next.round += 1;

  // P0 证据门禁（R1-1）：P0 必须带 verified/reproducible 证据，否则不进正式统计
  //（仍写入轮次记录供人工查看；由 isP0Allowed 保证，不再只是 prompt 文本约束）
  const formal = (roundResult.risks ?? []).filter((r) => isFormalRisk(r) && isP0Allowed(r));
  const thisRoundIds = formal.map((risk) => riskFingerprint(risk));
  const previous = new Set(next.last_round_risk_ids);
  const newIds = thisRoundIds.filter((id) => !previous.has(id));

  // 连续无新增轮数：本轮新增正式 risk 数为 0 则 +1，否则清零
  next.consecutive_clean = newIds.length === 0 ? next.consecutive_clean + 1 : 0;
  next.last_round_risk_ids = thisRoundIds;

  // 质量分
  const score = Number.isFinite(roundResult.score) ? roundResult.score : 0;
  next.last_score = Math.max(0, Math.min(10, score));

  // 振荡检测：文件级指纹对比（机器可解析，修复审查 P1）。
  // 指纹数组 {file, fingerprint}：与上轮指纹不同 = 内容被再次修改 → +1；
  // 相同 = 未新增修改 → 不计；新文件（上轮无指纹）→ +1。
  // 字符串数组（旧调用）：保持原语义（全部按本轮修改计数）。
  const prevFps = next.last_round_file_fingerprints;
  const nextFps = {};
  for (const entry of roundResult.changedFiles ?? []) {
    if (typeof entry === "string") {
      if (entry.length === 0) continue;
      nextFps[entry] = "";
      next.file_mod_counts[entry] = (next.file_mod_counts[entry] ?? 0) + 1;
      continue;
    }
    const file = entry?.file;
    if (typeof file !== "string" || file.length === 0) continue;
    const fp = typeof entry.fingerprint === "string" ? entry.fingerprint : "";
    nextFps[file] = fp;
    if (prevFps[file] === undefined || prevFps[file] !== fp) {
      next.file_mod_counts[file] = (next.file_mod_counts[file] ?? 0) + 1;
    }
  }
  next.last_round_file_fingerprints = nextFps;

  // 退出判定（按优先级）：
  const oscillating = Object.values(next.file_mod_counts).some((count) => count >= OSCILLATION_THRESHOLD);
  const hasP0P1 = formal.some((risk) => risk.severity === SEVERITY.P0 || risk.severity === SEVERITY.P1);
  if (oscillating) {
    next.exit_reason = EXIT_REASONS.OSCILLATION;
  } else if (roundResult.disputeUnresolved) {
    next.exit_reason = EXIT_REASONS.DISPUTE;
  } else if (next.consecutive_clean >= 2 && !hasP0P1) {
    // 收敛 = 连续两轮无新增正式 risk 且无未解决的 P0/P1（与质量门语义一致：
    // 同一未修 P1 连续上报不算「收敛」，避免把未解决的重要问题报成收敛退出）
    next.exit_reason = EXIT_REASONS.CONVERGED;
  } else if (next.last_score >= 7 && !hasP0P1) {
    next.exit_reason = EXIT_REASONS.QUALITY_GATE;
  } else if (next.round >= next.max_rounds) {
    next.exit_reason = EXIT_REASONS.MAX_ROUNDS;
  } else {
    next.exit_reason = "";
  }

  return next;
}
