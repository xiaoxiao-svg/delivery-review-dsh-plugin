// 审查材料自动刷新 hook 插件。
// 对应 Claude 版 plugin.json 的 PostToolUse hook（matcher: Write|Edit|Bash）：
// 监听 tools/post-execute waterfall，write/edit/pwsh/bash 调用结束后刷新
// .delivery-review/review_material.md。
//
// 设计要点：
//   - 事件在根上下文注册 = 全局监听，覆盖所有 agent（编排者、fixer 子代理等）
//   - 按 exec.name 过滤（等价于原 matcher），exec.agent.session.header.cwd 定位仓库
//   - 刷新在后台串行执行、不阻塞工具调用（waterfall 立即 next()）；
//     编排者/审查者读材料在后续轮次，天然晚于刷新完成

import { refreshReviewMaterial, MUTATING_TOOLS } from "./material.js";

const name = "delivery-review-hook";

function apply(ctx) {
  // 串行化刷新队列：并发 git diff 交错会写坏材料
  let queue = Promise.resolve();
  const enqueue = (task) => {
    queue = queue.then(task, task).catch(() => {});
    return queue;
  };

  ctx.on("tools/post-execute", (exec, _result, next) => {
    if (!MUTATING_TOOLS.has(exec.name)) return next();
    const cwd = exec.agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return next();
    enqueue(() => refreshReviewMaterial(cwd, { trigger: exec.name }));
    return next();
  });
}

export { apply, name };
