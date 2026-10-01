/* Auto Login — 本機保險箱（passkey 鎖）
 *
 * 關掉時：sites / tombstones / sync 照舊明文放 chrome.storage.local。
 * 開啟後：
 *   local   lock      { enabled, credId, prfSalt, wrapped, rpId }   ← 都不是秘密
 *           vault     AES-GCM(LK, {sites, tombstones, sync})        ← 密文
 *           siteIndex [{id, host, urlContains, urlRegex, enabled}]   ← 沒解鎖也要知道「這頁有沒有設定」
 *   session lockKey + 上面三包的明文工作副本（只在記憶體，關 Chrome 就沒了）
 *
 * LK（本機金鑰）是 256-bit 亂數，外面再用 passkey 的 PRF 輸出經 HKDF 導出的 KEK 包一層。
 * PRF 輸出只有通過 Touch ID / Windows Hello 才拿得到，而且不會寫進任何檔案 ——
 * 所以整份 Chrome profile 被偷走，拿到的也只有密文。
 *
 * 邊界（誠實寫下來）：
 *   - 解鎖期間明文在記憶體，常駐的木馬照樣讀得到
 *   - LevelDB 的刪除不是抹除 → enable() 最後會跑 scrub() 逼它 compaction（見下方）
 */
"use strict";

(function (g) {
  const SECRET_KEYS = ["sites", "tombstones", "sync"];
  const S = () => chrome.storage.session;
  const L = () => chrome.storage.local;
  const C = () => g.AL_CRYPTO;

  const lockConf = async () => (await L().get("lock")).lock || null;

  async function state() {
    const lock = await lockConf();
    if (!lock || !lock.enabled) return "off";
    const { lockKey } = await S().get("lockKey");
    return lockKey ? "unlocked" : "locked";
  }

  class LockedError extends Error {
    constructor() { super("Auto Login 已鎖定，請先用 passkey 解鎖"); this.name = "LockedError"; this.locked = true; }
  }

  const index = (sites = []) => sites.map((s) => ({
    id: s.id, label: s.label || "", host: s.host || "", pattern: s.pattern || "",
    urlContains: s.urlContains || "", urlRegex: s.urlRegex || "", enabled: s.enabled !== false,
  }));

  async function lkKey() {
    const { lockKey } = await S().get("lockKey");
    if (!lockKey) throw new LockedError();
    return C().importKey(lockKey);
  }

  // 把 session 裡的明文工作副本整包重新加密寫回 local
  async function persist() {
    const key = await lkKey();
    const data = await S().get(SECRET_KEYS);
    await L().set({
      vault: await C().encrypt(key, JSON.stringify(data)),
      siteIndex: index(data.sites),
    });
  }

  // ---------- 給其他程式碼用的 storage：介面跟 chrome.storage.local 一樣 ----------
  const isSecret = (k) => SECRET_KEYS.includes(k);
  const keysOf = (k) => (k == null ? SECRET_KEYS : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k));

  const store = {
    async get(keys) {
      const st = await state();
      const want = keysOf(keys);
      if (st === "off" || !want.some(isSecret)) return L().get(keys);
      if (st === "locked") throw new LockedError();
      const sec = want.filter(isSecret), pub = want.filter((k) => !isSecret(k));
      return { ...(pub.length ? await L().get(pub) : {}), ...(await S().get(sec)) };
    },
    async set(obj) {
      const st = await state();
      const sec = Object.keys(obj).filter(isSecret);
      if (st === "off" || !sec.length) return L().set(obj);
      if (st === "locked") throw new LockedError();
      const pub = Object.fromEntries(Object.entries(obj).filter(([k]) => !isSecret(k)));
      if (Object.keys(pub).length) await L().set(pub);
      await S().set(Object.fromEntries(sec.map((k) => [k, obj[k]])));
      await persist();   // 同一個呼叫裡就寫回密文，不賭 service worker 還醒著
    },
  };

  // ---------- 金鑰 ----------
  async function kekFrom(prf, prfSalt) {
    const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: C().fromB64(prfSalt),
        info: new TextEncoder().encode("autologin local vault v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // prf: ArrayBuffer（passkey 的 PRF 輸出）
  async function enable({ credId, prfSalt, prf, rpId, label }) {
    if ((await state()) !== "off") throw new Error("已經開啟了");
    const lkB64 = C().newKeyB64();
    const lk = await C().importKey(lkB64);
    const kek = await kekFrom(prf, prfSalt);
    const data = await L().get(SECRET_KEYS);
    const lock = { enabled: true, v: 1, credId, prfSalt, rpId, label: label || "",
                   wrapped: await C().encrypt(kek, lkB64), createdAt: Date.now() };
    const vault = await C().encrypt(lk, JSON.stringify(data));

    // 先確認解得回來，才動明文 —— 這一步錯了會把全部設定鎖死
    const back = await C().decrypt(await C().importKey(await C().decrypt(kek, lock.wrapped)), vault);
    if (back !== JSON.stringify(data)) throw new Error("自我檢查失敗：加密後解不回原文，沒有做任何改動");

    await S().set({ lockKey: lkB64, ...data });
    await L().set({ lock, vault, siteIndex: index(data.sites) });
    await L().remove(SECRET_KEYS);
    await scrub();
    return { ok: true };
  }

  /* remove() 只是在 LevelDB 裡寫一筆「已刪除」，舊的明文還躺在磁碟上的 .log / .ldb 裡，
   * 直到剛好被 compaction 合併掉 —— 設定檔這麼小，可能好幾個月都不會發生，
   * 而那正是木馬翻檔案會找到的東西。
   *
   * 實測（Chromium 的 extension storage）：
   *   1. 只寫填充資料 → 只會 L0→L1，舊資料那個檔案早就被放在 L2，碰不到
   *   2. 再反覆讀一個「在範圍內但不存在」的 key → 觸發 seek compaction，L1+L2 合併，舊值才真的消失
   * 填充 key 用 a~ / z~，確保範圍蓋過所有真正的 key 名稱。約 1 秒。 */
  async function scrub(rounds = 8) {
    const junk = "x".repeat(700 * 1024);
    for (let i = 0; i < rounds; i++) {
      await L().set({ "a~scrub": junk + i, "z~scrub": junk + i });
      await L().remove(["a~scrub", "z~scrub"]);
    }
    for (let i = 0; i < 1500; i++) await L().get("m~scrub");
  }

  async function unlock(prf) {
    const lock = await lockConf();
    if (!lock || !lock.enabled) return { ok: true, already: true };
    const { vault } = await L().get("vault");
    let lkB64, data;
    try {
      lkB64 = await C().decrypt(await kekFrom(prf, lock.prfSalt), lock.wrapped);
    } catch { throw new Error("這把 passkey 解不開（選到別把了？）"); }
    try {
      data = vault ? JSON.parse(await C().decrypt(await C().importKey(lkB64), vault)) : {};
    } catch { throw new Error("金鑰對，但保險箱內容解不開 —— 資料可能壞了"); }
    await S().set({ lockKey: lkB64, ...data });
    return { ok: true, count: (data.sites || []).length };
  }

  async function lockNow() {
    await S().remove(["lockKey", ...SECRET_KEYS]);
    return { ok: true };
  }

  // 關掉：明文搬回 local（要先解鎖）
  async function disable() {
    const st = await state();
    if (st === "off") return { ok: true };
    if (st === "locked") throw new LockedError();
    const data = await S().get(SECRET_KEYS);
    await L().set(data);
    await L().remove(["lock", "vault", "siteIndex"]);
    await lockNow();
    return { ok: true };
  }

  // passkey 沒了：放棄本機這份，回到空白狀態，再從 gist（發卡／救援片語）接回來
  async function abandon() {
    await L().remove(["lock", "vault", "siteIndex", ...SECRET_KEYS]);
    await lockNow();
    await scrub();
    return { ok: true };
  }

  async function info() {
    const lock = await lockConf();
    return {
      state: await state(),
      rpId: lock?.rpId || "", label: lock?.label || "", createdAt: lock?.createdAt || 0,
      rpMismatch: !!lock?.enabled && !!lock.rpId && typeof chrome.runtime.id === "string" && lock.rpId !== chrome.runtime.id,
    };
  }

  g.AL_VAULT = { SECRET_KEYS, state, info, store, enable, unlock, lockNow, disable, abandon, scrub,
                 lockConf, LockedError, siteIndex: async () => (await L().get("siteIndex")).siteIndex || [] };
})(globalThis);
