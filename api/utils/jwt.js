// ===== JWT / 凭证工具 =====
//
// 性能：旧版每个需认证请求都串行 fetch /auth/v1/user 验会话，
// 对「一次简单 select」的接口，这次跨网往返比业务查询本身还贵。
// 现在把校验结果按 token 的 SHA-256 短时复用（默认 20s）：
//   · 仍是 Supabase 官方在线校验，用户被删除/封禁后最多 20s 生效，
//     不改成纯本地验签 —— 那样旧 token 会一直活到 exp，安全语义会退化；
//   · 缓存里只存 uid 与到期时间，不存 token 明文，key 是哈希；
//   · JWT_VERIFY_CACHE_TTL=0 可一键关闭缓存，回到「每请求严格在线校验」。
// 冷启动 / 跨实例只是多一次校验，不会像全量数据缓存那样造成不一致。

import { resolveApiKey, isApiKeyFormat } from './apikey.js';

const VERIFY_CACHE_DEFAULT_MS = 20_000;
const VERIFY_CACHE_MAX = 4000;
const verifyCache = new Map();   // sha256(token) -> { sub, until }

function verifyTtl(env) {
  const raw = env?.JWT_VERIFY_CACHE_TTL;
  if (raw === undefined || raw === null || raw === '') return VERIFY_CACHE_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300_000) : VERIFY_CACHE_DEFAULT_MS;
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function pruneVerifyCache(now) {
  if (verifyCache.size <= VERIFY_CACHE_MAX) return;
  for (const [k, v] of verifyCache) {
    if (v.until <= now) verifyCache.delete(k);
  }
  // 仍超上限（全是未过期）：丢掉最早的一批，避免无界增长
  if (verifyCache.size > VERIFY_CACHE_MAX) {
    let n = verifyCache.size - VERIFY_CACHE_MAX;
    for (const k of verifyCache.keys()) {
      verifyCache.delete(k);
      if (--n <= 0) break;
    }
  }
}

function decodeJWTPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(b64 + pad);
    return JSON.parse(new TextDecoder().decode(new Uint8Array([...binary].map(c => c.charCodeAt(0)))));
  } catch { return null; }
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.substring(7).trim();
}

/** 本次请求是否使用 API Key 认证（而非登录会话 JWT） */
function isApiKeyRequest(request) {
  const t = bearerToken(request);
  return !!(t && isApiKeyFormat(t));
}

/**
 * 从请求中解析出用户 ID。
 *
 * 两条路径：
 *   · gooseh- 前缀 → 查 KV 里的 API Key（长期凭证，不参与 refresh 轮换，适合 CLI）
 *   · 其它         → 走 Supabase /auth/v1/user 校验会话 JWT
 *
 * 这样设计的好处：所有已存在的业务路由无需改动，
 * 只要它们调用 getUserId 就自动支持 API Key。
 */
async function getUserId(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  // ---- 路径 1：API Key ----
  if (isApiKeyFormat(token)) {
    const rec = await resolveApiKey(token, env);
    return rec ? rec.userId : null;
  }

  // ---- 路径 2：Supabase 会话 JWT（在线校验 + 短时结果复用） ----
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!supabaseUrl) {
    return decodeJWTPayload(token)?.sub || null;
  }

  const ttl = verifyTtl(env);
  let key = null;
  if (ttl > 0) {
    try {
      key = await tokenHash(token);
      const hit = verifyCache.get(key);
      if (hit && Date.now() < hit.until) return hit.sub;
    } catch { /* crypto 不可用时退化为不缓存 */ }
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': env.SUPABASE_ANON_KEY || '',
        'Authorization': `Bearer ${token}`
      }
    });
    if (!res.ok) {
      console.error('Auth verify failed:', res.status, await res.text().catch(()=>''));
      if (key) verifyCache.delete(key);
      return null;
    }
    const user = await res.json();
    const sub = user.id || null;
    if (key && sub && ttl > 0) {
      const now = Date.now();
      verifyCache.set(key, { sub, until: now + ttl });
      pruneVerifyCache(now);
    }
    return sub;
  } catch (e) {
    console.error('Auth verify error:', e.message);
    return null;
  }
}

async function isAdmin(request, env) {
  const userId = await getUserId(request, env);
  if (!userId) return false;
  const adminIds = (env.ADMIN_USER_IDS || '').split(',').filter(Boolean);
  return adminIds.includes(userId);
}

function isValidSlug(slug) {
  return slug?.length >= 1 && slug.length <= 64 && /^[a-zA-Z0-9_\-.~]+$/.test(slug);
}

export { decodeJWTPayload, getUserId, isAdmin, isValidSlug, isApiKeyRequest, bearerToken };
