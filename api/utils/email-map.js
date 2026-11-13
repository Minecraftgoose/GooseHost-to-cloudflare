// ===== 邮箱映射管理（旧版兼容，仅保留写入/同步）=====
//
// 新后台直接读 Supabase Auth Admin API，这里只服务 register.js 与
// delete-user.js 的历史逻辑。不要用这份文件作为展示数据源：它是一份副本。

import { storageUrl, makeSupabase } from './supabase.js';

async function fetchEmailMap(env) {
  try {
    const res = await fetch(storageUrl(env, 'admin/email-map.json'), {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) return {};
    const text = await res.text();
    const map = JSON.parse(text);
    return map && typeof map === 'object' ? map : {};
  } catch { return {}; }
}

/** @returns {Promise<boolean>} 写入是否成功（旧实现吞掉所有失败） */
async function saveEmailMap(env, map) {
  try {
    const res = await fetch(storageUrl(env, 'admin/email-map.json'), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
      },
      body: JSON.stringify(map),
    });
    if (!res.ok) {
      console.error('saveEmailMap failed: HTTP', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('saveEmailMap failed:', err.message);
    return false;
  }
}

/** 兼容工具：按 Auth Admin API 分页拉全量用户重建映射 */
async function syncEmailMap(env) {
  try {
    const supabase = makeSupabase(env);
    const perPage = 1000;
    const users = [];
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const batch = data?.users || [];
      users.push(...batch);
      if (batch.length < perPage) break;
    }
    const map = {};
    users.forEach(u => { if (u?.id && u?.email) map[u.id] = u.email; });
    return await saveEmailMap(env, map) ? map : null;
  } catch (err) {
    console.error('syncEmailMap failed:', err.message);
    return null;
  }
}

export { fetchEmailMap, saveEmailMap, syncEmailMap };
