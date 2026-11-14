// ===== 站点存储清理工具 =====
//
// 三个删除入口（sites/delete.js、admin/delete-user.js、auth/delete-account.js）共用。
//
// 路径事实依据（与 create.js / project.js 的写入路径严格对齐）：
//   html    → sites    桶：<owner_id>/<slug>/index.html
//   md      → md       桶：<owner_id>/<slug>/index.md
//   project → projects 桶：<owner_id>/<slug>/<任意子路径>
//
// 设计要点：
//   · supabase-js v2 的 remove() 返回 { data, error }，不抛异常，必须显式检查 error
//   · 调用方先删文件、确认成功后再删 gh_site，失败时记录保留、用户可重试
//   · 对不存在的路径幂等（Storage DELETE 未命中时返回 200 / 空 data）
//   · project 站点递归列目录、分批删除（同级目录 / 删除批次有限并发，避免 N+1 串行往返）
//   · 列目录失败一律当成删除失败返回，绝不能「当成没文件」——否则会造出新的孤儿

const REMOVE_BATCH = 500;      // Storage 单次 remove 上限 1000，留余量
const LIST_LIMIT = 1000;
const MAX_PAGES = 100;         // 防御 Storage 忽略 offset 导致的死循环
const MAX_DEPTH = 20;          // 目录递归深度防御
const RETRY_DELAY_MS = 300;    // 最终一致性窗口 / 瞬态网络错误的缓冲
const MAX_RETRY = 2;           // 首次 + 1 次重试
const LIST_CONCURRENCY = 6;    // 同级子目录并发列目录上限（别打爆 Storage）
const REMOVE_CONCURRENCY = 3;  // 同一站点内分批 remove 的并发上限

function toError(e) {
  return e instanceof Error ? e : new Error(e?.message || String(e));
}

/** 有限并发 map：保留结果顺序，任一项失败即整体 reject */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

/** gh_site.type → 桶名 */
export function bucketForType(type) {
  if (type === 'md') return 'md';
  if (type === 'project') return 'projects';
  return 'sites';
}

/** POST /storage/v1/object/list/:bucket 的单页结果；任何异常都抛出，不静默 */
async function listPage(env, bucket, prefix, offset) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit: LIST_LIMIT, offset }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`storage list ${bucket}/${prefix} 失败: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error(`storage list ${bucket}/${prefix} 返回格式异常`);
  }
  return items;
}

/**
 * 递归列出桶内 prefix 下所有文件（含 prefix 本身），返回 { path, size }。
 * Storage list 返回中 metadata === null 表示目录，否则是文件。
 * 任何异常都抛出，绝不静默返回空数组（否则会被误判成「目录里没文件」）。
 */
export async function listAllFileItems(env, bucket, prefix = '', depth = 0) {
  if (depth > MAX_DEPTH) {
    throw new Error(`storage list 递归过深: ${bucket}/${prefix}`);
  }
  const out = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await listPage(env, bucket, prefix, offset);
    if (!items.length) break;

    const dirs = [];
    for (const it of items) {
      if (it.metadata == null) dirs.push(it.name);
      else out.push({ path: `${prefix}${it.name}`, size: Number(it.metadata.size) || 0 });
    }
    // 同级子目录并发递归：旧版对每个目录 await 一次，目录越多延迟线性叠加
    if (dirs.length) {
      const subs = await mapLimit(dirs, LIST_CONCURRENCY,
        name => listAllFileItems(env, bucket, `${prefix}${name}/`, depth + 1));
      for (const sub of subs) out.push(...sub);
    }

    if (items.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
    if (page === MAX_PAGES - 1) {
      throw new Error(`storage list 分页超过上限: ${bucket}/${prefix}`);
    }
  }
  return out;
}

/** 兼容只关心路径的调用方（cleanup-orphans、删除清理） */
export async function listAllFiles(env, bucket, prefix = '', depth = 0) {
  return (await listAllFileItems(env, bucket, prefix, depth)).map(i => i.path);
}

/**
 * 按 gh_site 记录反推桶与待删路径。
 * 路径只信任数据库里的 owner_id / name / type，不使用请求体里的 slug。
 */
export async function collectSiteFiles(env, site) {
  const ownerId = site?.owner_id;
  const slug = site?.name;
  if (!ownerId || !slug) {
    throw new Error('站点记录缺少 owner_id / name，无法反推存储路径');
  }

  const type = site.type || 'html';
  const bucket = bucketForType(type);

  if (type === 'project') {
    return { bucket, paths: await listAllFiles(env, bucket, `${ownerId}/${slug}/`) };
  }

  const fileName = type === 'md' ? 'index.md' : 'index.html';
  return { bucket, paths: [`${ownerId}/${slug}/${fileName}`] };
}

/** 单轮：分批 remove（有限并发），返回第一个 error 或 null */
async function removeOnce(supabase, bucket, paths) {
  const chunks = [];
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    chunks.push(paths.slice(i, i + REMOVE_BATCH));
  }
  const results = await mapLimit(chunks, REMOVE_CONCURRENCY, async chunk => {
    const { error } = await supabase.storage.from(bucket).remove(chunk);
    return error ? toError(error) : null;
  });
  return results.find(Boolean) || null;
}

/**
 * 删除一批对象（带一次重试）。
 * @returns {Promise<Error|null>} null = 成功；Error = 两次都失败
 */
export async function removePaths(supabase, bucket, paths) {
  if (!paths.length) return null;      // 无文件视为成功（幂等）
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const err = await removeOnce(supabase, bucket, paths);
    if (!err) return null;
    lastErr = err;
    if (attempt < MAX_RETRY - 1) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return lastErr;
}

/**
 * 删除单个站点的全部存储文件。
 * @returns {Promise<Error|null>} null = 成功（含「本就没有文件」）；Error = 失败，调用方必须中止
 */
export async function removeSiteFiles(env, supabase, site) {
  try {
    const { bucket, paths } = await collectSiteFiles(env, site);
    return await removePaths(supabase, bucket, paths);
  } catch (err) {
    // 列目录 / 反推路径阶段的失败也必须冒泡成 Error，不能当成「没文件」
    return toError(err);
  }
}
