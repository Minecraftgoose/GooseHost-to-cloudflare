// ===== 管理员 - 封禁用户 / 批量操作 =====
//
// POST /api/admin/ban-user      { userId, action: 'ban'|'unban', duration }
// POST /api/admin/batch-users  { action: 'ban'|'unban'|'delete', userIds, duration }
// POST /api/admin/batch-sites  { siteNames }
//
// 批量采用「逐项独立执行 + 完整报告」：某一项失败不影响其它项，前端能逐条看到结果。
// 删除仍严格复用上一轮修复的「先删 Storage 文件、成功后再删记录」逻辑。

import { jsonResp } from '../utils/response.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { UUID_RE, requireAdminContext } from '../utils/admin-data.js';
import {
  normalizeBanDuration, parseUserIds, parseSiteNames,
  MAX_BATCH_USERS, MAX_BATCH_BAN_USERS,
  deleteUserCore, deleteSiteCore, setUserBanCore, runBatch,
} from '../utils/admin-actions.js';

const SELF_BLOCK = '不能封禁、解封或删除当前登录的管理员账号';

// 有限并发。Storage 列文件已改成「按桶聚合 + 一次 RPC」，单站请求数降到 ~4 次，
// 不再需要高并发来压延迟；并发本身不减少子请求总数，反而会让同一瞬间打满配额。
// 删用户串行（每个用户含 Auth 删除 + email-map 读写），封禁只是一次 Auth 调用可稍高。
// 单次批量上限见 admin-actions.js 的 MAX_BATCH_USERS / MAX_BATCH_SITES，
// 前端会把更大的勾选自动分块成多次 HTTP 请求。
const CONCURRENCY = { sites: 2, userDelete: 1, userBan: 4 };

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

/** 纯逻辑，便于无网络自测 */
export async function batchUsersCore(supabase, env, body, adminId) {
  const action = ['ban', 'unban', 'delete'].includes(body?.action) ? body.action : '';
  if (!action) return { status: 400, data: { error: '不支持的批量操作（仅 ban / unban / delete）' } };

  // 删除用户每个要走 Storage + 记录 + Auth + email-map，子请求多；
  // 封禁/解封只是一次 Auth 调用，可以放宽到与后台每页条数一致。
  const parsed = parseUserIds(body?.userIds,
    action === 'delete' ? MAX_BATCH_USERS : MAX_BATCH_BAN_USERS);
  if (parsed.error) return { status: 400, data: { error: parsed.error } };

  const duration = normalizeBanDuration(body?.duration);
  const worker = async (uid) => {
    if (uid === adminId) throw new Error(SELF_BLOCK);
    if (action === 'delete') return deleteUserCore(supabase, env, uid);
    return setUserBanCore(supabase, env, uid, action, duration);
  };

  const report = await runBatch(parsed.ids, worker,
    action === 'delete' ? CONCURRENCY.userDelete : CONCURRENCY.userBan);
  return {
    status: 200,
    data: {
      success: report.failed === 0,
      action,
      ...report,
      duration: action === 'delete' ? undefined : duration,
      note: action === 'ban'
        ? '封禁阻止新登录与令牌刷新；已签发的 access token 会存活至自身过期。'
        : (action === 'unban' ? '解封后用户可重新登录。' : undefined),
    },
  };
}

/** 纯逻辑，便于无网络自测 */
export async function batchSitesCore(supabase, env, body) {
  const parsed = parseSiteNames(body?.siteNames);
  if (parsed.error) return { status: 400, data: { error: parsed.error } };
  const report = await runBatch(parsed.names, (name) => deleteSiteCore(supabase, env, name), CONCURRENCY.sites);
  return {
    status: 200,
    data: { success: report.failed === 0, action: 'delete', ...report },
  };
}

export async function handleAdminBanUser(request, env, corsHeaders) {
  const { denied, adminId } = await requireAdminContext(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const body = await readBody(request);
  if (!body) return jsonResp({ error: '请求体无效' }, 400, corsHeaders);
  const uid = String(body.userId || '').trim();
  if (!UUID_RE.test(uid)) return jsonResp({ error: '无效的用户 UID' }, 400, corsHeaders);
  if (uid === adminId) return jsonResp({ error: SELF_BLOCK }, 403, corsHeaders);

  const action = body.action === 'unban' ? 'unban' : 'ban';
  const duration = normalizeBanDuration(body.duration);

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const r = await setUserBanCore(makeSupabase(env), env, uid, action, duration);
    return jsonResp({ success: true, userId: uid, ...r }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-ban-user] failed:', uid, err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}

export async function handleAdminBatchUsers(request, env, corsHeaders) {
  const { denied, adminId } = await requireAdminContext(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const body = await readBody(request);
  if (!body) return jsonResp({ error: '请求体无效' }, 400, corsHeaders);

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const { status, data } = await batchUsersCore(makeSupabase(env), env, body, adminId);
    return jsonResp(data, status, corsHeaders);
  } catch (err) {
    console.error('[admin-batch-users] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}

export async function handleAdminBatchSites(request, env, corsHeaders) {
  const { denied } = await requireAdminContext(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const body = await readBody(request);
  if (!body) return jsonResp({ error: '请求体无效' }, 400, corsHeaders);

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const { status, data } = await batchSitesCore(makeSupabase(env), env, body);
    return jsonResp(data, status, corsHeaders);
  } catch (err) {
    console.error('[admin-batch-sites] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
