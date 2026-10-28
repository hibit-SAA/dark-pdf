'use strict';

/**
 * 深色 PDF 阅读器 —— 后台服务
 *
 * 工作方式：
 *  1. 用 declarativeNetRequest 动态规则，在 PDF 请求真正发出前把主框架导航
 *     重定向到扩展自带的阅读器页面（viewer.html?file=<原始地址>）。
 *     这样不会出现"先闪一下白色原生阅读器"的观感。
 *  2. 对于地址里没有 .pdf 的链接（服务端返回 application/pdf），
 *     再用 webRequest 观察响应头做一次兜底重定向。
 *  3. 阅读器里的"用原生阅读器打开"会临时关闭规则 20 秒，避免死循环。
 */

const VIEWER_PAGE = 'viewer.html';
const RULE_ID = 1001;
const BYPASS_KEY = 'bypassUntil';
const BYPASS_ALARM = 'dark-pdf-restore-capture';
const BYPASS_MS = 20000;

const DEFAULTS = { autoCapture: true, invert: true, strength: 0.92 };
const PDF_PATH_RE = /\.pdf([?#].*)?$/i;
const HTTP_RE = /^https?:\/\//i;

const viewerUrl = (url) => chrome.runtime.getURL(VIEWER_PAGE) + '?file=' + url;
const isExtensionUrl = (url) => (url || '').startsWith(chrome.runtime.getURL(''));

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return Object.assign({}, DEFAULTS, stored);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

async function isBypassed() {
  try {
    const res = await chrome.storage.session.get(BYPASS_KEY);
    const until = res && res[BYPASS_KEY];
    return typeof until === 'number' && Date.now() < until;
  } catch (err) {
    return false;
  }
}

/** 根据当前设置同步动态重定向规则 */
async function syncRules() {
  const settings = await getSettings();
  const enabled = settings.autoCapture && !(await isBypassed());

  let removeRuleIds = [];
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    removeRuleIds = old.map((rule) => rule.id);
  } catch (err) {
    console.warn('[dark-pdf] 读取动态规则失败', err);
  }

  const addRules = [];
  if (enabled) {
    addRules.push({
      id: RULE_ID,
      priority: 1,
      action: {
        type: 'redirect',
        // \0 = 整个匹配到的原始 URL，原样塞进 file 参数
        redirect: { regexSubstitution: chrome.runtime.getURL(VIEWER_PAGE) + '?file=\\0' }
      },
      condition: {
        regexFilter: '^(https?|file)://.*\\.pdf([?#].*)?$',
        resourceTypes: ['main_frame']
      }
    });
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    console.error('[dark-pdf] 更新动态规则失败', err);
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncRules();
});

// Service Worker 每次被唤醒都对齐一次规则（浏览器重启、空闲回收后都能恢复）
syncRules();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && Object.prototype.hasOwnProperty.call(changes, 'autoCapture')) {
    syncRules();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BYPASS_ALARM) return;
  try {
    await chrome.storage.session.remove(BYPASS_KEY);
  } catch (err) {
    /* ignore */
  }
  await syncRules();
});

/* ------------------------------------------------------------------ */
/* 兜底：地址里没有 .pdf，但响应是 application/pdf                        */
/* ------------------------------------------------------------------ */

const pendingRedirects = new Set();

function scheduleRedirect(tabId, url) {
  if (pendingRedirects.has(url)) return;
  pendingRedirects.add(url);
  // 等浏览器把这一帧提交完再跳，否则会被原导航覆盖掉
  setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || isExtensionUrl(tab.url)) return;
      const settings = await getSettings();
      if (!settings.autoCapture || (await isBypassed())) return;
      await chrome.tabs.update(tabId, { url: viewerUrl(url) });
    } catch (err) {
      console.warn('[dark-pdf] 兜底跳转失败', err);
    } finally {
      pendingRedirects.delete(url);
    }
  }, 320);
}

if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        if (details.tabId < 0) return;
        if (details.type !== 'main_frame') return;
        if (!HTTP_RE.test(details.url)) return;
        if (isExtensionUrl(details.url)) return;
        if (PDF_PATH_RE.test(details.url)) return; // 已由 DNR 规则接管

        const headers = details.responseHeaders || [];
        const header = (name) => {
          const hit = headers.find((h) => h.name.toLowerCase() === name);
          return hit ? String(hit.value || '') : '';
        };

        if (!/application\/pdf/i.test(header('content-type'))) return;
        if (/^\s*attachment/i.test(header('content-disposition'))) return; // 本来就是下载，别拦

        scheduleRedirect(details.tabId, details.url);
      } catch (err) {
        console.warn('[dark-pdf] 响应头兜底失败', err);
      }
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['responseHeaders']
  );
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  const senderTabId = sender && sender.tab ? sender.tab.id : null;

  if (msg.type === 'open-in-viewer') {
    const target = msg.url;
    if (!target) {
      sendResponse({ ok: false, error: '没有可打开的地址' });
      return undefined;
    }
    if (isExtensionUrl(target)) {
      sendResponse({ ok: false, error: '该页面已经在深色阅读器中' });
      return undefined;
    }
    const tabId = msg.tabId || senderTabId;
    const done = tabId
      ? chrome.tabs.update(tabId, { url: viewerUrl(target) })
      : chrome.tabs.create({ url: viewerUrl(target) });
    done
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'open-native') {
    (async () => {
      try {
        await chrome.storage.session.set({ [BYPASS_KEY]: Date.now() + BYPASS_MS });
        await syncRules();
        chrome.alarms.create(BYPASS_ALARM, { when: Date.now() + BYPASS_MS + 800 });
        const tabId = msg.tabId || senderTabId;
        if (tabId) {
          await chrome.tabs.update(tabId, { url: msg.url });
        } else {
          await chrome.tabs.create({ url: msg.url });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
