export function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

export function baseName(rec) {
  let host = 'page';
  try {
    host = new URL(rec.url).hostname.replace(/^www\./, '');
  } catch (e) {}
  return `fullpage_${host.replace(/[^\w.-]/g, '_')}_${stamp(new Date(rec.ts || Date.now()))}`;
}

// 不用 fetch(dataUrl)，service worker 裡不保證可用
export function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToDataUrl(bytes, mime) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return `data:${mime};base64,${btoa(s)}`;
}

export function dataUrlToBlob(dataUrl) {
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}

export async function blobToDataUrl(blob) {
  return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type || 'application/octet-stream');
}

export function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function startDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });
}

// 分頁 / 擴充功能頁：用 blob URL，沒有大小限制
export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    return await startDownload(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// service worker：沒有 URL.createObjectURL，只能走 data URL
export function downloadDataUrl(dataUrl, filename) {
  return startDownload(dataUrl, filename);
}

export const DATA_URL_DOWNLOAD_LIMIT = 48 * 1024 * 1024;
