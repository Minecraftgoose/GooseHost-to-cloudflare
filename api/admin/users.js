// ===== 管理员 - 用户（Auth Admin API 为唯一事实来源）=====
//
// GET /api/admin/users           用户列表：邮箱/名字/UID/注册时间/最后登录时间/站点数
// GET /api/admin/users/:uid      用户详情：Auth 用户 + 名下站点 + 汇总（供 SPA 详情页钻取）
//
// 旧实现依赖数据库 RPC get_users_paginated 与 admin/email-map.json 副本：
// RPC 不存在时退化成「只列出有站点的用户」，永远看不到没建站的用户；
// 而且拿不到 last_sign_in_at、user_metadata 昵称。现在全部走官方 Auth Admin API。

import { jsonResp } from '../utils/response.js';
import {
  UUID_RE,
  requireAdmin, pager, cleanSearch, pagePayload, parseTime,
  publicUser, getAllAuthUsers, getAllSiteRows, fetchOwnerSites,
  countByOwner, siteView,
} from '../utils/admin-data.js';

const SORT_KEYS = {
  createdAt: 'createdAt',
  lastSignInAt: 'lastSignInAt',
  email: 'email',
  name: 'name',
  siteCount: 'siteCount',
};

/** 纯逻辑，便于无网络自测 */
export async function listAdminUsersCore(supabase, env, sp) {
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const q = cleanSearch(sp.get('q')).toLowerCase();
  const sortKey = SORT_KEYS[sp.get('sort')] || 'createdAt';
  const dir = (sp.get('dir') || '').toLowerCase() === 'asc' ? 1 : -1;
  const force = sp.get('refresh') === '1';

  const [auth, sites] = await Promise.all([
    getAllAuthUsers(supabase, env, { force }),
    getAllSiteRows(supabase, env, { force }),
  ]);
  const counts = countByOwner(sites.rows);

  let users = auth.users.map(u => ({
    ...publicUser(u),
    siteCount: counts.get(u.id) || 0,
  }));

  if (q) {
    users = users.filter(u =>
      u.email.toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q) ||
      u.uid.toLowerCase().includes(q) ||
      u.provider.toLowerCase().includes(q)
    );
  }

  users.sort((a, b) => {
    let av, bv;
    if (sortKey === 'createdAt' || sortKey === 'lastSignInAt') {
      av = parseTime(a[sortKey]); bv = parseTime(b[sortKey]);
    } else if (sortKey === 'siteCount') {
      av = a.siteCount; bv = b.siteCount;
    } else {
      av = String(a[sortKey] || '').toLowerCase();
      bv = String(b[sortKey] || '').toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.uid).localeCompare(String(b.uid));
  });

  const total = users.length;
  const slice = users.slice(offset, offset + limit);

  return {
    users: slice,
    pagination: pagePayload({ page, limit, offset }, total, slice.length),
    meta: {
      source: 'supabase-auth-admin',
      usersTruncated: auth.truncated,
      sitesTruncated: sites.truncated,
      cached: auth.cached && sites.cached,
    },
  };
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
    const data = await listAdminUsersCore(makeSupabase(env), env, sp);
    return jsonResp(data, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-users] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
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
    const data = await adminUserDetailCore(makeSupabase(env), env, uid);
    return jsonResp(data, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-user-detail] failed:', uid, err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
