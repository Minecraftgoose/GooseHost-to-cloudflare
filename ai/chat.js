import { getUserId } from '../utils/jwt.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { jsonResp } from '../utils/response.js';
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODELS = ['glm-4.7-flash', 'glm-4.6', 'glm-4-flash'];

// ===== 内置 Provider 预设（一键接入）=====
// 当 AI_PROVIDER 命中下表时，自动套用对应的 base url 与默认模型，
// 无需再手写完整的 AI_BASE_URL / AI_MODEL。
// 新增 provider 只需在此登记——保持 OpenAI 兼容协议即可。
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    // DeepSeek 官方 API 完全兼容 OpenAI Chat Completions 协议，
    // 故直接复用 /chat/completions 通道（参见 api-docs.deepseek.com）。
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    // 默认保留的思维/推理参数（DeepSeek-V4 支持 thinking mode）
    extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
  },
  // OpenCode Zen：官方精选模型网关，OpenAI Chat Completions 兼容。
  // 前端「一键接入」填入 https://opencode.ai/zen/v1 即命中此预设。
  // Endpoint 规范：https://opencode.ai/zen/v1（代理会自动追加 /chat/completions）。
  // 鉴权：Authorization: Bearer <opencode.ai/zen 控制台生成的 Key>。
  // 免费模型白名单（无需充值，超额返回 429 而非扣费）：
  //   big-pickle / deepseek-v4-flash-free / mimo-v2.5-free / qwen3.6-plus-free
  //   minimax-m3-free / nemotron-3-ultra-free / north-mini-code-free
  // 按量模型（按 token 计费，需先在控制台充值）：deepseek-v4-{flash,pro}、gpt-5.x 等。
  // 参考：https://opencode.ai/docs/zen
  'opencode-zen': {
    label: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    models: [
      'big-pickle',
      'deepseek-v4-flash-free', 'deepseek-v4-flash', 'deepseek-v4-pro',
      'mimo-v2.5-free', 'qwen3.6-plus-free', 'minimax-m3-free',
      'nemotron-3-ultra-free', 'north-mini-code-free',
      'gpt-5.4', 'gpt-5.5'
    ],
    // Zen 为 Chat Completions 兼容端点，不强制 thinking 参数；
    // 用户若填了付费模型，由前端/控制台侧控制计费，后端不做额外改写。
    extraBody: {}
  },
  // 示例：可继续扩展 openai / qwen 等 OpenAI 兼容 provider
  // openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: ['gpt-5'] }
};
function resolveProvider(env) {
  const name = String(env.AI_PROVIDER || '').trim().toLowerCase();
  return name ? PROVIDERS[name] || null : null;
}
function modelChain(env) {
  const provider = resolveProvider(env);
  const fallback = provider ? provider.models : DEFAULT_MODELS;
  const raw = (env.AI_MODEL || '').trim();
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : fallback;
  return list.length ? list : fallback;
}
function keyChain(env) {
  const raw = env.AI_API_KEYS || env.AI_API_KEY || '';
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}
let rrCursor = 0;
function rotateKeys(keys) {
  if (keys.length <= 1) return keys.slice();
  const start = (rrCursor++) % keys.length;
  return keys.slice(start).concat(keys.slice(0, start));
}
function buildBody(model, payload, env, stream, providerOverride) {
  const maxTokens = Number(env.AI_MAX_TOKENS) || 4096;
  const provider = providerOverride || resolveProvider(env);
  const body = {
    model,
    messages: payload.messages,
    max_tokens: maxTokens,
    stream: !!stream
  };
  // 合并 provider 预设的额外字段（如 DeepSeek 的 thinking / reasoning_effort；
  // OpenCode Zen 为 {}，不额外注入参数，保持 Chat Completions 兼容）。
  if (provider && provider.extraBody && typeof provider.extraBody === 'object') {
    for (const k of Object.keys(provider.extraBody)) body[k] = provider.extraBody[k];
  }
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = payload.tool_choice || 'auto';
  }
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
  return body;
}
function sseHeaders(corsHeaders, model, keyIdx, keyCount, errors, elapsedMs) {
  const h = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
    'X-Copilot-Model': model
  };
  if (typeof elapsedMs === 'number') h['X-Copilot-Elapsed'] = String(elapsedMs);
  if (keyCount > 1) h['X-Copilot-Key'] = `${keyIdx}/${keyCount}`;
  if (errors.length) h['X-Copilot-Fallback'] = errors.join(' | ');
  return h;
}
const DEFAULT_UPSTREAM_TIMEOUT = 30000;
const DEFAULT_BUDGET = 60000;
const MAX_ROUNDS = 1;         
const DEFAULT_429_WAIT = 2;   
const MAX_RETRY_SLEEP = 20;   
const sleep = ms => new Promise(r => setTimeout(r, ms));
function numEnv(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
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
  const userId = await getUserId(request, env);
  if (!userId) return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);
  const rl = await checkRateLimit(request, env, 'ai_chat');
  if (!rl.allowed) {
    const msg = rl.locked
      ? `操作过于频繁，请在 ${Math.ceil(rl.resetIn / 60)} 分钟后重试`
      : `请求过于频繁，请在 ${Math.ceil(rl.resetIn)} 秒后重试`;
    return jsonResp({ error: msg, retryAfter: Math.ceil(rl.resetIn) }, 429, corsHeaders);
  }
  const serverKeyList = keyChain(env);
  let payload;
  try { payload = await request.json(); } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }
  if (!Array.isArray(payload?.messages) || !payload.messages.length) {
    return jsonResp({ error: 'messages 不能为空' }, 400, corsHeaders);
  }
  const provider = resolveProvider(env);
  // 「一键接入」透传：前端自定义模型把 endpoint / apiKey 放进请求体，
  // 走本代理转发，避免浏览器直连第三方时因 CORS 被拒（已实测 DeepSeek /
  // OpenCode Zen 的 OPTIONS 预检均返回 403，且无 Access-Control-Allow-* 响应头）。
  // 优先级：请求体 endpoint > AI_BASE_URL > provider 预设 > 默认 GLM
  //
  // ⚠️ Endpoint 归一化策略（2026-09 调整）：
  // 前端已移除「自动补全 /chat/completions」，用户填的 URL 被视为【完整地址】，
  // 后端必须【原样使用】，不再做路径假设——否则用户填第三方网关
  // （如 /api/v1/chat、/completions、带子路径的代理）会被强制改坏。
  // 这里只做：去尾斜杠 + 兼容旧数据（若仍以 /chat/completions 结尾则保留，不再剥离）。
  const customEndpoint = String(payload.endpoint || '').trim().replace(/\/+$/, '');
  // OpenCode Zen 识别：Endpoint 命中 opencode.ai/zen 时，自动套用 opencode-zen
  // provider 预设（免费模型列表、计费提示），无需前端额外传 provider 名。
  // 仅做路由匹配，不读取、不持久化用户的 API Key。
  // 注意：用【原始 endpoint】匹配，因为用户可能填的是完整 URL
  // （如 https://opencode.ai/zen/v1/chat/completions），只要包含路径片段即命中。
  const zenProvider = /\/opencode\.ai\/zen(\/|$)/i.test(customEndpoint) ? PROVIDERS['opencode-zen'] : null;
  const activeProvider = provider || zenProvider;
  // base：用户填的自定义 endpoint 的处理——
  // ⚠️ 2026-09 调整：前端已移除「自动补全 /chat/completions」，用户填的 URL 被视为
  // 【完整请求地址】，后端【原样使用，绝不追加任何路径】。
  // 理由：自定义模型端点可能是任意 OpenAI 兼容网关（/api/v1/chat、/completions、
  // 带子路径的代理、第三方中转），若后端再硬拼 /chat/completions 会把这些地址改坏。
  // 一键接入（PRESETS）在前端就已填入完整地址（如 https://opencode.ai/zen/v1/chat/completions），
  // 用户手动填时也按「填什么请求什么」处理。仅做去尾斜杠规范化。
  const customBase = customEndpoint ? customEndpoint.replace(/\/$/, '') : '';
  const base = customBase
    ? customBase
    : (env.AI_BASE_URL || (provider && provider.baseURL) || DEFAULT_BASE).replace(/\/$/, '');
  // 前端传了自定义 key（用户自己的 DeepSeek Key）时，以它作为唯一 key；
  // 否则沿用服务端配置的 key 轮换列表。
  const customKey = String(payload.apiKey || '').trim();
  const keyList = customKey ? [customKey] : serverKeyList;
  if (!keyList.length) {
    return jsonResp({ error: '服务端未配置 AI_API_KEYS 或 AI_API_KEY' }, 500, corsHeaders);
  }
  const models = customEndpoint || customKey
    ? (String(payload.model || '').trim() ? [String(payload.model).trim()] : (activeProvider ? activeProvider.models : modelChain(env)))
    : modelChain(env);
  const errors = [];   
  const wantStream = payload.stream === true;   
  const budgetMs = numEnv(env, 'AI_BUDGET_MS', DEFAULT_BUDGET);
  const upstreamTimeout = numEnv(env, 'AI_UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT);
  const deadline = Date.now() + budgetMs;
  const remain = () => deadline - Date.now();
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
        body: JSON.stringify(buildBody(model, payload, env, wantStream, activeProvider))
      };
      const thisTimeout = Math.min(upstreamTimeout, Math.max(remain(), 1000));
      // 组装最终上游 URL：
      //   · 用户自定义 endpoint（customEndpoint）→ 已视为完整地址，原样请求；
      //   · 服务端 base（AI_BASE_URL / provider 预设 / 默认 GLM）→ 传统裸 base，补 /chat/completions。
      // 区分依据：customEndpoint 是否来自请求体。这里用「是否已含 chat 路径」做兼容判断——
      // 为保险仍保留：若 base 已以 /chat/completions 结尾则不再追加。
      const upstreamUrl = customEndpoint
        ? base
        : (/\/chat\/completions$/i.test(base) ? base : base + '/chat/completions');
      try {
        if (wantStream) {
          const r = await fetchUpstream(upstreamUrl, opts, thisTimeout);
          if (r.error) {
            errors.push(`${model}: key#${k + 1} ${r.error}`);
            maxWait = Math.max(maxWait, DEFAULT_429_WAIT);
            continue;
          }
          upstream = r.resp;
          clearTimeout(r.timer);   
          if (upstream.ok && upstream.body) {
            return { ok: true, streamResp: upstream, keyIdx: k + 1, elapsed: r.elapsed };
          }
          text = await upstream.text().catch(() => '');
        } else {
          const r = await fetchUpstreamText(upstreamUrl, opts, thisTimeout);
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
        return { fatalModel: true };      
      }
      if (st === 401) {
        errors.push(`${model}: key#${k + 1} HTTP 401`);
        continue;                          
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
        const elapsed = Date.now() - t0;
        if (r.streamResp) {
          return new Response(r.streamResp.body, {
            status: 200,
            headers: sseHeaders(corsHeaders, model, r.keyIdx, keyList.length, errors, elapsed)
          });
        }
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
        const waitMs = Math.min(r.wait * 1000, Math.max(remain(), 0));
        if (waitMs > 0) await sleep(waitMs);
      }
      if (r.exhausted) break;
    }
  }
  const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
  let payloadBytes = 0;
  try { payloadBytes = JSON.stringify(payload).length; } catch {  }
  return jsonResp({
    error: '所有模型与 API Key 均调用失败',
    tried: errors,
    models,
    elapsedMs: Date.now() - t0,
    payloadBytes,
    msgCount: payload.messages.length,
    toolCount,
    hint: '依次排查：1) 模型名是否有效（DeepSeek 当前为 deepseek-v4-flash / deepseek-v4-pro，'
      + '旧别名 deepseek-chat/deepseek-reasoner 已下线；智谱模型迭代也快，HTTP 400 即模型不存在）；'
      + '2) API Key 是否有效、额度是否用完（HTTP 401，DeepSeek 在 platform.deepseek.com 创建；'
      + 'OpenCode Zen 的 Key 在 opencode.ai/zen 控制台创建，注意不是 OpenAI 的 sk- 开头 Key）；'
      + '3) 是否触发限流（HTTP 429，各 Key 独立计数，多填几个可缓解；'
      + 'OpenCode Zen 的免费模型额度用尽后也会返回 429，可换一个免费模型或充值切按量模型）；'
      + '4) 端点是否正确——DeepSeek 官方为 https://api.deepseek.com（AI_PROVIDER=deepseek 可一键套用），'
      + '通用场景用 /api/paas/v4，Coding Plan 才是 /api/coding/paas/v4；'
      + 'OpenCode Zen 固定为 https://opencode.ai/zen/v1（注意是 /zen/v1，不是 /v1）；'
      + '5) 若大量「超时」且 payloadBytes 很大，说明请求太重导致上游慢'
      + '（可精简对话历史或减少工具数）；若 payloadBytes 很小仍超时，'
      + '则是到上游的网络不通，可调小 AI_UPSTREAM_TIMEOUT_MS 快速失败'
  }, 502, corsHeaders);
}
