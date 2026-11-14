// 管理后台接口自测：node tests/admin-api.test.mjs
// 用假的 Supabase client 在内存里复刻 sql/admin_perf.sql 的 RPC 行为：
// 覆盖过滤 / 排序 / 分页 / 总数 / 站点数聚合 / 统计 / 批量封禁与删除。
// 不触碰真实网络 / 真实数据库。
//
// v2 重点：列表接口只允许发 **一次** rpc，不允许再出现
// auth.admin.listUsers 分页拉全量 或 from('gh_site') 拉全量。

import assert from 'node:assert/strict';
import {
  publicUser, cleanSearch, pager, pagePayload, todayStartCST,
  rpc, siteTotals, getUserBriefs, emailMapFromDb,
} from '../api/utils/admin-data.js';
import { listAdminUsersCore, adminUserDetailCore } from '../api/admin/users.js';
import { listAdminSitesCore } from '../api/admin/sites.js';
import { adminStatsCore } from '../api/admin/stats.js';
import {
  normalizeBanDuration, parseUserIds, parseSiteNames,
  MAX_BATCH_USERS, MAX_BATCH_BAN_USERS, MAX_BATCH_SITES,
  setUserBanCore, deleteUserCore, runBatch,
} from '../api/utils/admin-actions.js';
import { batchUsersCore, batchSitesCore } from '../api/admin/batch.js';

let envSeq = 0;
function env() {
  envSeq++;
  return {
    SUPABASE_URL: `https://test-${envSeq}-${Date.now()}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    API_URL: 'https://page.goose.cc.cd',
  };
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function user(id, email, nickname, extra = {}) {
  return {
    id, email,
    created_at: extra.created_at || '2026-01-02T03:04:05Z',
    last_sign_in_at: extra.last_sign_in_at ?? null,
    updated_at: extra.updated_at || '2026-02-01T00:00:00Z',
    email_confirmed_at: extra.email_confirmed_at || '2026-01-02T03:10:00Z',
    user_metadata: { nickname, ...(extra.meta || {}) },
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [{ provider: 'email' }],
    is_anonymous: false,
    banned_until: null,
  };
}

function site(name, ownerId, extra = {}) {
  return {
    id: name,
    name,
    type: extra.type || 'html',
    owner_id: ownerId,
    ip_address: extra.ip_address || '1.2.3.4',
    created_at: extra.created_at || '2026-03-01T00:00:00Z',
    updated_at: extra.updated_at || '2026-03-02T00:00:00Z',
    visit_count: extra.visit_count ?? 0,
  };
}

function nicknameOf(u) {
  const m = u.user_metadata || {};
  return m.nickname || m.name || m.full_name || m.display_name || m.user_name || m.preferred_username || '';
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function time(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; }

/** 在内存里复刻 Postgres RPC：过滤 → 排序 → 窗口 total_count → limit/offset */
function fakeSupabase({ users = [], sites = [], rpcImpl = null } = {}) {
  const calls = [];
  const auth = {
    admin: {
      async getUserById(uid) {
        const u = users.find(x => x.id === uid);
        return u ? { data: { user: u }, error: null } : { data: null, error: { message: 'not found' } };
      },
      async listUsers() { throw new Error('禁止再分页拉全量 Auth 用户（性能回归）'); },
    },
  };

  function userPage(a) {
    const counts = new Map();
    for (const s of sites) counts.set(String(s.owner_id), (counts.get(String(s.owner_id)) || 0) + 1);
    let rows = users.map(u => ({
      uid: u.id, email: u.email, name: nicknameOf(u),
      created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
      updated_at: u.updated_at, email_confirmed_at: u.email_confirmed_at,
      banned_until: u.banned_until, is_anonymous: !!u.is_anonymous,
      provider: 'email', site_count: counts.get(String(u.id)) || 0,
    }));
    const q = String(a.p_q || '').toLowerCase();
    if (q) rows = rows.filter(r => [r.email, r.name, r.uid, r.provider].some(v => String(v || '').toLowerCase().includes(q)));
    const dir = a.p_dir === 'asc' ? 1 : -1;
    rows.sort((x, y) => {
      let av, bv;
      if (a.p_sort === 'createdAt' || a.p_sort === 'lastSignInAt') {
        const k = a.p_sort === 'createdAt' ? 'created_at' : 'last_sign_in_at';
        // nulls last（两种方向都把空值放最后）
        if (!x[k]) return !y[k] ? 0 : 1;
        if (!y[k]) return -1;
        av = time(x[k]); bv = time(y[k]);
      } else if (a.p_sort === 'siteCount') { av = x.site_count; bv = y.site_count; }
      else { const k = a.p_sort === 'email' ? 'email' : 'name'; av = String(x[k] || '').toLowerCase(); bv = String(y[k] || '').toLowerCase(); }
      return cmp(av, bv) * dir || cmp(x.uid, y.uid);
    });
    const total = rows.length;
    return rows.slice(a.p_offset, a.p_offset + a.p_limit).map(r => ({ ...r, total_count: total }));
  }

  function sitePage(a) {
    const byUid = new Map(users.map(u => [u.id, u]));
    let rows = sites.map(s => {
      const u = byUid.get(s.owner_id);
      return {
        id: String(s.id), name: s.name, type: s.type || 'html',
        owner_id: String(s.owner_id),
        owner_email: u?.email || '', owner_name: u ? nicknameOf(u) : '',
        ip_address: s.ip_address || '', created_at: s.created_at, updated_at: s.updated_at,
        visit_count: Number(s.visit_count) || 0,
      };
    });
    if (a.p_type) rows = rows.filter(r => r.type === a.p_type);
    if (a.p_owner_id) rows = rows.filter(r => r.owner_id === a.p_owner_id);
    const q = String(a.p_q || '').toLowerCase();
    if (q) rows = rows.filter(r => [r.name, r.owner_email, r.owner_name, r.owner_id, r.ip_address, r.type]
      .some(v => String(v || '').toLowerCase().includes(q)));
    const dir = a.p_dir === 'asc' ? 1 : -1;
    rows.sort((x, y) => {
      let av, bv;
      if (a.p_sort === 'createdAt' || a.p_sort === 'updatedAt') {
        const k = a.p_sort === 'createdAt' ? 'created_at' : 'updated_at';
        av = time(x[k]); bv = time(y[k]);
      } else if (a.p_sort === 'visitCount') { av = x.visit_count; bv = y.visit_count; }
      else { const k = a.p_sort === 'ownerEmail' ? 'owner_email' : 'name'; av = String(x[k] || '').toLowerCase(); bv = String(y[k] || '').toLowerCase(); }
      return cmp(av, bv) * dir || cmp(x.id, y.id);
    });
    const total = rows.length;
    return rows.slice(a.p_offset, a.p_offset + a.p_limit).map(r => ({ ...r, total_count: total }));
  }

  function overview() {
    const now = Date.now();
    const today = todayStartCST();
    const counts = new Map();
    for (const s of sites) counts.set(String(s.owner_id), (counts.get(String(s.owner_id)) || 0) + 1);
    const byType = { html: 0, md: 0, project: 0 };
    let totalVisits = 0, sitesToday = 0;
    for (const s of sites) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      totalVisits += Number(s.visit_count) || 0;
      if (time(s.created_at) >= today) sitesToday++;
    }
    const byUid = new Map(users.map(u => [u.id, u]));
    const recentSites = [...sites].sort((a, b) => time(b.created_at) - time(a.created_at)).slice(0, 6).map(s => {
      const u = byUid.get(s.owner_id);
      return {
        id: String(s.id), name: s.name, type: s.type || 'html',
        ownerId: String(s.owner_id), ownerEmail: u?.email || '', ownerName: u ? nicknameOf(u) : '',
        createdAt: s.created_at, updatedAt: s.updated_at, visitCount: Number(s.visit_count) || 0,
      };
    });
    const recentUsers = [...users].sort((a, b) => time(b.created_at) - time(a.created_at)).slice(0, 6).map(u => ({
      uid: u.id, email: u.email, name: nicknameOf(u), createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at, siteCount: counts.get(String(u.id)) || 0,
    }));
    return [{
      payload: {
        totalSites: sites.length, totalUsers: users.length, totalVisits,
        sitesToday, usersToday: users.filter(u => time(u.created_at) >= today).length,
        activeUsers7d: users.filter(u => time(u.last_sign_in_at) >= now - 7 * 86400e3).length,
        byType, recentSites, recentUsers,
      },
    }];
  }

  const defaultRpc = async (fn, a) => {
    switch (fn) {
      case 'admin_user_page': return { data: userPage(a), error: null };
      case 'admin_site_page': return { data: sitePage(a), error: null };
      case 'admin_overview_stats': return { data: overview(), error: null };
      case 'admin_user_briefs': {
        const ids = new Set(a.p_ids || []);
        return { data: users.filter(u => ids.has(u.id)).map(u => ({
          uid: u.id, email: u.email, name: nicknameOf(u),
          created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
          email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until,
          is_anonymous: false, provider: 'email', site_count: 0,
        })), error: null };
      }
      case 'site_totals': return { data: [{
        total_sites: sites.length,
        total_visits: sites.reduce((n, s) => n + (Number(s.visit_count) || 0), 0),
      }], error: null };
      case 'admin_email_map': return { data: [{
        payload: Object.fromEntries(users.map(u => [u.id, u.email])),
      }], error: null };
      default: return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    }
  };
  const impl = rpcImpl || defaultRpc;

  return {
    auth,
    _calls: calls,
    async rpc(fn, args) { calls.push({ fn, args }); return await impl(fn, args || {}); },
    from(table) {
      if (table !== 'gh_site') throw new Error('unexpected table: ' + table);
      const q = {};
      const api = {
        select(cols, opts) { q.cols = cols; q.opts = opts || {}; return api; },
        eq(f, v) { q.eq = [f, v]; return api; },
        order(f, o) { q.order = [f, o]; return api; },
        limit(n) { q.limit = n; return api; },
        range(a, b) { q.range = [a, b]; return api; },
        then(resolve) {
          let out = sites.slice();
          if (q.eq) out = out.filter(r => r[q.eq[0]] === q.eq[1]);
          if (q.order) {
            const [f, o] = q.order;
            out = [...out].sort((x, y) => o?.ascending === false
              ? String(y[f] ?? '').localeCompare(String(x[f] ?? ''))
              : String(x[f] ?? '').localeCompare(String(y[f] ?? '')));
          }
          const [from, to] = q.range || [0, (q.limit || 1000) - 1];
          resolve({ data: out.slice(from, to + 1), error: null, count: out.length });
        },
      };
      return api;
    },
  };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

async function main() {
  console.log('admin-api 自测（RPC 数据层）');

  await test('publicUser 映射 Auth 官方字段（含名字/注册/最后登录/ providers）', () => {
    const u = user(U1, 'a@example.com', '小明', { last_sign_in_at: '2026-05-06T07:08:09Z' });
    const p = publicUser(u);
    assert.equal(p.uid, U1);
    assert.equal(p.id, U1);
    assert.equal(p.email, 'a@example.com');
    assert.equal(p.name, '小明');
    assert.equal(p.createdAt, '2026-01-02T03:04:05Z');
    assert.equal(p.lastSignInAt, '2026-05-06T07:08:09Z');
    assert.equal(p.provider, 'email');
    assert.deepEqual(p.providers, ['email']);
    assert.equal(p.isAnonymous, false);
  });

  await test('publicUser 兼容 user_metadata 常见名字别名', () => {
    const raw = { id: U2, email: 'b@example.com', user_metadata: { full_name: '王五' }, created_at: '2026-01-01T00:00:00Z' };
    assert.equal(publicUser(raw).name, '王五');
    assert.equal(publicUser(raw).lastSignInAt, null);
  });

  await test('cleanSearch 去掉查询语法噪声字符', () => {
    assert.equal(cleanSearch('a,"b()*%.\\c'), 'a b c');
    assert.equal(cleanSearch('  x  '), 'x');
  });

  await test('pager / pagePayload 分页元数据正确', () => {
    const p = pager(new URLSearchParams('page=3&limit=20'));
    assert.deepEqual(p, { limit: 20, offset: 40, page: 3 });
    assert.deepEqual(pagePayload(p, 95, 20), { limit: 20, offset: 40, page: 3, total: 95, totalPages: 5, hasMore: true });
  });

  await test('列表只发 1 次 RPC，绝不拉全量用户/站点（P0 性能回归护栏）', async () => {
    const sb = fakeSupabase({ users: [user(U1, 'a@example.com', 'A')], sites: [site('a1', U1)] });
    const d = await listAdminUsersCore(sb, env(), new URLSearchParams('page=1'));
    assert.equal(d.users.length, 1);
    assert.equal(sb._calls.length, 1, '用户列表应只有一次 admin_user_page 调用');
    assert.equal(sb._calls[0].fn, 'admin_user_page');
    assert.deepEqual(sb._calls[0].args, {
      p_q: '', p_sort: 'createdAt', p_dir: 'desc', p_limit: 25, p_offset: 0,
    });

    const sb2 = fakeSupabase({ users: [user(U1, 'a@example.com', 'A')], sites: [site('a1', U1)] });
    await listAdminSitesCore(sb2, env(), new URLSearchParams());
    assert.equal(sb2._calls.length, 1);
    assert.equal(sb2._calls[0].fn, 'admin_site_page');
  });

  await test('listAdminUsersCore：六项字段齐全 + 站点数来自 SQL 聚合', async () => {
    const sb = fakeSupabase({
      users: [
        user(U1, 'a@example.com', '小明', { last_sign_in_at: '2026-05-01T00:00:00Z' }),
        user(U2, 'b@example.com', '小红'),
      ],
      sites: [site('a1', U1), site('a2', U1, { type: 'project' }), site('b1', U2, { type: 'md' })],
    });
    const data = await listAdminUsersCore(sb, env(), new URLSearchParams());
    assert.equal(data.users.length, 2);
    const a = data.users.find(u => u.uid === U1);
    assert.equal(a.email, 'a@example.com');
    assert.equal(a.name, '小明');
    assert.equal(a.createdAt, '2026-01-02T03:04:05Z');
    assert.equal(a.lastSignInAt, '2026-05-01T00:00:00Z');
    assert.equal(a.siteCount, 2);
    assert.equal(data.users.find(u => u.uid === U2).siteCount, 1);
    assert.equal(data.pagination.total, 2);
    assert.equal(data.meta.source, 'postgres-rpc');
  });

  await test('用户列表：没建站的用户也会出现', async () => {
    const sb = fakeSupabase({
      users: [user(U1, 'a@example.com', '小明'), user(U3, 'c@example.com', '无站点')],
      sites: [site('a1', U1)],
    });
    const data = await listAdminUsersCore(sb, env(), new URLSearchParams());
    assert.equal(data.pagination.total, 2);
    assert.equal(data.users.find(u => u.uid === U3).siteCount, 0);
  });

  await test('用户列表：搜索/排序/分页参数下推到 SQL', async () => {
    const sb = fakeSupabase({
      users: [user(U1, 'alpha@example.com', '阿法'), user(U2, 'beta@example.com', '贝塔')],
      sites: [],
    });
    const byEmail = await listAdminUsersCore(sb, env(), new URLSearchParams('q=ALPHA@'));
    assert.equal(byEmail.users.length, 1);
    assert.equal(byEmail.users[0].uid, U1);
    assert.equal(sb._calls.at(-1).args.p_q, 'alpha@');

    const byName = await listAdminUsersCore(sb, env(), new URLSearchParams('q=' + encodeURIComponent('贝塔')));
    assert.equal(byName.users[0].uid, U2);

    const sorted = await listAdminUsersCore(sb, env(), new URLSearchParams('sort=email&dir=asc&limit=1&page=2'));
    assert.equal(sorted.pagination.total, 2);
    assert.equal(sorted.users.length, 1);
    assert.deepEqual({ ...sb._calls.at(-1).args }, {
      p_q: '', p_sort: 'email', p_dir: 'asc', p_limit: 1, p_offset: 1,
    });
  });

  await test('用户列表：按最后登录时间排序，null 排最后', async () => {
    const sb = fakeSupabase({
      users: [
        user(U1, 'a@example.com', 'A', { last_sign_in_at: '2026-01-01T00:00:00Z' }),
        user(U2, 'b@example.com', 'B', { last_sign_in_at: '2026-09-01T00:00:00Z' }),
        user(U3, 'c@example.com', 'C'),
      ],
      sites: [],
    });
    const data = await listAdminUsersCore(sb, env(), new URLSearchParams('sort=lastSignInAt&dir=desc'));
    assert.deepEqual(data.users.map(u => u.uid), [U2, U1, U3]);
  });

  await test('用户列表：分页与总数精确（RPC 返回 total_count）', async () => {
    const users = Array.from({ length: 27 }, (_, i) => user(
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      `u${i}@example.com`, `用户${i}`
    ));
    const data = await listAdminUsersCore(fakeSupabase({ users }), env(), new URLSearchParams('page=2&limit=10'));
    assert.equal(data.users.length, 10);
    assert.equal(data.pagination.total, 27);
    assert.equal(data.pagination.totalPages, 3);
    assert.equal(data.pagination.hasMore, true);
  });

  await test('RPC 缺失时给出可执行指引，而不是静默退化全量扫描', async () => {
    const sb = fakeSupabase({ rpcImpl: async () => ({
      data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_user_page' },
    }) });
    await assert.rejects(() => rpc(sb, 'admin_user_page', {}), e =>
      e.missingMigration === true && e.status === 503 && e.message.includes('sql/admin_perf.sql'));
    await assert.rejects(() => listAdminUsersCore(sb, env(), new URLSearchParams()), /sql\/admin_perf\.sql/);
  });

  await test('用户详情：getUserById + 名下站点 + 按类型汇总', async () => {
    const sb = fakeSupabase({
      users: [user(U1, 'a@example.com', '小明'), user(U2, 'b@example.com', '小红')],
      sites: [
        site('a1', U1, { created_at: '2026-01-01T00:00:00Z', visit_count: 5 }),
        site('a2', U1, { type: 'project', created_at: '2026-06-01T00:00:00Z', visit_count: 7 }),
        site('a3', U1, { type: 'md', created_at: '2026-02-01T00:00:00Z', visit_count: 2 }),
        site('b1', U2, { visit_count: 999 }),
      ],
    });
    const d = await adminUserDetailCore(sb, env(), U1);
    assert.equal(d.user.email, 'a@example.com');
    assert.equal(d.user.name, '小明');
    assert.equal(d.sites.length, 3);
    assert.ok(d.sites.every(s => s.ownerId === U1));
    assert.ok(d.sites.every(s => s.ownerEmail === 'a@example.com'));
    assert.ok(d.sites[0].url.startsWith('https://page.goose.cc.cd/'));
    assert.deepEqual(d.summary.byType, { html: 1, md: 1, project: 1 });
    assert.equal(d.summary.totalVisits, 14);
    assert.equal(d.summary.siteCount, 3);
    assert.equal(d.summary.lastCreatedAt, '2026-06-01T00:00:00Z');
  });

  await test('站点列表：类型/所有者筛选、按所有者邮箱搜索、分页', async () => {
    const sb = fakeSupabase({
      users: [user(U1, 'alpha@example.com', '阿法'), user(U2, 'beta@example.com', '贝塔')],
      sites: [site('a1', U1), site('a2', U1, { type: 'project' }), site('b1', U2, { type: 'md' })],
    });
    const byType = await listAdminSitesCore(sb, env(), new URLSearchParams('type=project'));
    assert.equal(byType.sites.length, 1);
    assert.equal(byType.sites[0].name, 'a2');
    assert.equal(sb._calls.at(-1).args.p_type, 'project');

    const byEmail = await listAdminSitesCore(sb, env(), new URLSearchParams('q=beta@'));
    assert.equal(byEmail.sites.length, 1);
    assert.equal(byEmail.sites[0].ownerEmail, 'beta@example.com');

    const byOwner = await listAdminSitesCore(sb, env(), new URLSearchParams('ownerId=' + U1 + '&limit=1&page=2'));
    assert.equal(byOwner.pagination.total, 2);
    assert.equal(byOwner.sites.length, 1);
  });

  await test('站点列表：所有者信息由 SQL JOIN auth.users 提供（不是 email-map 副本）', async () => {
    const sb = fakeSupabase({ users: [user(U1, 'real@example.com', '真名')], sites: [site('s1', U1)] });
    const d = await listAdminSitesCore(sb, env(), new URLSearchParams());
    assert.equal(d.sites[0].ownerEmail, 'real@example.com');
    assert.equal(d.sites[0].ownerName, '真名');
  });

  await test('概览统计：一次 RPC 返回全部数字（含无站点用户）', async () => {
    const now = Date.now();
    const cstToday = todayStartCST();
    assert.ok(cstToday <= now && now - cstToday < 24 * 3600 * 1000, '当天 00:00 CST 应落在过去 24h 内');

    // 关键：不能用 now - 1h 当「今天」——CST 刚过零点时那属于昨天，
    // 会让 sitesToday / usersToday 在 00:00~01:00 之间随机变成 0（flaky）。
    // 一律相对 CST 当天零点构造，任何时刻跑结果都稳定。
    const todayTs = new Date(cstToday + 60 * 1000).toISOString();          // 今天 00:01 CST
    const yesterdayTs = new Date(cstToday - 24 * 3600e3).toISOString();      // 昨天 00:00 CST
    const within7d = new Date(now - 60 * 1000).toISOString();                // 近 7 日内

    const sb = fakeSupabase({
      users: [
        user(U1, 'a@example.com', 'A', {
          created_at: todayTs,
          last_sign_in_at: within7d,
        }),
        user(U2, 'b@example.com', 'B', { created_at: yesterdayTs, last_sign_in_at: '2020-01-02T00:00:00Z' }),
        user(U3, 'c@example.com', 'C', { created_at: yesterdayTs }),
      ],
      sites: [
        site('a1', U1, { created_at: todayTs, visit_count: 10 }),
        site('a2', U1, { type: 'md', created_at: yesterdayTs, visit_count: 3 }),
        site('a3', U1, { type: 'project', created_at: yesterdayTs, visit_count: 4 }),
      ],
    });
    const s = await adminStatsCore(sb, env());
    assert.equal(s.totalSites, 3);
    assert.equal(s.totalUsers, 3);
    assert.equal(s.sitesToday, 1);
    assert.equal(s.usersToday, 1);
    assert.equal(s.activeUsers7d, 1);
    assert.equal(s.totalVisits, 17);
    assert.deepEqual(s.byType, { html: 1, md: 1, project: 1 });
    assert.equal(s.recentSites.length, 3);
    assert.equal(s.recentUsers.length, 3);
    assert.equal(s.recentUsers[0].siteCount, 3);
    assert.equal(sb._calls.length, 1, '概览只能有一次 RPC');
    assert.equal(sb._calls[0].fn, 'admin_overview_stats');
  });

  await test('公开统计 site_totals：一次聚合替代 1+N 次分页累加', async () => {
    const sb = fakeSupabase({ sites: [site('a', U1, { visit_count: 3 }), site('b', U2, { visit_count: 7 })] });
    const t = await siteTotals(sb);
    assert.deepEqual(t, { total_sites: 2, total_visits: 10 });
    assert.equal(sb._calls.length, 1);
    assert.equal(sb._calls[0].fn, 'site_totals');
  });

  await test('getUserBriefs 只查当前页 uid，不再拉全量 Auth 用户', async () => {
    const sb = fakeSupabase({ users: [user(U1, 'a@example.com', 'A'), user(U2, 'b@example.com', 'B')] });
    const m = await getUserBriefs(sb, [U1, U1, 'nope']);
    assert.equal(m.size, 1);
    assert.equal(m.get(U1).email, 'a@example.com');
    assert.equal(sb._calls.length, 1);
    assert.deepEqual(sb._calls[0].args.p_ids, [U1, 'nope']);
  });

  await test('emailMapFromDb：一次 RPC 出全量映射', async () => {
    const sb = fakeSupabase({ users: [user(U1, 'a@example.com', 'A'), user(U2, 'b@example.com', 'B')] });
    const map = await emailMapFromDb(sb);
    assert.equal(map[U1], 'a@example.com');
    assert.equal(sb._calls[0].fn, 'admin_email_map');
    assert.equal(sb._calls.length, 1);
  });

  /* ---- 封禁 / 批量 ---- */
  await test('normalizeBanDuration 只放行官方 Go 时长格式白名单', () => {
    assert.equal(normalizeBanDuration('168h'), '168h');
    assert.equal(normalizeBanDuration('DROP TABLE'), '876000h');
    assert.equal(normalizeBanDuration(''), '876000h');
  });

  await test('parseUserIds 去重、校验 UUID、限制单次数量', () => {
    assert.deepEqual(parseUserIds([U1, U1, U2]).ids, [U1, U2]);
    assert.ok(parseUserIds(['not-a-uuid']).error);
    assert.ok(parseUserIds([]).error);
    assert.ok(parseUserIds('x').error);
    const many = Array.from({ length: 26 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    assert.ok(parseUserIds(many).error.includes('最多'));
  });

  await test('parseSiteNames 去重、限制数量、拒绝控制字符', () => {
    assert.deepEqual(parseSiteNames(['a', 'a', '中文站点']).names, ['a', '中文站点']);
    assert.ok(parseSiteNames(['a\u0000b']).error);
    assert.ok(parseSiteNames(Array.from({ length: 51 }, (_, i) => 's' + i)).error);
  });

  await test('setUserBanCore 走官方 updateUserById(ban_duration) 并检查 error', async () => {
    const e = env();
    const calls = [];
    const sb = { auth: { admin: { async updateUserById(uid, attrs) {
      calls.push([uid, attrs]);
      return { data: { user: { id: uid, banned_until: attrs.ban_duration === 'none' ? null : '2099-01-01T00:00:00Z' } }, error: null };
    } } } };
    const banned = await setUserBanCore(sb, e, U1, 'ban', '24h');
    assert.deepEqual(calls[0], [U1, { ban_duration: '24h' }]);
    assert.equal(banned.banDuration, '24h');
    assert.equal(banned.bannedUntil, '2099-01-01T00:00:00Z');
    assert.ok(banned.note.includes('access token'));

    const unbanned = await setUserBanCore(sb, e, U1, 'unban', 'ignored');
    assert.deepEqual(calls[1], [U1, { ban_duration: 'none' }]);
    assert.equal(unbanned.bannedUntil, null);

    const failing = { auth: { admin: { async updateUserById() { return { data: null, error: { message: 'GoTrue 500' } }; } } } };
    await assert.rejects(() => setUserBanCore(failing, env(), U1, 'ban', '24h'), /封禁失败/);
  });

  await test('runBatch 逐项独立：单项失败不阻断后续', async () => {
    const r = await runBatch(['a', 'b', 'c'], async id => {
      if (id === 'b') throw new Error('炸了');
      return { deletedSites: 1 };
    });
    assert.equal(r.total, 3);
    assert.equal(r.succeeded, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.results[1].error, '炸了');
  });

  await test('batchUsersCore 封禁报告：跳过当前管理员、其余继续执行', async () => {
    const e = env();
    const calls = [];
    const sb = { auth: { admin: { async updateUserById(uid, attrs) {
      calls.push([uid, attrs.ban_duration]);
      return { data: { user: { id: uid, banned_until: '2099-01-01T00:00:00Z' } }, error: null };
    } } } };
    const { status, data } = await batchUsersCore(sb, e, { action: 'ban', userIds: [U1, U2], duration: '168h' }, U1);
    assert.equal(status, 200);
    assert.equal(data.total, 2);
    assert.equal(data.succeeded, 1);
    assert.equal(data.failed, 1);
    assert.equal(data.results.find(r => r.id === U1).error.includes('管理员'), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [U2, '168h']);
    assert.equal(data.duration, '168h');
    assert.ok(data.note.includes('封禁'));
  });

  await test('batchUsersCore 参数错误返回 400，不触发任何 Auth 调用', async () => {
    const r = await batchUsersCore({}, env(), { action: 'ban', userIds: ['bad'] }, U1);
    assert.equal(r.status, 400);
    const r2 = await batchUsersCore({}, env(), { action: 'unknown', userIds: [U1] }, U1);
    assert.equal(r2.status, 400);
  });

  await test('batchSitesCore 站点不存在时给出逐项失败报告，不影响其它项', async () => {
    const sb = { from() {
      const api = { select() { return api; }, eq() { return api; }, async maybeSingle() { return { data: null, error: null }; } };
      return api;
    } };
    const { status, data } = await batchSitesCore(sb, env(), { siteNames: ['ghost', 'ghost2'] });
    assert.equal(status, 200);
    assert.equal(data.total, 2);
    assert.equal(data.failed, 2);
    assert.ok(data.results.every(r => r.error === '站点不存在'));
  });

  await test('批量上限按子请求预算收紧；封禁/解封单独放宽', async () => {
    const ids = (n) => Array.from({ length: n }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    assert.equal(MAX_BATCH_USERS, 5);
    assert.equal(MAX_BATCH_SITES, 10);
    assert.equal(MAX_BATCH_BAN_USERS, 25);
    assert.ok(parseUserIds(ids(6)).error, '删用户 6 个应被拒');
    assert.ok(parseSiteNames(ids(11).map(x => 's' + x)).error, '删站 11 个应被拒');
    // 封禁走放宽后的上限：25 个放行、26 个拒绝
    assert.equal(parseUserIds(ids(25), MAX_BATCH_BAN_USERS).ids.length, 25);
    assert.ok(parseUserIds(ids(26), MAX_BATCH_BAN_USERS).error);

    const sb = { auth: { admin: { async updateUserById(uid) {
      return { data: { user: { id: uid, banned_until: null } }, error: null };
    } } } };
    const { status, data } = await batchUsersCore(sb, env(), {
      action: 'ban', userIds: ids(25), duration: '24h',
    }, null);
    assert.equal(status, 200);
    assert.equal(data.total, 25);
  });

  await test('deleteUserCore：3 类站点只 1 次 Storage RPC + 3 桶各 1 次批量删', async () => {
    const originalFetch = globalThis.fetch;
    let rpcCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/rest/v1/rpc/admin_list_storage_files_multi')) {
        rpcCalls++;
        const body = JSON.parse(init.body);
        assert.equal(body.p_bucket_id, 'projects');
        assert.deepEqual(body.p_prefixes, [`${U1}/p1/`]);
        return {
          ok: true, status: 200, text: async () => '',
          json: async () => [
            { name: `${U1}/p1/index.html`, size: 10 },
            { name: `${U1}/p1/css/a.css`, size: 20 },
          ],
        };
      }
      // email-map 兼容读（返回空映射即可，不影响删除结果）
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };

    const removed = [];
    let recordDeletes = 0, authDeletes = 0;
    const sb = {
      auth: { admin: { async deleteUser() { authDeletes++; return { data: {}, error: null }; } } },
      storage: { from(bucket) { return { async remove(paths) {
        removed.push({ bucket, paths: paths.slice() });
        return { data: [], error: null };
      } }; } },
      from(table) {
        if (table !== 'gh_site') throw new Error('unexpected table: ' + table);
        const api = {
          select() { return api; },
          eq() { return api; },
          delete() { recordDeletes++; return { eq: async () => ({ data: null, error: null }) }; },
          then(resolve) {
            resolve({ data: [
              site('h1', U1),
              site('m1', U1, { type: 'md' }),
              site('p1', U1, { type: 'project' }),
            ], error: null });
          },
        };
        return api;
      },
    };

    try {
      const r = await deleteUserCore(sb, env(), U1);
      assert.equal(r.deletedSites, 3);
      assert.equal(rpcCalls, 1, '3 个站点只能 1 次多前缀 RPC，不能逐站查');
      assert.deepEqual(removed.map(x => x.bucket).sort(), ['md', 'projects', 'sites']);
      assert.equal(removed.find(x => x.bucket === 'projects').paths.length, 2);
      assert.equal(recordDeletes, 1);
      assert.equal(authDeletes, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('runBatch 有限并发：加速但结果仍按输入顺序、失败照样隔离', async () => {
    let active = 0, maxActive = 0;
    const r = await runBatch(['a', 'b', 'c', 'd', 'e'], async id => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(res => setTimeout(res, 5));
      active--;
      if (id === 'c') throw new Error('c 失败');
      return { deletedSites: 1 };
    }, 3);
    assert.ok(maxActive > 1 && maxActive <= 3, '并发度应受限于 3，实际 ' + maxActive);
    assert.deepEqual(r.results.map(x => x.id), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(r.results[2].error, 'c 失败');
    assert.equal(r.succeeded, 4);
    assert.equal(r.failed, 1);
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
