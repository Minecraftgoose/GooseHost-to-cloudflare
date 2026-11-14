// ===== 注册入口统一邮箱守卫 =====
//
// 合并历史上两份各自维护的硬编码黑名单：
//   api/auth/blocked-emails.js（25 条，支持子域）
//   api/auth/signup.js（478 条，只精确匹配）
// 现在唯一事实来源是 public.gh_block_rules → Workers KV 快照；
// 快照不可用时才回退到静态种子（fail-safe，防止规则加载失败导致临时邮箱全放行）。
//
// 只用于「新注册」。已有账号的封禁走 Supabase Auth 的 ban_duration，
// 两套语义不混用（用户确认口径）。

import {
  loadBlockSnapshot, compileSnapshot, matchEmail,
} from '../utils/block-rules.js';
import { recordBlockHit } from '../utils/block-audit.js';
import { isFallbackDisposable } from './disposable-domains.js';

/**
 * @returns {Promise<{allowed:boolean, error?:string, observe?:boolean, fallback?:boolean}>}
 */
export async function assertEmailAllowed(request, env, email) {
  const snap = await loadBlockSnapshot(env, request);
  const pathname = (() => { try { return new URL(request.url).pathname; } catch { return ''; } })();

  if (!snap.rules || snap.rules.length === 0) {
    // KV 未绑定 / 读失败 / 还没发布过快照：静态种子兜底
    console.warn('[email-guard] 快照为空，启用静态种子兜底');
    if (isFallbackDisposable(email)) {
      return { allowed: false, error: '暂不支持该临时邮箱，请使用真实邮箱' };
    }
    return { allowed: true, fallback: true };
  }

  const rule = matchEmail(email, compileSnapshot(snap));
  if (!rule) return { allowed: true };

  recordBlockHit(request, env, {
    rule, kind: 'email_domain', actorRaw: String(email).toLowerCase(), path: pathname,
  });

  if (rule.mode === 'block') {
    return { allowed: false, error: '暂不支持该邮箱域名，请使用真实邮箱' };
  }

  // observe：只记日志 + 审计，照常放行，方便上线前确认误伤面
  console.info('[email-guard] observe 命中:', { ruleId: rule.id, value: rule.value, path: pathname });
  return { allowed: true, observe: true };
}
