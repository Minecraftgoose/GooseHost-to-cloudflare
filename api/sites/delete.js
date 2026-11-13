// ===== 删除站点 =====

import { getUserId, isValidSlug } from '../utils/jwt.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { makeSupabase } from '../utils/supabase.js';
import { jsonResp } from '../utils/response.js';
import { removeSiteFiles } from '../utils/storage-cleanup.js';
import { invalidateAdminCache } from '../utils/admin-data.js';

export async function handleDelete(request, env, corsHeaders) {
  const userId = await getUserId(request, env);
  if (!userId) return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);

  await checkRateLimit(request, env, 'normal');

  let body;
  try { body = await request.json(); } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const slug = (body?.slug || '').trim();

  // 兼容旧格式：slug 带 md/ 前缀时剥掉
  const actualSlug = slug.startsWith('md/') ? slug.replace('md/', '') : slug;

  if (!isValidSlug(actualSlug)) {
    return jsonResp({ error: '站点名称无效' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);

    // 查出完整记录：owner_id / name / type 用于反推存储路径，不信任请求体里的 slug
    const { data: site, error: fetchError } = await supabase
      .from('gh_site')
      .select('owner_id, name, type')
      .eq('name', actualSlug)
      .eq('owner_id', userId)
      .maybeSingle();

    if (fetchError || !site) {
      return jsonResp({ error: 'Site not found' }, 404, corsHeaders);
    }

    // ① 先删文件：失败就返回 500，保留 gh_site 让用户重试，不产生孤儿
    const rmErr = await removeSiteFiles(env, supabase, site);
    if (rmErr) {
      console.error('[delete] storage remove failed:', site.type, site.name, rmErr.message);
      return jsonResp({ error: '存储文件删除失败，请重试' }, 500, corsHeaders);
    }

    // ② 文件确认删干净，再删数据库记录
    const { error: delError } = await supabase
      .from('gh_site')
      .delete()
      .eq('name', site.name)
      .eq('owner_id', userId);

    if (delError) throw delError;

    invalidateAdminCache(env);
    return jsonResp({ success: true }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}
