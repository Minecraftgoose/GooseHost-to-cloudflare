// ===== 管理员 - 概览统计 =====
//
// 旧实现优先调 get_site_stats RPC，RPC 不存在时退化成「按 gh_site 去重 owner」
// 当 totalUsers —— 没建站的用户永远统计不到。现在用户数来自 Auth Admin API。

import { jsonResp } from '../utils/response.js';
import {
  requireAdmin, getAllAuthUsers, getAllSiteRows, ownerIndex, siteView,
  publicUser, countByOwner, parseTime, todayStartCST,
} from '../utils/admin-data.js';

export async function adminStatsCore(supabase, env, sp = new URLSearchParams()) {
  const force = sp.get('refresh') === '1';
  const [auth, siteData] = await Promise.all([
    getAllAuthUsers(supabase, env, { force }),
    getAllSiteRows(supabase, env, { force }),
  ]);

  const owners = ownerIndex(auth.users);
  const counts = countByOwner(siteData.rows);
  const today = todayStartCST();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  const byType = { html: 0, md: 0, project: 0 };
  let totalVisits = 0;
  let sitesToday = 0;
  for (const s of siteData.rows) {
    const t = byType[s.type] === undefined ? 'html' : s.type;
    byType[t] = (byType[t] || 0) + 1;
    totalVisits += Number(s.visit_count) || 0;
    if (parseTime(s.created_at) >= today) sitesToday++;
  }

  let usersToday = 0;
  let activeUsers7d = 0;
  for (const u of auth.users) {
    if (parseTime(u.created_at) >= today) usersToday++;
    if (parseTime(u.last_sign_in_at) >= weekAgo) activeUsers7d++;
  }

  const recentSites = siteData.rows.slice(0, 6).map(r => siteView(r, owners, env));
  const recentUsers = [...auth.users]
    .sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at))
    .slice(0, 6)
    .map(u => ({ ...publicUser(u), siteCount: counts.get(u.id) || 0 }));

  return {
    totalSites: siteData.rows.length,
    totalUsers: auth.users.length,
    sitesToday,
    usersToday,
    activeUsers7d,
    totalVisits,
    byType,
    recentSites,
    recentUsers,
    meta: {
      source: 'supabase-auth-admin + gh_site',
      usersTruncated: auth.truncated,
      sitesTruncated: siteData.truncated,
      cached: auth.cached && siteData.cached,
    },
  };
}

export async function handleAdminStats(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const sp = new URL(request.url).searchParams;
    return jsonResp(await adminStatsCore(makeSupabase(env), env, sp), 200, corsHeaders);
  } catch (err) {
    console.error('[admin-stats] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
