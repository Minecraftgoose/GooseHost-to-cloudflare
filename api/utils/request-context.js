// ===== 请求执行上下文（waitUntil 桥接）=====
//
// Cloudflare Workers 会在响应返回后冻结未被 await 的异步任务。
// 旧代码为了让「访问计数」之类不丢，只能在返回前 await 一次写库，
// 于是把一次与页面内容无关的 RPC 计入了用户打开站点的 TTFB。
//
// 这里用 WeakMap 把 fetch(request, env, ctx) 的 ctx 绑到 request 上：
//   · 有 ctx → ctx.waitUntil(task)，调用方立刻继续，任务在响应后完成；
//   · 无 ctx（本地自测 / 非 Workers 运行时）→ 退化为 await，保证任务不丢。
// WeakMap 以 request 对象为键，天然 per-request，无并发串扰、无跨请求状态。

const contexts = new WeakMap();

export function bindRequestContext(request, ctx) {
  if (ctx && typeof ctx.waitUntil === 'function') contexts.set(request, ctx);
}

/**
 * 在后台执行一个「失败也无关紧要」的任务。
 * 调用方仍写 await：有 ctx 时几乎零成本返回，没有 ctx 时保持旧行为。
 * @param {Request} request
 * @param {() => Promise<*>|*} task
 */
export async function runInBackground(request, task) {
  const wrapped = Promise.resolve()
    .then(task)
    .catch(err => console.error('[background] task failed:', err?.message || err));

  const ctx = contexts.get(request);
  if (ctx) {
    ctx.waitUntil(wrapped);
    return;
  }
  await wrapped;   // 兜底：没有执行上下文就必须等完，避免任务被回收
}
