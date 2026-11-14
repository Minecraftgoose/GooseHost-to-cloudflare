// ===== 管理员 - 同步邮箱映射（兼容旧数据）=====
//
// 后台展示已直接读 Supabase Auth / Postgres RPC，不再依赖 admin/email-map.json；
// 但 register.js / delete-user.js 等旧路径仍会写这份映射，保留同步按钮。
// v2 用 public.admin_email_map() 一次 SQL 出全量 uid→email，
// 替代旧版 20 页 Auth Admin 分页接口串行遍历（低频操作，但不再制造 20 次往返）。

import { jsonResp } from '../utils/response.js';
import { makeSupabase } from '../utils/supabase.js';
import { saveEmailMap } from '../utils/email-map.js';
import { requireAdmin, emailMapFromDb } from '../utils/admin-data.js';

export async function handleAdminSyncEmails(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  try {
    const supabase = makeSupabase(env);
    const map = await emailMapFromDb(supabase);
    const saved = await saveEmailMap(env, map);
    if (!saved) return jsonResp({ error: '写入邮箱映射文件失败' }, 502, corsHeaders);
    return jsonResp({
      success: true,
      count: Object.keys(map).length,
      note: '后台展示已直接使用 Supabase Auth，此操作仅用于兼容旧版邮箱映射文件',
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-sync-emails] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}
