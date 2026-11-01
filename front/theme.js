/* ===== GooseHost 全站主题切换 =====
 * 三态循环：浅色 → 深色 → 跟随系统
 * - 偏好写入 localStorage（键 gh-theme），跨页面共享
 * - 跟随系统时用 matchMedia 实时响应，系统切换立即生效
 * - 按钮为固定悬浮按钮（右上角），不侵入各页面现有布局
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'gh-theme';
  var MODES = ['light', 'dark', 'system'];
  var LABEL = { light: '浅色', dark: '深色', system: '跟随系统' };
  var ICON = { light: 'fa-sun', dark: 'fa-moon', system: 'fa-circle-half-stroke' };

  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readMode() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (MODES.indexOf(v) !== -1) return v;
    } catch (e) {}
    return 'system';
  }

  function saveMode(m) {
    try { localStorage.setItem(STORAGE_KEY, m); } catch (e) {}
  }

  function systemIsDark() {
    return mql ? mql.matches : false;
  }

  function resolve(mode) {
    if (mode === 'system') return systemIsDark() ? 'dark' : 'light';
    return mode;
  }

  function apply() {
    var mode = readMode();
    var theme = resolve(mode);
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = theme;
    syncButton(mode, theme);
  }

  function syncButton(mode, theme) {
    var btn = document.getElementById('ghThemeToggle');
    if (!btn) return;
    var icon = btn.querySelector('i');
    if (icon) {
      icon.className = 'fas ' + ICON[mode];
    }
    var tip = mode === 'system' ? LABEL[mode] + '（当前' + LABEL[theme] + '）' : LABEL[mode];
    btn.setAttribute('title', '主题：' + tip + ' · 点击切换');
    btn.setAttribute('aria-label', '切换主题，当前' + tip);
    var dot = btn.querySelector('.gh-theme-dot');
    if (dot) dot.textContent = '';
  }

  function buildButton() {
    if (document.getElementById('ghThemeToggle')) return;
    var btn = document.createElement('button');
    btn.id = 'ghThemeToggle';
    btn.className = 'gh-theme-toggle';
    btn.type = 'button';
    btn.innerHTML = '<i class="fas fa-circle-half-stroke"></i><span class="gh-theme-dot"></span>';
    btn.addEventListener('click', function () {
      var cur = readMode();
      var next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
      saveMode(next);
      apply();
    });
    document.body.appendChild(btn);
  }

  function init() {
    apply();
    buildButton();
    apply();

    if (mql) {
      var onChange = function () { if (readMode() === 'system') apply(); };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
    }

    // 多标签页同步
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY) apply();
    });
  }

  // 尽早应用，避免闪烁（DOM 未就绪时只设置属性，按钮稍后构建）
  apply();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
