// ===== 管理员 - 删除用户及站点 =====
//
// 具体动作已抽到 api/utils/admin-actions.js，单项接口与批量接口共用同一份实现，
// 不会再出现「列表删一套、批量删另一套」的分叉。
// 新增自保：禁止删除当前登录的管理员账号。

import { jsonResp } from '../utils/response.js';
import { requireAdminContext, UUID_RE } from '../utils/admin-data.js';
import { deleteSiteCore, deleteUserCore } from '../utils/admin-actions.js';

const SELF_BLOCK = '不能删除当前登录的管理员账号';

// 删除单个站点（管理员）
export async function handleAdminDeleteSite(request, env, corsHeaders) {
  const { denied } = await requireAdminContext(request, env, corsHeaders);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch {
    return jsonResp({ error: '请求体无效' }, 400, corsHeaders);
  }
  const siteName = String(body?.siteName || body?.slug || '').trim();
  if (!siteName) return jsonResp({ error: 'Missing siteName' }, 400, corsHeaders);

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const r = await deleteSiteCore(makeSupabase(env), env, siteName);
    return jsonResp({ success: true, ...r }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-delete-site] failed:', siteName, err.message);
    return jsonResp({ error: err.message }, err.status || 500, corsHeaders);
  }
}

// 删除用户及其全部站点（管理员）
// POST 走 body.userId，DELETE /api/admin/user/:userId 走路径参数
export async function handleAdminDeleteUser(request, env, corsHeaders, fallbackUserId) {
  const { denied, adminId } = await requireAdminContext(request, env, corsHeaders);
  if (denied) return denied;

  let body = null;
  try { body = await request.json(); } catch { /* 允许无 body 的 DELETE */ }
  const targetUserId = String(body?.userId || fallbackUserId || '').trim();

  if (!targetUserId) return jsonResp({ error: 'Missing userId' }, 400, corsHeaders);
  if (!UUID_RE.test(targetUserId)) return jsonResp({ error: '无效的用户ID格式' }, 400, corsHeaders);
  if (targetUserId === adminId) return jsonResp({ error: SELF_BLOCK }, 403, corsHeaders);

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const r = await deleteUserCore(makeSupabase(env), env, targetUserId);
    return jsonResp({ success: true, userId: targetUserId, ...r }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-delete-user] failed:', targetUserId, err.message);
    return jsonResp({ error: err.message, partial: true }, err.status || 500, corsHeaders);
  }
}
