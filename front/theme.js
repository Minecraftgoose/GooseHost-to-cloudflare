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

  function avoidCollision() {
    // 右下角可能已有别的悬浮件（如第三方客服/反馈挂件），叠在一起会互相挡住。
    // 检测后把自己上移一格，避免遮挡。
    var btn = document.getElementById('ghThemeToggle');
    if (!btn) return;
    var box = btn.getBoundingClientRect();
    var clash = false;
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      if (el === btn || btn.contains(el)) return;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || +cs.opacity === 0) return;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
      clash = true;
    });
    btn.style.bottom = clash ? '70px' : '';
  }

  function init() {
    apply();
    buildButton();
    apply();
    // 外部悬浮件加载较慢，延后再判一次
    setTimeout(avoidCollision, 800);
    setTimeout(avoidCollision, 2500);

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
