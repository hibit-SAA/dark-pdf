'use strict';

/**
 * 深色 PDF 阅读器 · 原生工具栏版（v2）
 *
 * 原理：
 *  浏览器把 PDF 渲染在一个「插件文档」里（<html><body><embed type="application/pdf">），
 *  这个文档不能用 manifest 声明的内容脚本注入，但可以用 chrome.scripting 程序化注入。
 *
 *  注意：Edge 的 PDF 工具栏和文档画面在同一个 embed 里（同一层），
 *  直接给 embed 加 filter 会把工具栏一起反色成浅色。
 *  所以这里改成：在工具栏下方盖一层 pointer-events:none 的「反色遮罩」，
 *  用 backdrop-filter 反色它背后的画面——
 *    · 工具栏在遮罩上方，完全不受影响，保持原生深色与全部功能
 *    · 文档画面被反色：白纸变深底、黑字变亮字
 *
 *  「页面外空白也压深」：页面外的空白和文档在同一层，反色后会变浅灰。
 *  打开该选项后用 brightness+contrast 组合出一条陡峭曲线把它压回深色
 *  （代价是图片、色块会变暗）。
 */

const DEFAULTS = { enabled: true, strength: 0.92, deep: false };
const DARK_BG = '#0d0e11';
const BAR_HEIGHT = 41; // Edge PDF 原生工具栏高度（含 1px 分隔线）
const STYLE_ID = 'darkpdf-style';
const VEIL_ID = 'darkpdf-veil';
const APPLIED_KEY = 'appliedTabs';
const SCRIPTABLE = /^(https?|file):/i;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return Object.assign({}, DEFAULTS, stored);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

async function getApplied() {
  try {
    const stored = await chrome.storage.session.get(APPLIED_KEY);
    return (stored && stored[APPLIED_KEY]) || {};
  } catch (err) {
    return {};
  }
}

async function setApplied(map) {
  try {
    await chrome.storage.session.set({ [APPLIED_KEY]: map });
  } catch (err) {
    /* ignore */
  }
}

function filterParams(settings) {
  const strength = clamp(Number(settings.strength) || 0.92, 0, 1);
  // 深色主题下阅读器页面外空白是 #333（0.2），反色后落在 0.2+0.6*strength 附近。
  // 用 brightness(k) 缩放 + contrast(c) 绕 0.5 拉陡，等价于一条陡峭的线性曲线。
  const knee = 0.2 + 0.6 * strength + 0.005;
  const slope = 0.95 / Math.max(0.05, strength - knee);
  const contrast = 1 + 2 * knee * slope;
  const brightness = slope / contrast;
  return {
    strength: strength,
    knock: settings.deep
      ? ' brightness(' + brightness.toFixed(3) + ') contrast(' + contrast.toFixed(3) + ')'
      : ''
  };
}

function buildCSS(settings) {
  const p = filterParams(settings);
  const chain = 'invert(' + p.strength + ') hue-rotate(180deg)' + p.knock;
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
    '  z-index: 2147483647 !important;',
    '  -webkit-backdrop-filter: ' + chain + ' !important;',
    '  backdrop-filter: ' + chain + ' !important;',
    '}'
  ].join('\n');
}

/** 探测这个标签页是不是 PDF 插件文档 */
async function probe(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () {
        return {
          isPdf: document.contentType === 'application/pdf',
          hasEmbed: !!document.querySelector('embed[type="application/pdf"]')
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
      func: function (styleId, veilId, styleText) {
        var el = document.getElementById(styleId);
        if (!el) {
          el = document.createElement('style');
          el.id = styleId;
          (document.head || document.documentElement).appendChild(el);
        }
        el.textContent = styleText;

        if (!document.getElementById(veilId)) {
          var veil = document.createElement('div');
          veil.id = veilId;
          (document.body || document.documentElement).appendChild(veil);
        }
      },
      args: [STYLE_ID, VEIL_ID, css]
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
      func: function (styleId, veilId) {
        [styleId, veilId].forEach(function (id) {
          var el = document.getElementById(id);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        });
      },
      args: [STYLE_ID, VEIL_ID]
    });
    return true;
  } catch (err) {
    return false;
  }
}

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

  const css = buildCSS(settings);
  const prev = applied[tabId];
  if (prev && prev.url === url && prev.css === css) return;

  const ok = await injectStyle(tabId, css);
  if (ok) {
    applied[tabId] = { url: url, css: css };
    await setApplied(applied);
  }
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
  applyToTab(tabId, url);
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
  const applied = await getApplied();
  if (applied[tabId]) {
    delete applied[tabId];
    await setApplied(applied);
  }
});

chrome.storage.onChanged.addListener(async function (changes, area) {
  if (area !== 'sync') return;
  if (!changes.enabled && !changes.strength && !changes.deep) return;

  const settings = await getSettings();
  if (!settings.enabled) {
    await removeEverywhere();
    return;
  }
  await applyEverywhere();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'reapply') return undefined;

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

      await applyToTab(tabId, tab.url || '');

      const info = await probe(tabId);
      const isPdf = !!(info && (info.isPdf || info.hasEmbed));
      sendResponse({ ok: isPdf, isPdf: isPdf });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});
