/* Auto Login — 學習模式（由 popup 用 chrome.scripting 注入）
 * 流程：先自動偵測 → 讓你確認或手動點選 → 填帳密 → 存進 chrome.storage
 * UI 放在 closed shadow DOM 裡，不會被網頁的 CSS 影響，也不會影響網頁。
 */
(async () => {
  "use strict";
  const AL = window.__AL__;
  if (!AL) return;

  document.getElementById("__al_picker__")?.remove();

  const host = document.createElement("div");
  host.id = "__al_picker__";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:auto 16px 16px auto;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });

  const HL = document.createElement("div");
  HL.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;" +
    "background:rgba(59,130,246,.12);border-radius:4px;display:none;transition:all .05s;";
  document.documentElement.appendChild(HL);

  const box = (el) => {
    if (!el) { HL.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(HL.style, {
      display: "block", left: r.left + "px", top: r.top + "px",
      width: r.width + "px", height: r.height + "px",
    });
  };

  const cleanup = () => { host.remove(); HL.remove(); };

  const esc = (v) => String(v ?? "").replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 面板在 closed shadow DOM 裡，host.contains() 穿不過 shadow 邊界，
  // 必須用 composedPath 判斷這個事件是不是從面板自己發出來的。
  const inPanel = (e) => (e.composedPath?.() || []).includes(host);

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Noto Sans TC", system-ui, sans-serif; }
      .panel { width: 320px; background: #fff; color: #111827; border: 1px solid #d1d5db;
               border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.25); overflow: hidden; }
      .hd { display:flex; align-items:center; justify-content:space-between;
            padding: 10px 14px; background: #3b82f6; color: #fff; font-size: 13px; font-weight: 600; }
      .x { cursor: pointer; opacity: .85; font-size: 16px; line-height: 1; }
      .bd { padding: 14px; font-size: 13px; line-height: 1.6; }
      .row { display:flex; justify-content:space-between; gap:8px; padding:5px 0; border-bottom:1px dashed #e5e7eb; }
      .row:last-of-type { border-bottom: 0; }
      .k { color:#6b7280; white-space:nowrap; }
      .v { font-family: ui-monospace, Menlo, monospace; font-size: 11px; text-align:right;
           word-break: break-all; color:#111827; }
      .v.bad { color:#dc2626; }
      label { display:block; margin: 9px 0 3px; color:#374151; font-size:12px; }
      input { width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:7px;
              font-size:13px; background:#fff; color:#111827; }
      input:focus { outline:2px solid #93c5fd; outline-offset:-1px; border-color:#3b82f6; }
      .btns { display:flex; gap:8px; margin-top:13px; }
      button { flex:1; padding:8px; border-radius:8px; border:1px solid #d1d5db; background:#f9fafb;
               font-size:13px; cursor:pointer; color:#111827; }
      button.pri { background:#3b82f6; border-color:#3b82f6; color:#fff; font-weight:600; }
      button:hover { filter: brightness(.97); }
      .hint { margin-top:10px; padding:8px 10px; background:#eff6ff; border-radius:7px;
              color:#1e40af; font-size:12px; }
      .warn { background:#fef2f2; color:#991b1b; }
      .step { font-size:15px; font-weight:600; text-align:center; padding:6px 0 2px; }
      .sub { text-align:center; color:#6b7280; font-size:12px; }
    </style>
    <div class="panel"><div class="hd"><span>Auto Login · 設定這個網站</span><span class="x">✕</span></div>
    <div class="bd" id="bd"></div></div>`;

  const bd = root.getElementById("bd");
  root.querySelector(".x").onclick = () => cleanup();

  // ---------- 狀態 ----------
  const sel = { userSel: "", passSel: "", submitSel: "" };
  let userEl = null, passEl = null, submitEl = null;

  const describe = (el) => {
    if (!el) return "（沒找到）";
    const t = el.tagName.toLowerCase() +
      (el.id ? " #" + el.id : "") + (el.name ? " name=" + el.name : "");
    return "&lt;" + esc(t) + "&gt;";
  };

  // ---------- 手動點選 ----------
  const STEPS = [
    { key: "userSel",   name: "帳號欄位",  set: (el) => (userEl = el),   skip: false },
    { key: "passSel",   name: "密碼欄位",  set: (el) => (passEl = el),   skip: false },
    { key: "submitSel", name: "登入按鈕",  set: (el) => (submitEl = el), skip: true  },
  ];

  const pickStep = (i) =>
    new Promise((resolve) => {
      const st = STEPS[i];
      bd.innerHTML =
        `<div class="step">請點一下「${st.name}」</div>` +
        `<div class="sub">第 ${i + 1} / ${STEPS.length} 步</div>` +
        `<div class="hint">滑鼠移到頁面上會highlight，點下去就記住。` +
        (st.skip ? `<br>沒有明確的登入鈕可以<b>按 S 跳過</b>（改用自動偵測）。` : "") +
        `<br>按 <b>Esc</b> 取消整個設定。</div>`;

      const onMove = (e) => {
        if (inPanel(e)) { box(null); return; }
        box(e.composedPath?.()[0] || e.target);
      };
      const onClick = (e) => {
        if (inPanel(e)) return;
        const el = e.composedPath?.()[0] || e.target;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        st.set(el);
        sel[st.key] = AL.buildSelector(el) || "";
        done(); resolve(true);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(); cleanup(); resolve(false); }
        if (st.skip && (e.key === "s" || e.key === "S")) {
          e.preventDefault(); st.set(null); sel[st.key] = ""; done(); resolve(true);
        }
      };
      const done = () => {
        box(null);
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
    });

  const manual = async () => {
    for (let i = 0; i < STEPS.length; i++) {
      const ok = await pickStep(i);
      if (!ok) return;
    }
    showForm();
  };

  // ---------- 確認畫面 ----------
  const showConfirm = () => {
    const d = AL.detect();
    if (d) {
      userEl = d.userEl; passEl = d.passEl; submitEl = d.submitEl;
      sel.userSel   = userEl   ? AL.buildSelector(userEl)   || "" : "";
      sel.passSel   = passEl   ? AL.buildSelector(passEl)   || "" : "";
      sel.submitSel = submitEl ? AL.buildSelector(submitEl) || "" : "";
    }
    bd.innerHTML =
      `<div style="margin-bottom:8px">自動偵測到的欄位：</div>` +
      `<div class="row"><span class="k">帳號</span><span class="v ${userEl ? "" : "bad"}">${describe(userEl)}</span></div>` +
      `<div class="row"><span class="k">密碼</span><span class="v ${passEl ? "" : "bad"}">${describe(passEl)}</span></div>` +
      `<div class="row"><span class="k">登入鈕</span><span class="v ${submitEl ? "" : "bad"}">${describe(submitEl)}</span></div>` +
      (passEl ? `<div class="hint">滑鼠移到上面三列可以看到它 highlight 在頁面哪裡。對的話直接下一步。</div>`
              : `<div class="hint warn">這一頁看不到密碼欄位，可能不是登入頁，或表單還沒 render。可以改用手動點選。</div>`) +
      `<div class="btns">
         <button id="man">手動點選</button>
         <button id="ok" class="pri" ${passEl ? "" : "disabled"}>下一步</button>
       </div>`;

    const map = { 0: userEl, 1: passEl, 2: submitEl };
    [...bd.querySelectorAll(".row")].forEach((r, i) => {
      r.onmouseenter = () => box(map[i]);
      r.onmouseleave = () => box(null);
    });
    bd.querySelector("#man").onclick = manual;
    const ok = bd.querySelector("#ok");
    if (ok && !ok.disabled) ok.onclick = showForm;
  };

  // ---------- 填帳密並儲存 ----------
  const showForm = async () => {
    box(null);
    const { sites = [] } = await chrome.storage.local.get("sites");
    const existing = sites.find((s) => s.host?.toLowerCase() === location.host.toLowerCase());

    bd.innerHTML = `
      <div class="row"><span class="k">網域</span><span class="v">${esc(location.host)}</span></div>
      <label>名稱（自己看的）</label>
      <input id="label" value="${esc((existing?.label || document.title || location.host).slice(0, 60))}">
      <label>帳號</label>
      <input id="u" autocomplete="off" value="${esc(existing?.username || "")}">
      <label>密碼</label>
      <input id="p" type="password" autocomplete="off" value="${esc(existing?.password || "")}">
      <label style="display:flex;align-items:center;gap:7px;margin-top:11px">
        <input type="checkbox" id="auto" style="width:auto" ${existing?.autoSubmit === false ? "" : "checked"}>
        <span>填完自動按登入</span>
      </label>
      <div class="btns"><button id="cancel">取消</button><button id="save" class="pri">儲存</button></div>
      <div class="hint">${existing ? "這個網域已經有設定了，儲存會覆蓋掉。" : "儲存後重新整理這一頁就會自動登入。"}</div>`;

    bd.querySelector("#cancel").onclick = cleanup;
    bd.querySelector("#u").focus();

    bd.querySelector("#save").onclick = async () => {
      const rec = {
        id: existing?.id || (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)),
        label: bd.querySelector("#label").value.trim() || location.host,
        host: location.host,
        pattern: `*://${location.host}/*`,
        urlContains: "",
        username: bd.querySelector("#u").value,
        password: bd.querySelector("#p").value,
        userSel: sel.userSel, passSel: sel.passSel, submitSel: sel.submitSel,
        extra: existing?.extra || null,
        autoSubmit: bd.querySelector("#auto").checked,
        delay: existing?.delay ?? 300,
        enabled: true,
        updatedAt: Date.now(),
      };
      const next = sites.filter((s) => s.id !== rec.id);
      next.push(rec);
      await chrome.storage.local.set({ sites: next });
      // 等 background 真的把 content script 註冊好，不要 fire-and-forget
      let synced = null;
      try { synced = await chrome.runtime.sendMessage({ cmd: "sync" }); } catch {}
      const live = !!synced?.patterns?.some((p) => p.includes(location.host));

      bd.innerHTML = live
        ? `<div class="step">✅ 已儲存並啟用</div>
           <div class="sub">重新整理這一頁就會自動登入</div>
           <div class="btns"><button id="rl" class="pri">重新整理試試</button></div>`
        : `<div class="step">⚠️ 已儲存，但還沒生效</div>
           <div class="sub">這個網域還沒授權，所以不會自動執行</div>
           <div class="hint warn">請點一次瀏覽器右上角的 extension 圖示 →「授權並啟用」，
             允許之後再重新整理這一頁。</div>
           <div class="btns"><button id="rl">關閉</button></div>`;
      bd.querySelector("#rl").onclick = () => { cleanup(); if (live) location.reload(); };
      setTimeout(() => { if (document.getElementById("__al_picker__")) cleanup(); }, 8000);
    };
  };

  showConfirm();
})();
