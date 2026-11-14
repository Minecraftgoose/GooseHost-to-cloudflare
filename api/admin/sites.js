// ===== 管理员 - 站点列表 =====
//
// v2：public.admin_site_page() 在数据库内 JOIN auth.users 出所有者，
// 并完成类型/所有者/关键词过滤、排序、分页与总数统计，一次 RPC 返回当前页。
// 不再为补所有者邮箱而拉全量 Auth 用户，也不再拉全量 gh_site 在内存里排序。

import { jsonResp } from '../utils/response.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { requireAdmin, listSitesPage } from '../utils/admin-data.js';

export async function listAdminSitesCore(supabase, env, sp) {
  return await listSitesPage(supabase, env, sp);
}

export async function handleAdminSites(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const sp = new URL(request.url).searchParams;
    return jsonResp(await listAdminSitesCore(makeSupabase(env), env, sp), 200, corsHeaders);
  } catch (err) {
    console.error('[admin-sites] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}
