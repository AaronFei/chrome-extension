const DEFAULTS = {
  afterCapture: 'preview',
  hideFixed: true,
  preScroll: true,
  preScrollWaitMs: 120,
  settleMs: 250,
  jpegQuality: 0.92
};
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const bar = $('bar');
let settings = { ...DEFAULTS };

function setStatus(text, isErr) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (isErr ? ' err' : '');
}

async function load() {
  const got = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULTS, ...(got.settings || {}) };
  $('afterCapture').value = settings.afterCapture;
  $('hideFixed').checked = !!settings.hideFixed;
  $('preScroll').checked = !!settings.preScroll;
  $('settleMs').value = String(settings.settleMs);
}

async function save() {
  settings = {
    ...settings,
    afterCapture: $('afterCapture').value,
    hideFixed: $('hideFixed').checked,
    preScroll: $('preScroll').checked,
    settleMs: Number($('settleMs').value)
  };
  await chrome.storage.sync.set({ settings });
}

['afterCapture', 'hideFixed', 'preScroll', 'settleMs'].forEach((id) =>
  $(id).addEventListener('change', save)
);

$('go').addEventListener('click', async () => {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('go').disabled = true;
  bar.style.display = 'block';
  setStatus('啟動中…');
  chrome.runtime.sendMessage({ type: 'capture', tab });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'progress') return;
  if (msg.phase === 'capture' && msg.total) {
    bar.firstElementChild.style.width = Math.min(100, (msg.done / msg.total) * 100) + '%';
  }
  if (msg.phase === 'stitch') bar.firstElementChild.style.width = '100%';
  setStatus(msg.text, msg.phase === 'error');
  if (msg.phase === 'done' || msg.phase === 'error') {
    $('go').disabled = false;
    if (msg.phase === 'error') bar.style.display = 'none';
  }
});

load();
