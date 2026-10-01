// 這些函式會被 chrome.scripting.executeScript 序列化後注入到分頁執行，
// 必須是自給自足的（不能參考外部變數），也不能用到 chrome.* 以外的擴充功能環境。
// 它們跑在 isolated world，狀態掛在 window.__fpc 上，同一個 frame 之間可以延續。
//
// 兩種模式：
//   page      —— 捲 window（一般網頁）
//   container —— 頁面本身不會捲，內容放在內部 overflow:auto 的區塊裡（Wiki/後台/SPA 常見）。
//                自動找「可視面積最大、而且真的有東西可捲」的那個元素來捲，
//                輸出只包含該區塊的內容。

export function fpcPrepare(opts) {
  const st = (window.__fpc = window.__fpc || {});
  const se = () => document.scrollingElement || document.documentElement;
  const measurePage = () =>
    Math.max(
      se().scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.offsetHeight : 0
    );
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clientRect = (el) => {
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, r.left + el.clientLeft);
    const y0 = Math.max(0, r.top + el.clientTop);
    const x1 = Math.min(vw, r.left + el.clientLeft + el.clientWidth);
    const y1 = Math.min(vh, r.top + el.clientTop + el.clientHeight);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };

  const findScroller = () => {
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement) continue;
      const ch = el.clientHeight;
      const cw = el.clientWidth;
      if (ch < vh * 0.3 || cw < vw * 0.3) continue;
      if (el.scrollHeight - ch < 40) continue;
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = clientRect(el);
      const score = r.w * r.h;
      if (score > bestScore || (score === bestScore && best && el.scrollHeight > best.scrollHeight)) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore >= vw * vh * 0.15 ? best : null;
  };

  st.el = null;
  st.orig = {
    x: window.scrollX,
    y: window.scrollY,
    htmlBehavior: document.documentElement.style.getPropertyValue('scroll-behavior'),
    bodyBehavior: document.body ? document.body.style.getPropertyValue('scroll-behavior') : ''
  };
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');

  // 頁面本身幾乎捲不動（< 1/4 屏）才去找內部捲動區塊，避免一般長網頁被誤判
  if (opts.target !== 'page' && measurePage() - vh < vh * 0.25) {
    const el = findScroller();
    if (el) {
      st.el = el;
      st.orig.elTop = el.scrollTop;
      st.orig.elLeft = el.scrollLeft;
      st.orig.elBehavior = el.style.getPropertyValue('scroll-behavior');
      st.orig.elBehaviorPrio = el.style.getPropertyPriority('scroll-behavior');
      el.style.setProperty('scroll-behavior', 'auto', 'important');
    }
  }

  const el = st.el;
  const scroll = (y) => (el ? (el.scrollTop = y) : window.scrollTo(0, y));
  const full = () => (el ? el.scrollHeight : measurePage());
  const stepH = () => (el ? el.clientHeight : vh);

  const run = async () => {
    if (opts.preScroll) {
      // 先整個捲一遍，逼出 lazy-load 的圖片／內容，高度會邊捲邊長
      const step = Math.max(200, stepH() - 40);
      let h = full();
      let y = 0;
      let guard = 0;
      while (y < h - stepH() && guard++ < 400) {
        y += step;
        scroll(y);
        await new Promise((r) => setTimeout(r, opts.preScrollWaitMs));
        h = full();
      }
      scroll(0);
      await new Promise((r) => setTimeout(r, 250));
    }
    const base = {
      viewW: vw,
      clientW: document.documentElement.clientWidth || vw,
      dpr: window.devicePixelRatio || 1,
      title: document.title,
      url: location.href
    };
    if (el) {
      return {
        ...base,
        mode: 'container',
        fullHeight: el.scrollHeight,
        viewH: el.clientHeight,
        rect: clientRect(el),
        desc:
          el.tagName.toLowerCase() +
          (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '')
      };
    }
    // 整頁模式：貼齊左右邊、又高又窄的 position:fixed 元素視為固定側欄（Confluence 的 .ia-fixed-sidebar 等），
    // 輸出時整條裁掉 —— 否則第一屏有側欄、後面全是一大片空白欄，很醜
    let sideL = 0;
    let sideR = base.clientW;
    if (opts.cropSidebar) {
      for (const e of document.body ? document.body.querySelectorAll('*') : []) {
        let cs;
        try {
          cs = getComputedStyle(e);
        } catch (err) {
          continue;
        }
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = e.getBoundingClientRect();
        if (r.height < vh * 0.6 || r.width < 40 || r.width > base.clientW * 0.35) continue;
        if (r.left <= 2) sideL = Math.max(sideL, Math.round(r.right));
        else if (r.right >= base.clientW - 2) sideR = Math.min(sideR, Math.round(r.left));
      }
      if (sideR - sideL < base.clientW * 0.4) {
        sideL = 0;
        sideR = base.clientW;
      }
    }
    return { ...base, mode: 'page', fullHeight: measurePage(), viewH: vh, sideL, sideR };
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
  const box = st.el ? st.el.getBoundingClientRect() : null;
  const top0 = box ? box.top : 0;
  const zoneH = box ? st.el.clientHeight : window.innerHeight;
  const topZone = top0 + zoneH * 0.4;
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
    if (st.el) {
      // 容器模式：捲動容器本身或它的祖先絕對不能藏（藏了整塊內容就不見了）
      if (el === st.el || el.contains(st.el)) continue;
      // 不和容器重疊的（頂端導覽列、側欄）不會入鏡，不用動它
      if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
    }
    if (mode === 'bottom' && r.top <= topZone) continue; // 頂端的先留著，第一屏要有 header
    if (st.hidden.some((h) => h[0] === el)) continue;
    st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  return st.hidden.length;
}

export function fpcScrollTo(y, waitMs) {
  const st = window.__fpc || {};
  const el = st.el;
  const measure = () =>
    Math.max(
      (document.scrollingElement || document.documentElement).scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.offsetHeight : 0
    );
  if (el) el.scrollTop = y;
  else window.scrollTo(0, y);
  return new Promise((r) =>
    setTimeout(() => {
      if (el) {
        const b = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x0 = Math.max(0, b.left + el.clientLeft);
        const y0 = Math.max(0, b.top + el.clientTop);
        const x1 = Math.min(vw, b.left + el.clientLeft + el.clientWidth);
        const y1 = Math.min(vh, b.top + el.clientTop + el.clientHeight);
        r({
          y: el.scrollTop,
          fullHeight: el.scrollHeight,
          viewH: el.clientHeight,
          rect: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
        });
      } else {
        r({ y: window.scrollY, fullHeight: measure(), viewH: window.innerHeight });
      }
    }, waitMs)
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
    if (st.el) {
      st.el.scrollTop = st.orig.elTop || 0;
      st.el.scrollLeft = st.orig.elLeft || 0;
      if (st.orig.elBehavior)
        st.el.style.setProperty('scroll-behavior', st.orig.elBehavior, st.orig.elBehaviorPrio);
      else st.el.style.removeProperty('scroll-behavior');
    }
    window.scrollTo(st.orig.x, st.orig.y);
  }
  st.el = null;
  return true;
}
