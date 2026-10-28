'use strict';

const DEFAULTS = { enabled: true, strength: 0.92, deep: false };
const $ = (id) => document.getElementById(id);

const enabledEl = $('enabled');
const strengthEl = $('strength');
const strengthVal = $('strengthVal');
const deepEl = $('deep');
const reapplyBtn = $('reapply');
const statusEl = $('status');

let currentTab = null;

function setStatus(text) {
  statusEl.textContent = text || '';
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
  deepEl.checked = settings.deep === true;
  const percent = Math.round((Number(settings.strength) || 0.92) * 100);
  strengthEl.value = String(Math.min(100, Math.max(50, percent)));
  paintRange();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;

  if (!currentTab || !/^(https?|file):/i.test(currentTab.url || '')) {
    reapplyBtn.disabled = true;
    setStatus('当前页面不是 PDF');
  }

  enabledEl.addEventListener('change', async () => {
    await chrome.storage.sync.set({ enabled: enabledEl.checked });
    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({ type: 'reapply', tabId: currentTab.id });
    }
    setStatus(enabledEl.checked ? '已启用' : '已关闭，PDF 恢复原始配色');
  });

  strengthEl.addEventListener('input', paintRange);

  deepEl.addEventListener('change', async () => {
    await chrome.storage.sync.set({ deep: deepEl.checked });
    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({ type: 'reapply', tabId: currentTab.id });
    }
    setStatus(deepEl.checked ? '已压深页面外空白' : '已恢复标准反色');
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
