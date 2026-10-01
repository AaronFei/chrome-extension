/* Auto Login — background service worker
 * 1. 依照 chrome.storage 裡的設定，動態註冊 content script（只註冊到有授權的網域）
 * 2. 第一次安裝時，把舊的 credentials.js 匯進 storage
 */
"use strict";

// 舊版設定檔（如果還在的話）。匯入完就可以刪掉這個檔。
try { importScripts("credentials.js"); } catch (e) { /* 沒有就算了 */ }

importScripts("lib/crypto.js", "lib/vault.js", "lib/groups.js", "lib/identity.js", "lib/sync.js");

// sites / tombstones / sync 一律經過 STORE：沒開鎖 = storage.local，開了鎖 = 記憶體裡的工作副本 + 密文寫回
const STORE = AL_VAULT.store;

const SCRIPT_ID = "autologin";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const loadSites = async () => (await STORE.get("sites")).sites || [];
// 鎖著的時候還是要知道「有哪些網域」才能註冊 content script —— 用不含帳密的 siteIndex
const loadSitesOrIndex = async () => {
  try { return await loadSites(); }
  catch (e) { if (e.locked) return AL_VAULT.siteIndex(); throw e; }
};

// ---------- 從舊的 credentials.js 匯入 ----------
function fromLegacy() {
  const legacy = self.__AUTOFILL_SITES__;
  if (!Array.isArray(legacy) || !legacy.length) return [];
  return legacy.map((s) => {
    const raw = Array.isArray(s.match) ? s.match[0] : s.match;
    const str = typeof raw === "string" ? raw : (raw && raw.source) || "";
    const bare = str.replace(/^https?:\/\//, "").replace(/\\/g, "");
    const host = bare.split("/")[0];
    return {
      id: uid(),
      label: host,
      host,
      pattern: `*://${host}/*`,
      // 舊版把路徑寫進 match 是 bug 來源（根網址就比不中），匯入時只留網域
      urlContains: "",
      username: s.username || "",
      password: s.password || "",
      userSel: s.userSel || "",
      passSel: s.passSel || "",
      submitSel: s.submitSel || "",
      extra: s.extra || null,
      autoSubmit: s.autoSubmit !== false,
      delay: typeof s.delay === "number" ? s.delay : 300,
      enabled: true,
    };
  }).filter((s) => s.host);
}

// ---------- 動態註冊 content script ----------
// 舊資料可能存成 https://host/*，統一成 *://host/*，
// 否則 permissions.contains() 會比不中
async function normalizePatterns() {
  if ((await AL_VAULT.state()) === "locked") return AL_VAULT.siteIndex();
  const sites = await loadSites();
  let changed = false;
  for (const s of sites) {
    const want = s.host ? `*://${s.host}/*` : s.pattern;
    if (want && s.pattern !== want) { s.pattern = want; changed = true; }
  }
  if (changed) await STORE.set({ sites });
  return sites;
}

// 好幾個事件可能同時觸發同步（permissions.onAdded + storage.onChanged + 訊息），
// 而同步的內容是「先 unregister 再 register」。兩個同時跑會互相蓋掉，
// 結果就是註冊清單停在舊的狀態。所以這裡串成一條 chain，一次只跑一個。
let syncChain = Promise.resolve();
function syncRegistration() {
  syncChain = syncChain.then(doSync, doSync);
  return syncChain;
}

async function doSync() {
  const sites = (await normalizePatterns()).filter((s) => s.enabled !== false && s.pattern);

  const patterns = [];
  for (const s of sites) {
    try {
      if (await chrome.permissions.contains({ origins: [s.pattern] })) patterns.push(s.pattern);
    } catch (e) {
      console.warn("[AutoLogin] pattern 無效，略過：", s.pattern, e);
    }
  }
  const wanted = [...new Set(patterns)];

  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch {}
  if (!wanted.length) {
    console.log("[AutoLogin] 沒有已授權的網域，未註冊 content script");
    return [];
  }

  try {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: wanted,
      js: ["lib/selector.js", "content.js"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    }]);
    console.log("[AutoLogin] 已註冊 content script：", wanted.join(", "));
  } catch (e) {
    console.error("[AutoLogin] registerContentScripts 失敗：", e, wanted);
    return [];
  }
  return wanted;
}

// ---------- 事件 ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") {
    const existing = await loadSitesOrIndex();
    if (!existing.length && (await AL_VAULT.state()) !== "locked") {
      const seeded = fromLegacy();
      if (seeded.length) {
        await STORE.set({ sites: seeded });
        console.log("[AutoLogin] 已從 credentials.js 匯入", seeded.length, "筆設定");
      }
    }
  }
  await syncRegistration();
  maybeSync("installed");
});

chrome.runtime.onStartup.addListener(() => { syncRegistration(); maybeSync("startup"); updateBadge(); });
chrome.permissions.onAdded.addListener(syncRegistration);
chrome.permissions.onRemoved.addListener(syncRegistration);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.lockKey) updateBadge();
  if (area === "local" && changes.lock) updateBadge();
  if (area !== "local" && area !== "session") return;
  if (changes.sites) syncRegistration();
  if (changes.sites || changes.tombstones) schedulePush();
});

// ---------- 雲端同步的觸發 ----------
// 本機改動後推上去。debounce 是因為「儲存」那一下常常連帶好幾次寫入。
// 注意：套用遠端資料也會寫 sites，所以要靠 lastHash 判斷這次改動是不是自己造成的，
// 否則 pull → 寫入 → 推回去 → 又 pull，會自己跟自己打乒乓。
let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => maybeSync("local-change"), 4000);
}

async function maybeSync(reason) {
  if ((await AL_VAULT.state()) === "locked") return;   // 鎖著就沒有 PAT / DEK，等解鎖
  const conf = (await STORE.get("sync")).sync || {};
  if (!conf.enabled) return;
  if (reason === "local-change") {
    const cur = {
      sites: (await STORE.get("sites")).sites || [],
      tombstones: (await STORE.get("tombstones")).tombstones || [],
    };
    if ((await stateHash(cur)) === conf.lastHash) return;   // 這是剛套用下來的遠端資料，不是本機改的
  }
  await syncNow(reason);
}

// ---------- 程式碼更新 ----------
// MV3 三道鎖：不能載遠端 script、不能 eval 下載的字串、不能改自己的檔案。
// 所以程式碼沒辦法跟著設定一起同步 —— 檔案只能由 extension 以外的東西（git pull）換掉。
// extension 這邊唯一能做的是「發現磁碟上的檔案換了，就把自己重載」。
//
// 訊號用 manifest.json 本身：
//   chrome.runtime.getManifest() = 載入當下那一份（記憶體）
//   fetch(chrome.runtime.getURL(...)) = 磁碟上現在那一份
// 兩個不一樣 → git pull 已經換好檔案了 → reload 一次就會一樣。
// 天然不會無限重載：重載完兩邊就相等了。
async function diskVersion() {
  try {
    const r = await fetch(chrome.runtime.getURL("manifest.json") + "?t=" + Date.now(), { cache: "no-store" });
    return (await r.json()).version || "";
  } catch { return ""; }
}

async function codeCheck() {
  const loaded = chrome.runtime.getManifest().version;
  const disk = await diskVersion();
  return { ok: true, loaded, disk, stale: !!disk && disk !== loaded };
}

async function maybeReloadForCode() {
  const { stale, loaded, disk } = await codeCheck();
  if (!stale) return;

  // 有人正在看管理頁／popup 的話先不要重載 —— 重載會把那個分頁整個殺掉
  try {
    const views = await chrome.runtime.getContexts({ contextTypes: ["TAB", "POPUP"] });
    if (views.length) {
      console.log(`[AutoLogin] 磁碟上是 ${disk}（目前 ${loaded}），但有頁面開著，等它關掉再重載`);
      return;
    }
  } catch { /* 舊版 Chrome 沒有 getContexts，那就直接重載 */ }

  console.log(`[AutoLogin] 偵測到新版 ${disk}（目前 ${loaded}），重新載入 extension`);
  chrome.runtime.reload();
}

// service worker 隨時會被回收，setTimeout 不保證燒得到 —— alarm 才是撐得住的那個
chrome.alarms.create("autologin-sync", { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "autologin-sync") return;
  maybeSync("alarm");
  maybeReloadForCode();
});

// 一律回一個東西。以前是「沒有 if 命中就什麼都不回」，
// 而 sendMessage 拿不到回應時是 resolve(undefined) 不是丟錯 ——
// 呼叫端就 st.enabled 爆 TypeError，而真正的原因（哪個指令、哪個函式掛了）完全看不到。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = (fn) => {
    try {
      Promise.resolve(fn())
        .then((r) => sendResponse(r === undefined ? { ok: true } : r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    } catch (e) {
      // 同步就炸掉的情況（例如某個函式根本沒載進來）
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  };

  switch (msg && msg.cmd) {
    case "sync":        return run(async () => ({ ok: true, patterns: await syncRegistration() }));
    case "syncSetup":   return run(() => syncSetup(msg.args || {}));
    case "syncNow":     return run(() => syncNow(msg.reason || "manual"));
    case "syncStatus":  return run(() => syncStatus());
    case "codeCheck":   return run(() => codeCheck());
    case "codeReload":  return run(async () => { setTimeout(() => chrome.runtime.reload(), 100); return { ok: true }; });
    case "syncDisable": return run(() => syncDisable());
    case "setRescue":   return run(() => setRescue(msg.args || {}));
    case "identity":    return run(async () => ({ ok: true, ...(await AL_ID.me()) }));
    case "enrollIssue": return run(() => enrollIssue(msg.args || {}));
    case "enrollClaim": return run(() => enrollClaim(msg.args || {}));
    // ---- 給 content script / picker 的窄介面：只回「發問那個分頁的網域」的資料 ----
    case "siteFor":     return run(() => siteFor(sender));
    case "pickerLoad":  return run(() => pickerLoad(sender));
    case "pickerSave":  return run(() => pickerSave(sender, msg.rec));
    case "openUnlock":  return run(() => openUnlock(msg.tabId || (sender.tab && sender.tab.id), msg.reason));
    case "unlocked":    return run(() => afterUnlock(msg.tabId));
    case "lockNow":     return run(async () => { await AL_VAULT.lockNow(); return { ok: true }; });
    case "vaultInfo":   return run(async () => ({ ok: true, ...(await AL_VAULT.info()) }));
    case "debug":       return run(async () => ({
      ok: true,
      registered: await chrome.scripting.getRegisteredContentScripts().catch((e) => String(e)),
      grantedOrigins: (await chrome.permissions.getAll()).origins || [],
      lock: await AL_VAULT.info(),
      sites: (await loadSitesOrIndex()).map((s) => ({
        label: s.label, host: s.host, pattern: s.pattern, enabled: s.enabled !== false,
      })),
      loaded: {
        crypto: typeof AL_CRYPTO, identity: typeof AL_ID,
        syncStatus: typeof syncStatus, enrollIssue: typeof enrollIssue,
      },
    }));
  }
  sendResponse({ ok: false, error: `background 不認得這個指令：${msg && msg.cmd}` });
  return false;
});


// ================= 本機加密（passkey 鎖） =================
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

// content script 跑在網頁的 renderer 裡，不給它整份 sites，只給這個網域的
async function siteFor(sender) {
  const host = hostOf(sender && sender.url);
  if (!host) return { ok: false, error: "不明的來源" };
  const { siteStats = {} } = await chrome.storage.local.get("siteStats");
  if ((await AL_VAULT.state()) === "locked") {
    const idx = (await AL_VAULT.siteIndex()).filter((s) => s.enabled && s.host.toLowerCase() === host);
    return { ok: true, locked: true, index: idx, siteStats: {} };
  }
  const sites = (await loadSites()).filter((s) => (s.host || "").toLowerCase() === host);
  const stats = Object.fromEntries(sites.filter((s) => siteStats[s.id]).map((s) => [s.id, siteStats[s.id]]));
  return { ok: true, locked: false, sites, siteStats: stats };
}

async function pickerLoad(sender) {
  const host = hostOf(sender && sender.url);
  if ((await AL_VAULT.state()) === "locked") return { ok: true, locked: true };
  const sites = await loadSites();
  const existing = sites.find((s) => (s.host || "").toLowerCase() === host) || null;
  const G = self.AL_GROUPS;
  const grpN = existing && G && G.key(existing.credGroup)
    ? sites.filter((s) => G.key(s.credGroup) === G.key(existing.credGroup)).length : 0;
  return { ok: true, locked: false, existing, grpN };
}

async function pickerSave(sender, rec) {
  const host = hostOf(sender && sender.url);
  if (!rec || (rec.host || "").toLowerCase() !== host) return { ok: false, error: "網域對不上，拒絕寫入" };
  const sites = await loadSites();
  const existing = sites.find((s) => s.id === rec.id);
  const next = sites.filter((s) => s.id !== rec.id);
  next.push(rec);
  const G = self.AL_GROUPS;
  if (existing && G && G.key(rec.credGroup) &&
      (rec.username !== existing.username || rec.password !== existing.password)) {
    G.applyToGroup(next, rec.credGroup, { username: rec.username, password: rec.password });
  }
  await STORE.set({ sites: next });
  return { ok: true, patterns: await syncRegistration() };
}

// WebAuthn 不能在 service worker 跑，popup 又一失焦就關 —— 所以開一個小視窗
let unlockWin = null;
async function openUnlock(tabId, reason) {
  // 先試著直接打開工具列上的 popup（Chrome 127+）—— 解鎖就在那裡做，跟錢包一樣。
  // 打不開（舊版 Chrome、視窗沒焦點、icon 被收進拼圖選單）才退回獨立小視窗。
  try {
    const tab = tabId ? await chrome.tabs.get(Number(tabId)) : null;
    await chrome.action.openPopup(tab ? { windowId: tab.windowId } : {});
    return { ok: true, via: "popup" };
  } catch (e) {
    console.log("[AutoLogin] openPopup 不行，改開小視窗：", e && e.message);
  }
  if (unlockWin) {
    try { await chrome.windows.update(unlockWin, { focused: true }); return { ok: true }; } catch { unlockWin = null; }
  }
  const q = new URLSearchParams({ tab: tabId ? String(tabId) : "", reason: reason || "" });
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL("unlock.html?" + q), type: "popup", width: 420, height: 360, focused: true,
  });
  unlockWin = w.id;
  return { ok: true };
}
chrome.windows.onRemoved.addListener((id) => { if (id === unlockWin) unlockWin = null; });

// 解鎖後：把剛剛卡住的那一頁重新跑一次 content script，並補做鎖著時跳過的同步
async function afterUnlock(tabId) {
  updateBadge();
  syncRegistration();
  maybeSync("unlock");
  if (tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ["lib/selector.js", "content.js"] });
    } catch (e) { console.warn("[AutoLogin] 解鎖後重跑 content script 失敗：", e); }
  }
  return { ok: true };
}

async function updateBadge() {
  const st = await AL_VAULT.state().catch(() => "off");
  await chrome.action.setBadgeText({ text: st === "locked" ? "🔒" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  await chrome.action.setTitle({ title: st === "locked" ? "Auto Login（已鎖定，點開解鎖）" : "Auto Login" });
}
updateBadge();
