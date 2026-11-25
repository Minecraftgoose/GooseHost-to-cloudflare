// ===== 管理后台公共数据层（v2：数据库内分页 / 聚合）=====
//
// 旧版把「全部 Auth 用户 + 全部 gh_site 行」分页拉回 Worker，再在内存里
// filter / sort / slice(25)，还配了一个只在单个 isolate 内有效、被 refresh=1
// 绕过的 Map 缓存。数据量一上来就是 O(全站) 的延迟，且跨节点数据不一致。
//
// v2 的原则（不留后患）：
//   · 单一事实来源：auth.users + gh_site，不建影子表、不做数据同步；
//   · 过滤 / 排序 / 分页 / 聚合 / JOIN 全部下推到 Postgres（sql/admin_perf.sql）；
//   · 因此 Worker 端**没有任何缓存**，也就不需要 invalidate：写完立刻可读，
//     跨 Worker 实例永远一致，refresh=1 退化为无操作（仅保留参数兼容前端）；
//   · 所有 RPC 都是 SECURITY DEFINER，只暴露展示字段，权限仅授予 service_role。
//
// 需要的函数：见仓库 sql/admin_perf.sql（部署前在 Supabase SQL Editor 执行一次）。
// 若函数缺失，rpc() 会抛出带 migrationHint 的错误，handler 统一返回 503 指引，
// 而不是静默退化回全量扫描。

import { isAdmin, isWriteAdmin, getAdminRole, getUserId } from './jwt.js';
import { jsonResp } from './response.js';
import { getPublicBaseUrl } from './site-url.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SITE_COLS = 'id, name, type, owner_id, ip_address, created_at, updated_at, visit_count';

const MIGRATION_HINT = '管理后台数据库函数未安装，请在 Supabase SQL Editor 执行 sql/admin_perf.sql 后重试';
const MISSING_FN_RE = /could not find the function|function\s+public\.|does not exist|pgrst202|42883|schema cache/i;

/** 统一 RPC 调用：把「函数不存在」变成可识别、可给出指引的错误 */
export async function rpc(supabase, fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (!error) return data;

  const code = String(error.code || '');
  const msg = String(error.message || '');
  const missing = code === 'PGRST202' || code === '42883' || MISSING_FN_RE.test(msg);
  const err = new Error(missing ? MIGRATION_HINT : `数据库函数 ${fn} 调用失败: ${msg || error}`);
  err.status = missing ? 503 : 502;
  err.missingMigration = missing;
  err.rpc = fn;
  throw err;
}

const READONLY_DENIED = '只读管理员仅可查看，不能执行写操作';

/**
 * 只读接口鉴权：可写管理员 + 只读管理员都放行。
 * 所有 GET 类 admin 接口继续用它，行为与加只读角色之前完全一致。
 */
export async function requireAdmin(request, env, corsHeaders) {
  if (!await isAdmin(request, env)) {
    return jsonResp({ error: 'Admin only' }, 403, corsHeaders);
  }
  return null;
}

/**
 * 写接口鉴权：仅可写管理员放行。
 * 这是 handler 内的第二道防线；第一道是 api/index.js 管理员路由段的统一闸门。
 */
export async function requireWriteAdmin(request, env, corsHeaders) {
  if (!await isWriteAdmin(request, env)) {
    const role = await getAdminRole(request, env);
    return jsonResp({ error: role === 'readonly' ? READONLY_DENIED : 'Admin only' }, 403, corsHeaders);
  }
  return null;
}

/**
 * 写操作鉴权 + 当前操作者 UID（一次会话解析出角色与 UID，避免两次校验请求）。
 * 供需要 adminId 做「不能删自己」判断的接口使用。
 */
export async function requireWriteAdminContext(request, env, corsHeaders) {
  const role = await getAdminRole(request, env);
  if (role !== 'write') {
    const msg = role === 'readonly' ? READONLY_DENIED : 'Admin only';
    return { denied: jsonResp({ error: msg }, 403, corsHeaders), adminId: null };
  }
  // adminId 仍要拿，用于 SELF_BLOCK 自锁判断；getUserId 命中 20s 缓存，无额外网络往返
  const adminId = await getUserId(request, env);
  return { denied: null, adminId };
}

/** 兼容旧调用点：语义已收敛为「写操作专用」，等价于 requireWriteAdminContext */
export const requireAdminContext = requireWriteAdminContext;

/** URL 查询参数 → 分页（page 从 1 开始，也兼容 offset） */
export function pager(sp, { defLimit = 25, maxLimit = 100 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(sp.get('limit')) || defLimit));
  const offsetRaw = sp.get('offset');
  const offset = offsetRaw !== null
    ? Math.max(0, parseInt(offsetRaw) || 0)
    : (Math.max(1, parseInt(sp.get('page')) || 1) - 1) * limit;
  return { limit, offset, page: Math.floor(offset / limit) + 1 };
}

/** 清洗搜索词：SQL 用 position() 不会把输入当语法，这里只做长度与噪声控制 */
export function cleanSearch(q, maxLen = 64) {
  return String(q || '')
    .replace(/["'(),.*%\\:;\[\]{}<>\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function pagePayload(pagination, total, countReturned) {
  const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
  return {
    ...pagination,
    total,
    totalPages,
    hasMore: pagination.offset + countReturned < total,
  };
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Supabase Auth User → 后台展示对象（单用户详情 / briefs 复用）。
 * 名字取 user_metadata.nickname；user_metadata 用户可改，仅用于展示，
 * 管理员判定始终依赖 isAdmin() / ADMIN_USER_IDS。
 */
export function publicUser(u) {
  if (!u) return null;
  const meta = u.user_metadata || u.raw_user_meta_data || {};
  const app = u.app_metadata || {};
  const identities = Array.isArray(u.identities) ? u.identities : [];
  const providers = Array.isArray(app.providers) && app.providers.length
    ? app.providers.filter(p => typeof p === 'string')
    : identities.map(i => i?.provider).filter(Boolean);

  return {
    id: u.id || '',
    uid: u.id || '',
    email: u.email || '',
    name: firstString(meta.nickname, meta.name, meta.full_name, meta.display_name, meta.user_name, meta.preferred_username),
    avatarUrl: firstString(meta.avatar_url, meta.picture),
    createdAt: u.created_at || null,
    lastSignInAt: u.last_sign_in_at || null,
    updatedAt: u.updated_at || null,
    emailConfirmedAt: u.email_confirmed_at || null,
    confirmedAt: u.confirmed_at || null,
    isAnonymous: !!u.is_anonymous,
    bannedUntil: u.banned_until || null,
    provider: app.provider || providers[0] || (u.email ? 'email' : 'unknown'),
    providers: [...new Set(providers)],
  };
}

/** RPC 返回的用户行 → 展示对象（字段已经是扁平的） */
export function userViewFromRow(r) {
  return {
    id: r.uid || '',
    uid: r.uid || '',
    email: r.email || '',
    name: r.name || '',
    createdAt: r.created_at || null,
    lastSignInAt: r.last_sign_in_at || null,
    updatedAt: r.updated_at || null,
    emailConfirmedAt: r.email_confirmed_at || null,
    isAnonymous: !!r.is_anonymous,
    bannedUntil: r.banned_until || null,
    provider: r.provider || (r.email ? 'email' : 'unknown'),
    siteCount: Number(r.site_count) || 0,
  };
}

const USER_SORTS = ['createdAt', 'lastSignInAt', 'email', 'name', 'siteCount'];
const SITE_SORTS = ['createdAt', 'updatedAt', 'visitCount', 'name', 'ownerEmail'];
const SITE_TYPES = ['html', 'md', 'project'];

/**
 * 用户列表：一次 RPC，数据库完成搜索 / 排序 / 分页 / 站点数聚合 / 总数统计。
 * 传输量恒等于「每页条数」，与全站用户数无关。
 */
export async function listUsersPage(supabase, sp) {
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const q = cleanSearch(sp.get('q')).toLowerCase();
  const sort = USER_SORTS.includes(sp.get('sort')) ? sp.get('sort') : 'createdAt';
  const dir = (sp.get('dir') || '').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const rows = await rpc(supabase, 'admin_user_page', {
    p_q: q, p_sort: sort, p_dir: dir, p_limit: limit, p_offset: offset,
  });
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length ? Number(list[0].total_count) || 0 : 0;
  return {
    users: list.map(userViewFromRow),
    pagination: pagePayload({ page, limit, offset }, total, list.length),
    meta: { source: 'postgres-rpc', migration: 'sql/admin_perf.sql' },
  };
}

/**
 * 站点列表：一次 RPC，数据库 JOIN auth.users 出所有者，并完成全部筛选排序。
 */
export async function listSitesPage(supabase, env, sp) {
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const q = cleanSearch(sp.get('q')).toLowerCase();
  const type = SITE_TYPES.includes(sp.get('type')) ? sp.get('type') : '';
  const ownerParam = sp.get('ownerId') || '';
  const ownerId = UUID_RE.test(ownerParam) ? ownerParam : '';
  const sort = SITE_SORTS.includes(sp.get('order')) ? sp.get('order') : 'updatedAt';
  const dir = (sp.get('dir') || '').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const rows = await rpc(supabase, 'admin_site_page', {
    p_q: q, p_type: type, p_owner_id: ownerId,
    p_sort: sort, p_dir: dir, p_limit: limit, p_offset: offset,
  });
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length ? Number(list[0].total_count) || 0 : 0;
  return {
    sites: list.map(r => siteView(r, null, env)),
    pagination: pagePayload({ page, limit, offset }, total, list.length),
    meta: { source: 'postgres-rpc', migration: 'sql/admin_perf.sql' },
  };
}

/** 概览统计：一次 SQL 返回全部数字 + 最近 6 站点 / 6 用户 */
export async function overviewStats(supabase, env) {
  const rows = await rpc(supabase, 'admin_overview_stats');
  const payload = Array.isArray(rows) ? rows[0]?.payload : (rows?.payload || rows);
  if (!payload || typeof payload !== 'object') throw new Error('概览统计返回格式异常');

  // recentSites 补上前端需要的 url / ownerName 等派生字段
  const base = getPublicBaseUrl(env);
  payload.recentSites = (payload.recentSites || []).map(s => ({
    ...siteView(s, null, env),
    url: `${base}${buildSitePath(s)}`,
  }));
  payload.meta = { source: 'postgres-rpc', migration: 'sql/admin_perf.sql' };
  return payload;
}

/** 公开统计：一次聚合，替代 1 次 count + 最多 50 次分页累加 */
export async function siteTotals(supabase) {
  const rows = await rpc(supabase, 'site_totals');
  const r = Array.isArray(rows) ? rows[0] : rows;
  return {
    total_sites: Number(r?.total_sites) || 0,
    total_visits: Number(r?.total_visits) || 0,
  };
}

/** 旧版 email-map 同步：一次 SQL，替代 20 页 listUsers 全量遍历 */
export async function emailMapFromDb(supabase) {
  const rows = await rpc(supabase, 'admin_email_map');
  const payload = Array.isArray(rows) ? rows[0]?.payload : rows?.payload;
  return payload && typeof payload === 'object' ? payload : {};
}

/**
 * 按 uid 批量取用户简要信息 → Map。
 * 用于广场列表补作者邮箱、站点详情补所有者等「小集合」场景。
 * 不再为了补一页作者而拉全量 Auth 用户。
 */
export async function getUserBriefs(supabase, ids) {
  const uniq = [...new Set((ids || []).map(x => String(x || '')).filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const rows = await rpc(supabase, 'admin_user_briefs', { p_ids: uniq });
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const p = userViewFromRow(r);
    if (p.uid) map.set(p.uid, p);
  }
  return map;
}

/** 单用户站点：精确按 owner_id 查（带上限，避免极端账号拖垮请求） */
export async function fetchOwnerSites(supabase, uid) {
  const { data, error } = await supabase
    .from('gh_site')
    .select(SITE_COLS)
    .eq('owner_id', uid)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`查询用户站点失败: ${error.message || error}`);
  return data || [];
}

/** 把 Auth 用户数组转成 Map（仅用于已经拿到的**小集合**，绝不用于全量） */
export function ownerIndex(users) {
  const map = new Map();
  for (const u of users) {
    const p = publicUser(u);
    if (p?.id) map.set(p.id, p);
  }
  return map;
}

export function buildSitePath(s) {
  const slug = encodeURIComponent(s.name || '');
  if (s.type === 'md') return `/md/${slug}`;
  if (s.type === 'project') return `/p/${slug}`;
  return `/s/${slug}`;
}

/**
 * gh_site 行 / RPC 行 → 后台展示对象。
 * RPC 行自带 owner_email / owner_name；单表查询则回退到传入的 owners Map。
 */
export function siteView(s, owners, env) {
  const owner = owners?.get(s.owner_id) || null;
  const name = s.name || '';
  const type = s.type || 'html';
  return {
    id: s.id,
    name,
    type,
    ownerId: s.owner_id || s.ownerId || '',
    ownerEmail: s.owner_email || s.ownerEmail || owner?.email || '',
    ownerName: s.owner_name || s.ownerName || owner?.name || '',
    ipAddress: s.ip_address || s.ipAddress || '',
    createdAt: s.created_at || s.createdAt || null,
    updatedAt: s.updated_at || s.updatedAt || null,
    visitCount: Number(s.visit_count ?? s.visitCount) || 0,
    url: `${getPublicBaseUrl(env)}${buildSitePath({ name, type })}`,
  };
}

/** 当天 00:00（Asia/Shanghai）的毫秒时间戳 —— 仅前端展示辅助，热路径已不用 */
export function todayStartCST() {
  const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return Date.parse(`${date}T00:00:00+08:00`);
}

export function parseTime(v) {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}
