// ===== 管理员 - 同步邮箱映射（兼容旧数据）=====
//
// 后台现在直接读 Supabase Auth，不再依赖 admin/email-map.json；
// 但 register.js / delete-user.js 等旧路径仍会写这份映射，保留同步按钮，
// 用 Auth Admin listUsers 全量分页刷新它，避免旧实现只同步默认第一页 50 人。

import { jsonResp } from '../utils/response.js';
import { makeSupabase } from '../utils/supabase.js';
import { saveEmailMap } from '../utils/email-map.js';
import { requireAdmin, getAllAuthUsers, invalidateAdminCache } from '../utils/admin-data.js';

export async function handleAdminSyncEmails(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  try {
    const supabase = makeSupabase(env);
    const { users, truncated } = await getAllAuthUsers(supabase, env, { force: true });
    const map = {};
    for (const u of users) {
      if (u?.id && u?.email) map[u.id] = u.email;
    }
    const saved = await saveEmailMap(env, map);
    if (!saved) return jsonResp({ error: '写入邮箱映射文件失败' }, 502, corsHeaders);
    invalidateAdminCache(env);
    return jsonResp({
      success: true,
      count: Object.keys(map).length,
      truncated,
      note: '后台展示已直接使用 Supabase Auth，此操作仅用于兼容旧版邮箱映射文件',
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-sync-emails] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
