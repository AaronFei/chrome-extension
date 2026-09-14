/* Auto Login — background service worker
 * 1. 依照 chrome.storage 裡的設定，動態註冊 content script（只註冊到有授權的網域）
 * 2. 第一次安裝時，把舊的 credentials.js 匯進 storage
 */
"use strict";

// 舊版設定檔（如果還在的話）。匯入完就可以刪掉這個檔。
try { importScripts("credentials.js"); } catch (e) { /* 沒有就算了 */ }

importScripts("lib/crypto.js", "lib/identity.js", "lib/sync.js");

const SCRIPT_ID = "autologin";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const loadSites = async () => (await chrome.storage.local.get("sites")).sites || [];

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
  const sites = await loadSites();
  let changed = false;
  for (const s of sites) {
    const want = s.host ? `*://${s.host}/*` : s.pattern;
    if (want && s.pattern !== want) { s.pattern = want; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ sites });
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
    const existing = await loadSites();
    if (!existing.length) {
      const seeded = fromLegacy();
      if (seeded.length) {
        await chrome.storage.local.set({ sites: seeded });
        console.log("[AutoLogin] 已從 credentials.js 匯入", seeded.length, "筆設定");
      }
    }
  }
  await syncRegistration();
  maybeSync("installed");
});

chrome.runtime.onStartup.addListener(() => { syncRegistration(); maybeSync("startup"); });
chrome.permissions.onAdded.addListener(syncRegistration);
chrome.permissions.onRemoved.addListener(syncRegistration);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
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
  const conf = (await chrome.storage.local.get("sync")).sync || {};
  if (!conf.enabled) return;
  if (reason === "local-change") {
    const cur = {
      sites: (await chrome.storage.local.get("sites")).sites || [],
      tombstones: (await chrome.storage.local.get("tombstones")).tombstones || [],
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
    case "debug":       return run(async () => ({
      ok: true,
      registered: await chrome.scripting.getRegisteredContentScripts().catch((e) => String(e)),
      grantedOrigins: (await chrome.permissions.getAll()).origins || [],
      sites: (await loadSites()).map((s) => ({
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
