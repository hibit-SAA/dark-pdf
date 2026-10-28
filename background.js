'use strict';

/**
 * 深色 PDF 阅读器 · 原生工具栏版（v2.3）
 *
 * 原理：
 *  浏览器把 PDF 渲染在一个「插件文档」里（<html><body><embed type="application/pdf">），
 *  这个文档不能用 manifest 声明的内容脚本注入，但可以用 chrome.scripting 程序化注入。
 *
 *  Edge 的 PDF 工具栏和文档画面在同一个 embed 里（同一层），直接给 embed 加 filter
 *  会把工具栏一起反色成浅色。所以改成：在工具栏下方盖一层 pointer-events:none 的
 *  「反色遮罩」，用 backdrop-filter 反色它背后的画面——
 *    · 工具栏在遮罩上方，完全不受影响，保持原生深色与全部功能
 *    · 文档画面被反色：白纸变深底、黑字变亮字
 *
 *  页面外的空白（gutter）和文档同层，会被一起反色成浅灰。处理办法是「量出来再涂灰」：
 *  抓一帧视口 → 扫中间那一行 → 找出页面（与左右空白色差最大的连续段）→
 *  换算成视口百分比 → 在反色遮罩之上再盖一层只在两侧的深灰渐变。
 *
 *  关键优化（v2.3）：缩放/改窗口不再重新抓图，所以完全不闪。
 *  实测 Edge 的 PDF 缩放就是 tab zoom，且页面宽度严格线性：pageW = k × zoom，
 *  其中 k 是该文档在 100% 时的宽度（CSS px），页面水平居中（右侧预留滚动条）。
 *  于是只要在加载时量一次 k 和滚动条宽度，之后所有缩放/改窗口都能直接算出来。
 */

const DEFAULTS = { enabled: true, strength: 0.92, autoEdge: true };
const DARK_BG = '#0d0e11';
const EDGE_BG = '#33373d'; // 页面外空白涂的深灰（明显比纸面 #141414 亮，能看出边界）
const BAR_HEIGHT = 41; // Edge PDF 原生工具栏高度（含 1px 分隔线）
const STYLE_ID = 'darkpdf-style';
const VEIL_ID = 'darkpdf-veil';
const EDGE_ID = 'darkpdf-edge';
const APPLIED_KEY = 'appliedTabs';
const GEOM_KEY = 'gutterGeom';
const SCRIPTABLE = /^(https?|file):/i;

/* captureVisibleTab 有 2 次/秒 的限流，记一下上次调用时间 */
let lastCapture = 0;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return Object.assign({}, DEFAULTS, stored);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

async function getSession(key, fallback) {
  try {
    const stored = await chrome.storage.session.get(key);
    return (stored && stored[key]) || fallback;
  } catch (err) {
    return fallback;
  }
}

async function setSession(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (err) {
    /* ignore */
  }
}

const getApplied = () => getSession(APPLIED_KEY, {});
const setApplied = (map) => setSession(APPLIED_KEY, map);
const getGeoms = () => getSession(GEOM_KEY, {});
const setGeoms = (map) => setSession(GEOM_KEY, map);

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

function filterChain(settings) {
  const strength = clamp(Number(settings.strength) || 0.92, 0, 1);
  return 'invert(' + strength + ') hue-rotate(180deg)';
}

function edgeGradient(settings, geom) {
  if (!settings.autoEdge || !geom) return 'none';
  const l = clamp(geom.l, 0, 100);
  const r = clamp(geom.r, 0, 100);
  if (r - l < 10) return 'none'; // 量得不对，宁可不涂
  if (l <= 0.5 && r >= 99.5) return 'none'; // 页面铺满，没有空白要涂
  const f = 0.5; // 羽化宽度（视口百分比）
  const stop = (v) => v.toFixed(2) + '%';
  return (
    'linear-gradient(to right, ' +
    EDGE_BG + ' 0%, ' +
    EDGE_BG + ' ' + stop(l) + ', ' +
    'rgba(51,55,61,0) ' + stop(l + f) + ', ' +
    'rgba(51,55,61,0) ' + stop(r - f) + ', ' +
    EDGE_BG + ' ' + stop(r) + ', ' +
    EDGE_BG + ' 100%)'
  );
}

function buildCSS(settings, geom) {
  const chain = filterChain(settings);
  const grad = edgeGradient(settings, geom);

  return [
    'html, body { background: ' + DARK_BG + ' !important; }',

    '#' + VEIL_ID + ' {',
    '  position: fixed !important;',
    '  left: 0 !important;',
    '  right: 0 !important;',
    '  bottom: 0 !important;',
    '  top: ' + BAR_HEIGHT + 'px !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '  border: 0 !important;',
    '  background: transparent !important;',
    '  pointer-events: none !important;',
    '  z-index: 2147483646 !important;',
    '  -webkit-backdrop-filter: ' + chain + ' !important;',
    '  backdrop-filter: ' + chain + ' !important;',
    '}',

    '#' + EDGE_ID + ' {',
    '  position: fixed !important;',
    '  left: 0 !important;',
    '  right: 0 !important;',
    '  bottom: 0 !important;',
    '  top: ' + BAR_HEIGHT + 'px !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '  border: 0 !important;',
    '  pointer-events: none !important;',
    '  z-index: 2147483647 !important;',
    '  background: ' + grad + ' !important;',
    '}'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 几何模型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 由「文档在 100% 时的页面宽度 k」+ 当前 zoom + 视口宽度，推算页面左右边界。
 * 实测：pageW 与 zoom 严格线性，页面水平居中，右侧预留滚动条宽度。
 * 这样缩放/改窗口都不需要抓图 —— 也就没有闪烁。
 */
function projectGeom(geom, zoom, w) {
  if (!geom || !geom.k || !w || !zoom) return null;
  const pageW = geom.k * zoom;
  const sbw = typeof geom.sbw === 'number' ? geom.sbw : 0;
  if (pageW >= w - sbw - 1) return { l: 0, r: 100 }; // 铺满整个宽度
  const left = (w - sbw - pageW) / 2;
  if (left <= 0.6) return { l: 0, r: 100 };
  return { l: (left / w) * 100, r: ((left + pageW) / w) * 100 };
}

/* ------------------------------------------------------------------ */
/* 注入 / 移除                                                          */
/* ------------------------------------------------------------------ */

/** 探测这个标签页是不是 PDF 插件文档，顺便带回首屏宽度 */
async function probe(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        return {
          isPdf: document.contentType === 'application/pdf',
          hasEmbed: !!document.querySelector('embed[type="application/pdf"]'),
          w: window.innerWidth || 0
        };
      }
    });
    const first = results && results[0];
    return first ? first.result : null;
  } catch (err) {
    return null; // 页面还没就绪 / 无权访问 / 已关闭
  }
}

async function injectStyle(tabId, css) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (styleId, veilId, edgeId, styleText) {
        var el = document.getElementById(styleId);
        if (!el) {
          el = document.createElement('style');
          el.id = styleId;
          (document.head || document.documentElement).appendChild(el);
        }
        el.textContent = styleText;

        var root = document.body || document.documentElement;
        if (!document.getElementById(veilId)) {
          var veil = document.createElement('div');
          veil.id = veilId;
          root.appendChild(veil);
        }
        if (!document.getElementById(edgeId)) {
          var edge = document.createElement('div');
          edge.id = edgeId;
          root.appendChild(edge);
        }

        // 视口尺寸变了（改窗口 / 浏览器缩放）就让后台重新算一次
        if (!window.__darkpdfResizeBound) {
          window.__darkpdfResizeBound = true;
          var timer = null;
          window.addEventListener('resize', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
              try {
                chrome.runtime.sendMessage({ type: 'viewport-changed' });
              } catch (e) {
                /* 扩展已卸载 */
              }
            }, 220);
          });
        }
      },
      args: [STYLE_ID, VEIL_ID, EDGE_ID, css]
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function removeStyle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (styleId, veilId, edgeId) {
        [styleId, veilId, edgeId].forEach(function (id) {
          var el = document.getElementById(id);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        });
      },
      args: [STYLE_ID, VEIL_ID, EDGE_ID]
    });
    return true;
  } catch (err) {
    return false;
  }
}

/** 暂时摘掉边缘遮罩：量边界前必须先去掉，否则量到的是遮罩自己 */
async function clearEdge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (edgeId) {
        var el = document.getElementById(edgeId);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      },
      args: [EDGE_ID]
    });
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 量页面边界（只在加载时 / 手动刷新时做）                                 */
/* ------------------------------------------------------------------ */

/**
 * 抓一张当前视口，扫中间那一行，返回页面左右边界占视口宽度的百分比。
 * 抓不到 / 判断不了就返回 null（此时维持原样）。
 */
async function measureGutters(tabId, windowId) {
  const now = Date.now();
  if (now - lastCapture < 550) return null; // 避开 captureVisibleTab 限流
  lastCapture = now;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(
      typeof windowId === 'number' ? windowId : null,
      { format: 'png' }
    );
  } catch (err) {
    return null;
  }

  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const W = bmp.width;
    const H = bmp.height;
    if (!W || !H) return null;

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);

    const y = Math.max(1, Math.floor(H * 0.6));
    const row = ctx.getImageData(0, y, W, 1).data;

    const lum = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const i = x * 4;
      lum[x] = 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2];
    }

    // 视口最左边几个像素当作「页面外空白」的基准色
    const gutter = (lum[1] + lum[2] + lum[3]) / 3;
    const minRun = Math.floor(W * 0.06); // 太窄的段（滚动条、水印）不算页面

    const runs = [];
    let cur = -1;
    for (let x = 0; x < W; x++) {
      if (Math.abs(lum[x] - gutter) > 45) {
        if (cur < 0) cur = x;
      } else if (cur >= 0) {
        if (x - cur >= minRun) runs.push([cur, x - 1]);
        cur = -1;
      }
    }
    if (cur >= 0 && W - cur >= minRun) runs.push([cur, W - 1]);
    if (!runs.length) {
      // 连最左边都是深色 → 页面已经铺满整个宽度，压根没有空白要涂
      return gutter < 90 ? { l: 0, r: 100 } : null;
    }

    const left = runs[0][0];
    const right = runs[runs.length - 1][1];

    // 反色之后纸面一定比页面外空白「暗」。这条既是物理事实，
    // 也是一道保险：万一抓到的还是上一帧（遮罩还盖着，最左边是遮罩自己的颜色），
    // 找到的「段」就会比基准色更亮 —— 直接判为无效，保留旧数据。
    let sum = 0;
    let n = 0;
    for (let x = left; x <= right; x++) {
      sum += lum[x];
      n++;
    }
    if (!n || sum / n > gutter - 40) return null;

    const lPct = (left / W) * 100;
    const rPct = ((right + 1) / W) * 100;
    if (lPct < 0.6 && rPct > 99.4) return null;

    return { l: +lPct.toFixed(2), r: +rPct.toFixed(2) };
  } catch (err) {
    return null;
  }
}

async function getGeomFor(tabId, url) {
  const geoms = await getGeoms();
  const hit = geoms[tabId];
  if (hit && hit.url === url) return hit;
  return null;
}

/**
 * 真量一次边界，并顺手标定几何模型（k = 页面在 100% 时的宽度，sbw = 滚动条预留宽度）。
 * 只在「页面加载完」和「用户点重新应用」时调用。
 */
async function refreshGeometry(tabId, url) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.autoEdge) return false;

  // 只处理已经注入过遮罩的 PDF 标签页，别在普通网页上瞎抓图
  const applied0 = await getApplied();
  if (!applied0[tabId]) return false;

  const tab = await chrome.tabs.get(tabId).catch(function () {
    return null;
  });
  if (!tab || !tab.active) return false; // 只有前台标签页才抓得到画面

  const info = await probe(tabId);
  if (!info || (!info.isPdf && !info.hasEmbed)) return false;

  // 只有当前真的画着遮罩时才需要先摘掉；没画遮罩时抓图是「免费」的，不会闪
  const prev = await getGeomFor(tabId, url);
  const hasScrim = prev && !(prev.l <= 0.5 && prev.r >= 99.5);
  if (hasScrim) {
    await clearEdge(tabId);
    await sleep(110); // 让摘掉遮罩的那一帧真正上屏
  }

  let geom = null;
  for (let i = 0; i < 2; i++) {
    geom = await measureGutters(tabId, tab.windowId);
    if (geom) break;
    if (i === 0) await sleep(650);
  }

  if (geom) {
    const zoom = await chrome.tabs.getZoom(tabId).catch(function () {
      return 0;
    });
    const w = info.w;
    let k = null;
    let sbw = 0;
    if (zoom > 0 && w > 0 && geom.l > 0.5 && geom.r < 99.5) {
      const pageW = ((geom.r - geom.l) / 100) * w;
      const left = (geom.l / 100) * w;
      if (pageW > 40) {
        k = pageW / zoom;
        sbw = Math.max(0, w - 2 * left - pageW);
      }
    }
    const geoms = await getGeoms();
    geoms[tabId] = { l: geom.l, r: geom.r, zoom: zoom, k: k, sbw: sbw, w: w, url: url };
    await setGeoms(geoms);
  }

  // 量到了用新数据，没量到就按旧数据还原（不会把遮罩弄丢）
  const applied = await getApplied();
  delete applied[tabId];
  await setApplied(applied);
  await applyToTab(tabId, url);
  return !!geom;
}

/* ------------------------------------------------------------------ */
/* 应用                                                                */
/* ------------------------------------------------------------------ */

async function applyToTab(tabId, url) {
  const settings = await getSettings();
  const applied = await getApplied();

  if (!settings.enabled) {
    await removeStyle(tabId);
    if (applied[tabId]) {
      delete applied[tabId];
      await setApplied(applied);
    }
    return;
  }

  const info = await probe(tabId);
  if (!info || (!info.isPdf && !info.hasEmbed)) return;

  let geom = null;
  if (settings.autoEdge) {
    const stored = await getGeomFor(tabId, url);
    if (stored) {
      if (stored.w !== info.w && info.w > 0) {
        // 窗口宽度变了，把新宽度记下来，缩放快路径要用
        const geoms = await getGeoms();
        geoms[tabId] = Object.assign({}, stored, { w: info.w });
        await setGeoms(geoms);
        stored.w = info.w;
      }
      if (stored.k) {
        const zoom = await chrome.tabs.getZoom(tabId).catch(function () {
          return 0;
        });
        geom = projectGeom(stored, zoom, info.w);
      }
      if (!geom) geom = { l: stored.l, r: stored.r };
    }
  }

  const css = buildCSS(settings, geom);
  const prev = applied[tabId];
  if (prev && prev.url === url && prev.css === css) return;

  const ok = await injectStyle(tabId, css);
  if (ok) {
    applied[tabId] = { url: url, css: css };
    await setApplied(applied);
  }
}

/**
 * 缩放 / 改窗口后的重算入口：只重新投影，不抓图，所以完全不闪。
 * 若这个文档还没有标定过 k（比如加载时页面就铺满了宽度），才退回真量一次。
 */
const applyTimers = new Map();

function scheduleApply(tabId, delay) {
  if (typeof tabId !== 'number') return;
  const old = applyTimers.get(tabId);
  if (old) clearTimeout(old);
  const timer = setTimeout(function () {
    applyTimers.delete(tabId);
    chrome.tabs
      .get(tabId)
      .then(function (tab) {
        if (!tab || !tab.url || !SCRIPTABLE.test(tab.url)) return;
        const url = tab.url;
        getGeomFor(tabId, url).then(function (geom) {
          if (geom && geom.k) applyToTab(tabId, url);
          else refreshGeometry(tabId, url);
        });
      })
      .catch(function () {
        /* 标签页已关闭 */
      });
  }, delay);
  applyTimers.set(tabId, timer);
}

/** 关闭开关时把所有标签页上的样式清干净 */
async function removeEverywhere() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(function (tab) {
      return tab.id ? removeStyle(tab.id) : Promise.resolve(false);
    })
  );
  await setApplied({});
  await setGeoms({});
}

/** 设置变更后重新应用到所有标签页 */
async function applyEverywhere() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && SCRIPTABLE.test(tab.url || '')) {
      await applyToTab(tab.id, tab.url);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!changeInfo.status) return; // 只在 loading / complete 时处理
  const url = tab && tab.url ? tab.url : '';
  if (!SCRIPTABLE.test(url)) return;

  if (changeInfo.status === 'loading') {
    // 换了文档，旧的标定数据作废
    getGeoms().then(function (geoms) {
      if (geoms[tabId]) {
        delete geoms[tabId];
        setGeoms(geoms);
      }
    });
    applyToTab(tabId, url);
    return;
  }

  applyToTab(tabId, url).then(function () {
    // 文档画完了再量一次并标定模型（此刻还没画遮罩，抓图不会闪）
    setTimeout(function () {
      refreshGeometry(tabId, url);
    }, 700);
  });
});

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId).then(function (tab) {
    const url = tab && tab.url ? tab.url : '';
    if (!SCRIPTABLE.test(url)) return;
    getApplied().then(function (applied) {
      if (!applied[info.tabId]) return;
      getGeomFor(info.tabId, url).then(function (geom) {
        if (geom && geom.k) applyToTab(info.tabId, url);
        else refreshGeometry(info.tabId, url); // 后台标签页抓不到画面，切过来补量
      });
    });
  });
});

/**
 * 缩放快路径：直接用 onZoomChange 带过来的 newZoomFactor 算新边界，
 * 只做一次注入、不去读视口、不抓图、不去抖 —— 尽量压到 1 帧内完成。
 */
const zoomSeq = new Map();

async function zoomApply(tabId, zoom) {
  if (typeof tabId !== 'number' || !zoom) return false;
  zoomSeq.set(tabId, zoom);

  const settings = await getSettings();
  if (!settings.enabled || !settings.autoEdge) return false;

  const applied = await getApplied();
  const rec = applied[tabId];
  if (!rec) return false;

  const geoms = await getGeoms();
  const g = geoms[tabId];
  if (!g || !g.k || !g.w) return false; // 还没标定过模型，交给慢路径

  const geom = projectGeom(g, zoom, g.w);
  const css = buildCSS(settings, geom);
  if (rec.css === css) return true;

  const ok = await injectStyle(tabId, css);
  // 期间又缩放了就交给最新那次，别把旧的写回去
  if (ok && zoomSeq.get(tabId) === zoom) {
    const cur = await getApplied();
    if (cur[tabId]) {
      cur[tabId] = { url: cur[tabId].url, css: css };
      await setApplied(cur);
    }
  }
  return ok;
}

/** 缩放：Edge 的 PDF 缩放会同步到 tabs.getZoom（实测 ctrl+滚轮 1 → 0.316） */
chrome.tabs.onZoomChange.addListener(function (info) {
  zoomApply(info.tabId, info.newZoomFactor)
    .then(function (handled) {
      if (!handled) scheduleApply(info.tabId, 60);
    })
    .catch(function () {
      scheduleApply(info.tabId, 60);
    });
});

/** 改窗口大小：页面宽度不变，但两侧空白比例会变 */
const windowSizes = new Map();

chrome.windows.onBoundsChanged.addListener(function (win) {
  if (!win || typeof win.id !== 'number') return;
  const prev = windowSizes.get(win.id);
  windowSizes.set(win.id, { w: win.width, h: win.height });
  if (!prev || (prev.w === win.width && prev.h === win.height)) return; // 只是移动窗口

  chrome.tabs.query({ windowId: win.id }).then(function (tabs) {
    tabs.forEach(function (tab) {
      if (tab.id && tab.active) scheduleApply(tab.id, 220);
    });
  });
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
  const applied = await getApplied();
  if (applied[tabId]) {
    delete applied[tabId];
    await setApplied(applied);
  }
  const geoms = await getGeoms();
  if (geoms[tabId]) {
    delete geoms[tabId];
    await setGeoms(geoms);
  }
});

chrome.storage.onChanged.addListener(async function (changes, area) {
  if (area !== 'sync') return;
  if (!changes.enabled && !changes.strength && !changes.autoEdge) return;

  const settings = await getSettings();
  if (!settings.enabled) {
    await removeEverywhere();
    return;
  }
  await applyEverywhere();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return undefined;

  // 页面里挂的 resize 监听（窗口大小 / 浏览器缩放）通知过来
  if (msg.type === 'viewport-changed') {
    if (sender && sender.tab && typeof sender.tab.id === 'number') {
      scheduleApply(sender.tab.id, 200);
    }
    return undefined;
  }

  if (msg.type !== 'reapply') return undefined;

  (async function () {
    try {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: '没有可刷新的标签页' });
        return;
      }
      const tab = await chrome.tabs.get(tabId).catch(function () {
        return null;
      });
      if (!tab) {
        sendResponse({ ok: false, error: '标签页已关闭' });
        return;
      }

      await removeStyle(tabId);
      const applied = await getApplied();
      delete applied[tabId];
      await setApplied(applied);

      const geoms = await getGeoms();
      delete geoms[tabId];
      await setGeoms(geoms);

      const url = tab.url || '';
      await applyToTab(tabId, url);

      const info = await probe(tabId);
      const isPdf = !!(info && (info.isPdf || info.hasEmbed));
      if (isPdf) {
        setTimeout(function () {
          refreshGeometry(tabId, url);
        }, 250);
      }
      sendResponse({ ok: isPdf, isPdf: isPdf });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});
