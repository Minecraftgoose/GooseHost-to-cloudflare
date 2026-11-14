// 访问控制 + 限流分层自测：node tests/access-control.test.mjs
// 无第三方依赖。覆盖 IP/CIDR/域名匹配、KV 快照、统一拦截层、
// 短窗口 binding / 长窗口 SQL 分层与降级，以及 SQL / CI / UI 的静态护栏。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BLOCK_SNAPSHOT_KEY, parseIp, parseCidr, compileSnapshot, matchIp, matchEmail,
  normalizeRule, hitsSafeList, getClientIp, isPublicSitePath, isSelfManagePath,
  loadBlockSnapshot, evaluateBlock, evaluateEmail,
} from '../api/utils/block-rules.js';
import { checkRateLimit, RATE_LIMIT_V2, RATE_LIMIT } from '../api/utils/rate-limit.js';
import { isFallbackDisposable, FALLBACK_DISPOSABLE } from '../api/auth/disposable-domains.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
};
const OWNER = 'de90a631-30b0-4b4a-afe4-dba9dd72e288';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

function kvWith(value) {
  const calls = [];
  return {
    calls,
    async get(key) { calls.push(['get', key]); return value; },
    async put(key, val) { calls.push(['put', key, val]); },
  };
}
function req(ip, path = '/api/me', headers = {}) {
  const h = new Headers(headers);
  if (ip) h.set('CF-Connecting-IP', ip);
  return new Request('https://page.example' + path, { headers: h });
}
function snap(rules) { return { version: rules.length, generatedAt: new Date().toISOString(), rules }; }
const rule = (id, kind, value, mode = 'block') => ({ id, kind, value, mode, expiresAt: null });

async function main() {
  console.log('访问控制 / 限流分层自测');

  /* ---- IP 与 CIDR ---- */
  await test('IPv4 / IPv6 解析（含 :: 压缩与 IPv4-mapped）', () => {
    assert.equal(parseIp('1.2.3.4').num, 0x01020304n);
    assert.equal(parseIp('255.255.255.255').num, 0xffffffffn);
    assert.equal(parseIp('2001:db8::1').num, parseIp('2001:0db8:0000:0000:0000:0000:0000:0001').num);
    // IPv4-mapped 归一化成 32 位，避免同一地址存两份
    assert.equal(parseIp('::ffff:1.2.3.4').bits, 32);
    assert.equal(parseIp('::ffff:1.2.3.4').num, parseIp('1.2.3.4').num);
    assert.equal(parseIp('::1').bits, 128);
    for (const bad of ['', '1.2.3', '999.1.1.1', 'abc', '1::2::3', '2001:db8:::1']) {
      assert.equal(parseIp(bad), null, '应拒绝 ' + bad);
    }
  });

  await test('CIDR 解析与匹配（IPv4 / IPv6，不同族不串）', () => {
    assert.deepEqual(parseCidr('10.0.0.0/8').prefix, 8);
    assert.equal(parseCidr('1.2.3.4').prefix, 32);   // 无斜杠 = 单 IP
    assert.equal(parseCidr('10.0.0.0/33'), null);
    const c = compileSnapshot(snap([
      rule(1, 'cidr', '10.0.0.0/8'),
      rule(2, 'cidr', '2001:db8::/32'),
      rule(3, 'ip', '1.2.3.4'),
    ]));
    assert.equal(matchIp('10.20.30.40', c)?.id, 1);
    assert.equal(matchIp('11.0.0.1', c), null);
    assert.equal(matchIp('2001:db8:abcd::1', c)?.id, 2);
    assert.equal(matchIp('2001:db9::1', c), null);
    assert.equal(matchIp('1.2.3.4', c)?.id, 3, '精确 IP 优先');
    assert.equal(matchIp('2001:db8::1', compileSnapshot(snap([rule(9, 'ip', '10.0.0.1')]))), null,
      'IPv4 规则不能命中 IPv6 地址');
  });

  await test('邮箱后缀：精确 + 子域命中，且不误伤相似域名', () => {
    const c = compileSnapshot(snap([
      rule(1, 'email_domain', 'evil.com'),
      rule(2, 'email_domain', 'temp-mail.org'),
    ]));
    assert.equal(matchEmail('a@evil.com', c)?.id, 1);
    assert.equal(matchEmail('a@sub.deep.evil.com', c)?.id, 1);
    assert.equal(matchEmail('a@not-evil.com', c), null);
    assert.equal(matchEmail('a@evil.com.cn', c), null);
    assert.equal(matchEmail('a@temp-mail.org', c)?.id, 2);
    assert.equal(matchEmail('no-at-sign', c), null);
  });

  await test('过期规则与未启用模式不参与判定', () => {
    const c = compileSnapshot(snap([
      { ...rule(1, 'ip', '10.0.0.1'), expiresAt: Date.now() - 1000 },
      { ...rule(2, 'ip', '10.0.0.2'), mode: 'what' },
    ]));
    assert.equal(matchIp('10.0.0.1', c), null);
    assert.equal(matchIp('10.0.0.2', c), null);
  });

  /* ---- 规则归一化 ---- */
  await test('normalizeRule：类型/域名/IP/CIDR 校验，默认 observe', () => {
    assert.equal(normalizeRule({ kind: 'ip', value: '1.2.3.4' }).mode, 'observe');
    assert.equal(normalizeRule({ kind: 'email_domain', value: '@EVIL.com.' }).value, 'evil.com');
    assert.ok(normalizeRule({ kind: 'ip', value: '999.1.1.1' }).error);
    assert.ok(normalizeRule({ kind: 'cidr', value: '1.2.3.0/99' }).error);
    assert.ok(normalizeRule({ kind: 'email_domain', value: 'not a domain' }).error);
    assert.ok(normalizeRule({ kind: 'nope', value: 'x' }).error);
    assert.equal(normalizeRule({ kind: 'ip', value: '1.2.3.4', mode: 'block' }).mode, 'block');
  });

  /* ---- 客户端 IP 与路径豁免 ---- */
  await test('白名单自保：单 IP 落在白名单网段、或新网段覆盖白名单 IP 都拒绝', async () => {
    const e = { BLOCK_SAFE_IPS: '203.0.113.7,10.0.0.0/8,2001:db8::/32' };
    assert.equal(hitsSafeList('203.0.113.7', 'ip', e), true);
    assert.equal(hitsSafeList('10.20.30.40', 'ip', e), true);
    assert.equal(hitsSafeList('2001:db8:beef::1', 'ip', e), true);
    assert.equal(hitsSafeList('8.8.8.8', 'ip', e), false);
    assert.equal(hitsSafeList('203.0.112.0/24', 'cidr', e), false);
    assert.equal(hitsSafeList('203.0.113.0/24', 'cidr', e), true, '覆盖白名单 IP 的网段必须拒绝');
    assert.equal(hitsSafeList('10.0.0.0/8', 'cidr', e), true);
    assert.equal(hitsSafeList('evil.com', 'email_domain', e), false, '邮箱域名不受 IP 白名单影响');
  });

  await test('客户端 IP 只认 CF-Connecting-IP，伪造 XFF 无效', () => {
    assert.equal(getClientIp(req('1.1.1.1')), '1.1.1.1');
    assert.equal(getClientIp(req(null, '/api/me', { 'X-Forwarded-For': '9.9.9.9' })), '');
  });
  await test('公开站点访问与规则管理接口自身豁免', () => {
    assert.equal(isPublicSitePath(['s', 'demo']), true);
    assert.equal(isPublicSitePath(['p', 'demo', 'a.css']), true);
    assert.equal(isPublicSitePath(['md', 'note']), true);
    assert.equal(isPublicSitePath(['api', 'me']), false);
    assert.equal(isSelfManagePath('/api/admin/block-rules'), true);
    assert.equal(isSelfManagePath('/api/admin/block-rules/hits'), true);
    assert.equal(isSelfManagePath('/api/admin/users'), false);
  });

  /* ---- KV 快照 ---- */
  await test('快照读取：per-request memo、无绑定/故障都留痕而非静默', async () => {
    const kv = kvWith(snap([rule(1, 'ip', '10.0.0.1')]));
    const e = { ...env, RATE_LIMIT_KV: kv };
    const r = req('10.0.0.1');
    const a = await loadBlockSnapshot(e, r);
    const b = await loadBlockSnapshot(e, r);
    assert.equal(a, b, '同一次请求复用同一个 promise');
    assert.equal(kv.calls.filter(c => c[0] === 'get').length, 1);
    assert.equal(kv.calls[0][1], BLOCK_SNAPSHOT_KEY);

    const noKv = await loadBlockSnapshot({}, req('1.1.1.1'));
    assert.deepEqual(noKv.rules, []);
    const broken = { RATE_LIMIT_KV: { async get() { throw new Error('kv down'); } } };
    assert.deepEqual((await loadBlockSnapshot(broken, req('1.1.1.1'))).rules, []);
  });

  /* ---- 统一拦截层 ---- */
  await test('evaluateBlock：block / observe / 公开路径 / 安全白名单', async () => {
    const s = snap([
      rule(1, 'ip', '10.0.0.1', 'block'),
      rule(2, 'cidr', '172.16.0.0/12', 'observe'),
    ]);
    const e = { ...env, RATE_LIMIT_KV: kvWith(s) };
    const hit = await evaluateBlock(req('10.0.0.1'), e, '/api/me', ['api', 'me']);
    assert.equal(hit.mode, 'block');
    assert.equal(hit.rule.id, 1);
    const obs = await evaluateBlock(req('172.16.5.5'), e, '/api/me', ['api', 'me']);
    assert.equal(obs.mode, 'observe');
    assert.equal(await evaluateBlock(req('10.0.0.1'), e, '/s/demo', ['s', 'demo']), null);
    assert.equal(await evaluateBlock(req('10.0.0.1'), e, '/api/admin/block-rules', ['api', 'admin', 'block-rules']), null);
    const safe = { ...e, BLOCK_SAFE_IPS: '10.0.0.1,2001:db8::/32' };
    assert.equal(await evaluateBlock(req('10.0.0.1'), safe, '/api/me', ['api', 'me']), null);
    assert.equal(await evaluateBlock(req('8.8.8.8'), e, '/api/me', ['api', 'me']), null);
  });

  await test('evaluateEmail：邮箱后缀只由快照判定', async () => {
    const e = { ...env, RATE_LIMIT_KV: kvWith(snap([rule(7, 'email_domain', 'evil.com', 'block')])) };
    assert.equal((await evaluateEmail(req(null), e, 'a@evil.com')).mode, 'block');
    assert.equal(await evaluateEmail(req(null), e, 'a@gmail.com'), null);
    const obs = { ...env, RATE_LIMIT_KV: kvWith(snap([rule(8, 'email_domain', 'a.com', 'observe')])) };
    assert.equal((await evaluateEmail(req(null), obs, 'x@a.com')).mode, 'observe');
  });

  /* ---- 静态种子兜底 ---- */
  await test('静态种子 461 条，支持子域，快照为空时兜底', () => {
    assert.equal(FALLBACK_DISPOSABLE.size, 461);
    assert.equal(isFallbackDisposable('a@mailinator.com'), true);
    assert.equal(isFallbackDisposable('a@sub.mailinator.com'), true);
    assert.equal(isFallbackDisposable('a@gmail.com'), false);
    const oldSignup = read('api/auth/signup.js');
    assert.ok(!oldSignup.includes('const DISPOSABLE = new Set'), 'signup.js 不能再自带一份黑名单');
    assert.ok(oldSignup.includes('assertEmailAllowed'), 'signup.js 必须走统一守卫');
    assert.ok(read('api/auth/register.js').includes('assertEmailAllowed'));
  });

  /* ---- 限流分层 ---- */
  await test('档位划分：8 个短窗口走 binding，6 个长窗口/lockout 走 SQL', () => {
    assert.equal(Object.keys(RATE_LIMIT).length, 14);
    assert.equal(Object.keys(RATE_LIMIT_V2.shortBindings).length, 8);
    assert.equal(RATE_LIMIT_V2.longActions.size, 6);
    for (const a of RATE_LIMIT_V2.longActions) {
      assert.ok(!RATE_LIMIT_V2.shortBindings[a], a + ' 不能同时出现在两层');
    }
    // 长窗口档的 windowSec 都 >= 60；其中 5 个是 3600
    assert.equal([...RATE_LIMIT_V2.longActions].filter(a => RATE_LIMIT[a].windowSec === 3600).length, 5);
    assert.equal(RATE_LIMIT.create.lockoutSec, 600);
  });

  await test('短窗口：binding 命中即返回，不发 SQL RPC', async () => {
    const calls = [];
    const binding = { async limit({ key }) { calls.push(key); return { success: true }; } };
    const e = { ...env, RL_100_60: binding };
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('短窗口不该查库'); };
    try {
      const r = await checkRateLimit(req('1.1.1.1'), e, 'normal');
      assert.equal(r.allowed, true);
      assert.equal(r.source, 'binding');
      assert.equal(calls[0], 'normal:1.1.1.1');
    } finally { globalThis.fetch = original; }
  });

  await test('短窗口：binding 返回 success=false → 429 语义（allowed=false）', async () => {
    const e = { ...env, RL_20_60: { async limit() { return { success: false }; } } };
    const r = await checkRateLimit(req('1.1.1.1'), e, 'login');
    assert.equal(r.allowed, false);
    assert.equal(r.source, 'binding');
  });

  await test('长窗口：走 SQL RPC，dim 是哈希且不传明文 IP/邮箱', async () => {
    let captured = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => '', json: async () => ({ allowed: true, count: 1, resetIn: 0, locked: false }) };
    };
    try {
      const r = await checkRateLimit(req('1.2.3.4'), { ...env, RL_100_60: {} }, 'forgot_email', 'A@Example.COM');
      assert.equal(r.source, 'sql');
      assert.equal(r.allowed, true);
      assert.match(String(captured.url), /\/rest\/v1\/rpc\/admin_rate_check$/);
      assert.equal(captured.body.p_action, 'forgot_email');
      assert.equal(captured.body.p_limit, 3);
      assert.equal(captured.body.p_window_sec, 3600);
      assert.equal(captured.body.p_lockout_sec, 0);
      assert.match(captured.body.p_dim, /^[0-9a-f]{40}$/);
      assert.ok(!JSON.stringify(captured.body).includes('1.2.3.4'), '不能传明文 IP');
      assert.ok(!JSON.stringify(captured.body).toLowerCase().includes('a@example.com'), '不能传明文邮箱');
    } finally { globalThis.fetch = original; }
  });

  await test('create 档的 lockout 参数原样下推（2 次/60s，锁 600s）', async () => {
    let body = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => '', json: async () => ({ allowed: false, count: 3, resetIn: 600, locked: true }) };
    };
    try {
      const r = await checkRateLimit(req('1.1.1.1'), env, 'create');
      assert.equal(body.p_lockout_sec, 600);
      assert.equal(body.p_window_sec, 60);
      assert.equal(r.locked, true);
      assert.equal(r.allowed, false);
    } finally { globalThis.fetch = original; }
  });

  await test('binding 未绑定 → 自动降级 SQL，带 degraded 标记（不静默放行）', async () => {
    let hit = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      hit = true;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ allowed: true, count: 1, resetIn: 0, locked: false }) };
    };
    try {
      const r = await checkRateLimit(req('1.1.1.1'), env, 'normal');
      assert.equal(hit, true, '必须真的查库，不能 fail-open 了事');
      assert.equal(r.source, 'sql-fallback');
      assert.equal(r.degraded, true);
      assert.equal(r.allowed, true);
    } finally { globalThis.fetch = original; }
  });

  await test('SQL 也失败 → fail-open，但返回 degraded 且写结构化日志', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'busy', json: async () => ({}) });
    try {
      const r = await checkRateLimit(req('1.1.1.1'), env, 'reg_ip');
      assert.equal(r.allowed, true);
      assert.equal(r.degraded, true);
      assert.equal(r.source, 'sql-fail-open');
    } finally { globalThis.fetch = original; }
  });

  /* ---- SQL / CI / UI 静态护栏 ---- */
  await test('SQL 迁移：RLS + revoke + 4 个函数 + 461 条 seed', () => {
    const sql = read('sql/access_control.sql');
    for (const t of ['gh_block_rules', 'gh_block_hits', 'gh_rate_events', 'gh_rate_locks']) {
      assert.ok(sql.includes(`create table if not exists public.${t}`), '缺表 ' + t);
      assert.ok(new RegExp(`alter table public\\.${t} enable row level security`).test(sql), t + ' 未启用 RLS');
    }
    for (const fn of ['admin_block_rules_page', 'admin_block_snapshot', 'admin_block_hit', 'admin_rate_check']) {
      assert.ok(sql.includes(`create or replace function public.${fn}(`), '缺函数 ' + fn);
      assert.ok(sql.includes(`grant execute on function public.${fn}(`), fn + ' 未授权 service_role');
    }
    assert.ok((sql.match(/revoke all on function public\./g) || []).length >= 4);
    assert.ok(sql.includes("set search_path = ''"));
    assert.ok(sql.includes('on conflict (action, dim) do update'), 'lockout 必须原子');
    assert.ok(sql.includes('ts >= v_now - v_window'), '必须是滑动窗口而非整点清零');
    const seed = sql.match(/from unnest\(array\[([\s\S]*?)\]\) as d/)[1];
    assert.equal((seed.match(/'[^']+'/g) || []).length, 461, 'seed 域名数应为 461');
    assert.ok(!sql.includes('SEED_PLACEHOLDER'));
  });

  await test('wrangler.toml：5 个限流绑定 + 安全白名单，period 只 10/60', () => {
    const w = read('api/wrangler.toml');
    assert.equal((w.match(/\[\[ratelimits\]\]/g) || []).length, 5);
    for (const n of ['RL_10_10', 'RL_10_60', 'RL_100_60', 'RL_20_60', 'RL_40_60']) {
      assert.ok(w.includes(`name = "${n}"`), '缺绑定 ' + n);
    }
    assert.ok(w.includes('BLOCK_SAFE_IPS'));
    assert.ok(w.includes('STORAGE_RPC_PAGE_SIZE'));
    const periods = [...w.matchAll(/period = (\d+)/g)].map(m => Number(m[1]));
    assert.ok(periods.every(p => p === 10 || p === 60), 'binding period 只能是 10 或 60');
    const ids = [...w.matchAll(/namespace_id = "(\d+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'namespace_id 必须账号内唯一');
  });

  await test('GitHub Actions：自测门禁 + Wrangler 版本校验 + 独立 WAF workflow', () => {
    const d = read('.github/workflows/deploy.yml');
    assert.ok(d.includes('needs: test'), '部署必须挂在自测门禁之后');
    assert.ok(d.includes('Verify Wrangler supports ratelimits binding'));
    assert.ok(d.includes('4.36'));
    assert.ok(d.includes('sql/access_control.sql'), '部署摘要要提示 SQL 迁移');
    assert.ok(d.includes('tests/*.mjs'), '自测门禁必须覆盖 .smoke.mjs');
    assert.ok(d.includes('npx wrangler deploy'));
    const pkg = JSON.parse(read('api/package.json'));
    const [maj, min] = String(pkg.devDependencies.wrangler).replace(/[^\d.]/g, '').split('.').map(Number);
    assert.ok(maj > 4 || (maj === 4 && min >= 36), 'devDependencies 的 wrangler 必须 >= 4.36');

    const waf = read('.github/workflows/waf-setup.yml');
    assert.ok(waf.includes('workflow_dispatch'), 'WAF 规则不应挂在每次 push 上');
    assert.ok(waf.includes('scripts/waf-setup.sh'));
    const sh = read('scripts/waf-setup.sh');
    assert.ok(sh.includes('"period": 10'), '免费版周期只能 10s');
    assert.ok(sh.includes('"mitigation_timeout": 10'));
    assert.ok(sh.includes('RULE_DESC='), '必须按 description 幂等');
  });

  await test('后台 UI：封锁规则视图 / 侧栏 / 构建号一致', () => {
    const ui = read('front/admin/app.js');
    const html = read('front/admin/index.html');
    assert.ok(ui.includes("case 'blocks': await renderBlocks(token); break;"));
    assert.ok(ui.includes('async function renderBlocks'));
    assert.ok(html.includes('data-nav="blocks"'));
    assert.ok(ui.includes("data-filter=\"blocks-kind\""));
    assert.ok(ui.includes("data-action=\"block-save\""));
    assert.ok(ui.includes("data-action=\"block-hits\""));
    assert.ok(ui.includes('BLOCK_SAFE_IPS'));
    const build = (html.match(/build (\d{8}[a-z])/) || [])[1];
    assert.equal(build, '20261114b');
    assert.ok(read('tests/admin-ui.smoke.mjs').includes('20261114b'));
  });

  await test('主入口：统一拦截层在所有路由之前，且新接口已注册', () => {
    const idx = read('api/index.js');
    const pos = idx.indexOf('await evaluateBlock(');
    assert.ok(pos > 0, '缺少统一拦截层');
    assert.ok(pos < idx.indexOf("url.pathname === '/api/register'"), '拦截层必须在业务路由之前');
    assert.ok(idx.includes("pathParts[2] === 'block-rules'"));
    assert.ok(idx.includes('recordBlockHit'));
    assert.ok(idx.includes("import { handleAdminBlockRules }"));
  });

  await test('全 api 不再有旧的 KV 计数器与静默 catch', () => {
    const rl = read('api/utils/rate-limit.js');
    assert.ok(!rl.includes('RATE_LIMIT_KV'), '计数器不能再用 KV 读改写');
    assert.ok(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(rl), '不能有空 catch');
    assert.ok(rl.includes('degraded'), '降级必须可观测');
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
