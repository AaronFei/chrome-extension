// Classroom Wake — 方案 A：在頁面 JS 執行前偽裝成前景分頁（MAIN world, document_start）
(() => {
  'use strict';
  if (window.__classroomWake) return;
  window.__classroomWake = true;
  const TAG = '[ClassroomWake]';
  const realHidden = () => {
    try { return realVisibility.call(document) === 'hidden'; } catch { return false; }
  };

  // 1. visibilityState / hidden（含 webkit 前綴）
  const DP = Document.prototype;
  const realVisibility = Object.getOwnPropertyDescriptor(DP, 'visibilityState')?.get;
  const def = (name, value) => {
    try {
      Object.defineProperty(DP, name, { configurable: true, enumerable: true, get: () => value });
    } catch (e) { console.debug(TAG, 'defineProperty failed', name, e); }
  };
  def('visibilityState', 'visible');
  def('hidden', false);
  def('webkitVisibilityState', 'visible');
  def('webkitHidden', false);

  // 2. hasFocus 永遠 true
  try { DP.hasFocus = function hasFocus() { return true; }; } catch {}

  // 3. capture 階段攔截 visibilitychange
  const block = (e) => { e.stopImmediatePropagation(); };
  for (const t of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(t, block, true);
    document.addEventListener(t, block, true);
  }

  // 4. requestAnimationFrame：rAF 與 50ms timeout 賽跑，先到先執行
  const rawRAF = window.requestAnimationFrame.bind(window);
  const rawCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map(); // id -> { raf, timer }
  let seq = 0;
  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = ++seq;
    const entry = { raf: 0, timer: 0 };
    const run = (ts) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rawCAF(entry.raf);
      clearTimeout(entry.timer);
      try { cb(ts); } catch (e) { setTimeout(() => { throw e; }); }
    };
    entry.raf = rawRAF(run);
    entry.timer = setTimeout(() => run(performance.now()), 50);
    pending.set(id, entry);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    rawCAF(entry.raf);
    clearTimeout(entry.timer);
  };

  console.debug(TAG, 'installed; real hidden =', realHidden(), location.href);
})();
