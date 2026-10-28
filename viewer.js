'use strict';

/**
 * 深色 PDF 阅读器 —— 阅读器页面逻辑
 *
 * 设计要点：
 *  - 只对页面画布做反色（filter: invert + hue-rotate 回正色相），
 *    顶部控制栏、背景、滚动条始终是深色，不会被反色影响。
 *  - 页面按需渲染（IntersectionObserver），大文件也不会卡。
 */

(function () {
  const pdfjsLib = window.pdfjsLib;
  const $ = (id) => document.getElementById(id);
  const hasExt = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const extUrl = (p) => (hasExt ? chrome.runtime.getURL(p) : p);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const els = {
    viewer: $('viewer'),
    pages: $('pages'),
    filename: $('filename'),
    pageInput: $('pageInput'),
    pageCount: $('pageCount'),
    prev: $('prev'),
    next: $('next'),
    zoomIn: $('zoomIn'),
    zoomOut: $('zoomOut'),
    zoomLabel: $('zoomLabel'),
    fitBtn: $('fitBtn'),
    invertBtn: $('invertBtn'),
    downloadBtn: $('downloadBtn'),
    nativeBtn: $('nativeBtn'),
    overlay: $('overlay'),
    overlayTitle: $('overlayTitle'),
    overlayText: $('overlayText'),
    overlayBar: $('overlayBar'),
    overlayActions: $('overlayActions'),
    spinner: $('spinner'),
    toast: $('toast')
  };

  const state = {
    doc: null,
    pages: [],
    scaleMode: 'fit-width', // 'fit-width' | 'fit-page' | 'custom'
    zoom: 1,
    dpr: 1,
    current: 1,
    invert: true,
    strength: 0.92,
    fileUrl: '',
    name: 'PDF 文档'
  };

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function readFileUrl() {
    const href = location.href;
    const marker = '?file=';
    const at = href.indexOf(marker);
    if (at < 0) return '';
    let raw = href.slice(at + marker.length);
    // 兼容被整体编码过的情况
    if (/%3a%2f%2f/i.test(raw)) {
      try { raw = decodeURIComponent(raw); } catch (err) { /* keep raw */ }
    }
    return raw;
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      const name = decodeURIComponent(seg);
      return name || u.hostname || 'PDF 文档';
    } catch (err) {
      return 'PDF 文档';
    }
  }

  let toastTimer = 0;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
  }

  function setProgress(ratio) {
    if (!els.overlayBar) return;
    els.overlayBar.style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
  }

  function showOverlay(title, text, opts) {
    const o = opts || {};
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text || '';
    els.overlay.classList.remove('hidden');
    els.spinner.classList.toggle('hidden', o.spinner === false);
    els.overlayBar.parentElement.classList.toggle('hidden', !o.progress);
    setProgress(o.progress ? 0.04 : 0);
    els.overlayActions.textContent = '';
  }

  function hideOverlay() {
    els.overlay.classList.add('hidden');
  }

  function addAction(label, onClick, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (primary) btn.className = 'primary';
    btn.addEventListener('click', onClick);
    els.overlayActions.appendChild(btn);
    return btn;
  }

  function describeError(err) {
    const name = err && err.name ? err.name : '';
    const msg = err && err.message ? String(err.message) : String(err || '');
    if (name === 'PasswordException') return '这个 PDF 有密码保护，无法直接打开。';
    if (name === 'InvalidPDFException') return '文件不是有效的 PDF，或者内容已经损坏。';
    if (name === 'MissingPDFException') return '文件不存在或已被删除。';
    if (/Failed to fetch|NetworkError|HTTP \d+/i.test(msg)) {
      return '读取文件失败，可能是网站禁止了跨站访问，或需要登录状态。';
    }
    return msg || '未知错误';
  }

  function showError(err) {
    showOverlay('打不开这个 PDF', describeError(err), { spinner: false });
    addAction('重试', () => { hideOverlay(); load(); }, true);
    addAction('用原生阅读器打开', openNative);
    addAction('下载原文件', download);
  }

  /* ------------------------------------------------------------------ */
  /* 反色设置                                                            */
  /* ------------------------------------------------------------------ */

  function applyInvert() {
    document.body.classList.toggle('invert', state.invert);
    document.documentElement.style.setProperty('--inv', String(state.strength));
    els.invertBtn.classList.toggle('active', state.invert);
    els.invertBtn.title = state.invert
      ? '反色已开启，点击关闭 (I)'
      : '反色已关闭，点击开启 (I)';
  }

  function toggleInvert() {
    state.invert = !state.invert;
    applyInvert();
    toast(state.invert ? '已开启反色深色显示' : '已关闭反色（原始配色）');
    if (hasExt && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ invert: state.invert }).catch(() => {});
    }
  }

  async function loadSettings() {
    if (!hasExt || !chrome.storage || !chrome.storage.sync) {
      applyInvert();
      return;
    }
    try {
      const s = await chrome.storage.sync.get({ invert: true, strength: 0.92 });
      state.invert = s.invert !== false;
      const strength = Number(s.strength);
      state.strength = isNaN(strength) ? 0.92 : clamp(strength, 0, 1);
    } catch (err) {
      /* 用默认值 */
    }
    applyInvert();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.invert) state.invert = changes.invert.newValue !== false;
      if (changes.strength) {
        const v = Number(changes.strength.newValue);
        if (!isNaN(v)) state.strength = clamp(v, 0, 1);
      }
      applyInvert();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 载入文档                                                            */
  /* ------------------------------------------------------------------ */

  async function load() {
    showOverlay('正在载入 PDF…', '首次打开较大的文件需要几秒', { progress: true });

    const options = {
      cMapUrl: extUrl('vendor/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: extUrl('vendor/standard_fonts/'),
      withCredentials: true
    };

    let doc = null;
    let firstError = null;

    try {
      const task = pdfjsLib.getDocument(Object.assign({ url: state.fileUrl }, options));
      task.onProgress = (p) => setProgress(p && p.total ? p.loaded / p.total : 0.3);
      doc = await task.promise;
    } catch (err) {
      firstError = err;
      if (err && err.name === 'PasswordException') {
        showError(err);
        return;
      }
      // 有些站点不允许 pdf.js 的分段请求，退回到整包下载
      try {
        setProgress(0.1);
        const resp = await fetch(state.fileUrl, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        setProgress(0.6);
        doc = await pdfjsLib.getDocument(Object.assign({ data: buf }, options)).promise;
      } catch (err2) {
        showError(err2 || firstError);
        return;
      }
    }

    state.doc = doc;
    try {
      await buildPages();
    } catch (err) {
      showError(err);
      return;
    }
    hideOverlay();
    setProgress(1);
    updateCurrent(true);
  }

  async function buildPages() {
    els.pages.textContent = '';
    state.pages = [];
    const total = state.doc.numPages;
    els.pageCount.textContent = String(total);
    els.pageInput.value = '1';

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= total; i++) {
      const page = await state.doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.page = String(i);
      const canvas = document.createElement('canvas');
      div.appendChild(canvas);
      frag.appendChild(div);
      state.pages.push({
        num: i,
        page: page,
        base: base,
        div: div,
        canvas: canvas,
        scale: 1,
        rendered: false,
        rendering: false,
        task: null
      });
    }
    els.pages.appendChild(frag);

    layout(false);
    observePages();
  }

  /* ------------------------------------------------------------------ */
  /* 排版 / 渲染                                                         */
  /* ------------------------------------------------------------------ */

  function targetScale(base) {
    if (state.scaleMode === 'custom') return clamp(state.zoom, 0.1, 8);
    const availW = Math.max(140, els.viewer.clientWidth - 56);
    const availH = Math.max(140, els.viewer.clientHeight - 40);
    const byWidth = availW / base.width;
    if (state.scaleMode === 'fit-page') {
      return clamp(Math.min(byWidth, availH / base.height), 0.1, 8);
    }
    return clamp(byWidth, 0.1, 8);
  }

  function paintWhite(item) {
    const canvas = item.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function layout(preserveScroll) {
    const anchor = preserveScroll ? captureAnchor() : null;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (const item of state.pages) {
      const scale = targetScale(item.base);
      item.scale = scale;
      const w = Math.max(1, Math.floor(item.base.width * scale));
      const h = Math.max(1, Math.floor(item.base.height * scale));
      item.div.style.width = w + 'px';
      item.div.style.height = h + 'px';

      const canvas = item.canvas;
      const pw = Math.max(1, Math.floor(w * state.dpr));
      const ph = Math.max(1, Math.floor(h * state.dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';

      if (item.task) {
        try { item.task.cancel(); } catch (err) { /* ignore */ }
        item.task = null;
      }
      item.rendered = false;
      item.rendering = false;
      paintWhite(item);
    }

    updateZoomLabel();
    if (anchor) restoreAnchor(anchor);
    renderVisible();
  }

  function render(item) {
    if (!item || item.rendered || item.rendering) return;
    item.rendering = true;

    const viewport = item.page.getViewport({ scale: item.scale });
    const dpr = state.dpr;
    const canvas = item.canvas;
    const pw = Math.max(1, Math.floor(viewport.width * dpr));
    const ph = Math.max(1, Math.floor(viewport.height * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let task = null;
    try {
      task = item.page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      });
    } catch (err) {
      item.rendering = false;
      return;
    }

    item.task = task;
    task.promise
      .then(() => {
        item.rendered = true;
        item.rendering = false;
        item.div.classList.add('ready');
      })
      .catch((err) => {
        item.rendering = false;
        if (!err || err.name !== 'RenderingCancelledException') {
          console.warn('[dark-pdf] 第 ' + item.num + ' 页渲染失败', err);
        }
      });
  }

  function renderVisible() {
    const vr = els.viewer.getBoundingClientRect();
    const margin = Math.max(600, vr.height * 1.2);
    for (const item of state.pages) {
      const r = item.div.getBoundingClientRect();
      if (r.bottom > vr.top - margin && r.top < vr.bottom + margin) render(item);
    }
  }

  let observer = null;
  function observePages() {
    if (observer) observer.disconnect();
    if (typeof IntersectionObserver !== 'function') {
      renderVisible();
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = state.pages[Number(entry.target.dataset.page) - 1];
          render(item);
        }
      },
      { root: els.viewer, rootMargin: '120% 0px' }
    );
    for (const item of state.pages) observer.observe(item.div);
  }

  function captureAnchor() {
    const vr = els.viewer.getBoundingClientRect();
    const probe = vr.top + 80;
    let best = null;
    for (const item of state.pages) {
      const r = item.div.getBoundingClientRect();
      if (r.bottom <= vr.top || r.top >= vr.bottom) continue;
      const d = Math.abs(r.top - probe);
      if (!best || d < best.d) {
        best = { d: d, num: item.num, ratio: clamp((probe - r.top) / (r.height || 1), 0, 1) };
      }
    }
    return best;
  }

  function restoreAnchor(anchor) {
    const item = state.pages[anchor.num - 1];
    if (!item) return;
    const vr = els.viewer.getBoundingClientRect();
    const top = item.div.getBoundingClientRect().top - vr.top + els.viewer.scrollTop;
    els.viewer.scrollTop = top + anchor.ratio * item.div.offsetHeight - 80;
  }

  /* ------------------------------------------------------------------ */
  /* 缩放 / 翻页                                                         */
  /* ------------------------------------------------------------------ */

  function currentScale() {
    if (state.pages.length) return state.pages[0].scale;
    return state.scaleMode === 'custom' ? state.zoom : 1;
  }

  function updateZoomLabel() {
    els.zoomLabel.textContent = Math.round(currentScale() * 100) + '%';
  }

  function zoomTo(scale) {
    state.scaleMode = 'custom';
    state.zoom = clamp(scale, 0.15, 8);
    layout(true);
  }

  function zoomStep(factor) {
    zoomTo(currentScale() * factor);
  }

  function fitWidth() {
    state.scaleMode = 'fit-width';
    layout(true);
    toast('已适合宽度');
  }

  function scrollToPage(num, smooth) {
    const item = state.pages[num - 1];
    if (!item) return;
    const vr = els.viewer.getBoundingClientRect();
    const top = item.div.getBoundingClientRect().top - vr.top + els.viewer.scrollTop - 18;
    els.viewer.scrollTo({ top: top, behavior: smooth === false ? 'auto' : 'smooth' });
  }

  function stepPage(delta) {
    const total = state.pages.length || 1;
    scrollToPage(clamp(state.current + delta, 1, total));
  }

  function updateCurrent(force) {
    if (!state.pages.length) return;
    const vr = els.viewer.getBoundingClientRect();
    const probe = vr.top + Math.min(140, vr.height * 0.28);
    let best = null;
    for (const item of state.pages) {
      const r = item.div.getBoundingClientRect();
      if (r.bottom <= vr.top || r.top >= vr.bottom) continue;
      const d = Math.abs(r.top - probe);
      if (!best || d < best.d) best = { d: d, num: item.num };
    }
    if (best && (best.num !== state.current || force)) {
      state.current = best.num;
      if (document.activeElement !== els.pageInput) {
        els.pageInput.value = String(best.num);
      }
    }
  }

  function commitPageInput() {
    const n = parseInt(els.pageInput.value, 10);
    if (!isNaN(n)) scrollToPage(clamp(n, 1, state.pages.length || 1));
    updateCurrent(true);
  }

  /* ------------------------------------------------------------------ */
  /* 下载 / 原生打开                                                      */
  /* ------------------------------------------------------------------ */

  async function download() {
    if (!state.fileUrl) return;
    if (hasExt && chrome.downloads) {
      try {
        const opts = { url: state.fileUrl, saveAs: false };
        if (/\.pdf$/i.test(state.name)) opts.filename = state.name;
        await chrome.downloads.download(opts);
        toast('已开始下载原文件');
        return;
      } catch (err) {
        /* 退回新标签页打开 */
      }
    }
    window.open(state.fileUrl, '_blank', 'noopener');
  }

  function openNative() {
    if (!state.fileUrl) return;
    if (hasExt && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'open-native', url: state.fileUrl }, () => {
        if (chrome.runtime.lastError) location.href = state.fileUrl;
      });
    } else {
      location.href = state.fileUrl;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    els.prev.addEventListener('click', () => stepPage(-1));
    els.next.addEventListener('click', () => stepPage(1));
    els.zoomIn.addEventListener('click', () => zoomStep(1.15));
    els.zoomOut.addEventListener('click', () => zoomStep(1 / 1.15));
    els.zoomLabel.addEventListener('click', fitWidth);
    els.fitBtn.addEventListener('click', fitWidth);
    els.invertBtn.addEventListener('click', toggleInvert);
    els.downloadBtn.addEventListener('click', download);
    els.nativeBtn.addEventListener('click', openNative);

    els.pageInput.addEventListener('change', commitPageInput);
    els.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitPageInput();
        els.pageInput.blur();
      }
    });

    let ticking = false;
    els.viewer.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          updateCurrent(false);
        });
      },
      { passive: true }
    );

    els.viewer.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        zoomStep(e.deltaY < 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false }
    );

    document.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          stepPage(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          stepPage(-1);
          break;
        case 'Home':
          e.preventDefault();
          scrollToPage(1);
          break;
        case 'End':
          e.preventDefault();
          scrollToPage(state.pages.length || 1);
          break;
        case '+':
        case '=':
          e.preventDefault();
          zoomStep(1.15);
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomStep(1 / 1.15);
          break;
        case '0':
          e.preventDefault();
          fitWidth();
          break;
        case 'i':
        case 'I':
          toggleInvert();
          break;
        default:
          break;
      }
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.pages.length) layout(true);
      }, 160);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    if (!pdfjsLib) {
      showOverlay('渲染引擎加载失败', '请重新加载扩展后再试', { spinner: false });
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = extUrl('vendor/pdf.worker.min.js');

    await loadSettings();

    state.fileUrl = readFileUrl();
    if (!state.fileUrl) {
      showOverlay('缺少文件地址', '请从 PDF 链接打开，或点击扩展图标选择"用深色打开当前页"', {
        spinner: false
      });
      return;
    }

    state.name = nameFromUrl(state.fileUrl);
    els.filename.textContent = state.name;
    els.filename.title = state.fileUrl;
    document.title = state.name + ' · 深色 PDF';

    bindEvents();
    await load();
  }

  init();
})();
