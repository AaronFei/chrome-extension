import { imageToPdfBlob } from './lib/pdf.js';
import { baseName, dataUrlToBlob, humanBytes, downloadBlob } from './lib/common.js';

const $ = (id) => document.getElementById(id);
let rec = null;
let pngBlob = null;   // 目前這張圖（可能已裁切）
let img = null;       // 畫面上的 <img>，PDF / 裁切都以它為來源
let stage = null;
let origBlob = null;  // 未裁切的原圖
let cropped = false;
let crop = null;      // {x, y, w, h}，單位是影像原始像素

function toast(text, isErr) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 2600);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [id, ...rest] = raw.split('&');
  return { id, auto: new URLSearchParams(rest.join('&')).get('auto') };
}

function updateSub() {
  const extra =
    (rec.scaledDown ? ` · 超過畫布上限，已縮到 ${Math.round(rec.scaledDown * 100)}%` : '') +
    (rec.truncated ? ` · 底部 ${rec.truncated}px 未擷取` : '');
  $('sub').textContent =
    `${img.naturalWidth}×${img.naturalHeight} px` +
    (cropped ? `（原圖 ${rec.width}×${rec.height}，已裁切）` : ` · ${rec.shots} 屏`) +
    ` · ${humanBytes(pngBlob.size)}${extra} · ${rec.url}`;
}

async function main() {
  const { id, auto } = parseHash();
  if (!id) return ($('empty').textContent = '沒有指定截圖');
  const got = await chrome.storage.local.get(id);
  rec = got[id];
  if (!rec) return ($('empty').textContent = '找不到截圖資料（可能已被新的截圖取代）');

  pngBlob = origBlob = dataUrlToBlob(rec.dataUrl);
  img = new Image();
  img.src = rec.dataUrl;
  img.className = 'fit';
  img.alt = rec.title || '整頁截圖';
  img.draggable = false;
  await img.decode().catch(() => {});

  stage = document.createElement('div');
  stage.className = 'stage';
  stage.append(img, buildCropBox());
  $('main').replaceChildren(stage);

  $('title').textContent = rec.title || '(無標題)';
  document.title = `${rec.title || '整頁截圖'} — 預覽`;
  updateSub();

  if (auto === 'copy') copy(true);
  else if (auto === 'png') $('png').click();
  else if (auto === 'pdf') $('pdf').click();
}

/* ---------------- 裁切 ---------------- */

let box = null;
function buildCropBox() {
  box = document.createElement('div');
  box.id = 'cropbox';
  const grid = document.createElement('div');
  grid.className = 'grid';
  box.append(grid);
  for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const h = document.createElement('div');
    h.className = 'h ' + dir;
    h.dataset.dir = dir;
    box.append(h);
  }
  box.addEventListener('pointerdown', onPointerDown);
  return box;
}

// 畫面顯示的縮放比例：<img> 的實際寬度 / 影像原始寬度
const dispScale = () => (img.clientWidth || img.naturalWidth) / img.naturalWidth;

function renderCrop() {
  const s = dispScale();
  box.style.left = crop.x * s + 'px';
  box.style.top = crop.y * s + 'px';
  box.style.width = crop.w * s + 'px';
  box.style.height = crop.h * s + 'px';
  for (const [id, v] of [['cx', crop.x], ['cy', crop.y], ['cw', crop.w], ['ch', crop.h]]) {
    const el = $(id);
    if (el !== document.activeElement) el.value = Math.round(v);
  }
}

function clampCrop() {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  crop.w = Math.max(10, Math.min(crop.w, W));
  crop.h = Math.max(10, Math.min(crop.h, H));
  crop.x = Math.max(0, Math.min(crop.x, W - crop.w));
  crop.y = Math.max(0, Math.min(crop.y, H - crop.h));
}

function enterCrop() {
  crop = crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  clampCrop();
  stage.classList.add('cropping');
  $('normalBar').classList.add('hide');
  $('cropBar').classList.remove('hide');
  renderCrop();
}

function exitCrop() {
  stage.classList.remove('cropping');
  $('cropBar').classList.add('hide');
  $('normalBar').classList.remove('hide');
}

function onPointerDown(e) {
  const dir = e.target.dataset ? e.target.dataset.dir : null;
  if (!dir && e.target !== box && !e.target.classList.contains('grid')) return;
  e.preventDefault();
  const s = dispScale();
  const start = { ...crop };
  const px = e.clientX;
  const py = e.clientY;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - px) / s;
    const dy = (ev.clientY - py) / s;
    if (!dir) {
      crop.x = Math.max(0, Math.min(start.x + dx, W - start.w));
      crop.y = Math.max(0, Math.min(start.y + dy, H - start.h));
    } else {
      let l = start.x;
      let t = start.y;
      let r = start.x + start.w;
      let b = start.y + start.h;
      if (dir.includes('w')) l = Math.max(0, Math.min(start.x + dx, r - 10));
      if (dir.includes('e')) r = Math.min(W, Math.max(start.x + start.w + dx, l + 10));
      if (dir.includes('n')) t = Math.max(0, Math.min(start.y + dy, b - 10));
      if (dir.includes('s')) b = Math.min(H, Math.max(start.y + start.h + dy, t + 10));
      crop = { x: l, y: t, w: r - l, h: b - t };
    }
    renderCrop();
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

async function applyCrop() {
  clampCrop();
  const w = Math.round(crop.w);
  const h = Math.round(crop.h);
  if (w === img.naturalWidth && h === img.naturalHeight && crop.x === 0 && crop.y === 0) {
    exitCrop();
    return;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, Math.round(crop.x), Math.round(crop.y), w, h, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));

  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  pngBlob = blob;
  img.src = URL.createObjectURL(blob);
  await img.decode().catch(() => {});
  cropped = true;
  crop = null;
  exitCrop();
  $('revert').classList.remove('hide');
  updateSub();
  toast(`已裁切成 ${w}×${h}`);
}

async function revert() {
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  pngBlob = origBlob;
  img.src = rec.dataUrl;
  await img.decode().catch(() => {});
  cropped = false;
  crop = null;
  $('revert').classList.add('hide');
  updateSub();
  toast('已還原原圖');
}

// 長截圖用拖的很難拉到底，四個數字欄位可以直接輸入
for (const [id, key] of [['cx', 'x'], ['cy', 'y'], ['cw', 'w'], ['ch', 'h']]) {
  $(id).addEventListener('input', () => {
    if (!crop) return;
    const v = Number($(id).value);
    if (!Number.isFinite(v)) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    // 改位置就縮尺寸、改尺寸就以現在的位置為準，不要反過來把使用者剛打的數字彈掉
    if (key === 'x') {
      crop.x = Math.max(0, Math.min(v, W - 10));
      crop.w = Math.min(crop.w, W - crop.x);
    } else if (key === 'y') {
      crop.y = Math.max(0, Math.min(v, H - 10));
      crop.h = Math.min(crop.h, H - crop.y);
    } else if (key === 'w') {
      crop.w = Math.max(10, Math.min(v, W - crop.x));
    } else {
      crop.h = Math.max(10, Math.min(v, H - crop.y));
    }
    renderCrop();
  });
  $(id).addEventListener('keydown', (e) => e.stopPropagation());
  // 離開欄位時把夾過範圍的值寫回去，避免畫面顯示的數字和實際裁切框不一致
  const sync = () => {
    if (crop) $(id).value = Math.round(crop[key]);
  };
  $(id).addEventListener('change', sync);
  $(id).addEventListener('blur', sync);
}

$('crop').addEventListener('click', enterCrop);
$('cropCancel').addEventListener('click', exitCrop);
$('cropApply').addEventListener('click', applyCrop);
$('cropAll').addEventListener('click', () => {
  crop = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  renderCrop();
});
$('revert').addEventListener('click', revert);

/* ---------------- 輸出 ---------------- */

function fileName(ext) {
  return baseName(rec) + (cropped ? '_crop' : '') + ext;
}

async function copy(silentFail) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    toast('已複製到剪貼簿');
  } catch (e) {
    if (silentFail) toast('瀏覽器擋下自動複製，請按「複製到剪貼簿」', true);
    else toast('複製失敗：' + e.message, true);
  }
}

$('png').addEventListener('click', async () => {
  try {
    await downloadBlob(pngBlob, fileName('.png'));
    toast('PNG 已下載');
  } catch (e) {
    toast('下載失敗：' + e.message, true);
  }
});

$('copy').addEventListener('click', () => copy(false));

$('pdf').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const blob = await imageToPdfBlob(img);
    await downloadBlob(blob, fileName('.pdf'));
    toast('PDF 已下載');
  } catch (err) {
    toast('PDF 失敗：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '存成 PDF';
  }
});

$('zoom').addEventListener('click', (e) => {
  const fit = img.classList.toggle('fit');
  $('main').classList.toggle('full', !fit);
  e.currentTarget.textContent = fit ? '實際大小' : '符合寬度';
  if (stage.classList.contains('cropping')) renderCrop();
});

window.addEventListener('resize', () => {
  if (stage && stage.classList.contains('cropping')) renderCrop();
});

document.addEventListener('keydown', (e) => {
  const inCrop = stage && stage.classList.contains('cropping');
  if (inCrop) {
    if (e.key === 'Escape') return exitCrop();
    if (e.key === 'Enter') return applyCrop();
    const step = e.shiftKey ? 10 : 1;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (map[e.key]) {
      e.preventDefault();
      const [dx, dy] = map[e.key];
      if (e.altKey) {
        crop.w += dx;
        crop.h += dy;
      } else {
        crop.x += dx;
        crop.y += dy;
      }
      clampCrop();
      renderCrop();
    }
    return;
  }
  if (e.key === 'c' && !e.metaKey && !e.ctrlKey) return enterCrop();
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    $('png').click();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection().toString()) {
    e.preventDefault();
    copy(false);
  }
});

main();
