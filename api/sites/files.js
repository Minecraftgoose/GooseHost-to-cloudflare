// ===== 获取站点文件列表 =====
//
// 旧版在文件内自带一份 walk() 递归调用 Storage List API，且 `!res.ok` 时静默
// return 空列表 —— 既是「目录越多请求越多」的子请求炸弹，也会把「查不到」
// 伪装成「没有文件」。现在统一走 storage-cleanup.js 的数据库 RPC，
// 一次查询拿全，失败直接冒泡成 500。

import { getUserId } from '../utils/jwt.js';
import { makeSupabase } from '../utils/supabase.js';
import { jsonResp } from '../utils/response.js';
import { listAllFileItems } from '../utils/storage-cleanup.js';

export async function handleSiteFiles(request, env, corsHeaders, slug) {
  const userId = await getUserId(request, env);
  if (!userId) return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);

  const actualSlug = slug.startsWith('md/') ? slug.replace('md/', '') : slug;

  try {
    const supabase = makeSupabase(env);
    const { data: site, error: siteError } = await supabase
      .from('gh_site')
      .select('owner_id, type, name, created_at, updated_at, visit_count')
      .eq('name', actualSlug)
      .maybeSingle();

    if (siteError || !site) {
      return jsonResp({ error: 'Site not found' }, 404, corsHeaders);
    }
    if (site.owner_id !== userId) {
      return jsonResp({ error: 'Forbidden' }, 403, corsHeaders);
    }

    let files = [];
    if (site.type === 'project') {
      const prefix = `${site.owner_id}/${actualSlug}/`;
      const items = await listAllFileItems(env, 'projects', prefix);
      files = items.map(i => ({ name: i.path.slice(prefix.length), size: i.size }));
    } else {
      files = [{ name: site.type === 'md' ? 'index.md' : 'index.html', size: null }];
    }

    return jsonResp({ site, files }, 200, corsHeaders);
  } catch (err) {
    console.error('[site-files] failed:', actualSlug, err.message);
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}
