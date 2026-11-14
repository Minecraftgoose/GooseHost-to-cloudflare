// ===== 公开统计 =====
//
// 旧实现：1 次 count + 最多 50 次 select(visit_count).range(...) 分页累加，
// 站点过千时既慢又会漏算。v2 用 public.site_totals() 一次 SQL 聚合。

import { makeSupabase } from '../utils/supabase.js';
import { siteTotals } from '../utils/admin-data.js';

function resp(data, status, corsHeaders, cache) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...(cache ? { 'Cache-Control': cache } : {}),
    },
  });
}

export async function handlePublicStats(request, env, corsHeaders) {
  try {
    const totals = await siteTotals(makeSupabase(env));
    return resp(totals, 200, corsHeaders, 'public, max-age=60');
  } catch (err) {
    console.error('[public-stats] failed:', err.message);
    return resp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 500, corsHeaders);
  }
}
