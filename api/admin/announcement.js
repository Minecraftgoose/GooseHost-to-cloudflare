// ===== 公告 =====

import { jsonResp } from '../utils/response.js';
import { makeSupabase } from '../utils/supabase.js';
import { requireAdmin } from '../utils/admin-data.js';

// GET /api/announcement - 公开：当前生效公告
export async function handleGetAnnouncement(request, env, corsHeaders) {
  try {
    const supabase = makeSupabase(env);
    const { data, error } = await supabase
      .from('gh_announcement')
      .select('content, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResp({ announcement: null }, 200, corsHeaders);
    return jsonResp({ announcement: data.content, created_at: data.created_at }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}

// GET /api/admin/announcement - 管理员：当前公告 + 最近历史
export async function handleAdminGetAnnouncement(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  try {
    const supabase = makeSupabase(env);
    const { data, error } = await supabase
      .from('gh_announcement')
      .select('id, content, is_active, created_at')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    const current = (data || []).find(r => r.is_active) || null;
    return jsonResp({ announcement: current, history: data || [] }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}

// POST /api/admin/announcement - 发布 / 清除
// body: { action: 'set' | 'clear', content?: string }
export async function handleAdminAnnouncement(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch {
    return jsonResp({ error: '请求体无效' }, 400, corsHeaders);
  }

  const action = body?.action || 'set';
  const supabase = makeSupabase(env);

  try {
    if (action === 'clear') {
      const { error } = await supabase
        .from('gh_announcement').update({ is_active: false }).eq('is_active', true);
      if (error) throw error;
      return jsonResp({ success: true, message: '公告已清除' }, 200, corsHeaders);
    }

    const content = String(body?.content || '').trim();
    if (!content) return jsonResp({ error: '公告内容不能为空' }, 400, corsHeaders);
    if (content.length > 500) return jsonResp({ error: '公告内容超过 500 字符' }, 400, corsHeaders);

    const { error: deactivateErr } = await supabase
      .from('gh_announcement').update({ is_active: false }).eq('is_active', true);
    if (deactivateErr) throw deactivateErr;

    const { data, error } = await supabase
      .from('gh_announcement')
      .insert({ content, is_active: true })
      .select('id, content, created_at')
      .single();
    if (error) throw error;
    return jsonResp({ success: true, announcement: data }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-announcement] failed:', err.message);
    return jsonResp({ error: err.message }, 502, corsHeaders);
  }
}
