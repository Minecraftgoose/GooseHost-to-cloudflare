// ===== 管理员 - 用户列表=====

import { isAdmin } from '../utils/jwt.js';
import { makeSupabase } from '../utils/supabase.js';
import { fetchEmailMap } from '../utils/email-map.js';
import { jsonResp } from '../utils/response.js';
import { getPublicBaseUrl } from '../utils/site-url.js';

function buildSiteUrl(s) {
  if (s.type === 'md') {
    return `/md/${encodeURIComponent(s.name)}`;
  } else if (s.type === 'project') {
    return `/p/${encodeURIComponent(s.name)}`;
  } else {
    return `/s/${encodeURIComponent(s.name)}`;
  }
}

export async function handleAdminUsers(request, env, corsHeaders) {
  if (!await isAdmin(request, env)) {
    return jsonResp({ error: 'Admin only' }, 403, corsHeaders);
  }

  const urlParams = new URL(request.url).searchParams;
  const limit = Math.min(100, Math.max(1, parseInt(urlParams.get('limit')) || 50));
  const offsetParam = urlParams.get('offset');
  const offset = offsetParam !== null
    ? Math.max(0, parseInt(offsetParam) || 0)
    : (Math.max(1, parseInt(urlParams.get('page')) || 1) - 1) * limit;
  const page = Math.floor(offset / limit) + 1;

  try {
    const supabase = makeSupabase(env);
    const emailMap = await fetchEmailMap(env);

    const { data, error } = await supabase
      .rpc('get_users_paginated', { p_limit: limit, p_offset: offset });

    if (error) {
      console.error('RPC get_users_paginated failed, falling back:', error.message);
      
      const { data: allSites, error: sitesError } = await supabase
        .from('gh_site')
        .select('owner_id, name, created_at')
        .order('created_at', { ascending: false });

      if (sitesError) {
        return jsonResp({ error: 'DB error: ' + sitesError.message }, 500, corsHeaders);
      }

      const owners = {};
      const ownerOrder = [];

      allSites?.forEach(s => {
        if (!owners[s.owner_id]) {
          owners[s.owner_id] = {
            id: s.owner_id,
            email: emailMap[s.owner_id] || s.owner_id,
            siteCount: 0,
            sites: [],
            createdAt: s.created_at,
          };
          ownerOrder.push(s.owner_id);
        }
        owners[s.owner_id].sites.push({ 
          name: s.name, 
          url: `${getPublicBaseUrl(env)}${buildSiteUrl(s.name)}` 
        });
        owners[s.owner_id].siteCount++;
        if (new Date(s.created_at) < new Date(owners[s.owner_id].createdAt)) {
          owners[s.owner_id].createdAt = s.created_at;
        }
      });

      const all = ownerOrder.map(id => owners[id]);

      return jsonResp({
        users: all.slice(offset, offset + limit),
        pagination: { page, limit, total: all.length, hasMore: offset + limit < all.length }
      }, 200, corsHeaders);
    }

    const rows = data || [];

    // 修复分页总数：之前 map 后的对象里没有 total_count 字段，
    // `users[0]?.total_count` 恒为 undefined → 退化成 users.length（= 每页条数 50），
    // 于是 total 永远等于一页大小，66 个用户也只显示 50 条且没有第 2 页。
    // 现在先把 RPC 返回的 total_count 透传出来，再单独取总数并剔除，避免污染用户对象。
    const users = rows.map(row => ({
      id: row.owner_id,
      email: row.email,
      siteCount: parseInt(row.site_count),
      createdAt: row.created_at,
      totalCount: parseInt(row.total_count ?? row.total ?? row.full_count, 10),
      sites: (row.sites || []).map(s => ({
        name: s.name,
        type: s.type,
        url: `${getPublicBaseUrl(env)}${buildSiteUrl(s)}`
      }))
    }));

    const firstTotal = users.length > 0 ? users[0].totalCount : NaN;
    let totalCount = Number.isFinite(firstTotal) && firstTotal > 0 ? firstTotal : 0;

    // 兜底：RPC 没返回 total_count 时，按「本页是否已满」保守估算，
    // 保证至少还能翻到下一页，不会把总数锁死在一页大小上。
    if (!totalCount) {
      totalCount = offset + users.length + (users.length >= limit ? 1 : 0);
    }

    users.forEach(u => delete u.totalCount);

    return jsonResp({
      users,
      pagination: {
        page,
        limit,
        total: totalCount,
        hasMore: offset + users.length < totalCount
      }
    }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}