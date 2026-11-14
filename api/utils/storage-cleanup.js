// ===== 站点存储清理工具（v3：数据库 RPC 直查 storage.objects）=====
//
// 根治目标：Worker 端不再对 Storage List API 做任何递归 / 逐站点请求。
// 列文件改为一次 SQL RPC 查 storage.objects；删文件改为「按桶聚合路径 → 分批 remove」。
// 请求数从 O(目录数 / 站点数) 变成 O(文件数 / 每页行数 + 文件数 / 每批条数)。
//
// 路径事实依据（与 create.js / project.js 的写入路径严格对齐）：
//   html    → sites    桶：<owner_id>/<slug>/index.html
//   md      → md       桶：<owner_id>/<slug>/index.md
//   project → projects 桶：<owner_id>/<slug>/<任意子路径>
//
// 关键不变量（既有测试守着，别破坏）：
//   · supabase-js v2 的 remove() 返回 { data, error }，不抛异常，必须显式检查 error
//   · 调用方先删文件、确认成功后再删 gh_site；失败时记录保留、用户可重试
//   · 对不存在的路径幂等（Storage DELETE 未命中时返回 200 / 空 data）
//   · 列文件 / 反推路径失败一律变成 Error 返回，绝不「当成没文件」——否则会造孤儿
//   · storage.objects.name 是完整对象键（已含 owner/slug 目录），RPC 直接返回它，
//     不再像旧版那样拼 `${prefix}${it.name}`
//
// 为什么用裸 fetch 而不是 admin-data.js 的 rpc()：
//   本模块被 delete.js / delete-account.js 等基础模块引用，复用 admin-data 会拖入
//   supabase-js 依赖链并形成循环依赖。这里只需 POST /rest/v1/rpc/<fn>，保持零依赖。

const REMOVE_BATCH = 500;      // Storage 单次 remove 上限 1000，留余量
const REMOVE_CONCURRENCY = 3;  // 同一桶内分批 remove 的并发上限
const RETRY_DELAY_MS = 300;    // 最终一致性 / 瞬态网络错误的缓冲
const MAX_RETRY = 2;           // 首次 + 1 次重试
const RPC_PAGE_MAX = 1000;     // 与 SQL 函数 least(p_limit, 1000) 一致
const MAX_RPC_PAGES = 500;     // 防御服务端忽略 offset 导致的死循环（50 万对象）

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

function rpcPageSize(env) {
  const raw = Number(env?.STORAGE_RPC_PAGE_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), RPC_PAGE_MAX) : RPC_PAGE_MAX;
}

/**
 * 单个 RPC 页。失败一律抛错（含 HTTP 非 2xx、返回格式异常）。
 * 不带任何静默 return [] —— 那会把「查不到」伪装成「没有文件」，制造孤儿。
 */
async function callStorageRpcPage(env, fn, body, limit, offset) {
  const base = (env?.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env?.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 配置');

  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, p_limit: limit, p_offset: offset }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`RPC ${fn} 失败: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error(`RPC ${fn} 返回格式异常（期望数组）`);
  }
  return rows.map(d => ({ path: String(d?.name ?? ''), size: Number(d?.size) || 0 }))
    .filter(i => i.path);
}

/**
 * 按页拉完整个结果集。
 *   · 满页才继续 —— 请求数 = ceil(命中行数 / pageSize)，与站点数 / 目录层级无关
 *   · order by o.name 由 SQL 保证，分页稳定、不重不漏
 *   · 检测「服务端忽略 offset」：相邻两页首行相同立即抛错，绝不无限循环
 * 这样即使桶里有 10 万个对象也不会被 PostgREST 的 db-max-rows 静默截断。
 */
async function listRpcAll(env, fn, body) {
  const pageSize = rpcPageSize(env);
  const out = [];
  let prevFirst = null;

  for (let page = 0; page < MAX_RPC_PAGES; page++) {
    const rows = await callStorageRpcPage(env, fn, body, pageSize, page * pageSize);
    if (rows.length && rows[0].path === prevFirst) {
      throw new Error(`RPC ${fn} 分页未生效（offset 被忽略），已中止以避免重复/漏文件`);
    }
    if (rows.length) prevFirst = rows[0].path;
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error(`RPC ${fn} 分页超过上限 ${MAX_RPC_PAGES} 页，请缩小范围或调大 STORAGE_RPC_PAGE_SIZE`);
}

/** 单前缀：一次（或按行数分页）RPC */
export async function listAllFileItems(env, bucket, prefix = '') {
  return await listRpcAll(env, 'admin_list_storage_files', {
    p_bucket_id: bucket,
    p_prefix: prefix,
  });
}

/** 多前缀：一次（或按行数分页）RPC 查完 N 个站点的文件 */
export async function listFilesByPrefixes(env, bucket, prefixes) {
  if (!Array.isArray(prefixes) || !prefixes.length) return [];
  return await listRpcAll(env, 'admin_list_storage_files_multi', {
    p_bucket_id: bucket,
    p_prefixes: prefixes,
  });
}

/** 兼容只关心路径的调用方（cleanup-orphans、删除清理） */
export async function listAllFiles(env, bucket, prefix = '') {
  return (await listAllFileItems(env, bucket, prefix)).map(i => i.path);
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

/** 单轮：按 500 分批 remove（有限并发），返回第一个 error 或 null */
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
 * 删除一批对象（去重 + 一次重试）。
 * @returns {Promise<Error|null>} null = 成功（含「本就没有文件」）；Error = 失败
 */
export async function removePaths(supabase, bucket, paths) {
  if (!paths.length) return null;
  const uniquePaths = [...new Set(paths)];

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const err = await removeOnce(supabase, bucket, uniquePaths);
    if (!err) return null;
    lastErr = err;
    if (attempt < MAX_RETRY - 1) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return lastErr;
}

/**
 * 【批量核心】一次删光多个站点的全部存储文件，供删用户 / 注销账号 / 批量删站复用。
 *
 *  · html / md：路径是固定文件名，无需查库，直接按桶聚合
 *  · project：所有站点前缀合并成一次 multi RPC（内部按行数分页），不再逐站发请求
 *  · 最后按桶各调一次 removePaths（内部按 500 分批）
 *
 * 坏记录一律返回 Error（**绝不 continue 跳过**）：否则该站文件没清、
 * gh_site 记录却被删掉，又会产生一批孤儿。
 *
 * @returns {Promise<Error|null>} null = 全部清完；Error = 失败，调用方必须中止
 */
export async function removeSitesFiles(env, supabase, sites) {
  const byBucket = { sites: [], md: [], projects: [] };
  const projectPrefixes = [];

  for (const site of (sites || [])) {
    if (!site?.owner_id || !site?.name) {
      return toError(new Error('站点记录缺少 owner_id / name，无法反推存储路径'));
    }
    const type = site.type || 'html';
    if (type === 'project') {
      projectPrefixes.push(`${site.owner_id}/${site.name}/`);
    } else {
      const fileName = type === 'md' ? 'index.md' : 'index.html';
      byBucket[bucketForType(type)].push(`${site.owner_id}/${site.name}/${fileName}`);
    }
  }

  if (projectPrefixes.length) {
    try {
      const items = await listFilesByPrefixes(env, 'projects', projectPrefixes);
      byBucket.projects.push(...items.map(i => i.path));
    } catch (err) {
      return toError(err);
    }
  }

  for (const [bucket, paths] of Object.entries(byBucket)) {
    if (!paths.length) continue;
    const err = await removePaths(supabase, bucket, paths);
    if (err) return err;
  }
  return null;
}

/**
 * 删除单个站点的全部存储文件。
 * @returns {Promise<Error|null>} null = 成功；Error = 失败，调用方必须中止
 */
export async function removeSiteFiles(env, supabase, site) {
  try {
    const { bucket, paths } = await collectSiteFiles(env, site);
    return await removePaths(supabase, bucket, paths);
  } catch (err) {
    // 列文件 / 反推路径失败也必须冒泡成 Error，不能当成「没文件」
    return toError(err);
  }
}
