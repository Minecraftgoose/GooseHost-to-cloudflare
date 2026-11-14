// ===== 速率限制（v2）=====
//
// 分层（用户确认「长窗口按方案 B」）：
//   短窗口 10/60s → Cloudflare Workers Rate Limiting binding，边缘计数、零跨网 RTT
//   长窗口 3600s + create 的 600s lockout → Postgres 原子滑动窗口 RPC
//   binding 未绑定 / 调用异常 → 自动降级到同一个 SQL RPC，绝不静默全放行
//
// 旧版三个真问题，本版全部修掉：
//   ① KV 同一 key 每秒仅 1 次写，高频同 IP 计数严重偏低 → 改用 DB 原子 INSERT/COUNT
//   ② get + put 非原子，并发互相覆盖 → SQL 里读改写在一个事务内完成
//   ③ 旧版用空 catch 块把 KV 故障/配额耗尽全吞掉直接放行 → 现在降级 + 结构化日志 + degraded 标记
//
// 隐私：传给数据库的 dim 是 SHA-256 摘要，不落明文 IP / 邮箱。

import { getClientIp } from './block-rules.js';

export const RATE_LIMIT = {
  rapid:  { limit: 10, windowSec: 10 },
  create: { limit: 2,  windowSec: 60, lockoutSec: 600 },
  reg_ip: { limit: 5,  windowSec: 3600 },
  update: { limit: 10, windowSec: 60 },
  normal: { limit: 100, windowSec: 60 },
  login:  { limit: 20, windowSec: 60 },
  forgot_ip:    { limit: 5,  windowSec: 3600 },
  forgot_email: { limit: 3,  windowSec: 3600 },
  reset:        { limit: 10, windowSec: 3600 },
  me_update:    { limit: 20, windowSec: 60 },
  delete_acct:  { limit: 3,  windowSec: 3600 },
  play_write:   { limit: 40, windowSec: 60 },
  play_comment: { limit: 20, windowSec: 60 },
  token_manage: { limit: 10, windowSec: 60 },
};

// wrangler.toml 里的 [[ratelimits]] 绑定名。同一 namespace 内不同 action 用
// `${action}:${dim}` 作 key 隔开，互不串计数；不同 limit 必须不同 namespace。
const SHORT_BINDING = Object.freeze({
  rapid:        'RL_10_10',
  update:       'RL_10_60',
  token_manage: 'RL_10_60',
  normal:       'RL_100_60',
  login:        'RL_20_60',
  me_update:    'RL_20_60',
  play_comment: 'RL_20_60',
  play_write:   'RL_40_60',
});

// 长窗口 / 带 lockout 的档位走 SQL：binding 的 period 只支持 10 / 60 秒。
const LONG_ACTIONS = new Set([
  'reg_ip', 'create', 'forgot_ip', 'forgot_email', 'reset', 'delete_acct',
]);

export const RATE_LIMIT_V2 = Object.freeze({
  shortBindings: SHORT_BINDING,
  longActions: LONG_ACTIONS,
});

/** 兼容旧调用方；现在只认 CF-Connecting-IP，不接受可伪造的 X-Forwarded-For */
function getClientIP(request) {
  return getClientIp(request) || 'unknown';
}

async function hashDim(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

/** 直接 POST RPC，避免把 @supabase/supabase-js 拖进基础限流链路 */
async function callRateRpc(env, args) {
  const base = String(env?.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env?.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');

  const res = await fetch(`${base}/rest/v1/rpc/admin_rate_check`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`admin_rate_check HTTP ${res.status}: ${detail.slice(0, 160)}`);
  }
  const data = await res.json();
  if (!data || typeof data.allowed !== 'boolean') {
    throw new Error('admin_rate_check 返回格式异常');
  }
  return data;
}

/**
 * SQL 滑动窗口检查（长窗口主路径，也是 binding 缺失时的降级路径）。
 */
async function checkBySql(env, action, dim, cfg) {
  const hashed = await hashDim(`${action}:${dim}`);
  const data = await callRateRpc(env, {
    p_action: action,
    p_dim: hashed,
    p_limit: cfg.limit,
    p_window_sec: cfg.windowSec,
    p_lockout_sec: cfg.lockoutSec || 0,
  });
  return {
    allowed: data.allowed,
    resetIn: Number(data.resetIn) || cfg.windowSec,
    locked: !!data.locked,
    count: Number(data.count) || 0,
    source: 'sql',
  };
}

/**
 * Workers Rate Limiting binding（短窗口主路径）。
 * key 用稳定标识：已传 keyExtra（如邮箱）优先，否则退到 IP。
 * 官方不推荐纯 IP 作 key（NAT 共享），但注册/登录等匿名入口只能按 IP；
 * 这里的 key 都带 action 前缀，不会把不同接口的计数混在一起。
 */
async function checkByBinding(env, action, bindingName, dim) {
  const binding = env?.[bindingName];
  if (!binding || typeof binding.limit !== 'function') return null;
  const key = `${action}:${dim}`;
  const r = await binding.limit({ key });
  if (!r || typeof r.success !== 'boolean') {
    throw new Error(`${bindingName} 返回格式异常`);
  }
  if (r.success) return { allowed: true, resetIn: 0, locked: false, source: 'binding' };
  return { allowed: false, resetIn: 60, locked: false, source: 'binding' };
}

/**
 * @returns {Promise<{allowed:boolean, resetIn?:number, locked?:boolean, degraded?:boolean, source?:string}>}
 * 调用方签名与旧版完全一致，14 个调用点无需改动。
 */
async function checkRateLimit(request, env, action = 'normal', keyExtra = null) {
  const cfg = RATE_LIMIT[action] || RATE_LIMIT.normal;
  const dim = keyExtra ? String(keyExtra).trim().toLowerCase() : getClientIP(request);
  const bindingName = SHORT_BINDING[action];

  // 长窗口 / 带 lockout：直接走 SQL，binding 的 period 装不下 3600s
  if (LONG_ACTIONS.has(action)) {
    try {
      return await checkBySql(env, action, dim, cfg);
    } catch (err) {
      console.error('[rate-limit] SQL 检查失败（本次放行，需排查）:',
        { action, reason: err?.message || String(err) });
      return { allowed: true, degraded: true, source: 'sql-fail-open' };
    }
  }

  // 短窗口：优先 binding
  if (bindingName) {
    try {
      const r = await checkByBinding(env, action, bindingName, dim);
      if (r) return r;
      console.warn('[rate-limit] binding 未绑定，降级到 SQL:', { action, bindingName });
    } catch (err) {
      console.error('[rate-limit] binding 调用失败，降级到 SQL:',
        { action, bindingName, reason: err?.message || String(err) });
    }
  }

  // 降级：SQL 也能做 10/60s 窗口，只是多一跳跨网；高频档退化时会写日志告警
  try {
    const r = await checkBySql(env, action, dim, cfg);
    return { ...r, source: 'sql-fallback', degraded: true };
  } catch (err) {
    console.error('[rate-limit] 降级也失败（本次放行，需排查）:',
      { action, reason: err?.message || String(err) });
    return { allowed: true, degraded: true, source: 'fail-open' };
  }
}

export { getClientIP, checkRateLimit };
