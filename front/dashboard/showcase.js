(function () {
    'use strict';

    /* ===================================================================
     * 配置区：一条 = 一张可左右滑动的图片，点击图片跳转到 href
     *   img   : 图片地址。建议把图片放进 front/showcase/，用 /showcase/xxx 引用
     *   href  : 点击图片跳转的地址（http(s) 外链或站内相对路径均可）
     *   alt   : 图片说明；图片加载失败时作为兜底文字显示
     *   title : 可选，图片下方的标题。示例图自带文案，故留空
     *   desc  : 可选，图片下方的一行小字。示例图自带文案，故留空
     *   —— 换成没有文字的图片素材时，把 title / desc 填上即可叠加说明层
     * =================================================================== */
    const SHOWCASE_ITEMS = [
        {
            img: '/showcase/changelog.svg',
            href: '/changelog/',
            alt: '更新日志',
            title: '',
            desc: ''
        },
        {
            img: '/showcase/api.svg',
            href: '/api-docs/',
            alt: 'API 文档',
            title: '',
            desc: ''
        },
        {
            img: '/showcase/guide.svg',
            href: '/docs/',
            alt: '使用指南',
            title: '',
            desc: ''
        },
		{
		    img: 'https://kimi-file.moonshot.cn/prod-chat-kimi/kfs/4/2/2026-11-07/1dbndnnrkvk6ic0iulhj0?x-tos-process=image%2Fauto-orient%2C1%2Fstrip%2Fresize%2Cw_480%2Ch_480%2Cm_mfit%2Fignore-error%2C1',
			herf: 'https://ohdep.us.ci/',
			alt: 'ohdep · 把想法变成网址',
			title: 'ohdep · 把想法变成网址'
		}
    ];

    /* 自动切换间隔（毫秒）；设为 0 则只手动滑动 */
    const AUTO_PLAY_INTERVAL = 5500;

    /* 点击图片是否在新标签打开；false = 当前窗口跳转 */
    const OPEN_IN_NEW_TAB = true;

    const root = document.getElementById('ghShowcase');
    if (!root) return;
    if (!SHOWCASE_ITEMS.length) { root.hidden = true; return; }

    const track = root.querySelector('.gh-showcase-track');
    const dotsWrap = root.querySelector('.gh-showcase-dots');
    const prevBtn = root.querySelector('[data-dir="prev"]');
    const nextBtn = root.querySelector('[data-dir="next"]');
    if (!track) return;

    const dots = [];
    let index = 0;

    /* 只放行 http/https 与站内路径，避免误写 javascript: 之类的地址 */
    function safeHref(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return '';
        try {
            const url = new URL(raw, window.location.href);
            return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
        } catch (e) {
            return '';
        }
    }

    /* 渲染：每张图就是一个 <a> 包一个 <img>，整张图都是可点击区域 */
    SHOWCASE_ITEMS.forEach(function (item, i) {
        const link = document.createElement('a');
        link.className = 'gh-showcase-slide';
        link.setAttribute('data-fallback', item.alt || '精选内容');
        link.setAttribute('aria-label', item.alt || ('精选内容 ' + (i + 1)));

        const href = safeHref(item.href);
        if (href) {
            link.href = href;
            if (OPEN_IN_NEW_TAB) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
        } else {
            link.href = '#';
            link.addEventListener('click', function (e) { e.preventDefault(); });
        }

        const img = document.createElement('img');
        img.src = item.img;
        img.alt = item.alt || '';
        img.loading = i === 0 ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.draggable = false;
        img.addEventListener('error', function () {
            img.style.display = 'none';
            link.classList.add('gh-fallback');
        });
        link.appendChild(img);

        if (item.title || item.desc) {
            const cap = document.createElement('div');
            cap.className = 'gh-showcase-caption';
            if (item.title) {
                const t = document.createElement('strong');
                t.textContent = item.title;
                cap.appendChild(t);
            }
            if (item.desc) {
                const d = document.createElement('span');
                d.textContent = item.desc;
                cap.appendChild(d);
            }
            link.appendChild(cap);
        }
        track.appendChild(link);

        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'gh-showcase-dot';
        dot.setAttribute('aria-label', '切换到第 ' + (i + 1) + ' 张');
        dot.addEventListener('click', function () { goTo(i); });
        dotsWrap && dotsWrap.appendChild(dot);
        dots.push(dot);
    });

    const slides = Array.prototype.slice.call(track.children);
    if (slides.length <= 1) root.classList.add('gh-single');

    function offsetOf(i) {
        return slides[i].offsetLeft - slides[0].offsetLeft;
    }

    function syncDots() {
        dots.forEach(function (d, i) {
            d.classList.toggle('is-current', i === index);
            d.setAttribute('aria-current', i === index ? 'true' : 'false');
        });
    }

    function goTo(i, smooth) {
        if (!slides.length) return;
        index = (i + slides.length) % slides.length;
        track.scrollTo({ left: offsetOf(index), behavior: smooth === false ? 'auto' : 'smooth' });
        syncDots();
    }

    function nearestIndex() {
        let best = 0;
        let bestDist = Infinity;
        slides.forEach(function (_, i) {
            const dist = Math.abs(offsetOf(i) - track.scrollLeft);
            if (dist < bestDist) { bestDist = dist; best = i; }
        });
        return best;
    }

    /* 手动滑动（触摸 / 触控板 / 滚动条）后同步指示点 */
    let ticking = false;
    track.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
            ticking = false;
            index = nearestIndex();
            syncDots();
        });
    }, { passive: true });

    /* 桌面端鼠标按住左右拖动 */
    let pressed = false;
    let startX = 0;
    let startScroll = 0;
    let moved = false;
    let dragging = false;

    track.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        pressed = true;
        moved = false;
        startX = e.clientX;
        startScroll = track.scrollLeft;
    });

    track.addEventListener('pointermove', function (e) {
        if (!pressed) return;
        const dx = e.clientX - startX;
        if (!moved && Math.abs(dx) > 6) {
            moved = true;
            dragging = true;
            stopAuto();
            track.classList.add('is-dragging');
            try { track.setPointerCapture(e.pointerId); } catch (err) {}
        }
        if (moved) {
            e.preventDefault();
            track.scrollLeft = startScroll - dx;
        }
    });

    function endDrag(e) {
        if (!pressed) return;
        pressed = false;
        if (dragging) {
            dragging = false;
            track.classList.remove('is-dragging');
            try { track.releasePointerCapture(e.pointerId); } catch (err) {}
            goTo(nearestIndex());
            mayStartAuto();
        }
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('dragstart', function (e) { e.preventDefault(); });

    /* 拖动结束后的那一次 click 不应触发跳转 */
    track.addEventListener('click', function (e) {
        if (!moved) return;
        e.preventDefault();
        e.stopPropagation();
        moved = false;
    }, true);

    if (prevBtn) prevBtn.addEventListener('click', function () { goTo(index - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { goTo(index + 1); });

    root.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
    });

    /* 自动切换：鼠标悬停、键盘聚焦、拖拽、页面隐藏时暂停 */
    let timer = null;
    let hovering = false;
    let focused = false;

    function stopAuto() {
        if (timer) { window.clearInterval(timer); timer = null; }
    }
    function mayStartAuto() {
        if (!AUTO_PLAY_INTERVAL || timer || slides.length <= 1) return;
        if (hovering || focused || dragging || document.hidden) return;
        timer = window.setInterval(function () {
            if (document.hidden) return;
            goTo(index + 1);
        }, AUTO_PLAY_INTERVAL);
    }

    root.addEventListener('mouseenter', function () { hovering = true; stopAuto(); });
    root.addEventListener('mouseleave', function () { hovering = false; mayStartAuto(); });
    root.addEventListener('focusin', function () { focused = true; stopAuto(); });
    root.addEventListener('focusout', function (e) {
        if (!root.contains(e.relatedTarget)) { focused = false; mayStartAuto(); }
    });
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopAuto(); else mayStartAuto();
    });
    window.addEventListener('resize', function () { goTo(index, false); });

    goTo(0, false);
    mayStartAuto();
})();
