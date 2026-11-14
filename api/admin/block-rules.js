// ===== 管理员 - IP / CIDR / 邮箱后缀封锁规则 =====
//
// GET    /api/admin/block-rules?q=&kind=&page=&size=   列表
// GET    /api/admin/block-rules/hits                    最近命中日志
// POST   /api/admin/block-rules                        新增 / 编辑
// DELETE /api/admin/block-rules/:id                    删除
// POST   /api/admin/block-rules/refresh                强制重编译 KV 快照
//
// 事实来源只有 public.gh_block_rules。每次写操作成功后重新编译整包快照写入
// Workers KV（gh:block:rules:current），Worker 热路径只读这一份，不查库。
// KV 是最终一致，变更最多约 60 秒全网可见（用户已确认可接受）。

import { jsonResp } from '../utils/response.js';
import { makeSupabase } from '../utils/supabase.js';
import { requireAdmin, rpc } from '../utils/admin-data.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import {
  normalizeRule, hitsSafeList, BLOCK_SNAPSHOT_KEY, peekBlockSnapshot,
} from '../utils/block-rules.js';


/**
 * 重新编译快照并写 KV。失败一律抛错让接口返回 5xx：
 * 后台显示「已保存」但线上没生效，比保存失败更危险。
 */
async function publishSnapshot(supabase, env) {
  const snap = await rpc(supabase, 'admin_block_snapshot');
  const payload = {
    version: Number(snap?.version) || 0,
    generatedAt: snap?.generatedAt || new Date().toISOString(),
    rules: Array.isArray(snap?.rules) ? snap.rules : [],
  };
  const kv = env?.RATE_LIMIT_KV;
  if (!kv || typeof kv.put !== 'function') {
    throw new Error('RATE_LIMIT_KV 未绑定，无法发布封锁规则快照');
  }
  await kv.put(BLOCK_SNAPSHOT_KEY, JSON.stringify(payload));
  return { version: payload.version, ruleCount: payload.rules.length };
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

export async function handleAdminBlockRules(request, env, corsHeaders, subPath) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const supabase = makeSupabase(env);
  const method = request.method;

  try {
    // ---- 命中日志 ----
    if (method === 'GET' && subPath === 'hits') {
      const { data, error } = await supabase
        .from('gh_block_hits')
        .select('id, rule_id, kind, value, mode, actor, path, hit_at')
        .order('hit_at', { ascending: false })
        .limit(100);
      if (error) throw new Error('查询命中日志失败：' + error.message);
      return jsonResp({ hits: data || [] }, 200, corsHeaders);
    }

    // ---- 强制刷新快照 ----
    if (method === 'POST' && subPath === 'refresh') {
      const r = await publishSnapshot(supabase, env);
      return jsonResp({ success: true, ...r }, 200, corsHeaders);
    }

    // ---- 列表 ----
    if (method === 'GET') {
      const url = new URL(request.url);
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const kind = String(url.searchParams.get('kind') || '').trim();
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size')) || 25));
      const data = await rpc(supabase, 'admin_block_rules_page', { p_q: q, p_kind: kind, p_page: page, p_size: size });
      const snap = await peekBlockSnapshot(env);
      return jsonResp({
        items: data?.items || [],
        total: Number(data?.total) || 0,
        page, size,
        snapshot: { version: snap.version || 0, ruleCount: (snap.rules || []).length },
      }, 200, corsHeaders);
    }

    // ---- 新增 / 编辑 ----
    if (method === 'POST') {
      const body = await readBody(request);
      if (!body) return jsonResp({ error: '请求体无效' }, 400, corsHeaders);

      const norm = normalizeRule(body);
      if (norm.error) return jsonResp({ error: norm.error }, 400, corsHeaders);
      if (hitsSafeList(norm.value, norm.kind, env)) {
        return jsonResp({ error: '该 IP / 网段在 BLOCK_SAFE_IPS 白名单内，不能封锁' }, 400, corsHeaders);
      }

      const id = body.id == null ? null : Number(body.id);
      if (id != null && (!Number.isInteger(id) || id <= 0)) {
        return jsonResp({ error: '规则 ID 无效' }, 400, corsHeaders);
      }

      const row = {
        kind: norm.kind,
        value: norm.value,
        mode: norm.mode,
        note: norm.note,
        expires_at: norm.expiresAt,
        enabled: norm.enabled,
      };
      let result;
      if (id != null) {
        const q = await supabase.from('gh_block_rules').update(row).eq('id', id).select('id').maybeSingle();
        if (q.error) throw new Error('更新规则失败：' + q.error.message);
        if (!q.data) return jsonResp({ error: '规则不存在' }, 404, corsHeaders);
        result = { id, action: 'updated' };
      } else {
        row.created_by = String(env?.ADMIN_USER_IDS || '').split(',')[0].trim() || 'admin';
        const q = await supabase.from('gh_block_rules').insert(row).select('id').single();
        if (q.error) {
          if (String(q.error.code) === '23505') return jsonResp({ error: '该规则已存在' }, 409, corsHeaders);
          throw new Error('新增规则失败：' + q.error.message);
        }
        result = { id: q.data?.id, action: 'created' };
      }

      const snap = await publishSnapshot(supabase, env);
      return jsonResp({ success: true, ...result, snapshot: snap }, 200, corsHeaders);
    }

    // ---- 删除 ----
    if (method === 'DELETE' && subPath && /^\d+$/.test(subPath)) {
      const { data, error } = await supabase
        .from('gh_block_rules').delete().eq('id', Number(subPath)).select('id').maybeSingle();
      if (error) throw new Error('删除规则失败：' + error.message);
      if (!data) return jsonResp({ error: '规则不存在' }, 404, corsHeaders);
      const snap = await publishSnapshot(supabase, env);
      return jsonResp({ success: true, id: data.id, snapshot: snap }, 200, corsHeaders);
    }

    return jsonResp({ error: '不支持的操作' }, 405, corsHeaders);
  } catch (err) {
    console.error('[admin-block-rules] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/access_control.sql' } : {}) },
      err.status || 500, corsHeaders);
  }
}
