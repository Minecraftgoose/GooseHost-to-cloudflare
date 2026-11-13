/* =====================================================================
 * GooseHost 管理后台（全量重写 · SPA）
 *
 * 结构：hash 路由 → 视图函数 → 事件委托。不再有几十个 onclick 全局函数、
 * 不再用字符串拼接把用户输入塞进 JS 事件参数（旧版 XSS / 引号注入重灾区）。
 *
 * 视图层级（钻取，不平铺）：
 *   #/users            用户列表（邮箱 / 名字 / UID / 注册 / 最后登录 / 站点数）
 *   #/users/:uid       用户详情（资料 + 名下网站列表）
 *   #/sites/:slug      站点详情（从用户详情点进来时带 ?from=<uid> 面包屑）
 *   #/sites            站点列表
 *   #/play             广场（帖子 / 评论）
 *   #/announcement     公告
 *   #/tools            同步邮箱 / 孤儿清理
 *
 * 数据来源：后端按 Supabase Auth Admin API 重写，用户字段直接来自 user 对象。
 * 会话：沿用全站 /auth-session.js 的 GHAuth.apiFetch（带自动续期与跨标签页锁）。
 * ===================================================================== */
(function () {
    'use strict';

    const API_URL = 'https://page.goose.cc.cd';
    const PAGE_SIZE = 25;

    const view = document.getElementById('view');
    const crumbEl = document.getElementById('breadcrumb');
    const overlay = document.getElementById('modalOverlay');
    const modal = document.getElementById('modal');
    const toastEl = document.getElementById('toast');
    const sidebar = document.getElementById('sidebar');

    /* ------------------------------------------------------------------
     * 通用工具
     * ------------------------------------------------------------------ */

    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC_MAP[c]); }
    function fmtNum(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }
    function fmtDate(v, withTime) {
        if (!v) return '—';
        const d = new Date(v);
        if (isNaN(d.getTime())) return '—';
        const opt = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' };
        if (withTime !== false) { opt.hour = '2-digit'; opt.minute = '2-digit'; }
        return new Intl.DateTimeFormat('zh-CN', opt).format(d);
    }
    function fmtSize(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }
    function shortUid(uid) { return uid ? String(uid).slice(0, 8) + '…' : '—'; }
    function typeBadge(t) {
        const type = t === 'md' ? 'md' : (t === 'project' ? 'project' : 'html');
        const label = { html: 'HTML', md: 'MD', project: 'PROJECT' }[type];
        return `<span class="gh-badge gh-badge-${type}">${label}</span>`;
    }
    function badge(text, kind) { return `<span class="gh-badge gh-badge-${kind || 'muted'}">${esc(text)}</span>`; }
    function qs(obj) {
        const p = new URLSearchParams();
        Object.entries(obj || {}).forEach(([k, v]) => {
            if (v !== '' && v != null) p.set(k, String(v));
        });
        return p.toString();
    }
    function toast(msg, type) {
        toastEl.textContent = msg;
        toastEl.className = 'gh-toast show ' + (type || 'error');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { toastEl.className = 'gh-toast'; }, 3200);
    }
    function loading(text) {
        return `<div class="gh-loading"><i class="fas fa-circle-notch"></i><div style="margin-top:8px">${esc(text || '加载中…')}</div></div>`;
    }
    function empty(icon, text, extra) {
        return `<div class="gh-empty"><i class="fas ${icon}"></i><div>${esc(text)}</div>${extra ? `<div style="margin-top:10px">${extra}</div>` : ''}</div>`;
    }
    function errorView(err) {
        if (err && err.status === 403) {
            return empty('fa-shield-halved', '当前账号没有管理员权限', '<a class="gh-btn" href="/dashboard">返回面板</a>');
        }
        return empty('fa-triangle-exclamation', '加载失败：' + (err && err.message ? err.message : '未知错误'),
            '<button class="gh-btn" data-action="reload"><i class="fas fa-rotate-right"></i> 重试</button>');
    }
    function pageHead(icon, title, sub, actions) {
        return `<div class="gh-page-head"><div><div class="gh-page-title"><i class="fas ${icon}"></i>${esc(title)}</div>` +
            (sub ? `<div class="gh-page-sub">${sub}</div>` : '') + `</div><div class="gh-actions">${actions || ''}</div></div>`;
    }
    function card(icon, title, body, actions, foot) {
        return `<section class="gh-card"><div class="gh-card-head"><div class="gh-card-title"><i class="fas ${icon}"></i>${esc(title)}</div>` +
            `<div class="gh-toolbar">${actions || ''}</div></div>` +
            `<div class="gh-card-body" style="padding:0">${body}</div>` +
            (foot ? `<div class="gh-card-foot">${foot}</div>` : '') + `</section>`;
    }
    function cardPadded(icon, title, body, actions) {
        return `<section class="gh-card"><div class="gh-card-head"><div class="gh-card-title"><i class="fas ${icon}"></i>${esc(title)}</div>` +
            `<div class="gh-toolbar">${actions || ''}</div></div><div class="gh-card-body">${body}</div></section>`;
    }
    function kv(items) {
        return `<div class="gh-kv">${items.map(([k, v]) =>
            `<div class="gh-kv-item"><div class="gh-kv-key">${esc(k)}</div><div class="gh-kv-val">${v}</div></div>`
        ).join('')}</div>`;
    }
    function searchHtml(scope, placeholder, value) {
        return `<label class="gh-search"><i class="fas fa-magnifying-glass"></i>` +
            `<input id="search-${esc(scope)}" data-search="${esc(scope)}" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value || '')}"></label>`;
    }
    function refreshBtn() {
        return `<button class="gh-btn" data-action="reload"><i class="fas fa-rotate-right"></i> 刷新</button>`;
    }
    function pagerHtml(p, scope) {
        if (!p) return '';
        const pages = Math.max(1, p.totalPages || 1);
        if (pages <= 1) return `<div class="gh-pager"><span class="gh-page-info">共 ${fmtNum(p.total)} 条</span></div>`;
        const cur = p.page || 1;
        const nums = [];
        if (pages <= 7) { for (let i = 1; i <= pages; i++) nums.push(i); }
        else {
            nums.push(1);
            if (cur > 3) nums.push('…');
            for (let i = Math.max(2, cur - 1); i <= Math.min(pages - 1, cur + 1); i++) nums.push(i);
            if (cur < pages - 2) nums.push('…');
            nums.push(pages);
        }
        let html = `<div class="gh-pager"><button class="gh-page-btn" data-action="page" data-scope="${esc(scope)}" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>上一页</button>`;
        nums.forEach(n => {
            if (n === '…') html += '<span class="gh-page-info">…</span>';
            else html += `<button class="gh-page-btn ${n === cur ? 'active' : ''}" data-action="page" data-scope="${esc(scope)}" data-page="${n}">${n}</button>`;
        });
        html += `<button class="gh-page-btn" data-action="page" data-scope="${esc(scope)}" data-page="${cur + 1}" ${cur >= pages ? 'disabled' : ''}>下一页</button>`;
        html += `<span class="gh-page-info">第 ${cur}/${pages} 页 · 共 ${fmtNum(p.total)} 条</span></div>`;
        return html;
    }
    function tableHtml(headers, rows, emptyHtml) {
        if (!rows.length) return emptyHtml || empty('fa-inbox', '暂无数据');
        return `<div class="gh-table-wrap"><table class="gh-table"><thead><tr>${headers.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    }
    function siteLink(s) { return s.url || (API_URL + (s.type === 'md' ? '/md/' : s.type === 'project' ? '/p/' : '/s/') + encodeURIComponent(s.name)); }

    /* ------------------------------------------------------------------
     * 请求封装
     * ------------------------------------------------------------------ */

    let forceRefresh = false;   // 写操作后的第一次 GET 强制后端绕过 20s 缓存
    async function api(path, opts) {
        opts = opts || {};
        const token = localStorage.getItem('sb_token');
        if (!token) { location.href = '../login/'; throw new Error('请先登录'); }
        const method = (opts.method || 'GET').toUpperCase();
        let url = API_URL + path;
        if (forceRefresh && method === 'GET') {
            url += (url.indexOf('?') >= 0 ? '&' : '?') + 'refresh=1';
            forceRefresh = false;
        }
        const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
        if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const res = await GHAuth.apiFetch(url, Object.assign({}, opts, { method: method, headers: headers }));
        let data = null;
        try { data = await res.json(); } catch (_) { /* 允许空响应 */ }
        if (res.status === 401) { location.href = '../login/'; throw new Error('登录已过期，请重新登录'); }
        if (!res.ok) {
            const e = new Error((data && (data.error || data.msg)) || ('HTTP ' + res.status));
            e.status = res.status;
            throw e;
        }
        return data;
    }
    function post(path, body, method) {
        return api(path, { method: method || 'POST', body: JSON.stringify(body || {}) });
    }
    async function afterWrite(fn, successMsg, backTo) {
        try {
            const r = await fn();
            forceRefresh = true;
            toast(successMsg, 'success');
            if (backTo) navigate(backTo);
            else await renderRoute();
            return r;
        } catch (e) { toast(e.message, 'error'); return null; }
    }

    /* ------------------------------------------------------------------
     * 状态 / 路由
     * ------------------------------------------------------------------ */

    const state = {
        users: { page: 1, q: '', sort: 'createdAt', dir: 'desc' },
        sites: { page: 1, q: '', type: '', order: 'updatedAt', dir: 'desc' },
        play: { tab: 'posts', page: 1, q: '' },
        tools: { ownerId: '', result: null },
        siteDetail: null,
        userDetail: null,
    };
    const searchTimers = {};
    let viewToken = 0;
    let pendingConfirm = null;
    let pendingEditorSave = null;

    function parseRoute() {
        let h = location.hash.replace(/^#\/?/, '');
        const qi = h.indexOf('?');
        let query = {};
        if (qi >= 0) {
            query = Object.fromEntries(new URLSearchParams(h.slice(qi + 1)).entries());
            h = h.slice(0, qi);
        }
        let parts;
        try { parts = h.split('/').filter(Boolean).map(decodeURIComponent); }
        catch (_) { parts = h.split('/').filter(Boolean); }
        return { section: parts[0] || 'overview', parts: parts, query: query };
    }
    function navigate(path) { location.hash = '#/' + String(path).replace(/^\/+/, ''); }
    function setActiveNav(section) {
        document.querySelectorAll('[data-nav]').forEach(a => {
            a.classList.toggle('active', a.dataset.nav === section);
        });
    }
    function setCrumb(items) {
        crumbEl.innerHTML = items.map((it, i) => {
            const sep = i ? '<span class="gh-crumb-sep">/</span>' : '';
            const body = it.href
                ? `<a href="${esc(it.href)}">${esc(it.text)}</a>`
                : `<span class="gh-crumb-cur" title="${esc(it.text)}">${esc(it.text)}</span>`;
            return sep + body;
        }).join('');
    }
    async function withFocus(fn) {
        const a = document.activeElement;
        const id = a && a.id;
        let pos = null;
        try { pos = a && a.selectionStart; } catch (_) { }
        await fn();
        if (id) {
            const n = document.getElementById(id);
            if (n) {
                n.focus();
                if (pos != null) { try { n.setSelectionRange(pos, pos); } catch (_) { } }
            }
        }
    }
    function guard(token) { return token === viewToken; }
    function currentToken() { return ++viewToken; }
    function reload() { return renderRoute(); }

    async function renderRoute() {
        const token = currentToken();
        const route = parseRoute();
        setActiveNav(route.section);
        sidebar.classList.remove('open');
        try {
            switch (route.section) {
                case 'users':
                    if (route.parts[1]) await renderUserDetail(route.parts[1], token);
                    else await renderUsers(token);
                    break;
                case 'sites':
                    if (route.parts[1]) await renderSiteDetail(route.parts[1], route.query.from || '', token);
                    else await renderSites(token);
                    break;
                case 'play': await renderPlay(token); break;
                case 'announcement': await renderAnnouncement(token); break;
                case 'tools': await renderTools(token); break;
                default: await renderOverview(token);
            }
        } catch (err) {
            if (!guard(token)) return;
            view.innerHTML = errorView(err);
        }
    }

    /* ------------------------------------------------------------------
     * 弹窗
     * ------------------------------------------------------------------ */

    function openModal(html, wide) {
        modal.className = 'gh-modal' + (wide ? ' gh-modal-wide' : '');
        modal.innerHTML = html;
        overlay.classList.add('active');
    }
    function closeModal() {
        overlay.classList.remove('active');
        modal.innerHTML = '';
        pendingConfirm = null;
        pendingEditorSave = null;
    }
    function confirmAction(cfg) {
        pendingConfirm = cfg.onConfirm;
        openModal(
            `<div class="gh-modal-head"><span>${esc(cfg.title || '确认操作')}</span>` +
            `<button class="gh-modal-close" data-action="modal-close"><i class="fas fa-xmark"></i></button></div>` +
            `<div class="gh-modal-body"><p style="margin-bottom:10px">${esc(cfg.message || '')}</p>` +
            (cfg.detail ? `<div class="gh-pre">${esc(cfg.detail)}</div>` : '') +
            (cfg.note ? `<p class="gh-note" style="margin-top:10px">${esc(cfg.note)}</p>` : '') + `</div>` +
            `<div class="gh-modal-foot"><button class="gh-btn" data-action="modal-close">取消</button>` +
            `<button class="gh-btn ${cfg.danger === false ? 'gh-btn-primary' : 'gh-btn-danger'}" data-action="modal-confirm">${esc(cfg.confirmText || '确认')}</button></div>`
        );
    }
    function openEditor(cfg) {
        pendingEditorSave = cfg.onSave;
        openModal(
            `<div class="gh-modal-head"><span>${esc(cfg.title || '编辑')}</span>` +
            `<button class="gh-modal-close" data-action="modal-close"><i class="fas fa-xmark"></i></button></div>` +
            `<div class="gh-modal-body"><div class="gh-field"><label class="gh-label">${esc(cfg.subtitle || '内容')}</label>` +
            `<textarea id="ghEditor" class="gh-textarea">${esc(cfg.content || '')}</textarea></div>` +
            (cfg.note ? `<p class="gh-note" style="margin-top:10px">${esc(cfg.note)}</p>` : '') + `</div>` +
            `<div class="gh-modal-foot"><button class="gh-btn" data-action="modal-close">取消</button>` +
            `<button class="gh-btn gh-btn-primary" data-action="editor-save"><i class="fas fa-floppy-disk"></i> 保存</button></div>`,
            true
        );
    }

    /* ------------------------------------------------------------------
     * 概览
     * ------------------------------------------------------------------ */

    async function renderOverview(token) {
        setCrumb([{ text: '概览' }]);
        view.innerHTML = pageHead('fa-gauge-high', '站点概览', '数据来自 Supabase Auth Admin API 与 gh_site 表', refreshBtn()) + loading();
        const d = await api('/api/admin/stats');
        if (!guard(token)) return;

        const stats = [
            ['网站总数', d.totalSites, 'fa-globe'],
            ['注册用户', d.totalUsers, 'fa-users'],
            ['今日新增站点', d.sitesToday, 'fa-plus'],
            ['今日新用户', d.usersToday, 'fa-user-plus'],
            ['近 7 日活跃', d.activeUsers7d, 'fa-bolt'],
            ['累计访问量', d.totalVisits, 'fa-eye'],
        ];
        let html = pageHead('fa-gauge-high', '站点概览', 'Asia/Shanghai 口径 · ' + (d.meta && d.meta.cached ? '缓存数据' : '实时读取') + (d.meta && (d.meta.usersTruncated || d.meta.sitesTruncated) ? ' · 已达扫描上限' : ''), refreshBtn());
        html += `<div class="gh-grid gh-grid-4" style="margin-bottom:16px">${stats.map(([k, v, icon]) =>
            `<div class="gh-stat"><div class="gh-stat-num">${fmtNum(v)}</div><div class="gh-stat-label"><i class="fas ${icon}"></i> ${esc(k)}</div></div>`
        ).join('')}</div>`;

        const types = d.byType || {};
        html += cardPadded('fa-layer-group', '站点类型分布',
            `<div class="gh-pill-list"><span class="gh-pill">HTML：${fmtNum(types.html)}</span><span class="gh-pill">Markdown：${fmtNum(types.md)}</span><span class="gh-pill">多文件项目：${fmtNum(types.project)}</span></div>`);

        const siteRows = (d.recentSites || []).map(s => `<tr class="gh-row-click" data-action="open-site" data-slug="${esc(s.name)}">
            <td class="gh-cell-strong gh-mono">${esc(s.name)}</td><td>${typeBadge(s.type)}</td>
            <td class="gh-cell-muted">${esc(s.ownerEmail || s.ownerId || '—')}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(s.createdAt)}</td>
            <td class="gh-cell-actions"><button class="gh-btn gh-btn-sm" data-action="open-site" data-slug="${esc(s.name)}">查看</button></td></tr>`);
        html += card('fa-clock-rotate-left', '最近创建的站点', tableHtml(
            ['站点', '类型', '所有者', '创建时间', ''], siteRows, empty('fa-globe', '暂无站点')
        ));

        const userRows = (d.recentUsers || []).map(u => `<tr class="gh-row-click" data-action="open-user" data-uid="${esc(u.uid)}">
            <td class="gh-cell-strong">${esc(u.email || '—')}</td><td>${esc(u.name || '未设置')}</td>
            <td class="gh-mono gh-cell-muted">${shortUid(u.uid)}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(u.createdAt)}</td>
            <td class="gh-cell-muted">${fmtNum(u.siteCount)}</td>
            <td class="gh-cell-actions"><button class="gh-btn gh-btn-sm" data-action="open-user" data-uid="${esc(u.uid)}">查看</button></td></tr>`);
        html += card('fa-user-plus', '最近注册的用户', tableHtml(
            ['邮箱', '名字', 'UID', '注册时间', '站点数', ''], userRows, empty('fa-users', '暂无用户')
        ), `<button class="gh-btn gh-btn-sm" data-action="back" data-to="users">查看全部用户 <i class="fas fa-arrow-right"></i></button>`);

        view.innerHTML = html;
    }

    /* ------------------------------------------------------------------
     * 用户列表
     * ------------------------------------------------------------------ */

    function usersToolbar() {
        const s = state.users;
        const sortSelect = `<select class="gh-select" data-filter="users-sort">
            <option value="createdAt" ${s.sort === 'createdAt' ? 'selected' : ''}>注册时间</option>
            <option value="lastSignInAt" ${s.sort === 'lastSignInAt' ? 'selected' : ''}>最后登录</option>
            <option value="siteCount" ${s.sort === 'siteCount' ? 'selected' : ''}>站点数</option>
            <option value="email" ${s.sort === 'email' ? 'selected' : ''}>邮箱</option>
            <option value="name" ${s.sort === 'name' ? 'selected' : ''}>名字</option></select>`;
        return searchHtml('users', '搜索邮箱 / 名字 / UID', s.q) + sortSelect +
            `<button class="gh-btn" data-action="toggle-dir" data-scope="users" title="切换排序方向"><i class="fas fa-arrow-${s.dir === 'asc' ? 'up' : 'down'}-wide-short"></i> ${s.dir === 'asc' ? '升序' : '降序'}</button>` + refreshBtn();
    }
    function usersTableHtml(d) {
        const rows = (d.users || []).map(u => {
            const status = u.bannedUntil ? badge('已封禁', 'danger')
                : u.emailConfirmedAt ? badge('正常', 'ok') : badge('未验证邮箱', 'warn');
            return `<tr class="gh-row-click" data-action="open-user" data-uid="${esc(u.uid)}">
                <td class="gh-cell-strong">${esc(u.email || '—')}</td>
                <td>${esc(u.name || '未设置')}</td>
                <td class="gh-mono gh-cell-muted">${shortUid(u.uid)}
                    <button class="gh-btn gh-btn-sm gh-btn-link" data-action="copy" data-copy="${esc(u.uid)}" title="复制完整 UID"><i class="fas fa-copy"></i></button></td>
                <td class="gh-cell-muted gh-nowrap">${fmtDate(u.createdAt)}</td>
                <td class="gh-cell-muted gh-nowrap">${fmtDate(u.lastSignInAt)}</td>
                <td class="gh-cell-strong">${fmtNum(u.siteCount)}</td>
                <td>${status}</td>
                <td class="gh-cell-actions">
                    <button class="gh-btn gh-btn-sm" data-action="open-user" data-uid="${esc(u.uid)}"><i class="fas fa-arrow-up-right-from-square"></i> 详情</button>
                    <button class="gh-btn gh-btn-sm gh-btn-danger" data-action="delete-user" data-uid="${esc(u.uid)}" data-email="${esc(u.email)}" data-count="${fmtNum(u.siteCount)}"><i class="fas fa-user-times"></i></button>
                </td></tr>`;
        });
        return tableHtml(
            ['邮箱', '名字', 'UID', '注册时间', '最后登录时间', '站点数', '状态', ''], rows,
            empty('fa-users', state.users.q ? '没有匹配的用户' : '暂无用户')
        ) + pagerHtml(d.pagination, 'users');
    }
    async function renderUsers(token) {
        setCrumb([{ text: '用户' }]);
        const s = state.users;
        view.innerHTML = pageHead('fa-users', '用户管理',
            '用户字段来自 Supabase Auth：邮箱、名字(user_metadata.nickname)、UID、注册与最后登录时间', refreshBtn()) +
            card('fa-list', '全部用户', loading(), usersToolbar());
        const d = await api('/api/admin/users?' + qs({ page: s.page, limit: PAGE_SIZE, q: s.q, sort: s.sort, dir: s.dir }));
        if (!guard(token)) return;
        const body = document.getElementById('view');
        body.innerHTML = pageHead('fa-users', '用户管理',
            `共 ${fmtNum(d.pagination && d.pagination.total)} 位用户 · ${d.meta && d.meta.source === 'supabase-auth-admin' ? 'Auth Admin API 实时数据' : ''}`, refreshBtn()) +
            card('fa-list', '全部用户', usersTableHtml(d), usersToolbar());
    }

    /* ------------------------------------------------------------------
     * 用户详情（SPA 钻取第一层）
     * ------------------------------------------------------------------ */

    async function renderUserDetail(uid, token) {
        setCrumb([{ text: '用户', href: '#/users' }, { text: '用户详情' }]);
        view.innerHTML = pageHead('fa-user', '用户详情', esc(uid), '') + loading();
        const d = await api('/api/admin/users/' + encodeURIComponent(uid));
        if (!guard(token)) return;
        state.userDetail = d;
        const u = d.user || {};
        const sum = d.summary || {};
        const byType = sum.byType || {};

        let html = pageHead('fa-user', u.name || u.email || '用户详情',
            `${esc(u.email || '—')} · <span class="gh-mono">${esc(u.uid)}</span>`,
            `<button class="gh-btn" data-action="copy" data-copy="${esc(u.uid)}"><i class="fas fa-copy"></i> 复制 UID</button>` +
            `<button class="gh-btn" data-action="back" data-to="users"><i class="fas fa-arrow-left"></i> 用户列表</button>` +
            `<button class="gh-btn gh-btn-danger" data-action="delete-user" data-uid="${esc(u.uid)}" data-email="${esc(u.email)}" data-count="${fmtNum(sum.siteCount)}"><i class="fas fa-user-times"></i> 删除用户</button>`);

        html += `<div class="gh-grid gh-grid-2">`;
        html += cardPadded('fa-id-card', '账号资料', kv([
            ['邮箱', esc(u.email || '—')],
            ['名字', esc(u.name || '未设置')],
            ['UID', `<span class="gh-mono">${esc(u.uid)}</span>`],
            ['注册时间', fmtDate(u.createdAt)],
            ['最后登录时间', fmtDate(u.lastSignInAt)],
            ['邮箱确认时间', fmtDate(u.emailConfirmedAt)],
            ['账号更新时间', fmtDate(u.updatedAt)],
            ['登录方式', esc((u.providers || []).join(', ') || u.provider || '—')],
            ['账号类型', u.isAnonymous ? badge('匿名用户', 'warn') : badge('正式用户', 'ok')],
            ['封禁状态', u.bannedUntil ? badge('封禁至 ' + fmtDate(u.bannedUntil), 'danger') : badge('正常', 'ok')],
        ]));
        html += cardPadded('fa-chart-simple', '名下站点概况',
            kv([
                ['站点总数', `<strong style="font-size:18px">${fmtNum(sum.siteCount)}</strong>`],
                ['HTML / MD / 项目', `${fmtNum(byType.html)} / ${fmtNum(byType.md)} / ${fmtNum(byType.project)}`],
                ['累计访问量', fmtNum(sum.totalVisits)],
                ['最近创建站点', fmtDate(sum.lastCreatedAt)],
            ]) + `<div class="gh-divider"></div><p class="gh-note">点击下表中的站点可继续查看站点详情；所有删除操作都会先清理 Storage 文件再删记录。</p>`);
        html += `</div>`;

        const siteRows = (d.sites || []).map(s => `<tr class="gh-row-click" data-action="open-site" data-slug="${esc(s.name)}" data-from="${esc(u.uid)}">
            <td class="gh-cell-strong gh-mono">${esc(s.name)}</td>
            <td>${typeBadge(s.type)}</td>
            <td>${fmtNum(s.visitCount)}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(s.createdAt)}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(s.updatedAt)}</td>
            <td class="gh-cell-actions"><button class="gh-btn gh-btn-sm" data-action="open-site" data-slug="${esc(s.name)}" data-from="${esc(u.uid)}"><i class="fas fa-arrow-up-right-from-square"></i> 查看</button></td></tr>`);
        html += card('fa-globe', '名下网站', tableHtml(
            ['站点', '类型', '访问量', '创建时间', '更新时间', ''], siteRows,
            empty('fa-globe', '该用户还没有创建站点')
        ), `<button class="gh-btn gh-btn-sm" data-action="back" data-to="users"><i class="fas fa-arrow-left"></i> 返回用户列表</button>`);

        view.innerHTML = html;
    }

    /* ------------------------------------------------------------------
     * 站点列表
     * ------------------------------------------------------------------ */

    function sitesToolbar() {
        const s = state.sites;
        const typeSel = `<select class="gh-select" data-filter="sites-type">
            <option value="" ${!s.type ? 'selected' : ''}>全部类型</option>
            <option value="html" ${s.type === 'html' ? 'selected' : ''}>HTML</option>
            <option value="md" ${s.type === 'md' ? 'selected' : ''}>Markdown</option>
            <option value="project" ${s.type === 'project' ? 'selected' : ''}>多文件项目</option></select>`;
        const orderSel = `<select class="gh-select" data-filter="sites-order">
            <option value="updatedAt" ${s.order === 'updatedAt' ? 'selected' : ''}>最近更新</option>
            <option value="createdAt" ${s.order === 'createdAt' ? 'selected' : ''}>创建时间</option>
            <option value="visitCount" ${s.order === 'visitCount' ? 'selected' : ''}>访问量</option>
            <option value="name" ${s.order === 'name' ? 'selected' : ''}>名称</option>
            <option value="ownerEmail" ${s.order === 'ownerEmail' ? 'selected' : ''}>所有者邮箱</option></select>`;
        return searchHtml('sites', '搜索站点 / 邮箱 / UID / IP', s.q) + typeSel + orderSel +
            `<button class="gh-btn" data-action="toggle-dir" data-scope="sites"><i class="fas fa-arrow-${s.dir === 'asc' ? 'up' : 'down'}-wide-short"></i> ${s.dir === 'asc' ? '升序' : '降序'}</button>` + refreshBtn();
    }
    function sitesTableHtml(d) {
        const rows = (d.sites || []).map(s => `<tr class="gh-row-click" data-action="open-site" data-slug="${esc(s.name)}">
            <td class="gh-cell-strong gh-mono">${esc(s.name)}</td>
            <td>${typeBadge(s.type)}</td>
            <td><div>${esc(s.ownerEmail || s.ownerId || '—')}</div><div class="gh-cell-muted">${esc(s.ownerName || '')}</div></td>
            <td>${fmtNum(s.visitCount)}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(s.createdAt)}</td>
            <td class="gh-cell-actions">
                <button class="gh-btn gh-btn-sm" data-action="open-site" data-slug="${esc(s.name)}">详情</button>
                <a class="gh-btn gh-btn-sm" href="${esc(siteLink(s))}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="fas fa-arrow-up-right-from-square"></i></a>
                <button class="gh-btn gh-btn-sm gh-btn-danger" data-action="delete-site" data-slug="${esc(s.name)}"><i class="fas fa-trash"></i></button>
            </td></tr>`);
        return tableHtml(['站点', '类型', '所有者', '访问量', '创建时间', ''], rows,
            empty('fa-globe', state.sites.q ? '没有匹配的站点' : '暂无站点')) + pagerHtml(d.pagination, 'sites');
    }
    async function renderSites(token) {
        setCrumb([{ text: '站点' }]);
        const s = state.sites;
        view.innerHTML = pageHead('fa-globe', '站点管理', '支持按站点名、所有者邮箱/名字/UID、IP 搜索', refreshBtn()) +
            card('fa-list', '全部站点', loading(), sitesToolbar());
        const d = await api('/api/admin/sites?' + qs({ page: s.page, limit: PAGE_SIZE, q: s.q, type: s.type, order: s.order, dir: s.dir }));
        if (!guard(token)) return;
        view.innerHTML = pageHead('fa-globe', '站点管理',
            `共 ${fmtNum(d.pagination && d.pagination.total)} 个站点 · 所有者信息来自 Supabase Auth`, refreshBtn()) +
            card('fa-list', '全部站点', sitesTableHtml(d), sitesToolbar());
    }

    /* ------------------------------------------------------------------
     * 站点详情（SPA 钻取第二层）
     * ------------------------------------------------------------------ */

    async function renderSiteDetail(slug, fromUser, token) {
        const crumb = [{ text: '站点', href: '#/sites' }];
        if (fromUser) crumb.push({ text: '用户 ' + shortUid(fromUser), href: '#/users/' + encodeURIComponent(fromUser) });
        crumb.push({ text: slug });
        setCrumb(crumb);
        view.innerHTML = pageHead('fa-globe', slug, '站点详情', '') + loading();
        const d = await api('/api/admin/site/' + encodeURIComponent(slug));
        if (!guard(token)) return;
        const s = d.site || {};
        state.siteDetail = s;

        const backTo = fromUser ? 'users/' + encodeURIComponent(fromUser) : 'sites';
        let actions = `<a class="gh-btn gh-btn-primary" href="${esc(siteLink(s))}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> 访问站点</a>`;
        if (s.type !== 'project') actions += `<button class="gh-btn" data-action="edit-site-content" data-slug="${esc(s.name)}"><i class="fas fa-pen"></i> 编辑内容</button>`;
        actions += `<button class="gh-btn" data-action="back" data-to="${esc(backTo)}"><i class="fas fa-arrow-left"></i> 返回</button>`;
        actions += `<button class="gh-btn gh-btn-danger" data-action="delete-site" data-slug="${esc(s.name)}"><i class="fas fa-trash"></i> 删除</button>`;

        const ownerHtml = s.owner
            ? `${esc(s.owner.email || '—')} <span class="gh-cell-muted">(${esc(s.owner.name || '未设置')})</span><br>` +
              `<a class="gh-mono" href="#/users/${encodeURIComponent(s.ownerId)}" style="font-size:12px">${esc(s.ownerId)}</a>`
            : esc(s.ownerId || '—');

        let html = pageHead('fa-globe', s.name, `类型 ${esc(s.type || 'html')} · 访问量 ${fmtNum(s.visitCount)}`, actions);
        html += cardPadded('fa-circle-info', '站点信息', kv([
            ['站点名称', `<span class="gh-mono">${esc(s.name)}</span>`],
            ['类型', typeBadge(s.type)],
            ['所有者', ownerHtml],
            ['公开地址', `<a href="${esc(siteLink(s))}" target="_blank" rel="noopener">${esc(siteLink(s))}</a>`],
            ['累计访问量', fmtNum(s.visitCount)],
            ['创建 IP', esc(s.ipAddress || '—')],
            ['创建时间', fmtDate(s.createdAt)],
            ['更新时间', fmtDate(s.updatedAt)],
        ]));

        if (s.type === 'project') {
            const files = (s.files && s.files.files) || [];
            const rows = files.map(f => `<div class="gh-file-row"><div class="gh-file-name"><i class="fas fa-file-code"></i> ${esc(f.name)}</div>` +
                `<div style="display:flex;gap:6px;align-items:center"><span class="gh-file-size">${fmtSize(f.size)}</span>` +
                `<button class="gh-btn gh-btn-sm" data-action="proj-file-edit" data-slug="${esc(s.name)}" data-path="${esc(f.name)}">编辑</button>` +
                `<button class="gh-btn gh-btn-sm" data-action="proj-file-replace" data-slug="${esc(s.name)}" data-path="${esc(f.name)}">替换</button>` +
                `<button class="gh-btn gh-btn-sm gh-btn-danger" data-action="proj-file-delete" data-slug="${esc(s.name)}" data-path="${esc(f.name)}"><i class="fas fa-trash"></i></button></div></div>`).join('');
            html += `<section class="gh-card"><div class="gh-card-head"><div class="gh-card-title"><i class="fas fa-folder-open"></i>文件列表</div>` +
                `<div class="gh-toolbar"><span class="gh-note">共 ${files.length} 个文件 · ${fmtSize(s.files && s.files.totalSize)}</span>${refreshBtn()}</div></div>` +
                `<div class="gh-card-body" style="padding:0">${rows || empty('fa-folder-open', '该站点暂无文件')}</div></section>`;
        } else {
            const content = (s.content && s.content.text) || '';
            const preview = content.length > 20000 ? content.slice(0, 20000) + '\n…（内容过长，仅预览前 20000 字符）' : content;
            html += `<section class="gh-card"><div class="gh-card-head"><div class="gh-card-title"><i class="fas fa-file-code"></i>内容预览</div>` +
                `<div class="gh-toolbar"><span class="gh-note">${esc(s.content && s.content.kind || '')} · ${fmtSize(new Blob([content]).size)}</span>` +
                `<button class="gh-btn gh-btn-sm" data-action="edit-site-content" data-slug="${esc(s.name)}"><i class="fas fa-pen"></i> 编辑</button></div></div>` +
                `<div class="gh-card-body"><pre class="gh-pre">${esc(preview || '（空文件）')}</pre></div></section>`;
        }

        view.innerHTML = html;
    }

    function projFilePath(slug, path) {
        return '/api/proj-file/' + encodeURIComponent(slug) + '/' + String(path).split('/').map(encodeURIComponent).join('/');
    }

    /* ------------------------------------------------------------------
     * 广场
     * ------------------------------------------------------------------ */

    async function renderPlay(token) {
        setCrumb([{ text: '广场' }]);
        const p = state.play;
        const tabs = `<div class="gh-tabs"><button class="gh-tab ${p.tab === 'posts' ? 'active' : ''}" data-action="play-tab" data-tab="posts">帖子</button>` +
            `<button class="gh-tab ${p.tab === 'comments' ? 'active' : ''}" data-action="play-tab" data-tab="comments">评论</button></div>`;
        view.innerHTML = pageHead('fa-comments', '广场管理', '帖子 / 评论审核与删除', refreshBtn()) +
            `<div class="gh-grid gh-grid-4" id="playStats" style="margin-bottom:16px">${loading('加载统计…')}</div>` + tabs +
            card('fa-list', p.tab === 'posts' ? '全部帖子' : '全部评论', loading(),
                searchHtml('play', '搜索内容 / 作者 / 邮箱', p.q) + refreshBtn());
        const endpoint = p.tab === 'posts' ? 'posts' : 'comments';
        const [stats, list] = await Promise.all([
            api('/api/admin/play/stats'),
            api('/api/admin/play/' + endpoint + '?' + qs({ page: p.page, limit: PAGE_SIZE, q: p.q })),
        ]);
        if (!guard(token)) return;
        const statCards = [
            ['帖子', stats.posts], ['站点帖', stats.site_posts], ['文字帖', stats.text_posts],
            ['评论', stats.comments], ['AI 评论', stats.ai_comments], ['点赞', stats.likes],
            ['关注', stats.follows], ['24h 新帖', stats.posts_today],
        ].map(([k, v]) => `<div class="gh-stat"><div class="gh-stat-num">${fmtNum(v)}</div><div class="gh-stat-label">${esc(k)}</div></div>`).join('');

        const body = p.tab === 'posts' ? postsTableHtml(list) : commentsTableHtml(list);
        view.innerHTML = pageHead('fa-comments', '广场管理', '搜索会同时匹配内容、帖子标题与作者邮箱', refreshBtn()) +
            `<div class="gh-grid gh-grid-4" style="margin-bottom:16px">${statCards}</div>` + tabs +
            card('fa-list', p.tab === 'posts' ? '全部帖子' : '全部评论', body,
                searchHtml('play', '搜索内容 / 作者 / 邮箱', p.q) + refreshBtn());
    }
    function postsTableHtml(d) {
        const rows = (d.posts || []).map(x => `<tr>
            <td class="gh-cell-strong gh-ellipsis" title="${esc(x.title || '')}">${esc(x.title || '（无标题）')}</td>
            <td>${x.kind === 'site' ? badge('站点分享', 'ok') : badge('文字', 'muted')}</td>
            <td><div>${esc((x.author && (x.author.nickname || x.author.accountName)) || '—')}</div><div class="gh-cell-muted">${esc(x.author && x.author.email || '')}</div></td>
            <td class="gh-cell-muted">${fmtNum(x.like_count)} / ${fmtNum(x.comment_count)} / ${fmtNum(x.view_count)}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(x.created_at)}</td>
            <td class="gh-cell-actions">
                <button class="gh-btn gh-btn-sm" data-action="play-post-detail" data-id="${esc(x.id)}">详情</button>
                <button class="gh-btn gh-btn-sm gh-btn-danger" data-action="delete-play-post" data-id="${esc(x.id)}" data-title="${esc(x.title || '')}"><i class="fas fa-trash"></i></button>
            </td></tr>`);
        return tableHtml(['标题', '类型', '作者', '赞 / 评 / 浏览', '发布时间', ''], rows,
            empty('fa-comments', state.play.q ? '没有匹配的帖子' : '暂无帖子')) + pagerHtml(d.pagination, 'play');
    }
    function commentsTableHtml(d) {
        const rows = (d.comments || []).map(x => `<tr>
            <td class="gh-ellipsis" title="${esc(x.content || '')}">${esc(x.content || '')}</td>
            <td class="gh-cell-muted gh-ellipsis">${esc(x.post_title || x.post_id || '—')}</td>
            <td>${x.author && x.author.is_ai ? badge('AI 小鹅C', 'warn') : esc((x.author && (x.author.nickname || x.author.email)) || '—')}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(x.created_at)}</td>
            <td class="gh-cell-actions"><button class="gh-btn gh-btn-sm gh-btn-danger" data-action="delete-play-comment" data-id="${esc(x.id)}"><i class="fas fa-trash"></i></button></td></tr>`);
        return tableHtml(['内容', '所属帖子', '作者', '发布时间', ''], rows,
            empty('fa-comment', state.play.q ? '没有匹配的评论' : '暂无评论')) + pagerHtml(d.pagination, 'play');
    }
    async function showPlayPost(id) {
        const d = await api('/api/admin/play/post/' + encodeURIComponent(id));
        const p = d.post || {};
        const list = (d.comments || []).map(c => `<div class="gh-file-row"><div style="min-width:0"><div class="gh-file-name">${esc(c.content || '')}</div>` +
            `<div class="gh-cell-muted">${esc((c.author && (c.author.nickname || c.author.email)) || '—')} · ${fmtDate(c.created_at)}</div></div></div>`).join('');
        openModal(
            `<div class="gh-modal-head"><span>帖子详情</span><button class="gh-modal-close" data-action="modal-close"><i class="fas fa-xmark"></i></button></div>` +
            `<div class="gh-modal-body">` +
            `<div class="gh-kv" style="margin-bottom:12px">` +
            `<div class="gh-kv-item"><div class="gh-kv-key">标题</div><div class="gh-kv-val">${esc(p.title || '（无标题）')}</div></div>` +
            `<div class="gh-kv-item"><div class="gh-kv-key">作者</div><div class="gh-kv-val">${esc((p.author && (p.author.nickname || p.author.email)) || '—')}</div></div>` +
            `<div class="gh-kv-item"><div class="gh-kv-key">发布时间</div><div class="gh-kv-val">${fmtDate(p.created_at)}</div></div>` +
            `<div class="gh-kv-item"><div class="gh-kv-key">赞 / 评 / 浏览</div><div class="gh-kv-val">${fmtNum(p.like_count)} / ${fmtNum(p.comment_count)} / ${fmtNum(p.view_count)}</div></div>` +
            `</div><pre class="gh-pre" style="max-height:220px">${esc(p.content || '（无正文）')}</pre>` +
            `<div class="gh-divider"></div><p class="gh-note" style="margin-bottom:8px">最近 ${(d.comments || []).length} 条评论</p>` +
            (list || empty('fa-comment', '暂无评论')) + `</div>` +
            `<div class="gh-modal-foot"><button class="gh-btn" data-action="modal-close">关闭</button></div>`, true);
    }

    /* ------------------------------------------------------------------
     * 公告
     * ------------------------------------------------------------------ */

    async function renderAnnouncement(token) {
        setCrumb([{ text: '公告' }]);
        view.innerHTML = pageHead('fa-bullhorn', '全局公告', '发布后所有用户面板顶部显示', refreshBtn()) + loading();
        const d = await api('/api/admin/announcement');
        if (!guard(token)) return;
        const cur = d.announcement;
        const history = (d.history || []).map(h => `<tr>
            <td class="gh-ellipsis">${esc(h.content)}</td>
            <td>${h.is_active ? badge('生效中', 'ok') : badge('已停用', 'muted')}</td>
            <td class="gh-cell-muted gh-nowrap">${fmtDate(h.created_at)}</td></tr>`).join('');

        let html = pageHead('fa-bullhorn', '全局公告', '单行文本，最长 500 字符', refreshBtn());
        html += cardPadded('fa-bullhorn', '当前生效公告',
            cur ? `<div style="font-size:15px;margin-bottom:8px">${esc(cur.content)}</div><div class="gh-note">发布于 ${fmtDate(cur.created_at)}</div>`
                : `<div class="gh-note">当前没有生效的公告</div>`,
            `<button class="gh-btn gh-btn-danger" data-action="clear-announcement" ${cur ? '' : 'disabled'}><i class="fas fa-eraser"></i> 清除公告</button>`);
        html += cardPadded('fa-pen', '发布新公告',
            `<div class="gh-field"><label class="gh-label">公告内容</label>` +
            `<input id="announcementText" class="gh-input" maxlength="500" placeholder="输入公告内容（≤500 字符）"></div>` +
            `<p class="gh-note" style="margin-top:8px">发布会自动停用此前所有生效公告。</p>`,
            `<button class="gh-btn gh-btn-primary" data-action="publish-announcement"><i class="fas fa-paper-plane"></i> 发布公告</button>`);
        html += card('fa-clock-rotate-left', '最近 10 条', tableHtml(['内容', '状态', '发布时间'], [history].flat().filter(Boolean),
            empty('fa-clock-rotate-left', '暂无历史公告')));
        view.innerHTML = html;
    }

    /* ------------------------------------------------------------------
     * 工具：同步邮箱 / 孤儿清理
     * ------------------------------------------------------------------ */

    async function renderTools(token) {
        setCrumb([{ text: '工具' }]);
        const t = state.tools;
        let html = pageHead('fa-screwdriver-wrench', '维护工具', '兼容旧数据与 Storage 孤儿文件清理', refreshBtn());
        html += cardPadded('fa-address-book', '同步邮箱映射',
            `<p class="gh-note">后台展示已直接使用 Supabase Auth Admin API，不再依赖 <code>admin/email-map.json</code>。` +
            `此操作仅用于刷新注册/销号等旧逻辑仍在使用的兼容映射文件（按官方 listUsers 全量分页）。</p>`,
            `<button class="gh-btn" data-action="sync-emails"><i class="fas fa-rotate"></i> 立即同步</button>`);

        const result = t.result;
        let resultHtml = '';
        if (result) {
            const groups = (result.groups || []).map(g => `<tr><td>${esc(g.bucket)}</td><td class="gh-mono">${esc(g.prefix)}</td><td>${fmtNum(g.count)}</td></tr>`).join('');
            resultHtml = `<div class="gh-divider"></div>` +
                kv([
                    ['模式', result.dryRun ? badge('仅预览', 'warn') : badge('已执行', 'ok')],
                    ['扫描对象', fmtNum(Object.values(result.scanned || {}).reduce((a, b) => a + (Number(b) || 0), 0))],
                    ['孤儿文件', fmtNum(result.orphanFiles)],
                    ['已删除', fmtNum(result.deleted)],
                    ['跳过(非站点对象)', fmtNum(result.skipped)],
                ]) +
                (groups ? `<div style="margin-top:12px">${tableHtml(['桶', '前缀', '文件数'], [groups].flat().filter(Boolean))}</div>` : '') +
                (result.groupsTruncated ? `<p class="gh-note" style="margin-top:8px">分组过多，仅显示前 200 组。</p>` : '') +
                (result.errors && result.errors.length ? `<div class="gh-pre" style="margin-top:10px;color:var(--gh-a-danger)">${esc(result.errors.map(e => e.bucket + ': ' + e.message).join('\n'))}</div>` : '');
        } else {
            resultHtml = `<p class="gh-note">先点「预览」查看将被删除的孤儿文件，确认后再执行。</p>`;
        }

        html += cardPadded('fa-broom', '历史孤儿文件清理',
            `<div class="gh-field" style="max-width:420px"><label class="gh-label">限定用户 UID（可选，建议先小范围试）</label>` +
            `<input id="orphanOwner" class="gh-input" placeholder="留空则扫描全部用户" value="${esc(t.ownerId)}"></div>` +
            `<div class="gh-divider"></div><p class="gh-note">` +
            `判定规则：<code>&lt;UUID&gt;/&lt;slug&gt;/…</code> 前缀不在 gh_site 中的对象即孤儿；` +
            `删除一律走 Supabase Storage API 并检查 error，<strong>禁止直接 SQL 删除 storage.objects</strong>。</p>` + resultHtml,
            `<button class="gh-btn" data-action="orphan-preview"><i class="fas fa-magnifying-glass"></i> 预览 (dryRun)</button>` +
            `<button class="gh-btn gh-btn-danger" data-action="orphan-run" ${result && result.dryRun && result.orphanFiles > 0 ? '' : 'disabled'}><i class="fas fa-trash"></i> 执行清理</button>`);
        view.innerHTML = html;
    }

    /* ------------------------------------------------------------------
     * 事件委托
     * ------------------------------------------------------------------ */

    async function handleAction(action, el, ev) {
        const ds = el.dataset;
        switch (action) {
            case 'toggle-sidebar': sidebar.classList.toggle('open'); break;
            case 'reload': await reload(); break;
            case 'back': navigate(ds.to || 'overview'); break;
            case 'open-user': navigate('users/' + encodeURIComponent(ds.uid)); break;
            case 'open-site': navigate('sites/' + encodeURIComponent(ds.slug) + (ds.from ? '?from=' + encodeURIComponent(ds.from) : '')); break;
            case 'copy': {
                try { await navigator.clipboard.writeText(ds.copy || ''); toast('已复制到剪贴板', 'success'); }
                catch (_) { toast('复制失败，请手动选中文本', 'error'); }
                break;
            }
            case 'page': {
                const scope = ds.scope;
                if (state[scope]) { state[scope].page = Math.max(1, parseInt(ds.page) || 1); await reload(); view.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                break;
            }
            case 'toggle-dir': {
                const scope = ds.scope;
                if (state[scope]) { state[scope].dir = state[scope].dir === 'asc' ? 'desc' : 'asc'; state[scope].page = 1; await reload(); }
                break;
            }
            case 'delete-user': {
                const uid = ds.uid, email = ds.email || uid, count = ds.count || '0';
                confirmAction({
                    title: '删除用户',
                    message: `确定删除用户 ${email} 吗？该用户名下 ${count} 个站点的文件会先被清理，随后删除站点记录与 Auth 账号。`,
                    note: '此操作不可恢复。若 Storage 清理失败，接口会返回 500 并保留账号与记录，可重试。',
                    confirmText: '删除用户',
                    onConfirm: () => afterWrite(() => post('/api/admin/delete-user', { userId: uid }), '用户已删除', 'users'),
                });
                break;
            }
            case 'delete-site': {
                const slug = ds.slug;
                confirmAction({
                    title: '删除站点',
                    message: `确定删除站点「${slug}」吗？`,
                    note: '会先删除 sites / md / projects 桶里对应文件，再删 gh_site 记录；清理失败时记录保留。',
                    confirmText: '删除站点',
                    onConfirm: () => afterWrite(() => post('/api/admin/delete-site', { siteName: slug }), '站点已删除', 'sites'),
                });
                break;
            }
            case 'edit-site-content': {
                const s = state.siteDetail;
                if (!s || s.type === 'project') { toast('多文件站点请使用文件级编辑', 'error'); break; }
                const kind = (s.content && s.content.kind) || 'html';
                openEditor({
                    title: '编辑站点内容 · ' + s.name,
                    subtitle: kind === 'md' ? 'Markdown 源码' : 'HTML 源码',
                    content: (s.content && s.content.text) || '',
                    note: '单文件上限 500KB；保存会覆盖 Storage 中的原文件。',
                    onSave: (text) => afterWrite(
                        () => post('/api/admin/site/' + encodeURIComponent(s.name), { [kind]: text }),
                        '内容已保存'
                    ),
                });
                break;
            }
            case 'editor-save': {
                const fn = pendingEditorSave;
                const text = document.getElementById('ghEditor');
                const value = text ? text.value : '';
                closeModal();
                if (fn) { try { await fn(value); } catch (e) { toast(e.message, 'error'); } }
                break;
            }
            case 'modal-close': closeModal(); break;
            case 'modal-confirm': {
                const fn = pendingConfirm;
                closeModal();
                if (fn) { try { await fn(); } catch (e) { toast(e.message, 'error'); } }
                break;
            }
            case 'proj-file-edit': {
                const slug = ds.slug, path = ds.path;
                try {
                    const d = await api(projFilePath(slug, path));
                    openEditor({
                        title: '编辑文件 · ' + path,
                        subtitle: path,
                        content: d.content || '',
                        note: '单文件上限 200KB。',
                        onSave: (text) => afterWrite(() => post(projFilePath(slug, path), { content: text }, 'PUT'), '文件已保存'),
                    });
                } catch (e) { toast(e.message, 'error'); }
                break;
            }
            case 'proj-file-replace': {
                const slug = ds.slug, path = ds.path;
                const input = document.createElement('input');
                input.type = 'file';
                input.onchange = async () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    try {
                        const text = await file.text();
                        await afterWrite(() => post(projFilePath(slug, path), { content: text }, 'PUT'), '文件已替换');
                    } catch (e) { toast(e.message, 'error'); }
                };
                input.click();
                break;
            }
            case 'proj-file-delete': {
                const slug = ds.slug, path = ds.path;
                confirmAction({
                    title: '删除文件',
                    message: `确定删除文件「${path}」吗？`,
                    confirmText: '删除文件',
                    onConfirm: () => afterWrite(() => api(projFilePath(slug, path), { method: 'DELETE' }), '文件已删除'),
                });
                break;
            }
            case 'play-tab': state.play.tab = ds.tab === 'comments' ? 'comments' : 'posts'; state.play.page = 1; await reload(); break;
            case 'play-post-detail': {
                try { await showPlayPost(ds.id); } catch (e) { toast(e.message, 'error'); }
                break;
            }
            case 'delete-play-post': {
                const id = ds.id;
                confirmAction({
                    title: '删除帖子',
                    message: `确定删除帖子「${ds.title || id}」吗？`,
                    note: '评论与点赞会一并删除，不可恢复。',
                    confirmText: '删除帖子',
                    onConfirm: () => afterWrite(() => api('/api/admin/play/post/' + encodeURIComponent(id), { method: 'DELETE' }), '帖子已删除'),
                });
                break;
            }
            case 'delete-play-comment': {
                const id = ds.id;
                confirmAction({
                    title: '删除评论',
                    message: '确定删除这条评论吗？',
                    note: '按现有逻辑，子回复由数据库约束处理。',
                    confirmText: '删除评论',
                    onConfirm: () => afterWrite(() => api('/api/admin/play/comment/' + encodeURIComponent(id), { method: 'DELETE' }), '评论已删除'),
                });
                break;
            }
            case 'publish-announcement': {
                const input = document.getElementById('announcementText');
                const content = input ? input.value.trim() : '';
                if (!content) { toast('公告内容不能为空', 'error'); break; }
                await afterWrite(() => post('/api/admin/announcement', { action: 'set', content: content }), '公告已发布');
                break;
            }
            case 'clear-announcement': {
                confirmAction({
                    title: '清除公告',
                    message: '确定停用当前生效的公告吗？',
                    confirmText: '清除', danger: false,
                    onConfirm: () => afterWrite(() => post('/api/admin/announcement', { action: 'clear' }), '公告已清除'),
                });
                break;
            }
            case 'sync-emails': {
                try {
                    const d = await post('/api/admin/sync-emails', {});
                    forceRefresh = true;
                    toast(`同步完成，共 ${fmtNum(d.count)} 个邮箱${d.truncated ? '（已达扫描上限）' : ''}`, 'success');
                } catch (e) { toast(e.message, 'error'); }
                break;
            }
            case 'orphan-preview': {
                const inp = document.getElementById('orphanOwner');
                state.tools.ownerId = inp ? inp.value.trim() : '';
                try {
                    const d = await post('/api/admin/cleanup-orphans', { dryRun: true, ownerId: state.tools.ownerId || undefined });
                    state.tools.result = d;
                    await reload();
                    toast(`预览完成：发现 ${fmtNum(d.orphanFiles)} 个孤儿文件（未删除）`, 'success');
                } catch (e) { toast(e.message, 'error'); }
                break;
            }
            case 'orphan-run': {
                const r = state.tools.result;
                if (!r || !r.dryRun) { toast('请先执行一次预览', 'error'); break; }
                confirmAction({
                    title: '执行孤儿文件清理',
                    message: `即将删除 ${fmtNum(r.orphanFiles)} 个孤儿文件，确认已核对上方预览结果？`,
                    note: '删除通过 Supabase Storage API 执行；范围：' + (state.tools.ownerId || '全部用户') + '。',
                    confirmText: '确认删除',
                    onConfirm: async () => {
                        const d = await post('/api/admin/cleanup-orphans', { dryRun: false, ownerId: state.tools.ownerId || undefined });
                        state.tools.result = d;
                        forceRefresh = true;
                        toast(d.errors && d.errors.length ? `清理完成但有 ${d.errors.length} 个桶失败` : `清理完成，删除 ${fmtNum(d.deleted)} 个文件`, d.errors && d.errors.length ? 'error' : 'success');
                        await reload();
                    },
                });
                break;
            }
            default: break;
        }
    }

    document.addEventListener('click', async (ev) => {
        if (ev.target === overlay) { closeModal(); return; }
        const el = ev.target.closest('[data-action]');
        if (!el) return;
        ev.preventDefault();
        const btn = el.closest('button');
        if (btn && btn.disabled) return;
        try { await handleAction(el.dataset.action, el, ev); }
        catch (e) { console.error('[admin] action failed:', e); toast(e.message, 'error'); }
    });

    document.addEventListener('input', (ev) => {
        const t = ev.target;
        if (!t || !t.dataset || !t.dataset.search) return;
        const scope = t.dataset.search;
        const val = t.value;
        clearTimeout(searchTimers[scope]);
        searchTimers[scope] = setTimeout(async () => {
            if (scope === 'users') { state.users.q = val.trim(); state.users.page = 1; await withFocus(() => renderUsers(currentToken())); }
            else if (scope === 'sites') { state.sites.q = val.trim(); state.sites.page = 1; await withFocus(() => renderSites(currentToken())); }
            else if (scope === 'play') { state.play.q = val.trim(); state.play.page = 1; await withFocus(() => renderPlay(currentToken())); }
        }, 320);
    });

    document.addEventListener('change', (ev) => {
        const t = ev.target;
        if (!t || !t.dataset || !t.dataset.filter) return;
        const f = t.dataset.filter;
        if (f === 'users-sort') { state.users.sort = t.value; state.users.page = 1; reload(); }
        else if (f === 'sites-type') { state.sites.type = t.value; state.sites.page = 1; reload(); }
        else if (f === 'sites-order') { state.sites.order = t.value; state.sites.page = 1; reload(); }
        else if (f === 'orphan-owner') { state.tools.ownerId = t.value.trim(); }
    });

    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });
    window.addEventListener('hashchange', renderRoute);

    /* ------------------------------------------------------------------
     * 初始化
     * ------------------------------------------------------------------ */

    async function loadAdminNickname() {
        try {
            const token = localStorage.getItem('sb_token');
            if (!token) return;
            const res = await GHAuth.apiFetch(API_URL + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
            if (!res.ok) return;
            const d = await res.json();
            const el = document.getElementById('adminNickname');
            if (el) el.textContent = d.nickname || d.email || '管理员';
        } catch (_) { /* 昵称仅展示，失败不影响后台 */ }
    }

    async function init() {
        if (!localStorage.getItem('sb_token')) { location.href = '../login/'; return; }
        loadAdminNickname();
        if (!location.hash || location.hash === '#') {
            history.replaceState(null, '', location.pathname + location.search + '#/overview');
        }
        await renderRoute();
    }

    init();
})();
