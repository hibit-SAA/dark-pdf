'use strict';

const DEFAULTS = { autoCapture: true, invert: true, strength: 0.92 };
const $ = (id) => document.getElementById(id);

const autoEl = $('auto');
const invertEl = $('invert');
const strengthEl = $('strength');
const strengthVal = $('strengthVal');
const openBtn = $('open');
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
  autoEl.checked = settings.autoCapture !== false;
  invertEl.checked = settings.invert !== false;
  const percent = Math.round((Number(settings.strength) || 0.92) * 100);
  strengthEl.value = String(Math.min(100, Math.max(50, percent)));
  paintRange();

  autoEl.addEventListener('change', () => {
    chrome.storage.sync.set({ autoCapture: autoEl.checked });
    setStatus('');
  });

  invertEl.addEventListener('change', () => {
    chrome.storage.sync.set({ invert: invertEl.checked });
  });

  strengthEl.addEventListener('input', paintRange);

  strengthEl.addEventListener('change', () => {
    chrome.storage.sync.set({ strength: Number(strengthEl.value) / 100 });
  });

  openBtn.addEventListener('click', async () => {
    setStatus('');
    if (!currentTab || !currentTab.id) {
      setStatus('找不到当前标签页');
      return;
    }
    const url = currentTab.url || '';
    if (!/^(https?|file):/i.test(url)) {
      setStatus('当前页面不支持用阅读器打开');
      return;
    }
    openBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'open-in-viewer',
      tabId: currentTab.id,
      url: url
    }).catch((err) => ({ ok: false, error: String(err) }));

    if (res && res.ok) {
      window.close();
    } else {
      openBtn.disabled = false;
      setStatus((res && res.error) || '打开失败');
    }
  });

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;
  if (!currentTab || !/^(https?|file):/i.test(currentTab.url || '')) {
    openBtn.disabled = true;
    setStatus('当前页面无法用阅读器打开');
  } else if ((currentTab.url || '').startsWith(chrome.runtime.getURL(''))) {
    openBtn.disabled = true;
    setStatus('当前页已经在深色阅读器中');
  }
}

init();
