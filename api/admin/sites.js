// ===== 管理员 - 站点列表 =====
//
// 旧实现一半走 RPC get_sites_paginated、一半走 PostgREST 拼 or 字符串，
// 搜索还要靠 email-map.json 副本反查 uid；RPC 缺失时总数、字段都会漂移。
// 现在统一：Auth Admin API 提供所有者信息 + gh_site 分页拉全量 → 内存筛选排序分页。
// 数据量上限由 admin-data.js 的 SITE_MAX_PAGES 控制（默认 5 万行）。

import { jsonResp } from '../utils/response.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import {
  UUID_RE,
  requireAdmin, pager, cleanSearch, pagePayload, parseTime,
  getAllAuthUsers, getAllSiteRows, ownerIndex, siteView,
} from '../utils/admin-data.js';

const SITE_TYPES = ['html', 'md', 'project'];
const SORT_KEYS = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  visitCount: 'visitCount',
  name: 'name',
  ownerEmail: 'ownerEmail',
};

export async function listAdminSitesCore(supabase, env, sp) {
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const q = cleanSearch(sp.get('q')).toLowerCase();
  const type = SITE_TYPES.includes(sp.get('type')) ? sp.get('type') : '';
  const ownerParam = sp.get('ownerId') || '';
  const ownerId = UUID_RE.test(ownerParam) ? ownerParam : '';
  const sortKey = SORT_KEYS[sp.get('order')] || 'updatedAt';
  const dir = (sp.get('dir') || '').toLowerCase() === 'asc' ? 1 : -1;
  const force = sp.get('refresh') === '1';

  const [auth, siteData] = await Promise.all([
    getAllAuthUsers(supabase, env, { force }),
    getAllSiteRows(supabase, env, { force }),
  ]);
  const owners = ownerIndex(auth.users);

  let sites = siteData.rows.map(r => siteView(r, owners, env));

  if (type) sites = sites.filter(s => (s.type || 'html') === type);
  if (ownerId) sites = sites.filter(s => s.ownerId === ownerId);
  if (q) {
    sites = sites.filter(s =>
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.ownerEmail || '').toLowerCase().includes(q) ||
      String(s.ownerName || '').toLowerCase().includes(q) ||
      String(s.ownerId || '').toLowerCase().includes(q) ||
      String(s.ipAddress || '').toLowerCase().includes(q) ||
      String(s.type || '').toLowerCase().includes(q)
    );
  }

  sites.sort((a, b) => {
    let av, bv;
    if (sortKey === 'createdAt' || sortKey === 'updatedAt') {
      av = parseTime(a[sortKey]); bv = parseTime(b[sortKey]);
    } else if (sortKey === 'visitCount') {
      av = a.visitCount; bv = b.visitCount;
    } else {
      av = String(a[sortKey] || '').toLowerCase();
      bv = String(b[sortKey] || '').toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.name).localeCompare(String(b.name));
  });

  const total = sites.length;
  const slice = sites.slice(offset, offset + limit);

  return {
    sites: slice,
    pagination: pagePayload({ page, limit, offset }, total, slice.length),
    meta: {
      source: 'supabase-auth-admin + gh_site',
      usersTruncated: auth.truncated,
      sitesTruncated: siteData.truncated,
      cached: auth.cached && siteData.cached,
    },
  };
}

export async function handleAdminSites(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  try {
    const { makeSupabase } = await import('../utils/supabase.js');
    const sp = new URL(request.url).searchParams;
    return jsonResp(await listAdminSitesCore(makeSupabase(env), env, sp), 200, corsHeaders);
  } catch (err) {
    console.error('[admin-sites] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
