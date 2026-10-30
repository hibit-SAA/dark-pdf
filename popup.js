'use strict';

const DEFAULTS = { enabled: true, strength: 0.92, autoEdge: true };
const $ = (id) => document.getElementById(id);

const enabledEl = $('enabled');
const strengthEl = $('strength');
const strengthVal = $('strengthVal');
const edgeEl = $('autoEdge');
const reapplyBtn = $('reapply');
const peekBtn = $('peek');
const statusEl = $('status');

let currentTab = null;

function setStatus(text) {
  statusEl.textContent = text || '';
}

function paintPeek(on) {
  peekBtn.dataset.on = on ? '1' : '0';
  peekBtn.textContent = on ? '恢复深色反色（Alt+Shift+D）' : '临时显示原始页面（Alt+Shift+D）';
}

function paintRange() {
  const min = Number(strengthEl.min) || 0;
  const max = Number(strengthEl.max) || 100;
  const pct = ((Number(strengthEl.value) - min) / (max - min)) * 100;
  strengthEl.style.setProperty('--p', pct + '%');
  strengthVal.textContent = strengthEl.value + '%';
}

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  enabledEl.checked = settings.enabled !== false;
  edgeEl.checked = settings.autoEdge !== false;
  const percent = Math.round((Number(settings.strength) || 0.92) * 100);
  strengthEl.value = String(Math.min(100, Math.max(50, percent)));
  paintRange();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  if (!currentTab || !/^(https?|file):/i.test(currentTab.url || '')) {
    reapplyBtn.disabled = true;
    peekBtn.disabled = true;
    setStatus('当前页面不是 PDF');
  } else {
    const peek = (await chrome.storage.session.get('peekTabs')).peekTabs || {};
    paintPeek(!!peek[currentTab.id]);
  }

  // 快捷键改了状态也要跟着变
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.peekTabs || !currentTab || !currentTab.id) return;
    const map = changes.peekTabs.newValue || {};
    paintPeek(!!map[currentTab.id]);
  });

  peekBtn.addEventListener('click', async () => {
    if (!currentTab || !currentTab.id) return;
    peekBtn.disabled = true;
    const res = await chrome.runtime
      .sendMessage({ type: 'peek-toggle', tabId: currentTab.id })
      .catch((err) => ({ ok: false, error: String(err) }));
    peekBtn.disabled = false;
    if (res && res.ok) {
      paintPeek(res.peek);
      setStatus(res.peek ? '已临时还原为原始配色' : '已恢复深色反色');
      setTimeout(() => setStatus(''), 1800);
    } else {
      setStatus((res && res.error) || '当前页面不是 PDF');
    }
  });

  enabledEl.addEventListener('change', async () => {
    await chrome.storage.sync.set({ enabled: enabledEl.checked });
    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({ type: 'reapply', tabId: currentTab.id });
    }
    setStatus(enabledEl.checked ? '已启用' : '已关闭，PDF 恢复原始配色');
  });

  strengthEl.addEventListener('input', paintRange);

  edgeEl.addEventListener('change', async () => {
    await chrome.storage.sync.set({ autoEdge: edgeEl.checked });
    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({ type: 'reapply', tabId: currentTab.id });
    }
    setStatus(edgeEl.checked ? '页面外空白已自动压深' : '页面外空白保持反色后的浅灰');
  });

  strengthEl.addEventListener('change', async () => {
    await chrome.storage.sync.set({ strength: Number(strengthEl.value) / 100 });
    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({ type: 'reapply', tabId: currentTab.id });
    }
  });

  reapplyBtn.addEventListener('click', async () => {
    if (!currentTab || !currentTab.id) return;
    reapplyBtn.disabled = true;
    const res = await chrome.runtime
      .sendMessage({ type: 'reapply', tabId: currentTab.id })
      .catch((err) => ({ ok: false, error: String(err) }));
    reapplyBtn.disabled = false;
    if (res && res.ok) {
      setStatus('已重新应用');
      setTimeout(() => setStatus(''), 1600);
    } else {
      setStatus((res && res.error) || '当前页面不是 PDF');
    }
  });
}

init();
