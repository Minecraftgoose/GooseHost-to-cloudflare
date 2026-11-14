// 管理后台 SPA 冒烟测试：node tests/admin-ui.smoke.mjs
// 用最小 DOM 桩加载 front/admin/app.js，验证 hash 路由各视图能渲染、
// 用户列表包含要求的六列、用户/站点钻取层级正确，且没有运行时异常。

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const UID = '11111111-1111-4111-8111-111111111111';
const UID2 = '22222222-2222-4222-8222-222222222222';

const users = [
  {
    id: UID, uid: UID, email: 'alpha@example.com', name: '阿法',
    createdAt: '2026-01-02T03:04:05Z', lastSignInAt: '2026-05-06T07:08:09Z',
    emailConfirmedAt: '2026-01-02T03:10:00Z', siteCount: 2,
    providers: ['email'], provider: 'email', isAnonymous: false, bannedUntil: null,
  },
  {
    id: UID2, uid: UID2, email: 'beta@example.com', name: '贝塔',
    createdAt: '2026-02-02T03:04:05Z', lastSignInAt: null,
    emailConfirmedAt: null, siteCount: 0,
    providers: ['email'], provider: 'email', isAnonymous: false, bannedUntil: null,
  },
];
const sites = [
  { id: 's1', name: 'demo', type: 'project', ownerId: UID, ownerEmail: 'alpha@example.com', ownerName: '阿法', visitCount: 42, ipAddress: '1.2.3.4', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-02T00:00:00Z', url: 'https://page.goose.cc.cd/p/demo' },
  { id: 's2', name: 'note', type: 'md', ownerId: UID, ownerEmail: 'alpha@example.com', ownerName: '阿法', visitCount: 3, ipAddress: '1.2.3.4', createdAt: '2026-03-03T00:00:00Z', updatedAt: '2026-03-04T00:00:00Z', url: 'https://page.goose.cc.cd/md/note' },
];
const stats = {
  totalSites: 2, totalUsers: 2, sitesToday: 1, usersToday: 1, activeUsers7d: 1, totalVisits: 45,
  byType: { html: 0, md: 1, project: 1 }, recentSites: sites,
  recentUsers: users.map(u => ({ ...u })), meta: { cached: false, source: 'supabase-auth-admin' },
};

function jsonResponse(data) {
  return {
    ok: true, status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function fakeApi(url) {
  const path = String(url).split('?')[0];
  if (path.endsWith('/api/me')) return jsonResponse({ nickname: '管理员', email: 'admin@example.com' });
  if (path.endsWith('/api/admin/users/' + UID) || path.endsWith('/api/admin/users/' + UID2)) {
    const u = users.find(x => x.uid === path.split('/').pop());
    return jsonResponse({
      user: u,
      sites: sites.filter(s => s.ownerId === u.uid),
      summary: { siteCount: 2, byType: { html: 0, md: 1, project: 1 }, totalVisits: 45, lastCreatedAt: '2026-03-03T00:00:00Z' },
    });
  }
  if (path.endsWith('/api/admin/users')) return jsonResponse({ users, pagination: { page: 1, limit: 25, total: 2, totalPages: 1 }, meta: { source: 'supabase-auth-admin' } });
  if (path.endsWith('/api/admin/stats')) return jsonResponse(stats);
  if (path.endsWith('/api/admin/sites')) return jsonResponse({ sites, pagination: { page: 1, limit: 25, total: 2, totalPages: 1 }, meta: {} });
  if (path.includes('/api/admin/site/')) {
    const slug = decodeURIComponent(path.split('/').pop());
    const s = sites.find(x => x.name === slug);
    if (!s) return { ok: false, status: 404, json: async () => ({ error: '站点不存在' }) };
    return jsonResponse({
      site: {
        ...s,
        owner: { uid: s.ownerId, email: s.ownerEmail, name: s.ownerName },
        ...(s.type === 'project'
          ? { files: { files: [{ name: 'index.html', size: 1024 }, { name: 'css/main.css', size: 512 }], totalSize: 1536 } }
          : { content: { kind: 'md', text: '# hello\n\nworld' } }),
      },
    });
  }
  if (path.endsWith('/api/admin/play/stats')) return jsonResponse({ posts: 3, comments: 5, ai_comments: 1, likes: 8, follows: 2, posts_today: 1, site_posts: 1, text_posts: 2 });
  if (path.endsWith('/api/admin/play/posts')) return jsonResponse({
    posts: [{ id: 'p1', kind: 'text', title: '第一条', content: '正文', site_slug: '', like_count: 1, comment_count: 2, view_count: 3, created_at: '2026-04-01T00:00:00Z', author: { nickname: '阿法', email: 'alpha@example.com' } }],
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  });
  if (path.endsWith('/api/admin/play/comments')) return jsonResponse({ comments: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } });
  if (path.endsWith('/api/admin/announcement')) return jsonResponse({ announcement: { id: 'a1', content: '系统维护通知', created_at: '2026-04-01T00:00:00Z', is_active: true }, history: [{ id: 'a1', content: '系统维护通知', created_at: '2026-04-01T00:00:00Z', is_active: true }] });
  if (path.endsWith('/api/admin/cleanup-orphans')) return jsonResponse({ dryRun: true, orphanFiles: 2, groups: [{ bucket: 'projects', prefix: UID + '/old/', count: 2 }], scanned: { sites: 2, md: 1, projects: 3 }, skipped: 0, deleted: 0, errors: [] });
  if (path.endsWith('/api/admin/ban-user')) return jsonResponse({ success: true, userId: UID, action: 'ban', banDuration: '24h', bannedUntil: '2099-01-01T00:00:00Z', note: 'ok' });
  if (path.endsWith('/api/admin/batch-users')) return jsonResponse({ success: true, action: 'delete', results: [{ id: UID, ok: true }, { id: UID2, ok: true }], succeeded: 2, failed: 0, total: 2 });
  if (path.endsWith('/api/admin/batch-sites')) return jsonResponse({ success: true, action: 'delete', results: [{ id: 'demo', ok: true }], succeeded: 1, failed: 0, total: 1 });
  if (path.endsWith('/api/admin/delete-site')) return jsonResponse({ success: true });
  if (path.endsWith('/api/admin/delete-user')) return jsonResponse({ success: true });
  return jsonResponse({});
}

/* ---------- 最小 DOM 桩 ---------- */
const els = new Map();
const handlers = {};
const winHandlers = {};
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', className: '', value: '', dataset: {}, selectionStart: 0,
    checked: false, indeterminate: false,
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    focus() { }, setSelectionRange() { }, scrollIntoView() { }, closest() { return null; },
    querySelectorAll() { return []; },
  };
}
const nodes = [];   // 模拟页面上真实存在的 checkbox 节点
const documentStub = {
  _nodes: nodes,
  getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  querySelectorAll(sel) {
    if (sel.includes('select-all')) return nodes.filter(n => n.dataset.action === 'select-all');
    if (sel.includes('data-action="select"')) return nodes.filter(n => n.dataset.action === 'select');
    return [];
  },
  addEventListener(type, fn) { handlers[type] = fn; },
  createElement() { return { type: '', files: [], click() { } }; },
  activeElement: null,
};
const locationStub = { hash: '#/users', pathname: '/admin/', search: '', href: '' };
const sandbox = {
  console,
  document: documentStub,
  window: { addEventListener(type, fn) { winHandlers[type] = fn; }, matchMedia() { return { matches: false }; } },
  location: locationStub,
  history: { replaceState() { }, pushState() { } },
  localStorage: { getItem(k) { return k === 'sb_token' ? 'fake-token' : null; } },
  navigator: { clipboard: { writeText: async () => { } } },
  GHAuth: { apiFetch: async (url) => fakeApi(url) },
  setTimeout, clearTimeout,
  Intl, Blob, URLSearchParams,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(new URL('../front/admin/app.js', import.meta.url), 'utf8');
vm.runInNewContext(code, sandbox, { filename: 'front/admin/app.js' });

const view = documentStub.getElementById('view');
const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
async function go(hash) {
  locationStub.hash = hash;
  await winHandlers.hashchange();
  await wait(10);
  return view.innerHTML;
}

async function main() {
  console.log('admin-ui 冒烟测试');
  await wait(80);   // 等 init() 的首次渲染

  await test('初始路由 #/users 渲染用户列表（六列齐全）', () => {
    const html = view.innerHTML;
    for (const col of ['邮箱', '名字', 'UID', '注册时间', '最后登录时间', '站点数']) {
      assert.ok(html.includes(col), '缺少列：' + col);
    }
    assert.ok(html.includes('alpha@example.com'));
    assert.ok(html.includes('阿法'));
    assert.ok(html.includes('beta@example.com'));
  });

  await test('点击用户 → #/users/:uid 用户详情（SPA 钻取，非平铺）', async () => {
    const el = { dataset: { action: 'open-user', uid: UID }, closest() { return null; } };
    await handlers.click({ target: { closest: () => el }, preventDefault() { } });
    assert.equal(locationStub.hash, '#/users/' + UID);
    const html = await go(locationStub.hash);
    assert.ok(html.includes('账号资料'));
    assert.ok(html.includes('名下网站'));
    assert.ok(html.includes('最后登录时间'));
    assert.ok(html.includes('alpha@example.com'));
    assert.ok(html.includes('demo'));
    assert.ok(html.includes('data-from="' + UID + '"'), '站点行应带来源用户，便于面包屑回退');
  });

  await test('从用户详情点站点 → 站点详情带 from 面包屑', async () => {
    const el = { dataset: { action: 'open-site', slug: 'demo', from: UID }, closest() { return null; } };
    await handlers.click({ target: { closest: () => el }, preventDefault() { } });
    assert.ok(locationStub.hash.startsWith('#/sites/demo?from='));
    const html = await go(locationStub.hash);
    assert.ok(html.includes('文件列表'));
    assert.ok(html.includes('index.html'));
    assert.ok(html.includes('css/main.css'));
    assert.ok(html.includes('返回'));
  });

  await test('站点列表 / 概览 / 广场 / 公告 / 工具 均能渲染', async () => {
    assert.ok((await go('#/sites')).includes('站点管理'));
    assert.ok((await go('#/overview')).includes('站点概览'));
    assert.ok((await go('#/play')).includes('广场管理'));
    assert.ok((await go('#/announcement')).includes('全局公告'));
    assert.ok((await go('#/tools')).includes('历史孤儿文件清理'));
  });

  await test('确认弹窗与编辑器可打开/关闭（事件委托）', async () => {
    await go('#/users');
    const del = { dataset: { action: 'delete-user', uid: UID, email: 'alpha@example.com', count: '2' }, closest() { return null; } };
    await handlers.click({ target: { closest: () => del }, preventDefault() { } });
    assert.ok(documentStub.getElementById('modal').innerHTML.includes('删除用户'));
    const close = { dataset: { action: 'modal-close' }, closest() { return null; } };
    await handlers.click({ target: { closest: () => close }, preventDefault() { } });
    assert.equal(documentStub.getElementById('modal').innerHTML, '');
  });

  await test('搜索输入触发防抖重渲染且不抛异常', async () => {
    const input = makeEl('search-users');
    input.dataset = { search: 'users' };
    input.value = 'alpha';
    await handlers.input({ target: input });
    await wait(400);
    assert.ok(view.innerHTML.includes('用户管理'));
  });

  /* ---- 批量管理 / 封禁 / 行内删站 ---- */
  function clickEl(ds, extra) {
    const el = Object.assign({ dataset: ds, checked: false, closest() { return null; } }, extra || {});
    return handlers.click({ target: { closest: () => el }, preventDefault() { } });
  }

  await test('用户列表含全选/逐行复选框、批量条与行内封禁/删除按钮', async () => {
    const html = await go('#/users');
    assert.ok(html.includes('data-action="select-all"'));
    assert.ok(html.includes('data-action="select"'));
    assert.ok(html.includes('id="batch-users"'));
    assert.ok(html.includes('data-action="ban-user"'));
    assert.ok(html.includes('data-action="delete-user"'));
    assert.ok(html.includes('data-action="batch-ban"') === false, '未选中时不显示批量动作');
  });

  await test('勾选用户后批量条出现封禁/解封/删除并对齐选择数', async () => {
    nodes.length = 0;
    const cb = { dataset: { action: 'select', scope: 'users', id: UID }, checked: true, closest() { return null; } };
    nodes.push(cb);
    await handlers.click({ target: { closest: () => cb }, preventDefault() { } });
    const bar = documentStub.getElementById('batch-users').innerHTML;
    assert.ok(bar.includes('已选'));
    assert.ok(bar.includes('批量封禁'));
    assert.ok(bar.includes('批量解封'));
    assert.ok(bar.includes('批量删除用户'));
  });

  await test('行内封禁：弹窗选时长 → 调用封禁接口 → 关闭并刷新', async () => {
    await clickEl({ action: 'ban-user', uid: UID, email: 'alpha@example.com' });
    const html = documentStub.getElementById('modal').innerHTML;
    assert.ok(html.includes('封禁 1 位用户'));
    assert.ok(html.includes('876000h'));
    assert.ok(html.includes('ban_duration'));
    documentStub.getElementById('banDuration').value = '24h';
    await clickEl({ action: 'ban-confirm' });
    assert.equal(documentStub.getElementById('modal').innerHTML, '');
    assert.ok(view.innerHTML.includes('用户管理'));
  });

  await test('站点列表：不进详情页即可删除 + 全选与批量删除条', async () => {
    const html = await go('#/sites');
    assert.ok(html.includes('data-action="delete-site"'));
    assert.ok(html.includes('id="batch-sites"'));
    assert.ok(html.includes('data-action="select-all"'));
    assert.ok(html.includes('直接删除'));
  });

  await test('用户详情名下网站可直接删除，且带来源用户便于返回', async () => {
    const html = await go('#/users/' + UID);
    assert.ok(html.includes('data-action="delete-site"'));
    assert.ok(html.includes('data-from="' + UID + '"'));
    assert.ok(html.includes('封禁用户'));
  });

  await test('批量删除用户完整流程：全选 → 确认 → 报告 → 清空选择', async () => {
    await go('#/users');
    nodes.length = 0;
    nodes.push({ dataset: { action: 'select', scope: 'users', id: UID }, checked: true, closest() { return null; } });
    nodes.push({ dataset: { action: 'select', scope: 'users', id: UID2 }, checked: true, closest() { return null; } });
    for (const cb of [...nodes]) await handlers.click({ target: { closest: () => cb }, preventDefault() { } });
    assert.ok(documentStub.getElementById('batch-users').innerHTML.includes('<strong>2</strong>'));

    await clickEl({ action: 'batch-delete-users' });
    assert.ok(documentStub.getElementById('modal').innerHTML.includes('批量删除用户'));
    await clickEl({ action: 'modal-confirm' });
    assert.equal(documentStub.getElementById('modal').innerHTML, '');
    assert.ok(view.innerHTML.includes('用户管理'));
    assert.ok(documentStub.getElementById('batch-users').innerHTML.includes('勾选多行'));
  });

  await test('批量选择上限与清空选择可正常工作', async () => {
    await go('#/users');
    await clickEl({ action: 'clear-selection', scope: 'users' });
    assert.ok(documentStub.getElementById('batch-users').innerHTML.includes('勾选多行'));
  });

  /* ---- 本轮：表头 / 防误跳 / 详情页批量 / 超时 ---- */
  await test('表头 <th> + <colgroup> 列定义与数据行严格对齐', async () => {
    const html = await go('#/sites');
    const ths = (html.match(/<th(?:\s|>)/g) || []).length;
    const cols = (html.match(/<col(?:\s|>)/g) || []).length;
    const firstRow = (html.match(/<tr class="gh-row-click"[^>]*>([\s\S]*?)<\/tr>/) || [, ''])[1];
    const tds = (firstRow.match(/<td(?:\s|>)/g) || []).length;
    assert.ok(ths >= 7, '站点表应有 7 个表头单元格，实际 ' + ths);
    assert.equal(tds, ths, 'th 与 td 列数必须一致');
    assert.equal(cols, ths, 'colgroup 列数必须与 th 一致');
    assert.ok(html.includes('<colgroup>'), '必须有显式列定义');
    assert.ok(html.includes('<th scope="col" class="gh-th-check">'), '复选框列表头');
    assert.ok(html.includes('<th scope="col">站点</th>') && html.includes('<th scope="col">类型</th>'));
    assert.ok(html.includes('<th scope="col" class="gh-th-actions">'), '操作列表头');
    assert.ok(html.includes('<col style="width:38px">'), '复选框列宽固定');
  });

  await test('后台 HTML：PNG 图标 + 资源版本号 + 构建号可见', () => {
    const h = fs.readFileSync(new URL('../front/admin/index.html', import.meta.url), 'utf8');
    assert.ok(h.includes('icons/icon-64x64.png'), '左上角必须用 PNG 站点图标');
    assert.ok(!h.includes('src="../logo.svg"'), '不能再引用 logo.svg');
    assert.ok(h.includes('icon-128x128.png') && h.includes('srcset'), '高分屏用 2x 图');
    assert.ok(h.includes('app.js?v=20261114b') && h.includes('style.css?v=20261114b'));
    assert.ok(h.includes('build 20261114b'), '侧栏要能看到构建号，便于确认缓存');
    const headers = fs.readFileSync(new URL('../front/_headers', import.meta.url), 'utf8');
    assert.ok(/\/admin\/\s*\n[\s\S]*?must-revalidate/.test(headers), '后台 HTML 必须 no-cache');
  });

  await test('用户详情名下网站带批量条、全选与复选框', async () => {
    const html = await go('#/users/' + UID);
    assert.ok(html.includes('id="batch-sites"'));
    assert.ok(html.includes('data-action="select-all" data-scope="sites"'));
    assert.ok(html.includes('data-action="select-cell" data-scope="sites"'));
    assert.ok(html.includes('勾选多行可批量操作'));
  });

  await test('手抖点偏到复选框格子空白：只勾选，绝不跳站点详情', async () => {
    await go('#/sites');
    const before = locationStub.hash;
    nodes.length = 0;
    const cb = { checked: false, dataset: { action: 'select', scope: 'sites', id: 'demo' }, closest() { return null; } };
    nodes.push(cb);
    const td = {
      dataset: { action: 'select-cell', scope: 'sites', id: 'demo' }, tagName: 'TD',
      checked: false, querySelector() { return cb; }, closest() { return null; },
    };
    await handlers.click({ target: { closest: () => td }, preventDefault() { } });
    assert.equal(locationStub.hash, before, '不应导航到站点详情');
    assert.equal(cb.checked, true);
    assert.ok(documentStub.getElementById('batch-sites').innerHTML.includes('批量删除站点'));
  });

  await test('点操作列按钮之间的空白同样不跳详情页', async () => {
    await go('#/sites');
    const before = locationStub.hash;
    const td = { dataset: { action: 'actions-cell' }, tagName: 'TD', closest() { return null; } };
    await handlers.click({ target: { closest: () => td }, preventDefault() { } });
    assert.equal(locationStub.hash, before);
  });

  await test('点普通行仍可进入详情（保护只覆盖复选框/操作单元格）', async () => {
    await go('#/sites');
    const tr = { dataset: { action: 'open-site', slug: 'demo' }, tagName: 'TR', closest() { return null; } };
    await handlers.click({
      target: { closest: (sel) => sel === '[data-action]' ? tr : null }, preventDefault() { },
    });
    assert.equal(locationStub.hash, '#/sites/demo');
  });

  await test('慢接口 3 分钟超时 + 超时后自动刷新核对，而不是误报失败', () => {
    const src = fs.readFileSync(new URL('../front/admin/app.js', import.meta.url), 'utf8');
    assert.ok(src.includes('LONG_TIMEOUT_MS = 180000'));
    assert.ok(src.includes('LONG_TIMEOUT_RE'));
    assert.ok(src.includes('timeoutMs: timeoutMs'));
    assert.ok(src.includes('recoverFromTimeout') && src.includes('e.isTimeout'));
    assert.ok(src.includes('响应超时，服务端可能仍在执行'));
    const authSrc = fs.readFileSync(new URL('../front/auth-session.js', import.meta.url), 'utf8');
    assert.ok(authSrc.includes('options.timeoutMs'));
    assert.ok(authSrc.includes('te.isTimeout = true'));
  });

  console.log(`\n全部通过：${passed} 项`);
}

main().catch(e => { console.error(e); process.exit(1); });
