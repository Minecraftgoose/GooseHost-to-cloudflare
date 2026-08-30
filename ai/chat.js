// ===== AI Copilot 转发层 =====
//
// 路由：POST /api/ai/chat
//
// 与本项目其他端点保持一致：
//   - 认证复用 utils/jwt.js 的 getUserId()（走 env.SUPABASE_URL + SUPABASE_ANON_KEY）
//   - 限流复用 utils/rate-limit.js 的 checkRateLimit()
//   - CORS / 响应复用 utils/cors.js、utils/response.js
//
// 这样不需要额外配置 SUPABASE_URL —— 其他功能已经在用了。
// 只需新增两个环境变量（Cloudflare 控制台 → Worker → Settings → Variables）：
//   AI_API_KEYS   智谱 API Key，逗号分隔可填多个（各 Key 独立限流，多填能叠加并发）
//   AI_MODEL      模型链，逗号分隔，默认 glm-4.7-flash,glm-4.6,glm-4-flash

import { getUserId } from '../utils/jwt.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { jsonResp } from '../utils/response.js';

/*
 * 智谱官方端点。注意有两个，别混：
 *   https://open.bigmodel.cn/api/paas/v4          ← 通用 API，走资源包/余额（我们用这个）
 *   https://open.bigmodel.cn/api/coding/paas/v4  ← GLM Coding Plan 专用，仅限 Coding 场景
 * Copilot 是通用对话 + 工具调用，走通用端点。用错会报余额或权限错误。
 */
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';

/*
 * 默认模型链（依据智谱官方文档整理，**未经实测**，建议用 tools/test_api.py 验证）
 *
 *   glm-4.7-flash  免费，200K 上下文，编程能力 SOTA
 *   glm-4.6        工具调用最可靠的一档（官方强调其调用确定性与 JSON 完整性）
 *   glm-4-flash    永久免费兜底，128K 上下文
 *
 * 顺序：优先免费且编程强的 4.7-flash；不支持 tools 则降到 4.6；最后 4-flash 兜底。
 * 模型会迭代下线，过一阵子建议重跑 test_api.py 更新这里。
 */
const DEFAULT_MODELS = ['glm-4.7-flash', 'glm-4.6', 'glm-4-flash'];

/** 解析模型链：env.AI_MODEL（逗号分隔），没配用默认 */
function modelChain(env) {
  const raw = (env.AI_MODEL || '').trim();
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  return list.length ? list : DEFAULT_MODELS;
}

/** 解析 key 列表：AI_API_KEYS 优先，其次 AI_API_KEY。key 绝不写入任何响应 */
function keyChain(env) {
  const raw = env.AI_API_KEYS || env.AI_API_KEY || '';
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

/*
 * 轮转 key：每次请求从下一个开始。
 * 智谱各 API Key 独立计数限流，所以轮换本身就是扩容，不只是「一个挂了另一个顶上」。
 * 计数器在 isolate 内累计，被回收也只是从 0 重来，不影响正确性。
 */
let rrCursor = 0;
function rotateKeys(keys) {
  if (keys.length <= 1) return keys.slice();
  const start = (rrCursor++) % keys.length;
  return keys.slice(start).concat(keys.slice(0, start));
}

/* 构造上游请求体。只放行前端真正需要的字段，避免把奇怪参数透传给模型 */
function buildBody(model, payload, env, stream) {
  const maxTokens = Number(env.AI_MAX_TOKENS) || 4096;
  const body = {
    model,
    messages: payload.messages,
    max_tokens: maxTokens,
    stream: !!stream
  };
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = payload.tool_choice || 'auto';
  }
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
  return body;
}

/* 流式响应的固定头。X-Accel-Buffering 防反向代理缓冲，否则会攒着不发 */
function sseHeaders(corsHeaders, model, keyIdx, keyCount, errors, elapsedMs) {
  const h = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
    'X-Copilot-Model': model
  };
  // 首字节耗时：判断「慢在建立连接」还是「慢在生成」
  if (typeof elapsedMs === 'number') h['X-Copilot-Elapsed'] = String(elapsedMs);
  if (keyCount > 1) h['X-Copilot-Key'] = `${keyIdx}/${keyCount}`;
  if (errors.length) h['X-Copilot-Fallback'] = errors.join(' | ');
  return h;
}

/*
 * 单次上游请求超时（毫秒）。可用 AI_UPSTREAM_TIMEOUT_MS 覆盖。
 *
 * 30 秒是权衡后的值：
 *   - 太短（如 10s）会把「慢但能成功」误判成失败 —— 带 11 个工具 schema 的
 *     请求首 token 本来就比裸对话慢好几倍，砍太狠反而帮倒忙
 *   - 太长（如 60s）则失败路径拖沓，一次挂起就吃掉大半预算
 */
const DEFAULT_UPSTREAM_TIMEOUT = 30000;

/*
 * 整个请求的墙钟预算（毫秒）。可用 AI_BUDGET_MS 覆盖。
 *
 * 为什么必须有：最坏情况是 3 模型 × 2 轮 × 2 key = 12 次串行上游请求。
 * 即使每次都在 30 秒超时，12 × 30 = 360 秒，远超前端的 120 秒 ——
 * 前端超时断开，而 Worker 还在徒劳地继续，既浪费资源又拿不到结果。
 * 有了预算，无论中间怎么重试，最多 60 秒一定返回（成功或明确错误）。
 *
 * 60 秒 < 前端超时 120 秒，保证 Worker 总能先给出结论。
 */
const DEFAULT_BUDGET = 60000;

const MAX_ROUNDS = 1;         // 所有 key 试完算一轮，最多再补一轮
const DEFAULT_429_WAIT = 2;   // 没给 Retry-After 时的默认等待秒数
const MAX_RETRY_SLEEP = 20;   // 单次等待上限，防止异常 Retry-After 拖死请求
const sleep = ms => new Promise(r => setTimeout(r, ms));

function numEnv(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/*
 * 带超时的上游请求。
 *
 * 关键：这个超时**只作用于建立连接到响应头返回**这一段。
 * 因为 fetch 在响应头到达时就 resolve，之后我们立刻 clearTimeout，
 * 所以流式传输不会被中途掐断 —— 这正是我们要的语义。
 *
 * 返回 { resp } 时调用方需自行读取 body；非流式场景由调用方
 * 在同一个控制器有效期内读完，超时才覆盖完整过程（见 fetchUpstreamText）。
 */
async function fetchUpstream(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    return { resp, ctrl, timer, elapsed: Date.now() - t0 };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.name)));
    return { error: aborted ? `超时（>${timeoutMs}ms）` : ((e && e.message) || String(e)), aborted, elapsed: Date.now() - t0 };
  }
}

/*
 * 非流式：超时必须覆盖到 body 读完，而不只是响应头。
 * 头先到、body 卡住同样会让前端干等，所以读完后才停表。
 */
async function fetchUpstreamText(url, opts, timeoutMs) {
  const r = await fetchUpstream(url, opts, timeoutMs);
  if (r.error) return { ...r, text: '' };
  try {
    const text = await r.resp.text();
    return { resp: r.resp, text, elapsed: Date.now() - (Date.now() - r.elapsed) };
  } catch (e) {
    return { error: (e && e.message) || String(e), aborted: true, text: '', elapsed: r.elapsed };
  } finally {
    clearTimeout(r.timer);
  }
}

/** 解析 Retry-After：支持秒数与 HTTP-date 两种格式 */
function parseRetryAfter(resp) {
  const raw = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
  if (!raw) return 0;
  const n = Number(raw);
  if (!isNaN(n) && n >= 0) return Math.min(n, MAX_RETRY_SLEEP);
  const t = Date.parse(raw);
  if (!isNaN(t)) {
    const d = Math.round((t - Date.now()) / 1000);
    return d > 0 ? Math.min(d, MAX_RETRY_SLEEP) : 0;
  }
  return 0;
}

export async function handleAiChat(request, env, corsHeaders) {
  // 1) 认证 —— 与其他需要登录的端点完全一致
  const userId = await getUserId(request, env);
  if (!userId) return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);

  // 2) 限流 —— 保护智谱 key 不被刷
  const rl = await checkRateLimit(request, env, 'ai_chat');
  if (!rl.allowed) {
    const msg = rl.locked
      ? `操作过于频繁，请在 ${Math.ceil(rl.resetIn / 60)} 分钟后重试`
      : `请求过于频繁，请在 ${Math.ceil(rl.resetIn)} 秒后重试`;
    return jsonResp({ error: msg, retryAfter: Math.ceil(rl.resetIn) }, 429, corsHeaders);
  }

  const keyList = keyChain(env);
  if (!keyList.length) {
    return jsonResp({ error: '服务端未配置 AI_API_KEYS 或 AI_API_KEY' }, 500, corsHeaders);
  }

  let payload;
  try { payload = await request.json(); } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }
  if (!Array.isArray(payload?.messages) || !payload.messages.length) {
    return jsonResp({ error: 'messages 不能为空' }, 400, corsHeaders);
  }

  const base = (env.AI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const models = modelChain(env);
  const errors = [];   // 只记模型名与状态码，绝不记 key 内容
  const wantStream = payload.stream === true;   // 前端按需开启，默认仍是非流式

  /*
   * 时间预算。三条约束共同保证「最多 budget 毫秒一定返回」：
   *   1. 每次上游请求有单次超时
   *   2. 每次重试前检查剩余预算，不够就停
   *   3. sleep 也受预算约束
   */
  const budgetMs = numEnv(env, 'AI_BUDGET_MS', DEFAULT_BUDGET);
  const upstreamTimeout = numEnv(env, 'AI_UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT);
  const deadline = Date.now() + budgetMs;
  const remain = () => deadline - Date.now();

  /*
   * 用指定模型把 key 列表整个试一遍。
   * 关键判断：400 是「模型不存在/不支持」，换 key 没用，要换模型；
   *           429/401/5xx 是 key 级限流或临时故障，换 key 往往立刻就好。
   *           超时/网络错误同样换 key，并计入等待时间。
   */
  async function tryModelOnce(model, keys) {
    let maxWait = 0;

    for (let k = 0; k < keys.length; k++) {
      if (remain() <= 0) {
        errors.push(`${model}: 预算耗尽`);
        return { wait: 0, exhausted: true };
      }

      let upstream = null, text = '';
      const opts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + keys[k]
        },
        body: JSON.stringify(buildBody(model, payload, env, wantStream))
      };

      /*
       * 单次超时取「配置值」与「剩余预算」的较小者 ——
       * 否则最后一次请求可能突破预算，前面的检查就白做了。
       */
      const thisTimeout = Math.min(upstreamTimeout, Math.max(remain(), 1000));

      try {
        if (wantStream) {
          /*
           * 流式：只要连接成功 + 有 body，立刻返回去透传，
           * 绝不 await text() —— 那会把整个流读完，流式就白搭了。
           *
           * 超时只覆盖「首字节」，拿到响应头就停表，后续流式传输不掐断。
           */
          const r = await fetchUpstream(base + '/chat/completions', opts, thisTimeout);
          if (r.error) {
            errors.push(`${model}: key#${k + 1} ${r.error}`);
            maxWait = Math.max(maxWait, DEFAULT_429_WAIT);
            continue;
          }
          upstream = r.resp;
          clearTimeout(r.timer);   // 头已到，停止计时，别截断后续的流

          if (upstream.ok && upstream.body) {
            return { ok: true, streamResp: upstream, keyIdx: k + 1, elapsed: r.elapsed };
          }
          text = await upstream.text().catch(() => '');
        } else {
          // 非流式：超时覆盖到 body 读完
          const r = await fetchUpstreamText(base + '/chat/completions', opts, thisTimeout);
          if (r.error) {
            errors.push(`${model}: key#${k + 1} ${r.error}`);
            maxWait = Math.max(maxWait, DEFAULT_429_WAIT);
            continue;
          }
          upstream = r.resp;
          text = r.text;
        }
      } catch (e) {
        errors.push(`${model}: key#${k + 1} ${(e && e.message) || e}`);
        maxWait = Math.max(maxWait, DEFAULT_429_WAIT);
        continue;
      }

      const st = upstream.status;

      if (st === 400) {
        errors.push(`${model}: HTTP 400`);
        return { fatalModel: true };      // 换模型，别再浪费其他 key
      }
      if (st === 401) {
        errors.push(`${model}: key#${k + 1} HTTP 401`);
        continue;                          // 这个 key 废了，换下一个
      }
      if (st === 429 || st >= 500) {
        const w = parseRetryAfter(upstream) || DEFAULT_429_WAIT;
        maxWait = Math.max(maxWait, w);
        errors.push(`${model}: key#${k + 1} HTTP ${st}`);
        continue;
      }

      return { ok: true, text, status: st, keyIdx: k + 1 };
    }

    return { wait: maxWait };
  }

  const t0 = Date.now();

  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      if (remain() <= 0) { errors.push('预算耗尽，中止后续尝试'); break; }

      const keys = rotateKeys(keyList);
      const r = await tryModelOnce(model, keys);

      if (r.ok) {
        // 耗时诊断：正常返回也带，方便判断「慢在哪」
        const elapsed = Date.now() - t0;

        // 流式：直接把上游 body 当作响应体透传，逐块发给前端，不落地缓存
        if (r.streamResp) {
          return new Response(r.streamResp.body, {
            status: 200,
            headers: sseHeaders(corsHeaders, model, r.keyIdx, keyList.length, errors, elapsed)
          });
        }

        // 非流式：原样回传（前端要解析 tool_calls），只追加诊断头
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders,
          'X-Copilot-Model': model,
          'X-Copilot-Elapsed': String(elapsed)
        };
        if (keyList.length > 1) headers['X-Copilot-Key'] = `${r.keyIdx}/${keyList.length}`;
        if (errors.length) headers['X-Copilot-Fallback'] = errors.join(' | ');
        return new Response(r.text, { status: r.status, headers });
      }

      if (r.fatalModel) break;

      if (round < MAX_ROUNDS && r.wait > 0) {
        // sleep 也不能突破预算，否则「最多 budget 返回」的承诺就破了
        const waitMs = Math.min(r.wait * 1000, Math.max(remain(), 0));
        if (waitMs > 0) await sleep(waitMs);
      }

      if (r.exhausted) break;
    }
  }

  /*
   * 带上请求体规模。这是判断「慢」的关键指标：
   * 带 11 个工具 schema 的请求，光工具定义就约 3K tokens，
   * 加上长对话历史，首 token 时间天然比裸对话慢好几倍。
   * 没有这个数字，就只能靠猜。
   */
  const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
  let payloadBytes = 0;
  try { payloadBytes = JSON.stringify(payload).length; } catch { /* ignore */ }

  return jsonResp({
    error: '所有模型与 API Key 均调用失败',
    tried: errors,
    models,
    elapsedMs: Date.now() - t0,
    payloadBytes,
    msgCount: payload.messages.length,
    toolCount,
    hint: '依次排查：1) 模型名是否有效（智谱模型迭代快，HTTP 400 即模型不存在）；'
      + '2) API Key 是否有效、额度是否用完（HTTP 401）；'
      + '3) 是否触发限流（HTTP 429，各 Key 独立计数，多填几个可缓解）；'
      + '4) 端点是否正确——通用场景用 /api/paas/v4，Coding Plan 才是 /api/coding/paas/v4；'
      + '5) 若大量「超时」且 payloadBytes 很大，说明请求太重导致上游慢'
      + '（可精简对话历史或减少工具数）；若 payloadBytes 很小仍超时，'
      + '则是到上游的网络不通，可调小 AI_UPSTREAM_TIMEOUT_MS 快速失败'
  }, 502, corsHeaders);
}
