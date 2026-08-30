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
function buildBody(model, payload, env) {
  const maxTokens = Number(env.AI_MAX_TOKENS) || 4096;
  const body = {
    model,
    messages: payload.messages,
    max_tokens: maxTokens,
    stream: false
  };
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = payload.tool_choice || 'auto';
  }
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
  return body;
}

const MAX_ROUNDS = 1;         // 所有 key 试完算一轮，最多再补一轮
const DEFAULT_429_WAIT = 2;   // 没给 Retry-After 时的默认等待秒数
const MAX_RETRY_SLEEP = 20;   // 单次等待上限，防止异常 Retry-After 拖死请求
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  /*
   * 用指定模型把 key 列表整个试一遍。
   * 关键判断：400 是「模型不存在/不支持」，换 key 没用，要换模型；
   *           429/401/5xx 是 key 级限流或临时故障，换 key 往往立刻就好。
   */
  async function tryModelOnce(model, keys) {
    let maxWait = 0;

    for (let k = 0; k < keys.length; k++) {
      let upstream = null, text = '';
      try {
        upstream = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + keys[k]
          },
          body: JSON.stringify(buildBody(model, payload, env))
        });
        text = await upstream.text();
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

  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const keys = rotateKeys(keyList);
      const r = await tryModelOnce(model, keys);

      if (r.ok) {
        // 原样回传上游响应（前端要解析 tool_calls），只追加诊断头
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders,
          'X-Copilot-Model': model
        };
        if (keyList.length > 1) headers['X-Copilot-Key'] = `${r.keyIdx}/${keyList.length}`;
        if (errors.length) headers['X-Copilot-Fallback'] = errors.join(' | ');
        return new Response(r.text, { status: r.status, headers });
      }

      if (r.fatalModel) break;
      if (round < MAX_ROUNDS && r.wait > 0) await sleep(r.wait * 1000);
    }
  }

  return jsonResp({
    error: '所有模型与 API Key 均调用失败',
    tried: errors,
    models,
    hint: '依次排查：1) 模型名是否有效（智谱模型迭代快，HTTP 400 即模型不存在）；'
      + '2) API Key 是否有效、额度是否用完（HTTP 401）；'
      + '3) 是否触发限流（HTTP 429，各 Key 独立计数，多填几个可缓解）；'
      + '4) 端点是否正确——通用场景用 /api/paas/v4，Coding Plan 才是 /api/coding/paas/v4'
  }, 502, corsHeaders);
}
