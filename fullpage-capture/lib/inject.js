// 這些函式會被 chrome.scripting.executeScript 序列化後注入到分頁執行，
// 必須是自給自足的（不能參考外部變數），也不能用到 chrome.* 以外的擴充功能環境。
// 它們跑在 isolated world，狀態掛在 window.__fpc 上，同一個 frame 之間可以延續。

export function fpcPrepare(opts) {
  const st = (window.__fpc = window.__fpc || {});
  const se = () => document.scrollingElement || document.documentElement;
  const measure = () =>
    Math.max(
      se().scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.offsetHeight : 0
    );

  st.orig = {
    x: window.scrollX,
    y: window.scrollY,
    htmlBehavior: document.documentElement.style.getPropertyValue('scroll-behavior'),
    bodyBehavior: document.body ? document.body.style.getPropertyValue('scroll-behavior') : ''
  };
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');

  const run = async () => {
    if (opts.preScroll) {
      // 先整頁捲一遍，逼出 lazy-load 的圖片／內容，頁高會邊捲邊長
      const step = Math.max(200, window.innerHeight - 40);
      let h = measure();
      let y = 0;
      let guard = 0;
      while (y < h - window.innerHeight && guard++ < 400) {
        y += step;
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, opts.preScrollWaitMs));
        h = measure();
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      fullHeight: measure(),
      viewH: window.innerHeight,
      viewW: window.innerWidth,
      clientW: document.documentElement.clientWidth || window.innerWidth,
      dpr: window.devicePixelRatio || 1,
      title: document.title,
      url: location.href
    };
  };
  return run();
}

export function fpcSetFixedHidden(mode) {
  // mode: 'bottom' 只藏非貼齊頂端的固定元素（底部工具列、聊天氣泡、cookie 條）
  //       'all'    連頂端的 header 也藏起來（第一屏拍完之後用）
  //       'none'   全部還原
  const st = (window.__fpc = window.__fpc || {});
  st.hidden = st.hidden || [];
  if (mode === 'none') {
    for (const [el, v, p] of st.hidden) {
      if (v) el.style.setProperty('visibility', v, p);
      else el.style.removeProperty('visibility');
    }
    st.hidden = [];
    return 0;
  }
  const topZone = window.innerHeight * 0.4;
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      continue;
    }
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (mode === 'bottom' && r.top <= topZone) continue; // 頂端的先留著，第一屏要有 header
    if (st.hidden.some((h) => h[0] === el)) continue;
    st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  return st.hidden.length;
}

export function fpcScrollTo(y, waitMs) {
  const measure = () =>
    Math.max(
      (document.scrollingElement || document.documentElement).scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.offsetHeight : 0
    );
  window.scrollTo(0, y);
  return new Promise((r) =>
    setTimeout(
      () => r({ y: window.scrollY, fullHeight: measure(), viewH: window.innerHeight }),
      waitMs
    )
  );
}

export function fpcRestore() {
  const st = window.__fpc || {};
  for (const [el, v, p] of st.hidden || []) {
    if (v) el.style.setProperty('visibility', v, p);
    else el.style.removeProperty('visibility');
  }
  st.hidden = null;
  if (st.orig) {
    if (st.orig.htmlBehavior)
      document.documentElement.style.setProperty('scroll-behavior', st.orig.htmlBehavior);
    else document.documentElement.style.removeProperty('scroll-behavior');
    if (document.body) {
      if (st.orig.bodyBehavior) document.body.style.setProperty('scroll-behavior', st.orig.bodyBehavior);
      else document.body.style.removeProperty('scroll-behavior');
    }
    window.scrollTo(st.orig.x, st.orig.y);
  }
  return true;
}
