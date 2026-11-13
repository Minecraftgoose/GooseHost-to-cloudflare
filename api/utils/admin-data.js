// ===== 管理后台公共数据层 =====
//
// 依据 Supabase 官方文档重写，统一「用户从哪来、站点从哪来、权限怎么判」：
//
//   · Auth 用户：supabase.auth.admin.listUsers({ page, perPage }) / getUserById(uid)
//     https://supabase.com/docs/reference/javascript/auth-admin-listusers
//     https://supabase.com/docs/reference/javascript/auth-admin-getuserbyid
//     这两个方法只能在服务端用 service_role key 调用，绝不能进浏览器。
//     user 对象字段：id / email / created_at / last_sign_in_at / user_metadata /
//     app_metadata / identities / email_confirmed_at / is_anonymous / banned_until
//     https://supabase.com/docs/guides/auth/users
//   · 站点：gh_site 表（PostgREST），分页拉全量后在内存聚合，避免依赖
//     数据库里是否装了 get_users_paginated / get_sites_paginated 这类 RPC，
//     也避免为每个用户发一次 count 查询（N+1）。
//   · 旧版用 admin/email-map.json 当邮箱来源；那是一份会过期的副本。
//     现在 Auth Admin API 是唯一事实来源，email-map 只在兼容路径里保留。
//
// 注意：user_metadata 由用户可自行修改，文档明确要求「不得用于安全敏感上下文」。
// 这里只把它用于展示昵称，管理员判定依然完全依赖 isAdmin()（ADMIN_USER_IDS）。

import { isAdmin, getUserId } from './jwt.js';
import { jsonResp } from './response.js';
import { getPublicBaseUrl } from './site-url.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SITE_COLS = 'id, name, type, owner_id, ip_address, created_at, updated_at, visit_count';

const AUTH_PER_PAGE = 1000;   // 官方示例支持 perPage: 1000
const AUTH_MAX_PAGES = 20;    // 防御性上限：2 万用户，正常项目远达不到
const SITE_PER_PAGE = 1000;   // PostgREST 默认最大行数
const SITE_MAX_PAGES = 50;    // 5 万站点
const CACHE_TTL_MS = 20_000;  // Workers 实例内短缓存，削减 Auth Admin API 压力

const cache = new Map();      // key: `${SUPABASE_URL}::users|::sites`

function cacheKey(env, kind) {
  return `${env?.SUPABASE_URL || 'default'}::${kind}`;
}

function readCache(env, kind, force) {
  if (force) return null;
  const hit = cache.get(cacheKey(env, kind));
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  return null;
}

function writeCache(env, kind, value) {
  cache.set(cacheKey(env, kind), { at: Date.now(), value });
}

/** 写操作（删站/删用户/同步）后调用，保证下一次读立即看到新状态 */
export function invalidateAdminCache(env) {
  cache.delete(cacheKey(env, 'users'));
  cache.delete(cacheKey(env, 'sites'));
}

/** 统一管理员鉴权，返回 Response 表示已拒绝 */
export async function requireAdmin(request, env, corsHeaders) {
  if (!await isAdmin(request, env)) {
    return jsonResp({ error: 'Admin only' }, 403, corsHeaders);
  }
  return null;
}

/**
 * 管理员鉴权 + 返回当前操作者 UID。
 * 用于「禁止封禁/删除当前管理员自己」这类自保校验，只解析一次会话，
 * 避免 isAdmin() 与 getUserId() 各发一次 /auth/v1/user。
 */
export async function requireAdminContext(request, env, corsHeaders) {
  const adminId = await getUserId(request, env);
  const adminIds = (env?.ADMIN_USER_IDS || '').split(',').filter(Boolean);
  if (!adminId || !adminIds.includes(adminId)) {
    return { denied: jsonResp({ error: 'Admin only' }, 403, corsHeaders), adminId: null };
  }
  return { denied: null, adminId };
}

/** URL 查询参数 → 分页（page 从 1 开始，也兼容 offset） */
export function pager(sp, { defLimit = 25, maxLimit = 100 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(sp.get('limit')) || defLimit));
  const offsetRaw = sp.get('offset');
  const offset = offsetRaw !== null
    ? Math.max(0, parseInt(offsetRaw) || 0)
    : (Math.max(1, parseInt(sp.get('page')) || 1) - 1) * limit;
  return { limit, offset, page: Math.floor(offset / limit) + 1 };
}

/** 清洗搜索词：去掉 PostgREST 过滤语法与 ilike 通配符，防止用户输入变成查询语法 */
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
 * Supabase Auth User → 后台展示用对象。
 * 名字取 user_metadata.nickname（项目注册/改昵称写入的字段），兼容常见别名。
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

/** 遍历 Auth Admin listUsers 的所有分页（官方无服务端搜索/过滤，只能客户端筛） */
export async function getAllAuthUsers(supabase, env, { force = false } = {}) {
  const cached = readCache(env, 'users', force);
  if (cached) return { ...cached, cached: true };

  const users = [];
  let truncated = false;
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: AUTH_PER_PAGE });
    if (error) throw new Error(`Supabase Auth listUsers 失败: ${error.message || error}`);
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < AUTH_PER_PAGE) break;
    if (page === AUTH_MAX_PAGES) truncated = true;
  }

  const value = { users, truncated };
  writeCache(env, 'users', value);
  return { ...value, cached: false };
}

/** 分页拉全量 gh_site，避免 PostgREST 默认 1000 行截断导致统计失真 */
export async function getAllSiteRows(supabase, env, { force = false } = {}) {
  const cached = readCache(env, 'sites', force);
  if (cached) return { ...cached, cached: true };

  const rows = [];
  let truncated = false;
  for (let page = 0; page < SITE_MAX_PAGES; page++) {
    const from = page * SITE_PER_PAGE;
    const { data, error } = await supabase
      .from('gh_site')
      .select(SITE_COLS)
      .order('created_at', { ascending: false })
      .range(from, from + SITE_PER_PAGE - 1);
    if (error) throw new Error(`查询 gh_site 失败: ${error.message || error}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < SITE_PER_PAGE) break;
    if (page === SITE_MAX_PAGES - 1) truncated = true;
  }

  const value = { rows, truncated };
  writeCache(env, 'sites', value);
  return { ...value, cached: false };
}

/** 单用户站点：直接按 owner_id 查，比全量缓存更实时 */
export async function fetchOwnerSites(supabase, uid) {
  const rows = [];
  for (let page = 0; page < 10; page++) {
    const from = page * SITE_PER_PAGE;
    const { data, error } = await supabase
      .from('gh_site')
      .select(SITE_COLS)
      .eq('owner_id', uid)
      .order('created_at', { ascending: false })
      .range(from, from + SITE_PER_PAGE - 1);
    if (error) throw new Error(`查询用户站点失败: ${error.message || error}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < SITE_PER_PAGE) break;
  }
  return rows;
}

export function ownerIndex(users) {
  const map = new Map();
  for (const u of users) {
    const p = publicUser(u);
    if (p?.id) map.set(p.id, p);
  }
  return map;
}

export function countByOwner(rows) {
  const map = new Map();
  for (const s of rows) {
    if (s?.owner_id) map.set(s.owner_id, (map.get(s.owner_id) || 0) + 1);
  }
  return map;
}

export function buildSitePath(s) {
  const slug = encodeURIComponent(s.name || '');
  if (s.type === 'md') return `/md/${slug}`;
  if (s.type === 'project') return `/p/${slug}`;
  return `/s/${slug}`;
}

/** gh_site 行 → 后台展示对象（附带所有者信息，来自 Auth，不再来自 email-map 副本） */
export function siteView(s, owners, env) {
  const owner = owners?.get(s.owner_id) || null;
  return {
    id: s.id,
    name: s.name,
    type: s.type || 'html',
    ownerId: s.owner_id || '',
    ownerEmail: owner?.email || '',
    ownerName: owner?.name || '',
    ipAddress: s.ip_address || '',
    createdAt: s.created_at || null,
    updatedAt: s.updated_at || null,
    visitCount: Number(s.visit_count) || 0,
    url: `${getPublicBaseUrl(env)}${buildSitePath(s)}`,
  };
}

/** 当天 00:00（Asia/Shanghai）的毫秒时间戳 */
export function todayStartCST() {
  const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return Date.parse(`${date}T00:00:00+08:00`);
}

export function parseTime(v) {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}
