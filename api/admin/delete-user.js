// ===== 管理员 - 删除用户及站点 =====

import { isAdmin } from '../utils/jwt.js';
import { makeSupabase } from '../utils/supabase.js';
import { fetchEmailMap, saveEmailMap } from '../utils/email-map.js';
import { jsonResp } from '../utils/response.js';
import { removeSiteFiles } from '../utils/storage-cleanup.js';
import { invalidateAdminCache } from '../utils/admin-data.js';

// 删除单个站点（管理员）
export async function handleAdminDeleteSite(request, env, corsHeaders) {
  if (!await isAdmin(request, env)) {
    return jsonResp({ error: 'Admin only' }, 403, corsHeaders);
  }

  let siteName;
  try {
    const body = await request.json();
    siteName = body?.siteName || body?.slug || '';
  } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }
  if (!siteName) return jsonResp({ error: 'Missing siteName' }, 400, corsHeaders);

  try {
    const supabase = makeSupabase(env);

    const { data: site, error: fetchError } = await supabase
      .from('gh_site')
      .select('owner_id, name, type')
      .eq('name', siteName)
      .maybeSingle();

    if (fetchError || !site) {
      return jsonResp({ error: '站点不存在' }, 404, corsHeaders);
    }

    // 先删文件，失败则保留记录可重试
    const rmErr = await removeSiteFiles(env, supabase, site);
    if (rmErr) {
      console.error('[admin-delete-site] storage remove failed:', site.type, site.name, rmErr.message);
      return jsonResp({ error: '存储文件删除失败，请重试' }, 500, corsHeaders);
    }

    // 再删记录
    const { error: delError } = await supabase
      .from('gh_site')
      .delete()
      .eq('name', site.name);

    if (delError) throw delError;

    invalidateAdminCache(env);
    return jsonResp({ success: true }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}

// 删除用户及其全部站点（管理员）
export async function handleAdminDeleteUser(request, env, corsHeaders, fallbackUserId) {
  if (!await isAdmin(request, env)) {
    return jsonResp({ error: 'Admin only' }, 403, corsHeaders);
  }

  // POST 走 body.userId，DELETE /api/admin/user/:userId 走路径参数
  // （旧实现两者共用 handler 但只认 body，DELETE 路由永远 400）
  let body = null;
  try { body = await request.json(); } catch { /* 允许无 body 的 DELETE */ }
  const targetUserId = body?.userId || fallbackUserId || '';

  if (!targetUserId) return jsonResp({ error: 'Missing userId' }, 400, corsHeaders);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return jsonResp({ error: '无效的用户ID格式' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);

    // 1) 查全部站点（含 type / owner_id，用于反推桶与路径）
    const { data: sites, error: fetchError } = await supabase
      .from('gh_site')
      .select('owner_id, name, type')
      .eq('owner_id', targetUserId);

    if (fetchError) {
      console.error('[admin-delete-user] 查询站点失败:', fetchError.message);
      return jsonResp({ error: '查询用户站点失败，请重试' }, 500, corsHeaders);
    }

    // 2) 先逐站清文件；任一失败立即中止，不删记录、不删账号
    for (const site of (sites || [])) {
      const rmErr = await removeSiteFiles(env, supabase, site);
      if (rmErr) {
        console.error('[admin-delete-user] storage remove failed:', site.type, site.name, rmErr.message);
        return jsonResp({
          error: `站点「${site.name}」存储清理失败，请重试`,
          partial: true
        }, 500, corsHeaders);
      }
    }

    // 3) 文件全部清完，再删 gh_site 记录
    if (sites?.length) {
      const { error: delErr } = await supabase
        .from('gh_site')
        .delete()
        .eq('owner_id', targetUserId);
      if (delErr) throw delErr;
    }

    // 4) 删 auth 用户
    const { error: authError } = await supabase.auth.admin.deleteUser(targetUserId);
    if (authError) {
      console.error('[admin-delete-user] 删除 Auth 用户失败:', authError.message);
      return jsonResp({ error: '删除 Auth 用户失败: ' + authError.message }, 500, corsHeaders);
    }

    // 5) 同步 email 映射
    try {
      const map = await fetchEmailMap(env);
      if (map[targetUserId]) {
        delete map[targetUserId];
        await saveEmailMap(env, map);
      }
    } catch (err) {
      console.error('[admin-delete-user] 更新邮箱映射失败:', err.message);
    }

    invalidateAdminCache(env);
    return jsonResp({
      success: true,
      deletedSites: sites?.length || 0,
      userId: targetUserId
    }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}
