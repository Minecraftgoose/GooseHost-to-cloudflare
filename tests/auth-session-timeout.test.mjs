// 会话层超时自测：node tests/auth-session-timeout.test.mjs
// 验证 apiFetch 支持 options.timeoutMs、超时错误带 isTimeout 标记、
// 且自定义字段不会透传给 fetch。用 vm 加载真实 auth-session.js，不发真实网络。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../front/auth-session.js', import.meta.url), 'utf8');

function makeSandbox(fetchImpl) {
  const store = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    AbortController, Headers, URL, Date, Math, JSON, Promise, Error, String, Number, Object, Array,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
      key(i) { return Object.keys(store)[i] ?? null; },
      get length() { return Object.keys(store).length; },
    },
    location: { href: '/admin/', pathname: '/admin/', origin: 'https://page.goose.cc.cd', assign() { }, replace() { } },
    navigator: {},
    fetch: fetchImpl,
    // typeof BroadcastChannel === 'undefined' → bc = null，不启用跨标签页通道
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'front/auth-session.js' });
  return sandbox;
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

async function main() {
  console.log('auth-session 超时自测');

  await test('自定义 timeoutMs 生效：40ms 挂起即超时，且错误带 isTimeout', async () => {
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    };
    const sb = makeSandbox(fetchImpl);
    const t0 = Date.now();
    await assert.rejects(
      () => sb.GHAuth.apiFetch('/api/admin/batch-sites', { method: 'POST', timeoutMs: 40 }),
      e => e.isTimeout === true && e.timeoutMs === 40 && e.message === '请求超时'
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, '不应真的等到默认 15s，实际 ' + elapsed + 'ms');
    assert.equal(calls.length, 1);
    assert.ok(!('timeoutMs' in calls[0].opts), 'timeoutMs 不能透传给 fetch');
    assert.ok(calls[0].opts.signal, 'fetch 仍应收到 AbortSignal');
  });

  await test('不传 timeoutMs 时保持默认 15s 语义（不误伤其它页面）', async () => {
    const fetchImpl = (url, opts) => Promise.resolve({ status: 200, ok: true });
    const sb = makeSandbox(fetchImpl);
    const res = await sb.GHAuth.apiFetch('/api/admin/stats');
    assert.equal(res.status, 200);
  });

  await test('未超时的正常响应原样返回，不打 isTimeout 标记', async () => {
    const sb = makeSandbox(() => Promise.resolve({ status: 200, ok: true }));
    const res = await sb.GHAuth.apiFetch('/api/admin/batch-sites', { method: 'POST', timeoutMs: 500 });
    assert.equal(res.status, 200);
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
