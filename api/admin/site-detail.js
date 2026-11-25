// ===== 管理员 - 站点详情 / 内容更新 =====
//
// GET  /api/admin/site/:slug  元信息 + 所有者(Auth) + 内容预览 / project 文件列表
// POST /api/admin/site/:slug  更新 html / md 内容（project 请在文件级接口操作）
//
// 旧实现的 listProjectFiles() 在 Storage list 失败时静默返回空列表，
// DELETE/POST 也有多处不检查 error。这里统一：列目录失败直接 502，
// 不把「查不到」伪装成「没有文件」。

import { jsonResp } from '../utils/response.js';
import { makeSupabase, storageUrl } from '../utils/supabase.js';
import { listAllFileItems } from '../utils/storage-cleanup.js';
import {
  requireAdmin, requireWriteAdmin, publicUser, siteView, getUserBriefs,
} from '../utils/admin-data.js';

// 宽松校验：支持中文、字母、数字、_ - . ~ /，长度 1~128
function isValidSlugWithSlash(slug) {
  return !!slug && slug.length >= 1 && slug.length <= 128 && /^[\u4e00-\u9fa5a-zA-Z0-9_\-.~/]+$/.test(slug);
}

function decodeSlug(slugEncoded) {
  try { return decodeURIComponent(slugEncoded || ''); } catch { return ''; }
}

async function readText(env, path) {
  const res = await fetch(storageUrl(env, path), {
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return '';
  return await res.text();
}

export async function handleAdminSiteDetail(request, env, corsHeaders, slugEncoded) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  const slug = decodeSlug(slugEncoded);
  if (!isValidSlugWithSlash(slug)) {
    return jsonResp({ error: '站点名称无效' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);
    const { data: row, error } = await supabase
      .from('gh_site')
      .select('id, name, type, owner_id, ip_address, created_at, updated_at, visit_count')
      .eq('name', slug)
      .maybeSingle();
    if (error) throw error;
    if (!row) return jsonResp({ error: '站点不存在' }, 404, corsHeaders);

    // 所有者：优先按 uid 精确取（官方 getUserById）；失败时用一次批量 RPC 兜底。
    // 旧版在这里回退到「全量 Auth 用户扫描」，Auth 一抖动就把打开一个站点详情
    // 变成全站用户遍历，属于不可预测的延迟尖刺，已移除。
    let owner = null;
    if (row.owner_id) {
      const { data, error: authErr } = await supabase.auth.admin.getUserById(row.owner_id);
      if (!authErr) {
        const raw = data?.user || data;
        const p = publicUser(raw);
        if (p?.uid) owner = p;
      } else {
        try {
          const briefs = await getUserBriefs(supabase, [row.owner_id]);
          owner = briefs.get(row.owner_id) || null;
        } catch (e) {
          console.warn('[admin-site-detail] owner lookup failed:', e.message);
        }
      }
    }

    const owners = owner ? new Map([[owner.uid, owner]]) : new Map();
    const site = siteView(row, owners, env);
    site.owner = owner;

    if (row.type === 'project') {
      const prefix = `${row.owner_id}/${row.name}/`;
      const items = await listAllFileItems(env, 'projects', prefix);
      site.files = {
        files: items.map(i => ({ name: i.path.slice(prefix.length), size: i.size })),
        totalSize: items.reduce((n, i) => n + i.size, 0),
      };
    } else {
      const isMd = row.type === 'md';
      const fileName = isMd ? 'index.md' : 'index.html';
      const text = await readText(env, `${isMd ? 'md' : 'sites'}/${row.owner_id}/${row.name}/${fileName}`);
      site.content = { kind: isMd ? 'md' : 'html', text };
    }

    return jsonResp({ site }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-site-detail] failed:', slug, err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminSiteUpdate(request, env, corsHeaders, slugEncoded) {
  const denied = await requireWriteAdmin(request, env, corsHeaders);
  if (denied) return denied;

  const slug = decodeSlug(slugEncoded);
  if (!isValidSlugWithSlash(slug)) {
    return jsonResp({ error: '站点名称无效' }, 400, corsHeaders);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResp({ error: '请求体无效' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);
    const { data: row, error } = await supabase
      .from('gh_site')
      .select('name, type, owner_id')
      .eq('name', slug)
      .maybeSingle();
    if (error) throw error;
    if (!row) return jsonResp({ error: '站点不存在' }, 404, corsHeaders);
    if (row.type === 'project') {
      return jsonResp({ error: '多文件站点请使用文件级编辑接口 /api/proj-file/:slug/:path' }, 400, corsHeaders);
    }

    const isMd = row.type === 'md';
    const field = isMd ? 'md' : 'html';
    const content = body?.[field];
    if (content === undefined) {
      return jsonResp({ success: true, message: '没有内容需要更新' }, 200, corsHeaders);
    }
    if (typeof content !== 'string' || content.length > 500 * 1024) {
      return jsonResp({ error: '内容无效或超过 500KB' }, 400, corsHeaders);
    }

    const bucket = isMd ? 'md' : 'sites';
    const fileName = isMd ? 'index.md' : 'index.html';
    const res = await fetch(storageUrl(env, `${bucket}/${row.owner_id}/${row.name}/${fileName}`), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': isMd ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        'x-upsert': 'true',
      },
      body: content,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`文件上传失败: HTTP ${res.status} ${detail.slice(0, 160)}`);
    }

    return jsonResp({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-site-update] failed:', slug, err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}
