// ===== 管理员动作核心（单项 / 批量共用，避免逻辑分叉）=====
//
// 封禁依据 Supabase 官方 Auth Admin API：
//   https://supabase.com/docs/reference/javascript/auth-api-updateuserbyid
//     updateUserById(uid, { ban_duration: '876000h' })  → 封禁（官方「100 年」示例）
//     updateUserById(uid, { ban_duration: 'none' })     → 解封
//   duration 采用 Go 时长格式：ns / us / ms / s / m / h。
//   该方法只能在服务端用 service_role key 调用。
//   banned_until 会写进 auth.users，用户对象里可读到。
//
// 重要局限（官方/社区一致）：封禁只阻止**新登录与令牌刷新**，已经签发出去的
// access token 仍可用到自身过期。signOut(jwt, 'global') 需要该用户的有效 JWT，
// 管理员手里没有，因此这里不做「假装立即踢下线」的动作，只在响应与 UI 里如实提示。
// 若要真正即时生效，需缩短 JWT_EXPIRY 或在 RLS / 业务层检查 banned_until。

import { invalidateAdminCache, UUID_RE } from './admin-data.js';
import { removeSiteFiles } from './storage-cleanup.js';

/** 允许的封禁时长白名单（禁止任意字符串传给 GoTrue） */
export const BAN_DURATIONS = Object.freeze(['1h', '24h', '168h', '720h', '876000h']);
export const DEFAULT_BAN_DURATION = '876000h';

export const MAX_BATCH_USERS = 25;   // 与后台每页条数一致
export const MAX_BATCH_SITES = 50;

export function normalizeBanDuration(v) {
  return BAN_DURATIONS.includes(String(v || '')) ? String(v) : DEFAULT_BAN_DURATION;
}

/** 纯函数：批量用户参数校验，便于无网络自测 */
export function parseUserIds(raw, max = MAX_BATCH_USERS) {
  if (!Array.isArray(raw)) return { error: 'userIds 必须是数组' };
  const ids = [...new Set(raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
  if (!ids.length) return { error: '至少选择一个用户' };
  if (ids.length > max) return { error: `一次最多操作 ${max} 个用户，当前 ${ids.length} 个` };
  const bad = ids.filter(id => !UUID_RE.test(id));
  if (bad.length) return { error: '包含无效的用户 UID：' + bad.slice(0, 3).join('、') };
  return { ids };
}

/** 纯函数：批量站点名校验。名称按 gh_site.name 精确匹配，不做字符白名单（项目支持中文/多级名） */
export function parseSiteNames(raw, max = MAX_BATCH_SITES) {
  if (!Array.isArray(raw)) return { error: 'siteNames 必须是数组' };
  const names = [...new Set(raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
  if (!names.length) return { error: '至少选择一个站点' };
  if (names.length > max) return { error: `一次最多删除 ${max} 个站点，当前 ${names.length} 个` };
  const bad = names.filter(n => n.length > 128 || /[\x00-\x1f\x7f]/.test(n));
  if (bad.length) return { error: '包含无效的站点名称' };
  return { names };
}

/**
 * 删除单个站点：先清 Storage 文件，成功后再删 gh_site。
 * 成功返回 { name, type }；失败一律抛 Error（调用方负责转成响应或批量报告）。
 */
export async function deleteSiteCore(supabase, env, siteName) {
  const { data: site, error: fetchError } = await supabase
    .from('gh_site')
    .select('owner_id, name, type')
    .eq('name', siteName)
    .maybeSingle();

  if (fetchError) throw new Error('查询站点失败：' + fetchError.message);
  if (!site) throw Object.assign(new Error('站点不存在'), { status: 404 });

  const rmErr = await removeSiteFiles(env, supabase, site);
  if (rmErr) throw new Error(`存储文件删除失败：${rmErr.message}`);

  const { error: delError } = await supabase
    .from('gh_site')
    .delete()
    .eq('name', site.name);
  if (delError) throw new Error('删除站点记录失败：' + delError.message);

  invalidateAdminCache(env);
  return { name: site.name, type: site.type || 'html' };
}

/**
 * 删除用户及其全部站点：逐站先清文件 → 删 gh_site → 删 Auth 用户 → 同步旧邮箱映射。
 * 任一步失败即抛 Error，此时 gh_site 与 Auth 账号都还在，可重试。
 */
export async function deleteUserCore(supabase, env, targetUserId) {
  const { data: sites, error: fetchError } = await supabase
    .from('gh_site')
    .select('owner_id, name, type')
    .eq('owner_id', targetUserId);
  if (fetchError) throw new Error('查询用户站点失败：' + fetchError.message);

  for (const site of (sites || [])) {
    const rmErr = await removeSiteFiles(env, supabase, site);
    if (rmErr) throw new Error(`站点「${site.name}」存储清理失败：${rmErr.message}`);
  }

  if (sites?.length) {
    const { error: delErr } = await supabase
      .from('gh_site')
      .delete()
      .eq('owner_id', targetUserId);
    if (delErr) throw new Error('删除站点记录失败：' + delErr.message);
  }

  const { error: authError } = await supabase.auth.admin.deleteUser(targetUserId);
  if (authError) throw new Error('删除 Auth 用户失败：' + authError.message);

  // 兼容旧版 admin/email-map.json；这里动态导入，避免工具模块被测试环境
  // 拉进 @supabase/supabase-js 依赖链。失败只记日志，不影响删除结果。
  try {
    const { fetchEmailMap, saveEmailMap } = await import('./email-map.js');
    const map = await fetchEmailMap(env);
    if (map[targetUserId]) {
      delete map[targetUserId];
      await saveEmailMap(env, map);
    }
  } catch (err) {
    console.error('[admin-actions] 更新邮箱映射失败:', err.message);
  }

  invalidateAdminCache(env);
  return { deletedSites: sites?.length || 0 };
}

/** 封禁 / 解封单个用户，返回更新后的 banned_until */
export async function setUserBanCore(supabase, env, uid, action, duration) {
  const isUnban = action === 'unban';
  const banDuration = isUnban ? 'none' : normalizeBanDuration(duration);

  const { data, error } = await supabase.auth.admin.updateUserById(uid, { ban_duration: banDuration });
  if (error) throw new Error((isUnban ? '解封' : '封禁') + '失败：' + (error.message || error));

  const user = data?.user || data;
  invalidateAdminCache(env);

  return {
    action: isUnban ? 'unban' : 'ban',
    banDuration,
    bannedUntil: user?.banned_until ?? (isUnban ? null : undefined),
    note: isUnban
      ? '已解除封禁，用户可重新登录。'
      : '封禁已生效：该用户无法再登录或刷新令牌；已签发的 access token 会存活至自身过期。',
  };
}

/** 批量执行：逐项独立，任何一项失败不影响其它项；返回完整报告 */
export async function runBatch(items, worker) {
  const results = [];
  for (const id of items) {
    try {
      const extra = await worker(id);
      results.push({ id, ok: true, ...(extra && typeof extra === 'object' ? extra : {}) });
    } catch (err) {
      results.push({ id, ok: false, error: err?.message || String(err) });
    }
  }
  const succeeded = results.filter(r => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded, total: results.length };
}
