// ===== 黑名单（兼容层）=====
//
// 旧版这里硬编码 25 个临时邮箱域名，api/auth/signup.js 里另有一份 478 条的
// DISPOSABLE Set，两份各自维护、口径还不一样（这份支持子域，那份只精确匹配）。
//
// 现已统一到 public.gh_block_rules（SQL 迁移里 seed 了去重后的 461 条），
// 运行时由 api/auth/email-guard.js 读 Workers KV 快照判定，支持后台增删。
// 本文件只保留同步版纯函数供历史 import / 无 request 上下文的调用方使用。

import { FALLBACK_DISPOSABLE, isFallbackDisposable } from './disposable-domains.js';

export const BLOCKED_DOMAINS = Object.freeze([...FALLBACK_DISPOSABLE]);

/** 同步兜底判定；注册主链路请用 email-guard.js 的 assertEmailAllowed() */
export function isDisposableEmail(email) {
  return isFallbackDisposable(email);
}
