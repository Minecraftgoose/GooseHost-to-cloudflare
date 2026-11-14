// ===== 代理注册 =====
//
// 历史版本在这里硬编码了 478 个临时邮箱域名（只精确匹配），与
// auth/blocked-emails.js 的 25 条（支持子域）各自维护、口径不一致。
// 现已统一到 public.gh_block_rules → KV 快照，见 auth/email-guard.js。
//
// 顺带补上原先缺失的注册限流：这个入口此前完全没有 checkRateLimit，
// 等于给 /api/register 的 reg_ip 额度留了个绕过后门。

import { jsonResp } from '../utils/response.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { assertEmailAllowed } from './email-guard.js';

export async function handleSignup(request, env, corsHeaders) {
  const rl = await checkRateLimit(request, env, 'reg_ip');
  if (!rl.allowed) {
    return jsonResp({ error: '注册过于频繁，请稍后再试' }, 429, corsHeaders);
  }

  try {
    const { email, password } = await request.json();

    if (!email || !password || password.length < 6) {
      return jsonResp({ error: '邮箱或密码格式不正确' }, 400, corsHeaders);
    }

    const normalized = String(email).trim().toLowerCase();
    const domain = (normalized.split('@')[1] || '').toLowerCase();
    if (!domain) {
      return jsonResp({ error: '邮箱格式错误' }, 400, corsHeaders);
    }

    // 统一守卫（含 observe 模式与命中审计）
    const guard = await assertEmailAllowed(request, env, normalized);
    if (!guard.allowed) {
      return jsonResp({ error: guard.error }, 400, corsHeaders);
    }

    // MX 有效性检查：与黑名单是两回事，保留；DNS 失败时静默放行（不阻断注册）
    try {
      const mxRes = await fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
        headers: { 'accept': 'application/dns-json' },
        cf: { cacheTtl: 3600 }
      });
      const mxData = await mxRes.json();
      const hasMX = mxData.Status === 0 && Array.isArray(mxData.Answer) && mxData.Answer.some(a => a.type === 15);
      if (!hasMX) {
        return jsonResp({ error: '邮箱域名无效，请检查拼写' }, 400, corsHeaders);
      }
    } catch { /* DNS 服务不可用时不影响注册 */ }

    const supabaseRes = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: normalized, password, redirect_to: 'https://host.goose.cc.cd/login.html' })
    });
    const supabaseData = await supabaseRes.json();

    if (!supabaseRes.ok) {
      return jsonResp({ error: supabaseData.msg || supabaseData.message || '注册失败' }, 400, corsHeaders);
    }

    return jsonResp({ success: true, message: '验证邮件发给你了，请查收' }, 200, corsHeaders);
  } catch {
    return jsonResp({ error: '服务器错误' }, 500, corsHeaders);
  }
}
