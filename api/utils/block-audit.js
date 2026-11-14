// ===== 封锁命中审计 =====
//
// 命中日志统一写 public.admin_block_hit()，由 waitUntil 在响应后发出，
// 不把一跳跨网 RPC 计入被拦请求的 TTFB。actor 存哈希，不落明文 IP / 邮箱。

import { runInBackground } from './request-context.js';

async function hashActor(raw) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(raw || '')));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  } catch { return 'unknown'; }
}

export function recordBlockHit(request, env, { rule, kind, actorRaw, path }) {
  runInBackground(request, async () => {
    const base = String(env?.SUPABASE_URL || '').replace(/\/$/, '');
    const key = env?.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!base || !key) return;
    const actor = await hashActor(actorRaw);
    const res = await fetch(`${base}/rest/v1/rpc/admin_block_hit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_rule_id: rule?.id ?? null,
        p_kind: String(kind || ''),
        p_value: String(rule?.value || ''),
        p_mode: String(rule?.mode || 'observe'),
        p_actor: actor,
        p_path: String(path || '').slice(0, 200),
      }),
    });
    if (!res.ok) console.error('[block-audit] 写入失败: HTTP', res.status);
  });
}
