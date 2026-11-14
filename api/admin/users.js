// ===== 管理员 - 用户（Auth Admin API / Postgres RPC 为唯一事实来源）=====
//
// GET /api/admin/users       用户列表：邮箱/名字/UID/注册时间/最后登录时间/站点数
// GET /api/admin/users/:uid  用户详情：Auth 用户 + 名下站点 + 汇总（SPA 详情页钻取）
//
// v2：列表由 public.admin_user_page() 在数据库内完成搜索/排序/分页/站点数聚合，
// 一次 RPC 返回当前页，不再把全量用户与全量站点搬进 Worker 内存。

import { jsonResp } from '../utils/response.js';
import {
  UUID_RE,
  requireAdmin, parseTime,
  publicUser, listUsersPage, fetchOwnerSites, siteView,
} from '../utils/admin-data.js';

/** 纯逻辑，便于无网络自测 */
export async function listAdminUsersCore(supabase, env, sp) {
  return await listUsersPage(supabase, sp);
}

/** 纯逻辑，便于无网络自测 */
export async function adminUserDetailCore(supabase, env, uid) {
  const { data, error } = await supabase.auth.admin.getUserById(uid);
  if (error) throw new Error(`Supabase Auth getUserById 失败: ${error.message || error}`);
  // supabase-js v2 返回 { data: { user } }；兼容个别版本直接返回 user
  const raw = data?.user || data;
  const user = publicUser(raw);
  if (!user?.uid) throw new Error('用户不存在');

  const rows = await fetchOwnerSites(supabase, uid);
  const owners = new Map([[uid, user]]);
  const sites = rows.map(r => siteView(r, owners, env));

  const byType = { html: 0, md: 0, project: 0 };
  let totalVisits = 0;
  let lastCreatedAt = null;
  for (const s of sites) {
    const t = byType[s.type] === undefined ? 'html' : s.type;
    byType[t] = (byType[t] || 0) + 1;
    totalVisits += s.visitCount;
    if (!lastCreatedAt || parseTime(s.createdAt) > parseTime(lastCreatedAt)) lastCreatedAt = s.createdAt;
  }

  return {
    user,
    sites,
    summary: { siteCount: sites.length, byType, totalVisits, lastCreatedAt },
  };
}

export async function handleAdminUsers(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const sp = new URL(request.url).searchParams;
    return jsonResp(await listAdminUsersCore(makeSupabase(env), env, sp), 200, corsHeaders);
  } catch (err) {
    console.error('[admin-users] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminUserDetail(request, env, corsHeaders, uid) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  if (!uid || !UUID_RE.test(uid)) {
    return jsonResp({ error: '无效的用户 UID' }, 400, corsHeaders);
  }

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    return jsonResp(await adminUserDetailCore(makeSupabase(env), env, uid), 200, corsHeaders);
  } catch (err) {
    console.error('[admin-user-detail] failed:', uid, err.message);
    return jsonResp({ error: err.message }, err.status || 502, corsHeaders);
  }
}
