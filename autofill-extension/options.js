"use strict";

const list  = document.getElementById("list");
const bar   = document.getElementById("bar");
const count = document.getElementById("count");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const load = async () => (await chrome.storage.local.get("sites")).sites || [];
const loadStats = async () => (await chrome.storage.local.get("siteStats")).siteStats || {};
const deriveIdle = (ms) => ms == null ? null : Math.min(4000, Math.max(1000, Math.round(ms * 3 + 800)));
// 每一筆改動都要蓋時間戳，雲端同步的合併完全靠它決定誰比較新
const touch = (s) => { s.updatedAt = Date.now(); return s; };

const save = async (sites) => {
  await chrome.storage.local.set({ sites });
  try { await chrome.runtime.sendMessage({ cmd: "sync" }); } catch {}
};

// 只改單一張卡片的外觀（開關切換時不整頁重畫，免得其他卡片還沒按儲存的輸入被清掉）
function paintCard(card, on, granted) {
  card.classList.toggle("dim", !on);
  card.dataset.granted = granted ? "1" : "0";
  const badge = card.querySelector(".badge");
  if (badge) {
    badge.className = "badge " + (!on ? "off" : granted ? "on" : "need");
    badge.textContent = !on ? "已停用" : granted ? "已啟用" : "未授權";
  }
  const lbl = card.querySelector(".swlbl");
  if (lbl) lbl.textContent = on ? "啟用" : "停用";
  const grantBtn = card.querySelector('button[data-a="grant"]');
  if (grantBtn) grantBtn.hidden = granted;
}

function updateCount(sites) {
  const n = sites.filter((s) => s.enabled !== false).length;
  bar.hidden = !sites.length;
  count.textContent = `共 ${sites.length} 個網站，已啟用 ${n} 個`;
}

async function render() {
  const sites = await load();
  const stats = await loadStats();
  updateCount(sites);
  if (!sites.length) {
    list.innerHTML = `<div class="empty">還沒有任何設定。<br>開啟一個登入頁，點 extension 圖示 →「設定這個網站」。</div>`;
    return;
  }

  const idleHint = (s, stats) => {
    const ms = stats[s.id]?.renderMs;
    return ms == null
      ? "留空＝自動判斷（還沒觀測到登入頁）"
      : `留空＝自動判斷（觀測 ${ms}ms → ${deriveIdle(ms)}ms）`;
  };

  const rows = await Promise.all(sites.map(async (s) => {
    const on = s.enabled !== false;
    const granted = s.pattern ? await chrome.permissions.contains({ origins: [s.pattern] }).catch(() => false) : false;
    const badge = !on      ? '<span class="badge off">已停用</span>'
                : !granted ? '<span class="badge need">未授權</span>'
                :            '<span class="badge on">已啟用</span>';
    return `<div class="card${on ? "" : " dim"}" data-id="${esc(s.id)}"
                 data-pattern="${esc(s.pattern || "")}" data-granted="${granted ? 1 : 0}">
      <div class="top">
        <div><span class="name">${esc(s.label || s.host)}</span>${badge}
             <div class="host">${esc(s.host)}</div></div>
        <div class="swwrap">
          <span class="swlbl">${on ? "啟用" : "停用"}</span>
          <label class="sw" title="在這個網站啟用／停用自動登入">
            <input type="checkbox" data-t="enabled" ${on ? "checked" : ""}>
            <span class="track"></span>
          </label>
        </div>
      </div>
      <div class="grid">
        <label>帳號</label><input type="text" data-f="username" value="${esc(s.username)}">
        <label>密碼</label><input type="password" data-f="password" value="${esc(s.password)}">
        <label>自動送出</label><div><input type="checkbox" data-f="autoSubmit" ${s.autoSubmit === false ? "" : "checked"}></div>
      </div>
      <details><summary>進階（selector、網址過濾、延遲）</summary>
        <div class="grid">
          <label>帳號欄</label><input type="text" data-f="userSel" placeholder="留空＝自動偵測" value="${esc(s.userSel)}">
          <label>密碼欄</label><input type="text" data-f="passSel" placeholder="留空＝自動偵測" value="${esc(s.passSel)}">
          <label>登入鈕</label><input type="text" data-f="submitSel" placeholder="留空＝自動偵測" value="${esc(s.submitSel)}">
          <label>錯誤訊息</label><input type="text" data-f="errorSel" placeholder="留空＝通用偵測。指定後以它為準" value="${esc(s.errorSel)}">
          <label>網址須含</label><input type="text" data-f="urlContains" placeholder="留空＝整個網域都算（建議）" value="${esc(s.urlContains)}">
          <label>送出延遲</label><input type="text" data-f="delay" value="${esc(s.delay ?? 300)}">
          <label>空頁等待</label><input type="text" data-f="idleMs" placeholder="${esc(idleHint(s, stats))}" value="${esc(s.idleMs ?? "")}">
        </div>
      </details>
      <div class="btns">
        <button class="pri" data-a="save">儲存</button>
        <button data-a="grant"${granted ? " hidden" : ""}>授權這個網域</button>
        <button class="dgr" data-a="del">刪除</button>
      </div>
    </div>`;
  }));
  list.innerHTML = rows.join("");
}

// ---------- 單一網站開關 ----------
list.addEventListener("change", async (e) => {
  const el = e.target.closest('input[data-t="enabled"]');
  if (!el) return;
  const card = el.closest(".card");
  const on = el.checked;
  const pattern = card.dataset.pattern;
  let granted = card.dataset.granted === "1";

  // 打開卻還沒授權這個網域時順手要授權。
  // permissions.request 必須在使用者手勢當下呼叫，所以這一步要排在其他 await 之前。
  if (on && !granted && pattern) {
    granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  }

  const sites = await load();
  const i = sites.findIndex((s) => s.id === card.dataset.id);
  if (i < 0) return;
  touch(sites[i]).enabled = on;
  await save(sites);
  paintCard(card, on, granted);
  updateCount(sites);
});

// ---------- 全部啟用／全部停用 ----------
bar.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-all]");
  if (!btn) return;
  const on = btn.dataset.all === "on";

  if (on) {
    // 同樣要在手勢當下呼叫：把所有還沒授權的網域一次要完
    const need = [...list.querySelectorAll('.card[data-granted="0"]')]
      .map((c) => c.dataset.pattern).filter(Boolean);
    if (need.length) await chrome.permissions.request({ origins: [...new Set(need)] }).catch(() => false);
  }

  const sites = await load();
  sites.forEach((s) => { touch(s).enabled = on; });
  await save(sites);
  return render();
});

// ---------- 卡片上的按鈕 ----------
list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-a]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const a = btn.dataset.a;

  if (a === "grant") {
    // 先要授權（使用者手勢當下），再讀設定
    const ok = await chrome.permissions.request({ origins: [card.dataset.pattern] }).catch(() => false);
    if (ok) { try { await chrome.runtime.sendMessage({ cmd: "sync" }); } catch {} }
    return render();
  }

  const sites = await load();
  const i = sites.findIndex((s) => s.id === id);
  if (i < 0) return;

  if (a === "save") {
    card.querySelectorAll("[data-f]").forEach((el) => {
      const f = el.dataset.f;
      if (el.type === "checkbox") sites[i][f] = el.checked;
      else if (f === "delay")  sites[i][f] = Number(el.value) || 300;
      else if (f === "idleMs") {
        const v = el.value.trim();
        if (v === "") delete sites[i][f];              // 留空＝交還給自動判斷
        else sites[i][f] = Math.max(200, Number(v) || 4000);
      }
      else sites[i][f] = el.value;
    });
    touch(sites[i]);
    await save(sites);
    btn.textContent = "已儲存 ✓";
    setTimeout(render, 900);
    return;
  }
  if (a === "del") {
    if (!confirm(`確定刪除「${sites[i].label || sites[i].host}」的設定？`)) return;
    const pattern = sites[i].pattern;
    const { tombstones = [] } = await chrome.storage.local.get("tombstones");
    tombstones.push({ id: sites[i].id, at: Date.now() });
    await chrome.storage.local.set({ tombstones });
    sites.splice(i, 1);
    await save(sites);
    if (pattern && !sites.some((s) => s.pattern === pattern)) {
      try { await chrome.permissions.remove({ origins: [pattern] }); } catch {}
    }
    return render();
  }
});

render();


/* ===================== 雲端同步 ===================== */
const $ = (id) => document.getElementById(id);
const GH_ORIGIN = "https://api.github.com/*";

// 隨機片語（≈158 bits）。字母表去掉 i l o 0 1，手抄不會看錯。
function genPassphrase() {
  const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((n) => ALPHA[n % ALPHA.length]).slice(0, 32).join("").replace(/(.{4})(?=.)/g, "$1-");
}

const ago = (t) => {
  if (!t) return "從來沒有";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
};

async function syncRender() {
  // background 可能整個沒起來（service worker 掛掉時 sendMessage 會 resolve(undefined) 而不是丟錯），
  // 所以不能假設一定拿得到東西 —— 拿不到就退回直接讀 storage，畫面至少是對的
  let st = null, why = "";
  try { st = await chrome.runtime.sendMessage({ cmd: "syncStatus" }); }
  catch (e) { why = e.message; }
  if (!st || !st.ok) {
    const { sync = {} } = await chrome.storage.local.get("sync");
    st = { ok: false, degraded: true, enabled: !!sync.enabled, gistId: sync.gistId || "",
           rev: sync.rev || 0, lastOk: sync.lastOk || 0, lastError: sync.lastError || "",
           lastErrorAt: sync.lastErrorAt || 0, hasRescue: !!sync.hasRescue, granted: false };
    $("syncStat").innerHTML =
      `<span class="err">背景服務沒有回應${why ? "：" + esc(why) : "（沒有回傳值）"}</span>` +
      `　·　到 chrome://extensions 點 Auto Login 的「service worker」看 console 的紅字`;
  }

  $("syncForm").hidden = !!st.enabled;
  $("syncOn").hidden = !st.enabled;

  if (st.degraded) return;
  if (!st.enabled) {
    $("syncStat").textContent = "目前沒有同步，設定只存在這台機器。";
    return;
  }

  const bits = [
    `<span class="ok">已啟用</span>`,
    `gist <span class="mono">${esc(st.gistId)}</span>`,
    `rev ${st.rev}`,
    `上次成功：${ago(st.lastOk)}`,
    st.hasRescue ? "救援片語：已設定" : "救援片語：未設定",
  ];
  if (!st.granted) bits.push(`<span class="err">未授權 api.github.com</span>`);
  if (st.lastError) bits.push(`<span class="err">上次錯誤（${ago(st.lastErrorAt)}）：${esc(st.lastError)}</span>`);
  $("syncStat").innerHTML = bits.join("　·　");
  $("rescueToggle").textContent = st.hasRescue ? "換一組救援片語" : "設定救援片語";
}

const eye = (id) => () => { $(id).type = $(id).type === "password" ? "text" : "password"; };
$("syncEye").addEventListener("click", eye("syncPass"));
$("rescueEye").addEventListener("click", eye("rescuePass"));

// 第一台：只要 PAT。DEK 隨機產，第二台靠發卡拿，所以這裡沒有片語要打
$("syncGo").addEventListener("click", async () => {
  const token = $("syncToken").value.trim();
  if (!token) { $("syncStat").innerHTML = '<span class="err">請先填 PAT。</span>'; return; }

  // permissions.request 必須在使用者手勢當下呼叫 —— 排在所有 await 之前
  const okPerm = await chrome.permissions.request({ origins: [GH_ORIGIN] }).catch(() => false);
  if (!okPerm) { $("syncStat").innerHTML = '<span class="err">沒有授權 api.github.com 就沒辦法同步。</span>'; return; }

  $("syncGo").disabled = true;
  $("syncStat").textContent = "建立 gist 中…";
  const r = await chrome.runtime.sendMessage({ cmd: "syncSetup", args: { mode: "create", token } })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("syncGo").disabled = false;
  if (!r || !r.ok) { $("syncStat").innerHTML = `<span class="err">${esc(r?.error || "沒有回應")}</span>`; return; }
  $("syncToken").value = "";
  await syncRender(); await idRender(); await render();
});

// 救援路線：只有設過救援片語的 gist 走得通
$("joinGo").addEventListener("click", async () => {
  const args = {
    mode: "join",
    token: $("syncToken").value.trim(),
    gistId: $("syncGist").value.trim().replace(/^.*\//, ""),
    passphrase: $("syncPass").value.trim(),
  };
  if (!args.token || !args.gistId || !args.passphrase) {
    $("syncStat").innerHTML = '<span class="err">PAT、gist id、救援片語三個都要填。</span>'; return;
  }
  const okPerm = await chrome.permissions.request({ origins: [GH_ORIGIN] }).catch(() => false);
  if (!okPerm) { $("syncStat").innerHTML = '<span class="err">沒有授權 api.github.com 就沒辦法同步。</span>'; return; }

  $("joinGo").disabled = true;
  $("syncStat").textContent = "下載並解密中…";
  const r = await chrome.runtime.sendMessage({ cmd: "syncSetup", args })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("joinGo").disabled = false;
  if (!r || !r.ok) { $("syncStat").innerHTML = `<span class="err">${esc(r?.error || "沒有回應")}</span>`; return; }
  $("syncToken").value = $("syncPass").value = $("syncGist").value = "";
  await syncRender(); await idRender(); await render();
});

$("rescueToggle").addEventListener("click", () => {
  $("rescueBox").hidden = !$("rescueBox").hidden;
});

$("rescueGen").addEventListener("click", () => {
  $("rescuePass").type = "text";
  $("rescuePass").value = genPassphrase();
  $("syncStat").innerHTML = '<span class="err">先把這串存進密碼管理器，再按「存進 gist」。</span>';
});

$("rescueSave").addEventListener("click", async () => {
  const passphrase = $("rescuePass").value.trim();
  if (!passphrase) { $("syncStat").innerHTML = '<span class="err">還沒填救援片語。</span>'; return; }
  $("rescueSave").disabled = true;
  $("syncStat").textContent = "寫進 gist 中…";
  const r = await chrome.runtime.sendMessage({ cmd: "setRescue", args: { passphrase } })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("rescueSave").disabled = false;
  if (!r || !r.ok) { $("syncStat").innerHTML = `<span class="err">${esc(r?.error || "沒有回應")}</span>`; return; }
  $("rescuePass").value = ""; $("rescuePass").type = "password";
  $("rescueBox").hidden = true;
  await syncRender();
});

$("syncNow").addEventListener("click", async () => {
  $("syncNow").disabled = true;
  $("syncStat").textContent = "同步中…";
  const r = await chrome.runtime.sendMessage({ cmd: "syncNow", reason: "manual" })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("syncNow").disabled = false;
  if (!r || !r.ok) { $("syncStat").innerHTML = `<span class="err">${esc(r?.error || "沒有回應")}</span>`; return; }
  await syncRender(); await render();
});

$("syncCopy").addEventListener("click", async () => {
  const st = await chrome.runtime.sendMessage({ cmd: "syncStatus" }).catch(() => null);
  await navigator.clipboard.writeText(st?.gistId || "");
  $("syncCopy").textContent = "已複製 ✓";
  setTimeout(() => ($("syncCopy").textContent = "複製 gist id"), 1200);
});

$("syncOff").addEventListener("click", async () => {
  if (!confirm("停用這台機器的同步？\n\ngist 會留著（其他機器還在用），本機設定也不會動。")) return;
  await chrome.runtime.sendMessage({ cmd: "syncDisable" }).catch(() => {});
  await syncRender();
  await idRender();
});

syncRender();

/* ===================== 備份與轉移（加密檔） ===================== */
const loadTombs = async () => (await chrome.storage.local.get("tombstones")).tombstones || [];

$("expGo").addEventListener("click", async () => {
  const data = { sites: await load(), tombstones: await loadTombs() };

  if ($("expCreds").checked) {
    const { sync } = await chrome.storage.local.get("sync");
    if (sync?.enabled && sync.token && sync.gistId && sync.dek) {
      // 同一組 PAT 在幾台機器上一起用沒問題，gist scope 本來就是讀+寫
      data.sync = { token: sync.token, gistId: sync.gistId, dek: sync.dek, salt: sync.salt || "" };
    }
  }

  const code = AL_TRANSFER.genCode();
  let file;
  try { file = await AL_TRANSFER.makeFile(code, data); }
  catch (e) { $("impStat").innerHTML = `<span class="err">匯出失敗：${esc(e.message)}</span>`; return; }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `autologin-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);

  $("expCode").value = code;
  $("expOut").hidden = false;
  $("expCode").select();
});

$("expCopy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("expCode").value);
  $("expCopy").textContent = "已複製 ✓";
  setTimeout(() => ($("expCopy").textContent = "複製"), 1200);
});

$("impEye").addEventListener("click", () => {
  $("impCode").type = $("impCode").type === "password" ? "text" : "password";
});

// 讀檔跟套用要分兩步：permissions.request 必須在使用者手勢當下呼叫，
// 而解密（PBKDF2 600k）會吃掉幾百毫秒，擠在同一個點擊裡會撞到手勢失效。
// 分兩步順便讓你先看清楚會被改動什麼。
let staged = null;

$("impRead").addEventListener("click", async () => {
  staged = null;
  $("impApplyBox").hidden = true;
  const f = $("impFile").files?.[0];
  const code = $("impCode").value.trim();
  if (!f)    { $("impStat").innerHTML = '<span class="err">先選一個匯出檔。</span>'; return; }
  if (!code) { $("impStat").innerHTML = '<span class="err">還沒填轉移碼。</span>'; return; }

  $("impStat").textContent = "解密中…";
  let data;
  try {
    data = await AL_TRANSFER.openFile(code, JSON.parse(await f.text()));
  } catch (e) {
    $("impStat").innerHTML = `<span class="err">${esc(e.message)}</span>`;
    return;
  }

  const local = { sites: await load(), tombstones: await loadTombs() };
  const merged = AL_TRANSFER.mergeAll(local, data);
  const pv = AL_TRANSFER.preview(local, merged);

  // 需要授權的網域：合併後所有站台，加上要接同步的話的 api.github.com
  const origins = [...new Set(merged.sites.map((s) => s.pattern).filter(Boolean))];
  if (data.sync) origins.push("https://api.github.com/*");
  const missing = [];
  for (const o of origins) {
    if (!(await chrome.permissions.contains({ origins: [o] }).catch(() => false))) missing.push(o);
  }

  staged = { data, merged, missing };
  const bits = [`共 ${pv.total} 筆`, `新增 ${pv.added}`, `更新 ${pv.changed}`];
  if (pv.removed) bits.push(`<span class="err">移除 ${pv.removed}（對方刪過）</span>`);
  if (data.sync) bits.push('<span class="ok">檔案含同步憑證 → 會一併接上 gist</span>');
  if (missing.length) bits.push(`套用時要授權 ${missing.length} 個網域`);
  $("impStat").innerHTML = bits.join("　·　");
  $("impApplyBox").hidden = false;
});

$("impApply").addEventListener("click", async () => {
  if (!staged) return;
  // 第一個 await 就要是 permissions.request，手勢才還在
  let ok = true;
  if (staged.missing.length) ok = await chrome.permissions.request({ origins: staged.missing }).catch(() => false);

  await chrome.storage.local.set({
    sites: staged.merged.sites,
    tombstones: staged.merged.tombstones,
  });

  if (staged.data.sync) {
    await chrome.storage.local.set({ sync: { enabled: true, ...staged.data.sync } });
    await chrome.runtime.sendMessage({ cmd: "syncNow", reason: "import" }).catch(() => {});
  }
  try { await chrome.runtime.sendMessage({ cmd: "sync" }); } catch {}

  $("impStat").innerHTML = ok
    ? '<span class="ok">已套用 ✓</span>　·　記得把匯出檔刪掉'
    : '<span class="err">設定已套用，但你沒有授權那些網域 —— 卡片會顯示「未授權」，之後可以個別按。</span>';
  $("impApplyBox").hidden = true;
  $("impFile").value = $("impCode").value = "";
  staged = null;
  await syncRender();
  await render();
});

/* ===================== 裝置金鑰（發卡） ===================== */
const GH_ORIGINS = ["https://api.github.com/*", "https://gist.githubusercontent.com/*"];

async function idRender() {
  const me = await chrome.runtime.sendMessage({ cmd: "identity" }).catch((e) => ({ ok: false, error: e.message }));
  if (!me || !me.ok) {
    $("idStat").innerHTML = `<span class="err">裝置金鑰讀不到${me?.error ? "：" + esc(me.error) : "（背景服務沒回應）"}</span>`;
    $("issueBox").hidden = $("claimBox").hidden = true;
    return;
  }
  $("myFp").textContent = me.fp;
  $("myPub").value = me.pub;

  // 已經接上同步的機器負責發卡；還沒接上的負責接卡
  const st = await chrome.runtime.sendMessage({ cmd: "syncStatus" }).catch(() => null);
  const on = !!(st && st.ok && st.enabled);
  $("issueBox").hidden = !on;    // 已接上同步的機器 → 負責發卡
  $("claimBox").hidden = on;     // 還沒接上的 → 負責接卡
}

$("myCopy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("myPub").value);
  $("myCopy").textContent = "已複製 ✓";
  setTimeout(() => ($("myCopy").textContent = "複製公鑰"), 1200);
});

// 貼上公鑰就即時算指紋 —— 這一眼是整個流程唯一的防線，
// 擋的是「有人把公鑰換成自己的」，換掉你就把 PAT 加密給攻擊者了
$("peerPub").addEventListener("input", async () => {
  const v = $("peerPub").value.trim();
  if (!v) { $("peerFp").textContent = "—"; return; }
  try { $("peerFp").textContent = await AL_ID.fingerprintOf(v); }
  catch { $("peerFp").textContent = "（不是合法公鑰）"; }
});

$("issueGo").addEventListener("click", async () => {
  const pub = $("peerPub").value.trim();
  if (!pub) { $("idStat").innerHTML = '<span class="err">先貼上對方的公鑰。</span>'; return; }
  $("issueGo").disabled = true;
  $("idStat").textContent = "封裝並寫進 gist 中…";
  const r = await chrome.runtime.sendMessage({ cmd: "enrollIssue", args: { pub } })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("issueGo").disabled = false;
  if (!r?.ok) { $("idStat").innerHTML = `<span class="err">${esc(r?.error || "失敗")}</span>`; return; }
  $("idStat").innerHTML =
    `<span class="ok">已發卡給 ${esc(r.fp)} ✓</span>　·　發卡檔 24 小時後自己清掉`;
  if (r.rawUrl) {
    $("issueUrl").value = r.rawUrl;
    $("issueUrlBox").hidden = false;
  }
  $("peerPub").value = ""; $("peerFp").textContent = "—";
});

$("issueUrlCopy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("issueUrl").value);
  $("issueUrlCopy").textContent = "已複製 ✓";
  setTimeout(() => ($("issueUrlCopy").textContent = "複製"), 1200);
});

$("claimGo").addEventListener("click", async () => {
  const gistId = $("claimGist").value.trim().replace(/^.*\//, "");
  const rawBlob = $("claimBlob").value.trim();
  if (!gistId && !rawBlob) { $("idStat").innerHTML = '<span class="err">貼 gist id 或發卡檔內容。</span>'; return; }

  // permissions.request 必須在使用者手勢當下 —— 排在所有 await 之前
  const ok = await chrome.permissions.request({ origins: GH_ORIGINS }).catch(() => false);
  if (!ok) { $("idStat").innerHTML = '<span class="err">沒授權 api.github.com 就抓不到發卡檔。</span>'; return; }

  let blob = null;
  if (rawBlob) {
    try { blob = JSON.parse(rawBlob); }
    catch { $("idStat").innerHTML = '<span class="err">發卡檔不是合法 JSON。</span>'; return; }
  }

  $("claimGo").disabled = true;
  $("idStat").textContent = "解卡中…";
  const r = await chrome.runtime.sendMessage({ cmd: "enrollClaim", args: { gistId, blob } })
                  .catch((e) => ({ ok: false, error: e.message }));
  $("claimGo").disabled = false;

  if (!r?.ok) { $("idStat").innerHTML = `<span class="err">${esc(r.error || "失敗")}</span>`; return; }
  $("idStat").innerHTML = `<span class="ok">已接上，同步到 ${r.count} 筆設定 ✓</span>　·　各網域的授權在卡片上個別按`;
  $("claimGist").value = $("claimBlob").value = "";
  await idRender();
  await syncRender();
  await render();
});

idRender();

/* ===================== 程式碼版本 ===================== */
// MV3 不准 extension 改自己的檔案，所以程式碼沒辦法跟設定一起同步。
// 這裡只做兩件事：磁碟上有新版就讓你一鍵套用；別台比較新就告訴你該 git pull。
async function codeRender() {
  const bar = $("codeBar");
  const r = await chrome.runtime.sendMessage({ cmd: "codeCheck" }).catch(() => null);
  const { sync = {} } = await chrome.storage.local.get("sync");
  const group = sync.groupVersion || "";
  const loaded = r?.loaded || "?";

  const cmp = (a, b) => {
    const pa = String(a || "0").split("."), pb = String(b || "0").split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
      if (d) return d;
    }
    return 0;
  };

  if (r?.stale) {
    bar.innerHTML = `<div>磁碟上已經是 <b>${esc(r.disk)}</b>，目前跑的還是 <b>${esc(loaded)}</b>
      —— git pull 已經換好檔案了，重載一次就生效。</div>
      <button class="pri" id="codeApply">立即套用</button>`;
    bar.hidden = false;
    $("codeApply").addEventListener("click", async () => {
      $("codeApply").textContent = "重載中…";
      await chrome.runtime.sendMessage({ cmd: "codeReload" }).catch(() => {});
      setTimeout(() => location.reload(), 900);
    });
    return;
  }

  if (group && cmp(loaded, group) < 0) {
    bar.innerHTML = `<div>同步群組裡已經有 <b>${esc(group)}</b>，這台是 <b>${esc(loaded)}</b>
      —— 等排程 git pull，或自己在 repo 跑一次 <code>git pull</code>。</div>`;
    bar.hidden = false;
    return;
  }

  bar.hidden = true;
}

codeRender();
