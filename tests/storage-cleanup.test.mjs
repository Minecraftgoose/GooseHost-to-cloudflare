// 站点存储清理模块自测：node tests/storage-cleanup.test.mjs
// 无第三方依赖。mock REST /rpc/admin_list_storage_files*，验证：
//   · 不再调用 Storage List API（递归子请求已废除）
//   · 稳定分页（绕过 db-max-rows 截断，不漏文件）
//   · 多前缀合并成 1 次 RPC、按桶聚合批量删
//   · 下划线前缀是字面量、坏记录不静默跳过、RPC 失败不伪装成「没文件」

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  bucketForType,
  collectSiteFiles,
  listAllFiles,
  listAllFileItems,
  listFilesByPrefixes,
  removePaths,
  removeSiteFiles,
  removeSitesFiles,
} from '../api/utils/storage-cleanup.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
};
const OWNER = 'de90a631-30b0-4b4a-afe4-dba9dd72e288';
const SQL = fs.readFileSync(new URL('../sql/storage_rpc_patch.sql', import.meta.url), 'utf8');

/** fake RPC：handler(fn, body) => [{name,size}] | {__httpError:true,...} */
function fakeRpc(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const fn = String(url).split('/rest/v1/rpc/')[1];
    const body = JSON.parse(init.body);
    calls.push({ fn, body });
    const res = await handler(fn, body);
    if (res && res.__httpError) {
      return { ok: false, status: res.status, text: async () => res.message, json: async () => [] };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => res };
  };
  return { fetchImpl, calls };
}

const row = (name, size = 10) => ({ name, size });

function makeSupabase(responses = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            calls.push({ bucket, paths: paths.slice() });
            const r = responses[Math.min(i++, responses.length - 1)];
            return r ?? { data: [], error: null };
          },
        };
      },
    },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('storage-cleanup 自测（RPC 数据层）');

  await test('类型 → 桶映射（含未知类型回落 sites）', () => {
    assert.equal(bucketForType('html'), 'sites');
    assert.equal(bucketForType('md'), 'md');
    assert.equal(bucketForType('project'), 'projects');
    assert.equal(bucketForType(undefined), 'sites');
  });

  await test('html / md 路径反推不查库（0 次 RPC）', async () => {
    const { fetchImpl, calls } = fakeRpc(() => { throw new Error('固定文件名不该查库'); });
    globalThis.fetch = fetchImpl;
    assert.deepEqual((await collectSiteFiles(env, { owner_id: OWNER, name: 'demo', type: 'html' })),
      { bucket: 'sites', paths: [`${OWNER}/demo/index.html`] });
    assert.deepEqual((await collectSiteFiles(env, { owner_id: OWNER, name: 'note', type: 'md' })),
      { bucket: 'md', paths: [`${OWNER}/note/index.md`] });
    assert.equal(calls.length, 0);
  });

  await test('project 站点：1 次 RPC 拿到多级目录全部完整路径（不再拼 prefix+name）', async () => {
    const { fetchImpl, calls } = fakeRpc((fn, body) => {
      assert.equal(fn, 'admin_list_storage_files');
      assert.equal(body.p_bucket_id, 'projects');
      assert.equal(body.p_prefix, `${OWNER}/app/`);
      return [
        row(`${OWNER}/app/index.html`, 10),
        row(`${OWNER}/app/css/main.css`, 1234),
        row(`${OWNER}/app/js/lib/util.js`, 20),
        row(`${OWNER}/app/js/main.js`, 30),
      ];
    });
    globalThis.fetch = fetchImpl;
    const { bucket, paths } = await collectSiteFiles(env, { owner_id: OWNER, name: 'app', type: 'project' });
    assert.equal(bucket, 'projects');
    assert.deepEqual(paths.sort(), [
      `${OWNER}/app/css/main.css`,
      `${OWNER}/app/index.html`,
      `${OWNER}/app/js/lib/util.js`,
      `${OWNER}/app/js/main.js`,
    ].sort());
    assert.equal(calls.length, 1, '多级目录也只发 1 次请求');
  });

  await test('listAllFileItems 返回 path + size；listAllFiles 只取路径', async () => {
    const { fetchImpl } = fakeRpc(() => [row(`${OWNER}/app/index.html`, 10), row(`${OWNER}/app/a.css`, 1234)]);
    globalThis.fetch = fetchImpl;
    const items = await listAllFileItems(env, 'projects', `${OWNER}/app/`);
    assert.deepEqual(items, [
      { path: `${OWNER}/app/index.html`, size: 10 },
      { path: `${OWNER}/app/a.css`, size: 1234 },
    ]);
    assert.deepEqual(await listAllFiles(env, 'projects', `${OWNER}/app/`),
      [`${OWNER}/app/index.html`, `${OWNER}/app/a.css`]);
  });

  await test('下划线前缀按字面量比较：SQL 用 left()，绝不含 LIKE 通配符拼接', async () => {
    assert.ok(SQL.includes('left(o.name, length(p_prefix)) = p_prefix'), '单前缀函数必须用 left()');
    assert.ok(SQL.includes('left(o.name, length(p.prefix)) = p.prefix'), 'multi 也必须用 left()');
    assert.ok(!/like\s+p_prefix|like\s+p\.prefix/i.test(SQL), '不能出现 LIKE 前缀拼接');
    assert.ok(SQL.includes('order by o.name'), '分页必须稳定排序');

    // Worker 侧把含 _ 的 slug 原样透传，不做任何通配/转义处理
    const { fetchImpl, calls } = fakeRpc(() => [row(`${OWNER}/foo_bar/index.html`)]);
    globalThis.fetch = fetchImpl;
    const paths = await listAllFiles(env, 'projects', `${OWNER}/foo_bar/`);
    assert.equal(calls[0].body.p_prefix, `${OWNER}/foo_bar/`);
    assert.deepEqual(paths, [`${OWNER}/foo_bar/index.html`]);
    assert.ok(!paths.some(p => p.includes('fooXbar')), 'fooXbar 绝不能被连带返回');
  });

  await test('project 站点：remove 收到完整路径且检查 error 返回值', async () => {
    const { fetchImpl } = fakeRpc(() => [row(`${OWNER}/app/index.html`), row(`${OWNER}/app/a.css`)]);
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSiteFiles(env, sb, { owner_id: OWNER, name: 'app', type: 'project' });
    assert.equal(err, null);
    assert.equal(sb.calls.length, 1);
    assert.equal(sb.calls[0].bucket, 'projects');
    assert.equal(sb.calls[0].paths.length, 2);
  });

  await test('remove 返回 error 不抛异常时，模块能捕获并重试一次', async () => {
    const sb = makeSupabase([{ data: null, error: new Error('503') }, { data: [], error: null }]);
    const err = await removePaths(sb, 'sites', [`${OWNER}/demo/index.html`]);
    assert.equal(err, null);
    assert.equal(sb.calls.length, 2);
  });

  await test('连续两次失败 → 返回 Error，调用方应中止删记录', async () => {
    const sb = makeSupabase([{ data: null, error: { message: 'boom' } }]);
    const err = await removePaths(sb, 'sites', [`${OWNER}/demo/index.html`]);
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'boom');
    assert.equal(sb.calls.length, 2);
  });

  await test('RPC 失败 → 返回 Error，绝不「当成没文件」，且不发 remove', async () => {
    const { fetchImpl } = fakeRpc(() => ({ __httpError: true, status: 503, message: 'db unavailable' }));
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSiteFiles(env, sb, { owner_id: OWNER, name: 'app', type: 'project' });
    assert.ok(err instanceof Error);
    assert.match(err.message, /RPC admin_list_storage_files 失败/);
    assert.equal(sb.calls.length, 0);
  });

  await test('空结果 → 幂等成功，不发 remove', async () => {
    const { fetchImpl } = fakeRpc(() => []);
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    assert.equal(await removeSiteFiles(env, sb, { owner_id: OWNER, name: 'empty', type: 'project' }), null);
    assert.equal(sb.calls.length, 0);
  });

  await test('超过 1000 行时自动分页（2 次 RPC）+ 按 500 分批删除', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => row(`${OWNER}/big/f${String(i).padStart(4, '0')}.txt`));
    const { fetchImpl, calls } = fakeRpc((fn, body) => all.slice(body.p_offset, body.p_offset + body.p_limit));
    globalThis.fetch = fetchImpl;
    const paths = await listAllFiles(env, 'projects', `${OWNER}/big/`);
    assert.equal(paths.length, 1200, '不能被 db-max-rows 截断');
    assert.equal(calls.length, 2, '1000 满页 + 200 尾页');
    assert.deepEqual(calls.map(c => c.body.p_offset), [0, 1000]);
    const sb = makeSupabase();
    assert.equal(await removePaths(sb, 'projects', paths), null);
    assert.deepEqual(sb.calls.map(c => c.paths.length), [500, 500, 200]);
  });

  await test('服务端忽略 offset → 立即抛错，不无限循环 / 不重复删', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => row(`p/${i}.txt`));
    const { fetchImpl, calls } = fakeRpc(() => page);
    globalThis.fetch = fetchImpl;
    await assert.rejects(() => listAllFiles(env, 'projects', ''), /分页未生效/);
    assert.equal(calls.length, 2);
  });

  await test('站点记录缺 owner_id/name → 报错而不是拼出错误路径', async () => {
    const { fetchImpl } = fakeRpc(() => []);
    globalThis.fetch = fetchImpl;
    const err = await removeSiteFiles(env, makeSupabase(), { name: 'x', type: 'html' });
    assert.ok(err instanceof Error);
    assert.match(err.message, /缺少/);
  });

  /* ---- 批量核心 removeSitesFiles ---- */
  await test('removeSitesFiles：N 个 project 站点只发 1 次 multi RPC，按桶聚合删除', async () => {
    const sites = [
      { owner_id: OWNER, name: 'a', type: 'project' },
      { owner_id: OWNER, name: 'b', type: 'project' },
      { owner_id: OWNER, name: 'c', type: 'project' },
    ];
    const { fetchImpl, calls } = fakeRpc((fn, body) => {
      assert.equal(fn, 'admin_list_storage_files_multi');
      assert.deepEqual(body.p_prefixes, [
        `${OWNER}/a/`, `${OWNER}/b/`, `${OWNER}/c/`,
      ]);
      return [
        row(`${OWNER}/a/index.html`),
        row(`${OWNER}/b/css/main.css`),
        row(`${OWNER}/c/lib/x.js`),
      ];
    });
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSitesFiles(env, sb, sites);
    assert.equal(err, null);
    assert.equal(calls.length, 1, '3 个站点也只能 1 次 RPC');
    assert.equal(sb.calls.length, 1, '同一桶只 1 次批量 remove');
    assert.equal(sb.calls[0].bucket, 'projects');
    assert.equal(sb.calls[0].paths.length, 3);
  });

  await test('removeSitesFiles：html/md 直接拼路径，0 次 RPC；三个桶各删一次', async () => {
    const { fetchImpl, calls } = fakeRpc(() => { throw new Error('固定文件名不该查库'); });
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSitesFiles(env, sb, [
      { owner_id: OWNER, name: 'h1', type: 'html' },
      { owner_id: OWNER, name: 'h2' },
      { owner_id: OWNER, name: 'm1', type: 'md' },
    ]);
    assert.equal(err, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(sb.calls.map(c => c.bucket).sort(), ['md', 'sites']);
    assert.equal(sb.calls.find(c => c.bucket === 'sites').paths.length, 2);
  });

  await test('removeSitesFiles：坏记录返回 Error 且完全不发 remove（绝不静默 continue）', async () => {
    const { fetchImpl } = fakeRpc(() => [row(`${OWNER}/a/index.html`)]);
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSitesFiles(env, sb, [
      { owner_id: OWNER, name: 'a', type: 'project' },
      { name: 'broken', type: 'html' },   // 缺 owner_id
    ]);
    assert.ok(err instanceof Error, '必须是失败信号，返回 null 会删掉记录造孤儿');
    assert.match(err.message, /缺少 owner_id/);
    assert.equal(sb.calls.length, 0);
  });

  await test('removeSitesFiles：RPC 失败 → Error，不删任何文件', async () => {
    const { fetchImpl } = fakeRpc(() => ({ __httpError: true, status: 500, message: 'boom' }));
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    const err = await removeSitesFiles(env, sb, [{ owner_id: OWNER, name: 'a', type: 'project' }]);
    assert.ok(err instanceof Error);
    assert.equal(sb.calls.length, 0);
  });

  await test('removeSitesFiles：空站点数组 → 成功且 0 次请求', async () => {
    const { fetchImpl, calls } = fakeRpc(() => []);
    globalThis.fetch = fetchImpl;
    const sb = makeSupabase();
    assert.equal(await removeSitesFiles(env, sb, []), null);
    assert.equal(calls.length, 0);
    assert.equal(sb.calls.length, 0);
  });

  await test('listFilesByPrefixes 空数组 → 0 次 RPC；路径去重后 removePaths 不重复删', async () => {
    const { fetchImpl, calls } = fakeRpc(() => []);
    globalThis.fetch = fetchImpl;
    assert.deepEqual(await listFilesByPrefixes(env, 'projects', []), []);
    assert.equal(calls.length, 0);
    const sb = makeSupabase();
    assert.equal(await removePaths(sb, 'projects', ['p/a', 'p/a', 'p/b']), null);
    assert.deepEqual(sb.calls[0].paths, ['p/a', 'p/b']);
  });

  await test('STORAGE_RPC_PAGE_SIZE 可调小；分页仍不漏行', async () => {
    const all = Array.from({ length: 5 }, (_, i) => row(`p/${i}.txt`));
    const { fetchImpl, calls } = fakeRpc((fn, body) => all.slice(body.p_offset, body.p_offset + body.p_limit));
    globalThis.fetch = fetchImpl;
    const rows = await listAllFiles({ ...env, STORAGE_RPC_PAGE_SIZE: '2' }, 'projects', 'p/');
    assert.equal(rows.length, 5);
    assert.deepEqual(calls.map(c => c.body.p_offset), [0, 2, 4]);
    assert.ok(calls.every(c => c.body.p_limit === 2));
  });

  await test('全项目已无 Storage List API 递归调用', () => {
    const roots = ['api/sites', 'api/admin', 'api/utils', 'api/auth'];
    for (const dir of roots) {
      const base = new URL('../' + dir + '/', import.meta.url);
      for (const f of fs.readdirSync(base)) {
        if (!f.endsWith('.js')) continue;
        const s = fs.readFileSync(new URL(f, base), 'utf8');
        assert.ok(!s.includes('/storage/v1/object/list/'), `${dir}/${f} 仍在递归列目录`);
      }
    }
    const files = fs.readFileSync(new URL('../api/sites/files.js', import.meta.url), 'utf8');
    assert.ok(files.includes('listAllFileItems'), 'files.js 必须改用公共函数');
    assert.ok(!/if \(!res\.ok\) return;/.test(files), 'files.js 不能再静默吞掉列目录失败');
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
