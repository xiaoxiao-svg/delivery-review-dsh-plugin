// delivery-review 活动面板浮层（原生 JS，无构建步骤）。
// 由 panel.js 经 webServer.tapIndex 注入 index.html，通过
// /plugins/delivery-review/state 路由 1s 轮询渲染右上角状态摘要。
//
// 第一期职责（状态摘要）：
//   - 当前阶段 / 轮次 / 质量分 / 退出原因 / 最近一轮 risk 摘要
//   - 可收起（右上角小圆点），不覆盖操作区
// 设计原则：只读展示，不引入任何依赖；挂载失败静默降级（不破坏页面）。

(() => {
  // 幂等保护：只挂一次
  if (window.__deliveryReviewFloaterLoaded) return;
  window.__deliveryReviewFloaterLoaded = true;

  const STATE_URL = "/plugins/delivery-review/state";
  const POLL_MS = 1000;

  // ── DOM 构建 ────────────────────────────────────────────────────────────
  const styles = document.createElement("style");
  styles.textContent = `
.dr-floater-wrap {
  position: fixed; top: 12px; right: 12px; z-index: 2147483000;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px; color: #1f2328; user-select: none;
}
.dr-floater {
  width: 280px; max-height: 60vh; overflow: auto;
  background: rgba(255,255,255,0.96); border: 1px solid rgba(0,0,0,0.12);
  border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.14);
  padding: 10px 12px; box-sizing: border-box;
}
.dr-floater h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; cursor: grab; }
.dr-floater h4.dr-grabbing, .dr-dot.dr-grabbing { cursor: grabbing; }
.dr-floater .dr-close { cursor: pointer; opacity: 0.5; font-size: 14px; line-height: 1; padding: 0 2px; }
.dr-floater .dr-close:hover { opacity: 1; }
.dr-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.dr-row .dr-k { opacity: 0.65; }
.dr-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; margin-left: 4px; }
.dr-tag-ok { background: #e6f4ea; color: #137333; }
.dr-tag-warn { background: #fef7e0; color: #b06000; }
.dr-tag-bad { background: #fce8e6; color: #c5221f; }
.dr-risk { border-top: 1px dashed rgba(0,0,0,0.1); margin-top: 6px; padding-top: 6px; }
.dr-risk-item { padding: 3px 0; display: flex; gap: 6px; align-items: baseline; }
.dr-p { font-weight: 700; font-size: 11px; flex-shrink: 0; }
.dr-p0 { color: #c5221f; } .dr-p1 { color: #e37400; } .dr-p2 { color: #888; }
.dr-ev { opacity: 0.55; font-size: 10px; }
.dr-empty { opacity: 0.45; text-align: center; padding: 8px 0; }
.dr-dot {
  position: fixed; top: 12px; right: 12px; z-index: 2147483000;
  width: 12px; height: 12px; border-radius: 50%; cursor: pointer;
  background: #4b8bf5; box-shadow: 0 0 6px rgba(75,139,245,0.5);
  border: 2px solid #fff;
}
.dr-dot.running { animation: dr-pulse 1.2s infinite; }
.dr-dot.idle { background: #9aa0a6; box-shadow: 0 0 4px rgba(154,160,166,0.4); animation: none; }
@keyframes dr-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }
`;
  document.head.appendChild(styles);

  const wrap = document.createElement("div");
  wrap.className = "dr-floater-wrap";
  wrap.innerHTML = `
<div class="dr-floater" style="display:none">
  <h4>交付协作 <span class="dr-close" title="收起">—</span></h4>
  <div class="dr-body"></div>
</div>`;
  const dot = document.createElement("div");
  dot.className = "dr-dot idle";
  dot.title = "delivery-review 活动面板";
  document.body.appendChild(wrap);
  document.body.appendChild(dot);

  const floater = wrap.querySelector(".dr-floater");
  const body = wrap.querySelector(".dr-body");

  // ── 状态渲染 ────────────────────────────────────────────────────────────
  function tag(text, kind) {
    return `<span class="dr-tag dr-tag-${kind}">${text}</span>`;
  }

  function exitTag(reason) {
    if (!reason) return tag("运行中", "ok");
    const map = {
      converged: ["✅ 收敛", "ok"],
      quality_gate: ["🎯 达质量门", "ok"],
      max_rounds: ["⚠️ 达轮次上限", "warn"],
      oscillation: ["⚠️ 震荡退出", "bad"],
      dispute: ["⚠️ dispute 未解", "bad"]
    };
    const [text, kind] = map[reason] ?? [reason, "warn"];
    return tag(text, kind);
  }

  function stageText(payload) {
    if (!payload?.active) return "未运行";
    const s = payload.state;
    if (s.exit_reason) return `已结束（Round ${s.round}）`;
    if (s.round === 0) return "初始化中";
    return `Round ${s.round} / 上限 ${s.max_rounds}`;
  }

  function render(payload) {
    const last = payload?.last_round;
    const s = payload?.state;
    if (!payload?.active || !s) {
      body.innerHTML = `<div class="dr-empty">未在运行<br>（/delivery-review 启动）</div>`;
      dot.className = "dr-dot idle";
      return;
    }
    dot.className = "dr-dot" + (s.exit_reason ? "" : " running");

    let html = "";
    html += `<div class="dr-row"><span class="dr-k">阶段</span><span>${stageText(payload)}${exitTag(s.exit_reason)}</span></div>`;
    html += `<div class="dr-row"><span class="dr-k">质量分</span><span>${last ? last.score + "/10" : "—"}</span></div>`;
    html += `<div class="dr-row"><span class="dr-k">正式 risk</span><span>${last ? last.formal_risks : "—"}${last?.doubts ? ` · 存疑 ${last.doubts}` : ""}${last?.unknowns ? ` · 未知 ${last.unknowns}` : ""}</span></div>`;
    if (last?.risks?.length) {
      html += `<div class="dr-risk">${last.risks.map((r) => `
        <div class="dr-risk-item">
          <span class="dr-p dr-p${r.severity?.toLowerCase()}">${r.severity}</span>
          <span>${escapeHtml(r.summary)} <span class="dr-ev">${r.evidence} · ${escapeHtml(r.location)}</span></span>
        </div>`).join("")}</div>`;
    }
    body.innerHTML = html;
  }

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // ── 交互与轮询 ──────────────────────────────────────────────────────────
  function toggle(show) {
    floater.style.display = show ? "block" : "none";
    dot.style.display = show ? "none" : "block";
  }
  // 拖动后抑制 click（避免拖动圆点误触发展开）
  let suppressClick = false;
  dot.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    toggle(true);
  });
  wrap.querySelector(".dr-close").addEventListener("click", () => toggle(false));

  // ── 可拖动（浮层与圆点联动，位置持久化） ────────────────────────────────
  const POS_KEY = "delivery-review-floater-pos";
  const FLOATER_W = 280;   // .dr-floater 宽度
  const DOT_W = 16;        // .dr-dot 含边框宽度
  let pos = null;
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) pos = saved;
  } catch { /* 损坏数据忽略 */ }

  function applyPos() {
    if (!pos) return;
    wrap.style.left = pos.left + "px";
    wrap.style.top = pos.top + "px";
    wrap.style.right = "auto";
    dot.style.left = (pos.left + FLOATER_W - DOT_W) + "px";
    dot.style.top = pos.top + "px";
    dot.style.right = "auto";
  }
  applyPos();

  function makeDraggable(handle) {
    let sx = 0, sy = 0, origin = null, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".dr-close")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      origin = pos ?? {
        left: Math.max(0, window.innerWidth - FLOATER_W - 12),
        top: 12
      };
      handle.classList.add("dr-grabbing");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      pos = {
        left: Math.max(0, Math.min(window.innerWidth - FLOATER_W, origin.left + e.clientX - sx)),
        top: Math.max(0, Math.min(window.innerHeight - 40, origin.top + e.clientY - sy))
      };
      applyPos();
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dr-grabbing");
      if (origin && pos && (pos.left !== origin.left || pos.top !== origin.top)) suppressClick = true;
      if (pos) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* 隐私模式忽略 */ } }
    });
  }
  makeDraggable(wrap.querySelector(".dr-floater h4"));
  makeDraggable(dot);

  async function poll() {
    try {
      const res = await fetch(STATE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch {
      render({ active: false });
    }
  }
  setInterval(poll, POLL_MS);
  poll();
})();
