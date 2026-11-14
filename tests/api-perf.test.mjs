// API 性能修复专项自测：node tests/api-perf.test.mjs
// 不触碰真实网络 / 数据库；用 mock fetch 与假 ctx 验证结构性优化确实生效。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listAllFileItems, removePaths } from '../api/utils/storage-cleanup.js';
import { bindRequestContext, runInBackground } from '../api/utils/request-context.js';
import { getUserId } from '../api/utils/jwt.js';

const ROOT = new URL('../', import.meta.url);
const U1 = '11111111-1111-4111-8111-111111111111';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
function read(p) { return fs.readFileSync(new URL(p, ROOT), 'utf8'); }

async function main() {
  console.log('api-perf 专项自测');

  /* ---- P0：结构护栏 ---- */
  await test('Worker 端已彻底删除全量拉取与实例内缓存（不留两套逻辑）', () => {
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(new URL(rel, ROOT), { withFileTypes: true })) {
        const p = rel + e.name + (e.isDirectory() ? '/' : '');
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk('api/');
    const banned = [
      'getAllAuthUsers', 'getAllSiteRows', 'invalidateAdminCache',
      'CACHE_TTL_MS', 'countByOwner', 'auth.admin.listUsers', 'syncEmailMap',
    ];
    for (const f of files) {
      const s = read(f);
      for (const k of banned) assert.ok(!s.includes(k), `${f} 仍残留 ${k}`);
      assert.ok(!s.includes('/storage/v1/object/list/'), `${f} 仍在递归调 Storage List API`);
    }
    assert.ok(files.length > 40, '应扫描到全部 api 源文件');
  });

  await test('批量清理已接线：删用户/销号不再逐站循环', () => {
    for (const p of ['api/utils/admin-actions.js', 'api/auth/delete-account.js']) {
      const s = read(p);
      assert.ok(s.includes('removeSitesFiles'), p + ' 未接批量清理');
      assert.ok(!/for \(const site of \(sites/.test(s), p + ' 仍有逐站循环');
    }
    // 单站删除仍走 removeSiteFiles（合理），但 deleteUserCore 函数体内不允许
    const actions = read('api/utils/admin-actions.js');
    const coreStart = actions.indexOf('export async function deleteUserCore');
    const coreEnd = actions.indexOf('/** 封禁', coreStart);
    assert.ok(coreStart > 0 && coreEnd > coreStart);
    const core = actions.slice(coreStart, coreEnd);
    assert.ok(core.includes('removeSitesFiles'), 'deleteUserCore 未走批量清理');
    assert.ok(!core.includes('removeSiteFiles('), 'deleteUserCore 仍在循环里单站删');
    assert.ok(read('api/admin/batch.js').includes('MAX_BATCH_BAN_USERS'));
    assert.ok(read('front/admin/app.js').includes('splitBatchBody'), '前端未做分块');
    assert.ok(read('api/sites/project.js').includes('const MAX_FILES = 30'));
  });

  await test('SQL 迁移齐备：8 个函数 + 索引 + service_role 权限', () => {
    const sql = read('sql/admin_perf.sql');
    for (const fn of ['admin_user_page', 'admin_site_page', 'admin_user_briefs',
      'admin_overview_stats', 'site_totals', 'admin_email_map']) {
      assert.ok(sql.includes(`create or replace function public.${fn}(`), '缺少 ' + fn);
      assert.ok(sql.includes(`grant execute on function public.${fn}(`), '未给 service_role 授权 ' + fn);
    }
    assert.ok(sql.includes("set search_path = ''"), 'SECURITY DEFINER 必须清空 search_path');
    assert.ok(sql.includes('security definer'));
    assert.ok(sql.includes('count(*) over()'), '分页总数必须由窗口函数一次得出');
    assert.ok(sql.includes("position(lower(p_q)"), '搜索不能用 ilike 拼接，避免通配符语义');
    assert.ok(sql.includes("at time zone 'Asia/Shanghai'"), '今日统计必须按 CST 零点');
    assert.ok((sql.match(/create index if not exists/g) || []).length >= 5);

    // Storage RPC（第 9 节）：DROP+CREATE 消重载歧义、字面量前缀、稳定分页、权限
    for (const fn of ['admin_list_storage_files', 'admin_list_storage_files_multi']) {
      assert.ok(sql.includes(`create function public.${fn}(`), '缺少 ' + fn);
      assert.ok(sql.includes(`grant execute on function public.${fn}(`), '未授权 ' + fn);
      assert.ok(sql.includes(`drop function if exists public.${fn}(`), '改签名必须先 DROP');
    }
    assert.ok(sql.includes('left(o.name, length(p_prefix)) = p_prefix'));
    assert.ok(sql.includes('left(o.name, length(p.prefix)) = p.prefix'));
    assert.ok(!/like\s+p_prefix/i.test(sql), '前缀不能用 LIKE（_ 是单字符通配符）');
    assert.ok((sql.match(/order by o\.name/g) || []).length >= 2, '两个函数分页都要稳定排序');
    const patch = read('sql/storage_rpc_patch.sql');
    assert.ok(patch.includes('revoke all on function public.admin_list_storage_files(text,text,int,int)'));
  });

  await test('列表接口把分页/过滤/排序全部下推 RPC，Worker 内不再 sort/filter 全量', () => {
    for (const p of ['api/admin/users.js', 'api/admin/sites.js', 'api/admin/stats.js']) {
      const s = read(p);
      assert.ok(s.includes('listUsersPage') || s.includes('listSitesPage') || s.includes('overviewStats'), p);
      assert.ok(!/\.sort\(/.test(s), p + ' 不应再有内存排序');
      assert.ok(!/Promise\.all\(\[\s*getAll/.test(s), p + ' 不应再并行拉两份全量');
    }
  });

  /* ---- Storage：RPC 直查，请求数与目录层级脱钩 ---- */
  await test('Storage 列文件：1 次 RPC 返回全部完整对象键，不再按目录层级发请求', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      assert.match(String(url), /\/rest\/v1\/rpc\/admin_list_storage_files$/);
      const body = JSON.parse(opts.body);
      assert.equal(body.p_bucket_id, 'projects');
      assert.equal(body.p_prefix, `${U1}/demo/`);
      return {
        ok: true, status: 200,
        async text() { return ''; },
        async json() {
          return [
            { name: `${U1}/demo/index.html`, size: 10 },
            { name: `${U1}/demo/css/a.css`, size: 20 },
            { name: `${U1}/demo/js/a.js`, size: 30 },
            { name: `${U1}/demo/img/a.png`, size: 40 },
          ];
        },
      };
    };
    try {
      const files = await listAllFileItems({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
        'projects', `${U1}/demo/`);
      assert.equal(files.length, 4);
      assert.deepEqual(files.map(f => f.path).sort(), [
        `${U1}/demo/css/a.css`, `${U1}/demo/img/a.png`,
        `${U1}/demo/index.html`, `${U1}/demo/js/a.js`,
      ].sort());
      assert.equal(calls, 1, '4 级目录也只能 1 次请求');
    } finally {
      globalThis.fetch = original;
    }
  });

  await test('RPC 失败必须抛出（不能静默当成「没文件」而制造孤儿）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return 'busy'; }, async json() { return []; } });
    try {
      await assert.rejects(() => listAllFileItems({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
        'projects', `${U1}/demo/`), /RPC admin_list_storage_files 失败/);
    } finally { globalThis.fetch = original; }
  });

  await test('分批 remove 有限并发，且 error 仍能被捕获', async () => {
    const paths = Array.from({ length: 1200 }, (_, i) => `p/${i}.txt`);
    let active = 0, maxActive = 0, batches = 0;
    const supabase = { storage: { from() { return { async remove(chunk) {
      batches++; active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return { data: chunk.map(x => ({ name: x })), error: null };
    } }; } } };
    const err = await removePaths(supabase, 'projects', paths);
    assert.equal(err, null);
    assert.equal(batches, 3, '1200 / 500 = 3 批');
    assert.ok(maxActive > 1 && maxActive <= 3, '并发度应受限于 3');

    const failing = { storage: { from() { return { async remove() {
      return { data: null, error: { message: 'storage 500' } };
    } }; } } };
    const e2 = await removePaths(failing, 'projects', ['a']);
    assert.ok(e2 instanceof Error && e2.message.includes('storage 500'));
  });

  /* ---- P1：waitUntil ---- */
  await test('有 ctx 时后台任务交给 waitUntil，调用方不阻塞', async () => {
    const tasks = [];
    const ctx = { waitUntil(p) { tasks.push(p); } };
    const req = { headers: { get() { return null; } } };
    bindRequestContext(req, ctx);
    let done = false;
    const t0 = Date.now();
    await runInBackground(req, async () => {
      await new Promise(r => setTimeout(r, 40));
      done = true;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 30, '不应等待任务完成，实际 ' + elapsed + 'ms');
    assert.equal(done, false);
    assert.equal(tasks.length, 1);
    await tasks[0];
    assert.equal(done, true);
  });

  await test('无 ctx（本地/旧运行时）退化成 await，任务不会丢', async () => {
    let done = false;
    const req = { headers: { get() { return null; } } };
    await runInBackground(req, async () => { await new Promise(r => setTimeout(r, 5)); done = true; });
    assert.equal(done, true);
  });

  await test('站点访问计数已移出响应路径（serve / project 用 runInBackground）', () => {
    assert.ok(read('api/sites/serve.js').includes('runInBackground(request, () => fetch'), 'serve.js');
    assert.ok(read('api/sites/project.js').includes('runInBackground(request, () => fetch'), 'project.js');
    assert.ok(read('api/index.js').includes('bindRequestContext(request, ctx)'));
  });

  /* ---- P1：JWT 在线校验复用 ---- */
  await test('JWT 校验结果按 token 哈希复用：连续请求只发一次 auth 往返', async () => {
    const original = globalThis.fetch;
    let authCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/auth/v1/user')) {
        authCalls++;
        return { ok: true, status: 200, async json() { return { id: U1 }; }, async text() { return ''; } };
      }
      throw new Error('unexpected fetch: ' + url);
    };
    try {
      const env = {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_ANON_KEY: 'anon',
        JWT_VERIFY_CACHE_TTL: '20000',
      };
      const req = { headers: { get: (k) => k === 'Authorization' ? 'Bearer session-token-abc' : null } };
      assert.equal(await getUserId(req, env), U1);
      assert.equal(await getUserId(req, env), U1);
      assert.equal(await getUserId(req, env), U1);
      assert.equal(authCalls, 1, '三次请求应只有一次在线校验');

      // 不同 token 不应复用
      const req2 = { headers: { get: (k) => k === 'Authorization' ? 'Bearer another-token' : null } };
      assert.equal(await getUserId(req2, env), U1);
      assert.equal(authCalls, 2);
    } finally { globalThis.fetch = original; }
  });

  await test('JWT_VERIFY_CACHE_TTL=0 可一键回到严格逐请求在线校验', async () => {
    const original = globalThis.fetch;
    let authCalls = 0;
    globalThis.fetch = async () => {
      authCalls++;
      return { ok: true, status: 200, async json() { return { id: U1 }; }, async text() { return ''; } };
    };
    try {
      const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', JWT_VERIFY_CACHE_TTL: '0' };
      const req = { headers: { get: (k) => k === 'Authorization' ? 'Bearer strict-mode-token' : null } };
      await getUserId(req, env);
      await getUserId(req, env);
      assert.equal(authCalls, 2);
      // 源码里不能出现 token 明文入缓存
      const jwt = read('api/utils/jwt.js');
      assert.ok(jwt.includes('crypto.subtle.digest'), '缓存 key 必须是哈希');
      assert.ok(jwt.includes('JWT_VERIFY_CACHE_TTL'));
      assert.ok(!jwt.includes('verifyCache.set(token'), '不能拿明文 token 当 key');
    } finally { globalThis.fetch = original; }
  });

  await test('公开统计走一次聚合 RPC，不再分页累加', () => {
    const s = read('api/admin/public-stats.js');
    assert.ok(s.includes('siteTotals'));
    assert.ok(!s.includes(".select('visit_count')"), '不应再分页拉 visit_count');
    assert.ok(!/for \(let p = 0/.test(s));
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
