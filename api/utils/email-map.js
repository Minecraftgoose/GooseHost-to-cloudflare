// ===== 邮箱映射管理（旧版兼容，仅保留读/写）=====
//
// 新后台直接读 Supabase Auth / Postgres RPC，这里只服务 register.js 与
// delete-user.js 的历史逻辑。不要用这份文件作为展示数据源：它是一份副本。
//
// 全量同步已移到 public.admin_email_map()（一次 SQL 聚合），
// 见 admin/sync-emails.js 与 debug.js；此处不再分页遍历 Auth Admin 接口。

import { storageUrl } from './supabase.js';

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

export { fetchEmailMap, saveEmailMap };
