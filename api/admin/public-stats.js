// ===== 公开统计 =====
//
// 旧实现 select('visit_count') 一次性取全表，PostgREST 默认最多返回 1000 行，
// 站点过千时 total_sites / total_visits 都会停在 1000。现在分页聚合 + count exact。

import { makeSupabase } from '../utils/supabase.js';

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
    const supabase = makeSupabase(env);
    const { count, error } = await supabase
      .from('gh_site')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;

    let totalVisits = 0;
    const PAGE = 1000;
    const pages = Math.min(50, Math.ceil((count || 0) / PAGE));
    for (let p = 0; p < pages; p++) {
      const { data, error: pageErr } = await supabase
        .from('gh_site')
        .select('visit_count')
        .range(p * PAGE, (p + 1) * PAGE - 1);
      if (pageErr) throw pageErr;
      for (const r of (data || [])) totalVisits += Number(r.visit_count) || 0;
    }

    return resp({ total_sites: count || 0, total_visits: totalVisits }, 200, corsHeaders, 'public, max-age=60');
  } catch (err) {
    return resp({ error: err.message }, 500, corsHeaders);
  }
}
