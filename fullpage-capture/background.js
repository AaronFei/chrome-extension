import { fpcPrepare, fpcSetFixedHidden, fpcScrollTo, fpcRestore } from './lib/inject.js';
import { imageToPdfBlob } from './lib/pdf.js';
import {
  baseName,
  dataUrlToBytes,
  bytesToDataUrl,
  dataUrlToBlob,
  blobToDataUrl,
  downloadDataUrl,
  DATA_URL_DOWNLOAD_LIMIT
} from './lib/common.js';

const DEFAULTS = {
  afterCapture: 'preview', // preview | png | pdf | clipboard
  hideFixed: true,
  preScroll: true,
  preScrollWaitMs: 120,
  settleMs: 250,
  jpegQuality: 0.92
};

// captureVisibleTab 的配額是每秒 2 次，抓太快會丟 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
const CAPTURE_MIN_INTERVAL_MS = 560;
const MAX_CANVAS_SIDE = 32000; // Chrome canvas 單邊上限（保守值）
const MAX_CANVAS_AREA = 240 * 1000 * 1000; // 總像素上限，超過就整張等比縮小
const KEEP_RESULTS = 3;

let busy = false;

async function getSettings() {
  const got = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(got.settings || {}) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup 可能已關閉
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function exec(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args: args || [],
    world: 'ISOLATED'
  });
  return res && res.result;
}

async function captureOnce(windowId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      const msg = String(e && e.message);
      if (msg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') || msg.includes('quota')) {
        await sleep(700);
        continue;
      }
      throw e;
    }
  }
  throw new Error('captureVisibleTab 一直被配額限制擋下');
}

async function captureFullPage(tab, settings) {
  const tabId = tab.id;
  const windowId = tab.windowId;

  post({ type: 'progress', phase: 'prepare', text: '量測頁面…' });
  setBadge('…', '#2563eb');

  const info = await exec(tabId, fpcPrepare, [
    { preScroll: settings.preScroll, preScrollWaitMs: settings.preScrollWaitMs }
  ]);
  if (!info) throw new Error('無法在這個分頁執行腳本');

  let fullHeight = info.fullHeight;
  const shots = [];
  let lastCaptureAt = 0;

  const grab = async () => {
    const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    const d = await captureOnce(windowId);
    lastCaptureAt = Date.now();
    return d;
  };

  let scale = 1;
  let effViewH = info.viewH;

  try {
    // 第一屏之前先藏掉「不是貼在頂端」的固定元素：底部工具列、聊天氣泡、cookie 條
    if (settings.hideFixed) await exec(tabId, fpcSetFixedHidden, ['bottom']);

    const first = await exec(tabId, fpcScrollTo, [0, settings.settleMs]);
    fullHeight = Math.max(fullHeight, first.fullHeight);
    const d0 = await grab();
    shots.push({ y: first.y, dataUrl: d0 });

    // 不要假設「截到的高度 == innerHeight」。實際可視高度一律從截圖本身推回來，
    // 這樣縮放、瀏覽器橫幅、headless 等情況都不會出現接縫或漏段。
    const bmp0 = await createImageBitmap(new Blob([dataUrlToBytes(d0)], { type: 'image/png' }));
    scale = bmp0.width / info.viewW;
    effViewH = Math.max(50, Math.floor(bmp0.height / scale));
    bmp0.close();

    // 第一屏拍完，header 已經入鏡，接下來整批藏起來避免每屏重複
    if (settings.hideFixed) await exec(tabId, fpcSetFixedHidden, ['all']);

    const estimate = Math.max(1, Math.ceil(fullHeight / effViewH));
    post({ type: 'progress', phase: 'capture', done: 1, total: estimate, text: `擷取中 1/${estimate}` });
    setBadge('1', '#2563eb');

    let y = effViewH;
    while (shots.length < 500) {
      const maxScroll = Math.max(0, fullHeight - info.viewH);
      if (shots[shots.length - 1].y >= maxScroll - 1) break;
      const s = await exec(tabId, fpcScrollTo, [Math.min(y, maxScroll), settings.settleMs]);
      fullHeight = Math.max(fullHeight, s.fullHeight);
      if (s.y <= shots[shots.length - 1].y) break; // 捲不動了
      shots.push({ y: s.y, dataUrl: await grab() });

      const total = Math.max(shots.length, Math.ceil(fullHeight / effViewH));
      setBadge(String(shots.length), '#2563eb');
      post({
        type: 'progress',
        phase: 'capture',
        done: shots.length,
        total,
        text: `擷取中 ${shots.length}/${total}`
      });
      y = s.y + effViewH;
    }
  } finally {
    await exec(tabId, fpcRestore, []).catch(() => {});
  }

  post({ type: 'progress', phase: 'stitch', text: '拼接中…' });
  const coverage = shots[shots.length - 1].y + effViewH;
  const result = await stitch(shots, {
    scale,
    outWCss: info.clientW || info.viewW,
    outHCss: Math.min(fullHeight, coverage)
  });
  result.url = info.url;
  result.title = info.title;
  result.truncated = coverage < fullHeight - 1 ? Math.round(fullHeight - coverage) : null;
  return result;
}

async function stitch(shots, dims) {
  let outW = Math.round(dims.outWCss * dims.scale);
  let outH = Math.round(dims.outHCss * dims.scale);

  let shrink = 1;
  if (outH > MAX_CANVAS_SIDE) shrink = MAX_CANVAS_SIDE / outH;
  if (outW * outH * shrink * shrink > MAX_CANVAS_AREA) {
    shrink = Math.min(shrink, Math.sqrt(MAX_CANVAS_AREA / (outW * outH)));
  }
  if (shrink < 1) {
    outW = Math.max(1, Math.round(outW * shrink));
    outH = Math.max(1, Math.round(outH * shrink));
  }

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  for (const shot of shots) {
    const bmp = await createImageBitmap(new Blob([dataUrlToBytes(shot.dataUrl)], { type: 'image/png' }));
    // 最後一屏通常和前一屏重疊，直接覆蓋上去內容一樣，不會有接縫
    ctx.drawImage(bmp, 0, shot.y * dims.scale * shrink, bmp.width * shrink, bmp.height * shrink);
    bmp.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    dataUrl: bytesToDataUrl(bytes, 'image/png'),
    width: outW,
    height: outH,
    shots: shots.length,
    scaledDown: shrink < 1 ? Number(shrink.toFixed(3)) : null
  };
}

async function saveResult(result) {
  const id = 'cap_' + Date.now().toString(36);
  const all = await chrome.storage.local.get(null);
  const olds = Object.keys(all)
    .filter((k) => k.startsWith('cap_'))
    .sort();
  const drop = olds.slice(0, Math.max(0, olds.length - (KEEP_RESULTS - 1)));
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({ [id]: { ...result, id, ts: Date.now() } });
  return id;
}

async function exportFile(rec, action) {
  const name = baseName(rec);
  if (action === 'pdf') {
    const bmp = await createImageBitmap(dataUrlToBlob(rec.dataUrl));
    const blob = await imageToPdfBlob(bmp, { quality: 0.92 });
    bmp.close();
    const url = await blobToDataUrl(blob);
    if (url.length > DATA_URL_DOWNLOAD_LIMIT) return false;
    await downloadDataUrl(url, name + '.pdf');
    return true;
  }
  if (rec.dataUrl.length > DATA_URL_DOWNLOAD_LIMIT) return false;
  await downloadDataUrl(rec.dataUrl, name + '.png');
  return true;
}

async function runAfterCapture(id, action) {
  if (action === 'png' || action === 'pdf') {
    post({ type: 'progress', phase: 'export', text: action === 'pdf' ? '產生 PDF…' : '下載中…' });
    const got = await chrome.storage.local.get(id);
    const rec = got[id];
    if (!rec) throw new Error('找不到截圖資料');
    // 檔案太大時 data URL 下載會失敗，改開預覽頁用 blob URL 下載
    if (await exportFile(rec, action)) return;
    await chrome.tabs.create({
      url: chrome.runtime.getURL('preview.html') + `#${id}&auto=${action}`
    });
    return;
  }
  const hash = action === 'clipboard' ? `#${id}&auto=copy` : `#${id}`;
  await chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') + hash });
}

async function start(tab) {
  if (busy) {
    post({ type: 'progress', phase: 'error', text: '已經有一個擷取在進行中' });
    return;
  }
  busy = true;
  const settings = await getSettings();
  try {
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab || !tab.id) throw new Error('找不到目前的分頁');
    if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(tab.url || '')) {
      throw new Error('瀏覽器內建頁面（chrome://、擴充功能頁）不允許截圖');
    }

    const result = await captureFullPage(tab, settings);
    const id = await saveResult(result);
    setBadge('✓', '#16a34a');
    post({
      type: 'progress',
      phase: 'done',
      text: `完成：${result.width}×${result.height}`,
      width: result.width,
      height: result.height,
      id
    });
    await runAfterCapture(id, settings.afterCapture);
    setTimeout(() => setBadge(''), 2500);
  } catch (e) {
    console.error('[fullpage-capture]', e);
    setBadge('!', '#dc2626');
    post({ type: 'progress', phase: 'error', text: String((e && e.message) || e) });
    setTimeout(() => setBadge(''), 4000);
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    start(msg.tab || null);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'getState') {
    sendResponse({ busy });
    return false;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'capture-full-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  start(tab);
});

// 給自動化測試用：擴充功能自己的頁面才能呼叫
globalThis.__fpcStart = start;
