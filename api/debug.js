// ===== Debug 接口 =====

import { makeSupabase } from './utils/supabase.js';
import { saveEmailMap } from './utils/email-map.js';
import { emailMapFromDb } from './utils/admin-data.js';
import { jsonResp } from './utils/response.js';

// Service Role Key 验证的同步邮箱
// 旧实现要串行翻 20 页 Auth Admin 分页接口重建全量映射；
// 现在和后台工具页一样走 public.admin_email_map()，一次 SQL 聚合。
export async function handleDebugSyncEmails(request, env, corsHeaders) {
  const header = request.headers.get('Authorization') || '';
  if (header !== `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`) {
    return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  try {
    const map = await emailMapFromDb(makeSupabase(env));
    const saved = await saveEmailMap(env, map);
    if (!saved) {
      return jsonResp({ error: '写入邮箱映射文件失败' }, 502, corsHeaders);
    }
    return jsonResp({ success: true, count: Object.keys(map).length }, 200, corsHeaders);
  } catch (err) {
    console.error('[debug-sync-emails] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 500, corsHeaders);
  }
}

export async function handleDebugTestAuth(request, env, corsHeaders) {
  const url = new URL(request.url);
  const testId = url.searchParams.get('id') || '789c1a30-bd1d-4a4b-9c41-0e56d6ff536f';

  const supabase = makeSupabase(env);

  try {
    const r = await supabase.auth.admin.deleteUser(testId);
    return jsonResp({
      result: { message: r.error?.message, status: r.error?.status, code: r.error?.code },
      userId: testId
    }, 200, corsHeaders);
  } catch (e) {
    return jsonResp({ threw: e.message, userId: testId }, 500, corsHeaders);
  }
}
