// ===== 注销账号 =====

import { getUserId, isApiKeyRequest } from '../utils/jwt.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import { makeSupabase } from '../utils/supabase.js';
import { jsonResp } from '../utils/response.js';
import { removeSitesFiles } from '../utils/storage-cleanup.js';
// 无 Worker 端缓存：删完库里立刻可读，不需要任何失效动作。

export async function handleDeleteAccount(request, env, corsHeaders) {
  // 销号是不可逆操作：一枚落到 CI 里的 API 密钥不该具备抹掉整个账号的能力。
  // 这里与「修改昵称」保持一致 —— 账号级危险操作必须回到登录会话下确认。
  if (isApiKeyRequest(request)) {
    return jsonResp({ error: '注销账号需使用登录会话' }, 403, corsHeaders);
  }

  const userId = await getUserId(request, env);
  if (!userId) return jsonResp({ error: 'Unauthorized' }, 401, corsHeaders);

  const rl = await checkRateLimit(request, env, 'delete_acct');
  if (!rl.allowed) {
    return jsonResp({ error: `操作过于频繁，请在 ${Math.ceil(rl.resetIn / 60)} 分钟后重试` }, 429, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);

    // 1) 查全部站点（含 type / owner_id，用于反推桶与路径）
    const { data: sites, error: selErr } = await supabase
      .from('gh_site')
      .select('owner_id, name, type')
      .eq('owner_id', userId);
    if (selErr) throw selErr;

    // 2) 一次性清光所有站点的 Storage 文件（project 前缀一次 RPC 查完、按桶批量删）。
    //    失败立即中止，账号与 gh_site 记录都保留，用户可重试；不会留下孤儿。
    if (sites?.length) {
      const rmErr = await removeSitesFiles(env, supabase, sites);
      if (rmErr) {
        console.error('[delete-account] storage remove failed:', rmErr.message);
        return jsonResp({
          error: '站点文件清理失败，请重试注销',
          partial: true
        }, 500, corsHeaders);
      }
    }

    // 3) 文件全部清完，再删 gh_site 记录
    if (sites?.length) {
      const { error: delErr } = await supabase
        .from('gh_site')
        .delete()
        .eq('owner_id', userId);
      if (delErr) throw delErr;
    }

    // 4) 删 auth 用户
    const delRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
    });
    if (!delRes.ok) {
      const errData = await delRes.json().catch(() => ({}));
      throw new Error(errData.msg || '删除用户失败');
    }

    return jsonResp({ success: true }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message || '注销失败，请稍后再试' }, 500, corsHeaders);
  }
}
