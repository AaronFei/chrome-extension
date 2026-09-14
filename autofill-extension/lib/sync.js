/* Auto Login — GitHub Gist 加密同步（只在 service worker 裡跑）
 *
 * gist 上的東西長這樣（v/kdf/rev 以外全部是密文，連你在哪些站有帳號都看不到）：
 *   { v, kdf{alg,iters,salt}, wrappedKey{iv,ct}, payload{iv,ct}, rev, updatedAt }
 *
 * secret gist 不等於 private —— 拿到網址就讀得到，只是不列在 profile。
 * 所以加密不是加分項，是前提。
 */
"use strict";

const SYNC_FILE = "autologin.json";
const GH_API    = "https://api.github.com";
const GH_ORIGIN = "https://api.github.com/*";
const KDF_ITERS = 600000;
const TOMB_MS   = 90 * 86400 * 1000;   // 墓碑保留 90 天
const BLOB_V    = 1;

// 同步群組裡看過的最高程式碼版本。程式碼本身不會跟著同步（MV3 禁止），
// 但至少要讓「這台落後了」變成看得見的東西，而不是等格式對不上才發現。
const myVersion = () => { try { return chrome.runtime.getManifest().version; } catch { return "0.0.0"; } };
const cmpVer = (a, b) => {
  const pa = String(a || "0").split("."), pb = String(b || "0").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return 0;
};
const maxVer = (a, b) => (cmpVer(a, b) >= 0 ? a : b);
const ENROLL_PRE = "enroll-";
const ENROLL_TTL = 24 * 3600 * 1000;   // 發卡檔放超過一天就自己清掉

const syncConf = async () => (await chrome.storage.local.get("sync")).sync || {};
const syncSave = async (patch) => {
  const next = { ...(await syncConf()), ...patch };
  await chrome.storage.local.set({ sync: next });
  return next;
};
const loadTombs = async () => (await chrome.storage.local.get("tombstones")).tombstones || [];

// ---------- GitHub API ----------
async function gh(path, { token, method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(GH_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("連不到 GitHub（網路或公司防火牆）：" + e.message);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const msg = res.status === 401 ? "PAT 無效或已過期"
              : res.status === 403 ? "被 GitHub 拒絕（PAT 少了 gist scope，或觸發速率限制）"
              : res.status === 404 ? "找不到這個 gist（id 打錯，或這個 PAT 沒有權限讀它）"
              : `GitHub HTTP ${res.status}`;
    const err = new Error(msg + (txt ? ` — ${txt.slice(0, 160)}` : ""));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const readGist = (conf, auth = true) =>
  gh(`/gists/${conf.gistId}`, auth ? { token: conf.token } : {});

function pickBlob(g) {
  const f = g.files?.[SYNC_FILE];
  if (!f) throw new Error(`gist 裡沒有 ${SYNC_FILE}（是不是貼到別的 gist？）`);
  if (f.truncated) throw new Error("gist 內容被 GitHub 截斷了（超過 1MB，設定不該這麼大）");
  let blob;
  try { blob = JSON.parse(f.content); } catch { throw new Error("gist 內容不是合法 JSON"); }
  if (blob.v !== BLOB_V) throw new Error(`不認得的格式版本 v=${blob.v}`);
  return blob;
}

const readBlob = async (conf) => pickBlob(await readGist(conf));

// 發過的卡放著沒意義（對方接上之後就用不到了），順手清掉
async function sweepEnroll(conf, g) {
  const dead = {};
  for (const [name, f] of Object.entries(g.files || {})) {
    if (!name.startsWith(ENROLL_PRE)) continue;
    let at = 0;
    try { at = JSON.parse(f.content || "{}").at || 0; } catch {}
    if (Date.now() - at > ENROLL_TTL) dead[name] = null;
  }
  if (!Object.keys(dead).length) return 0;
  await gh(`/gists/${conf.gistId}`, { token: conf.token, method: "PATCH", body: { files: dead } });
  console.log("[AutoLogin] 清掉過期發卡檔：", Object.keys(dead).join(", "));
  return Object.keys(dead).length;
}

const writeBlob = (conf, blob) =>
  gh(`/gists/${conf.gistId}`, {
    token: conf.token, method: "PATCH",
    body: { files: { [SYNC_FILE]: { content: JSON.stringify(blob, null, 1) } } },
  });

// ---------- 合併 ----------
// 每一筆設定帶 updatedAt，刪除留墓碑。沒有墓碑的話，A 刪掉的設定會被 B 推回來。
function mergeAll(local, remote) {
  const tombs = new Map();
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    const prev = tombs.get(t.id);
    if (!prev || t.at > prev.at) tombs.set(t.id, t);
  }

  const byId = new Map();
  // remote 先放、local 後放 —— 時間戳相同時以本機為準
  for (const s of [...(remote.sites || []), ...(local.sites || [])]) {
    if (!s || !s.id) continue;
    const prev = byId.get(s.id);
    if (!prev || (s.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(s.id, s);
  }

  const sites = [];
  for (const s of byId.values()) {
    const t = tombs.get(s.id);
    if (t && t.at >= (s.updatedAt || 0)) continue;   // 刪除比這次修改新 → 真的刪掉
    sites.push(s);
  }

  // 兩台各自替同一個網站建過設定（id 不同）時去重：host + urlContains 相同才算同一筆
  const seen = new Map();
  const deduped = [];
  for (const s of sites.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const k = `${(s.host || "").toLowerCase()}|${s.urlContains || ""}`;
    if (seen.has(k)) continue;
    seen.set(k, s.id);
    deduped.push(s);
  }
  deduped.sort((a, b) => String(a.label || a.host).localeCompare(String(b.label || b.host)));

  const cutoff = Date.now() - TOMB_MS;
  return { sites: deduped, tombstones: [...tombs.values()].filter((t) => t.at > cutoff) };
}

const stateHash = (o) => AL_CRYPTO.sha256(AL_CRYPTO.stable({ sites: o.sites, tombstones: o.tombstones }));

// ---------- 一條龍：pull → merge → 寫回本機 → push ----------
let syncBusy = null;

async function syncNow(reason = "") {
  if (syncBusy) return syncBusy;                    // 同時被 alarm 和 storage 事件叫到就共用同一次
  syncBusy = (async () => {
    const conf = await syncConf();
    if (!conf.enabled) return { ok: false, error: "同步沒有開啟" };
    if (!conf.token || !conf.gistId || !conf.dek) return { ok: false, error: "同步設定不完整" };

    try {
      if (!(await chrome.permissions.contains({ origins: [GH_ORIGIN] }))) {
        throw new Error("還沒授權存取 api.github.com（到管理頁按一次同步就會問）");
      }

      const dek = await AL_CRYPTO.importKey(conf.dek);
      const gist = await readGist(conf);
      const blob = pickBlob(gist);
      sweepEnroll(conf, gist).catch(() => {});   // 清不掉不影響同步

      let remote;
      try {
        remote = JSON.parse(await AL_CRYPTO.decrypt(dek, blob.payload));
      } catch {
        throw new Error("解密失敗：這個 gist 是用另一組金鑰加密的");
      }

      const local = {
        sites: (await chrome.storage.local.get("sites")).sites || [],
        tombstones: await loadTombs(),
      };
      const merged = mergeAll(local, remote);

      const [hLocal, hRemote, hMerged] = await Promise.all([
        stateHash(local), stateHash(remote), stateHash(merged),
      ]);

      if (hMerged !== hLocal) {
        // 先記 hash 再寫，否則 storage.onChanged 會把這次「套用遠端」當成本機改動，再推一次
        await syncSave({ lastHash: hMerged });
        await chrome.storage.local.set({ sites: merged.sites, tombstones: merged.tombstones });
      }

      let pushed = false;
      if (hMerged !== hRemote) {
        const next = {
          v: BLOB_V,
          // 救援片語是選用的。沒設就沒有這兩個欄位，也就沒有任何可以拿去離線暴力破解的東西
          ...(blob.wrappedKey ? { kdf: blob.kdf, wrappedKey: blob.wrappedKey } : {}),
          codeVersion: maxVer(blob.codeVersion || "0.0.0", myVersion()),
          payload: await AL_CRYPTO.encrypt(dek, JSON.stringify(merged)),
          rev: (blob.rev || 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        await writeBlob(conf, next);
        pushed = true;
      }

      await syncSave({
        lastHash: hMerged, lastOk: Date.now(), lastError: "", hasRescue: !!blob.wrappedKey,
        groupVersion: maxVer(blob.codeVersion || "0.0.0", myVersion()),
        rev: (blob.rev || 0) + (pushed ? 1 : 0),
        lastReason: reason,
      });
      console.log(`[AutoLogin] 同步完成（${reason}）`,
        { 拉下來: hMerged !== hLocal, 推上去: pushed, 站台數: merged.sites.length });
      return { ok: true, pulled: hMerged !== hLocal, pushed, count: merged.sites.length };
    } catch (e) {
      await syncSave({ lastError: String(e.message || e), lastErrorAt: Date.now() });
      console.error("[AutoLogin] 同步失敗：", e);
      return { ok: false, error: String(e.message || e) };
    }
  })().finally(() => { syncBusy = null; });
  return syncBusy;
}

// ---------- 設定 ----------
async function syncSetup({ mode, token, gistId, passphrase }) {
  if (!token) return { ok: false, error: "請填 PAT" };

  try {
    if (mode === "create") {
      // DEK 直接隨機產，不經過任何人想得出來的東西。
      // 第二台靠發卡拿到它，所以這裡完全不需要 passphrase。
      const dekB64 = AL_CRYPTO.newKeyB64();
      const dek = await AL_CRYPTO.importKey(dekB64);

      const now = Date.now();
      const sites = ((await chrome.storage.local.get("sites")).sites || [])
        .map((s) => ({ ...s, updatedAt: s.updatedAt || now }));
      const payloadObj = { sites, tombstones: await loadTombs() };

      const blob = {
        v: BLOB_V,
        codeVersion: myVersion(),
        payload: await AL_CRYPTO.encrypt(dek, JSON.stringify(payloadObj)),
        rev: 1,
        updatedAt: new Date().toISOString(),
      };

      const created = await gh("/gists", {
        token, method: "POST",
        body: {
          public: false,
          description: "Auto Login — encrypted settings (AES-256-GCM)",
          files: { [SYNC_FILE]: { content: JSON.stringify(blob, null, 1) } },
        },
      });

      await chrome.storage.local.set({ sites });
      await syncSave({
        enabled: true, token, gistId: created.id, dek: dekB64, salt: "",
        hasRescue: false, rev: 1, lastOk: Date.now(), lastError: "",
        lastHash: await stateHash(payloadObj),
      });
      return { ok: true, gistId: created.id, created: true };
    }

    // mode === "join"：只有設過救援片語的 gist 才走得通（一般情況請用發卡）
    if (!gistId) return { ok: false, error: "請填 gist id" };
    if (!passphrase) return { ok: false, error: "請填救援片語" };
    const conf = { token, gistId };
    const blob = await readBlob(conf);
    if (!blob.wrappedKey) {
      return { ok: false, error: "這個 gist 沒有設定救援片語 —— 請改用發卡（在已接上的那台按「發卡給這台」）" };
    }
    const kek = await AL_CRYPTO.deriveKEK(passphrase, blob.kdf.salt, blob.kdf.iters || KDF_ITERS);

    let dekB64;
    try {
      dekB64 = await AL_CRYPTO.decrypt(kek, blob.wrappedKey);
    } catch {
      return { ok: false, error: "救援片語不對（或這個 gist 不是這個 extension 的）" };
    }
    const dek = await AL_CRYPTO.importKey(dekB64);
    try { JSON.parse(await AL_CRYPTO.decrypt(dek, blob.payload)); }
    catch { return { ok: false, error: "片語對，但內容解不開 —— gist 可能壞了" }; }

    const now = Date.now();
    const local = ((await chrome.storage.local.get("sites")).sites || [])
      .map((s) => ({ ...s, updatedAt: s.updatedAt || now }));
    await chrome.storage.local.set({ sites: local });

    await syncSave({ enabled: true, token, gistId, dek: dekB64,
                     salt: blob.kdf.salt, hasRescue: true, lastError: "" });
    const r = await syncNow("join");
    return r.ok ? { ok: true, gistId, joined: true, count: r.count } : r;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 選用：把 DEK 用片語包起來放進 gist。所有機器都掛掉時，靠這個 + PAT 就能救回來。
// 不設的話 gist 上就沒有任何可以離線暴力破解的目標 —— 這是它真正的代價所在。
async function setRescue({ passphrase }) {
  const conf = await syncConf();
  if (!conf.enabled || !conf.dek) return { ok: false, error: "這台還沒接上同步" };
  if (!passphrase || passphrase.length < 12) return { ok: false, error: "救援片語太短（至少 12 個字）" };
  try {
    const salt = AL_CRYPTO.toB64(AL_CRYPTO.rand(16));
    const kek = await AL_CRYPTO.deriveKEK(passphrase, salt, KDF_ITERS);
    const wrappedKey = await AL_CRYPTO.encrypt(kek, conf.dek);

    const blob = await readBlob(conf);
    await writeBlob(conf, {
      ...blob,
      kdf: { alg: "PBKDF2-SHA256", hash: "SHA-256", iters: KDF_ITERS, salt },
      wrappedKey,
      rev: (blob.rev || 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    await syncSave({ salt, hasRescue: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// 只關掉本機的同步。gist 留著（其他機器還在用），要刪請自己去 GitHub 刪。
async function syncDisable() {
  await chrome.storage.local.set({ sync: { enabled: false } });
  return { ok: true };
}

async function syncStatus() {
  const c = await syncConf();
  return {
    ok: true,
    enabled: !!c.enabled,
    gistId: c.gistId || "",
    hasToken: !!c.token,
    rev: c.rev || 0,
    hasRescue: !!c.hasRescue,
    version: myVersion(),
    groupVersion: c.groupVersion || "",
    behind: !!c.groupVersion && cmpVer(myVersion(), c.groupVersion) < 0,
    lastOk: c.lastOk || 0,
    lastError: c.lastError || "",
    lastErrorAt: c.lastErrorAt || 0,
    granted: c.enabled ? await chrome.permissions.contains({ origins: [GH_ORIGIN] }).catch(() => false) : false,
  };
}


/* ---------- 裝置發卡 ----------
 * A（已經有同步的機器）把憑證用 B 的公鑰封起來，丟進同一個 gist。
 * 封起來的東西只有 B 的私鑰解得開，所以這個檔案本身不是秘密 ——
 * gist 網址、B 的公鑰也都不是。整個流程沒有任何要用手搬的秘密。
 */
async function enrollIssue({ pub }) {
  const conf = await syncConf();
  if (!conf.enabled || !conf.token || !conf.gistId || !conf.dek) {
    return { ok: false, error: "這台機器自己還沒接上同步，沒有東西可以發卡" };
  }
  if (!pub) return { ok: false, error: "請貼上對方的公鑰" };
  try {
    const sealed = await AL_ID.sealTo(pub, {
      token: conf.token, gistId: conf.gistId, dek: conf.dek, salt: conf.salt || "",
    });
    const name = ENROLL_PRE + sealed.to + ".json";
    const res = await gh(`/gists/${conf.gistId}`, {
      token: conf.token, method: "PATCH",
      body: { files: { [name]: { content: JSON.stringify(sealed, null, 1) } } },
    });
    // raw_url 一定匿名讀得到（secret gist 就是靠網址分享的）。
    // API 端點能不能匿名讀 secret gist，GitHub 文件沒寫死，所以給一條保證走得通的路。
    return { ok: true, fp: sealed.to, rawUrl: res.files?.[name]?.raw_url || "" };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// B 端：gist 是 secret 不是 private，所以不帶 token 也讀得到。
// 萬一 GitHub 擋了，管理頁還有「直接貼發卡檔內容」那條路。
async function enrollClaim({ gistId, blob }) {
  try {
    let sealed = blob;
    if (!sealed && /^https?:\/\//i.test(gistId || "")) {
      // 直接給 raw 網址：最穩的一條路，不經過 API
      const r = await fetch(gistId).catch((e) => { throw new Error("抓不到那個網址：" + e.message); });
      if (!r.ok) throw new Error(`抓不到發卡檔（HTTP ${r.status}）`);
      sealed = JSON.parse(await r.text());
    }
    if (!sealed) {
      if (!gistId) return { ok: false, error: "請貼 gist id、raw 網址或發卡檔內容" };
      const g = await readGist({ gistId }, false);
      const me = await AL_ID.me();
      const f = g.files?.[ENROLL_PRE + me.fp + ".json"];
      if (!f) return { ok: false, error: `這個 gist 裡沒有發給這台機器的卡（這台是 ${me.fp}，請先在另一台按發卡）` };
      sealed = JSON.parse(f.content);
    }
    const creds = await AL_ID.openSealed(sealed);
    if (!creds || !creds.token || !creds.gistId || !creds.dek) return { ok: false, error: "卡片內容不完整" };

    await syncSave({ enabled: true, token: creds.token, gistId: creds.gistId,
                     dek: creds.dek, salt: creds.salt || "", lastError: "" });
    const r = await syncNow("enroll");
    return r.ok ? { ok: true, count: r.count } : r;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
