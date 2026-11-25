// ===== 管理员 - 历史孤儿文件清理 =====
//
// POST /api/admin/cleanup-orphans
//   { "dryRun": true }                        默认：只预览，不删任何东西
//   { "dryRun": false, "ownerId": "<uuid>" } 执行：只清指定用户（推荐先用它小范围试）
//   { "dryRun": false }                      执行：全量清理三个桶
//
// 判定规则：对象路径 <owner_id>/<slug>/... 的前两级目录必须在 gh_site 里存在且桶匹配，
// 否则视为孤儿。路径段数不足、owner_id 不是 UUID 的对象一律跳过，避免误删桶内其它数据。
// 必须走 Storage API 删除，禁止直接 DELETE storage.objects。

import { isWriteAdmin } from '../utils/jwt.js';
import { makeSupabase } from '../utils/supabase.js';
import { jsonResp } from '../utils/response.js';
import { listAllFiles, removePaths, bucketForType } from '../utils/storage-cleanup.js';

const BUCKETS = ['sites', 'md', 'projects'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GROUPS = 200;

export async function handleAdminCleanupOrphans(request, env, corsHeaders) {
  if (!await isWriteAdmin(request, env)) {
    return jsonResp({ error: '只读管理员仅可查看，不能执行写操作' }, 403, corsHeaders);
  }

  let opts = {};
  try { opts = await request.json(); } catch { /* 空 body 也允许，默认 dryRun */ }
  const dryRun = opts?.dryRun !== false;
  const ownerId = typeof opts?.ownerId === 'string' && UUID_RE.test(opts.ownerId.trim())
    ? opts.ownerId.trim() : null;

  try {
    const supabase = makeSupabase(env);
    const { data: sites, error: selErr } = await supabase
      .from('gh_site')
      .select('owner_id, name, type');
    if (selErr) throw selErr;

    const valid = new Set();
    for (const s of (sites || [])) {
      if (s?.owner_id && s?.name) {
        valid.add(`${bucketForType(s.type)}:${s.owner_id}/${s.name}/`);
      }
    }

    // 第一遍：只扫描、不删除。三个桶并发列目录（旧版串行，桶内递归又串行，很慢）。
    // Promise.all 保证任一桶失败即整体中止，不会出现「扫了一半就开始删」。
    const doomedByBucket = {};
    const scanned = {};
    let skipped = 0;

    const scans = await Promise.all(BUCKETS.map(async bucket => {
      const prefix = ownerId ? `${ownerId}/` : '';
      const paths = await listAllFiles(env, bucket, prefix);
      const doomed = [];
      let localSkipped = 0;
      for (const p of paths) {
        const parts = p.split('/');
        if (parts.length < 3 || !parts[1] || !UUID_RE.test(parts[0])) {
          localSkipped++;
          continue;
        }
        const sitePrefix = `${parts[0]}/${parts[1]}/`;
        if (!valid.has(`${bucket}:${sitePrefix}`)) doomed.push(p);
      }
      return { bucket, paths, doomed, localSkipped };
    }));
    for (const r of scans) {
      scanned[r.bucket] = r.paths.length;
      doomedByBucket[r.bucket] = r.doomed;
      skipped += r.localSkipped;
    }

    // 汇总分组（按 bucket + 前两级目录），方便人工核对
    const groups = [];
    let orphanFiles = 0;
    for (const bucket of BUCKETS) {
      const byPrefix = new Map();
      for (const p of doomedByBucket[bucket]) {
        const parts = p.split('/');
        const key = `${parts[0]}/${parts[1]}/`;
        byPrefix.set(key, (byPrefix.get(key) || 0) + 1);
        orphanFiles++;
      }
      for (const [prefix, count] of byPrefix) {
        if (groups.length < MAX_GROUPS) groups.push({ bucket, prefix, count });
      }
    }

    const report = {
      dryRun,
      scopedOwner: ownerId,
      scanned,
      skipped,
      siteCount: sites?.length || 0,
      orphanFiles,
      groups,
      groupsTruncated: groups.length >= MAX_GROUPS,
      deleted: 0,
      errors: [],
    };

    if (dryRun) {
      return jsonResp({ success: true, ...report }, 200, corsHeaders);
    }

    // 第二遍：真正删除，逐桶分批 + 一次重试
    for (const bucket of BUCKETS) {
      const doomed = doomedByBucket[bucket];
      if (!doomed.length) continue;
      const err = await removePaths(supabase, bucket, doomed);
      if (err) {
        report.errors.push({ bucket, message: err.message });
      } else {
        report.deleted += doomed.length;
      }
    }

    return jsonResp({ success: report.errors.length === 0, ...report }, 200, corsHeaders);
  } catch (err) {
    return jsonResp({ error: err.message }, 500, corsHeaders);
  }
}
