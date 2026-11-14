// ===== 管理员 - 概览统计 =====
//
// v2：public.admin_overview_stats() 一次 SQL 出全部数字 + 最近站点/用户，
// 不再「拉全量用户 + 拉全量站点 → 三轮遍历 → 排序取前 6」。

import { jsonResp } from '../utils/response.js';
import { requireAdmin, overviewStats } from '../utils/admin-data.js';

export async function adminStatsCore(supabase, env, sp = new URLSearchParams()) {
  return await overviewStats(supabase, env);
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
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}
