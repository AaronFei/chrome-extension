/* Auto Login — 加密匯出／匯入（給管理頁用）
 *
 * 設計前提：金鑰不能跟著程式碼走。extension 是 unpacked，lib/*.js 就躺在硬碟上，
 * 寫死在裡面的任何密鑰對「拿得到匯出檔的人」等於公開。
 * 所以檔案走一條路（AirDrop / USB / 雲端），轉移碼走另一條（你自己打）。
 */
"use strict";

const AL_TRANSFER = (() => {
  const V = 1;
  const TYPE = "autologin-export";
  const ITERS = 600000;
  const TOMB_MS = 90 * 86400 * 1000;

  // 一次性轉移碼。熵在這裡（≈158 bits），不在字典。
  // 字母表去掉 i l o 0 1，手抄不會看錯。
  function genCode() {
    const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
    const b = crypto.getRandomValues(new Uint8Array(32));
    return [...b].map((n) => ALPHA[n % ALPHA.length]).slice(0, 32).join("")
                 .replace(/(.{4})(?=.)/g, "$1-");
  }

  async function makeFile(code, data) {
    const salt = AL_CRYPTO.toB64(AL_CRYPTO.rand(16));
    const kek = await AL_CRYPTO.deriveKEK(code, salt, ITERS);
    return {
      v: V,
      type: TYPE,
      count: (data.sites || []).length,
      kdf: { alg: "PBKDF2-SHA256", hash: "SHA-256", iters: ITERS, salt },
      payload: await AL_CRYPTO.encrypt(kek, JSON.stringify(data)),
      exportedAt: new Date().toISOString(),
    };
  }

  async function openFile(code, file) {
    if (!file || file.type !== TYPE) throw new Error("這不是 Auto Login 的匯出檔");
    if (file.v !== V) throw new Error(`不認得的格式版本 v=${file.v}`);
    const kek = await AL_CRYPTO.deriveKEK(code, file.kdf.salt, file.kdf.iters || ITERS);
    let json;
    try {
      json = await AL_CRYPTO.decrypt(kek, file.payload);   // GCM 的 tag 會擋下錯的碼，不是用猜的
    } catch {
      throw new Error("轉移碼不對（或檔案被改過）");
    }
    const data = JSON.parse(json);
    if (!Array.isArray(data.sites)) throw new Error("檔案內容格式不對");
    return data;
  }

  // 合併：每筆帶 updatedAt，晚的贏；刪除留墓碑，否則舊檔案會把刪掉的設定復活
  function mergeAll(local, incoming) {
    const tombs = new Map();
    for (const t of [...(local.tombstones || []), ...(incoming.tombstones || [])]) {
      const prev = tombs.get(t.id);
      if (!prev || t.at > prev.at) tombs.set(t.id, t);
    }

    const byId = new Map();
    // incoming 先放、local 後放 —— 時間戳一樣時以本機為準
    for (const s of [...(incoming.sites || []), ...(local.sites || [])]) {
      if (!s || !s.id) continue;
      const prev = byId.get(s.id);
      if (!prev || (s.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(s.id, s);
    }

    const kept = [];
    for (const s of byId.values()) {
      const t = tombs.get(s.id);
      if (t && t.at >= (s.updatedAt || 0)) continue;   // 刪除比這次修改新 → 真的刪掉
      kept.push(s);
    }

    // 兩台各自替同一個網站建過設定（id 不同）時去重：host + urlContains 相同才算同一筆
    const seen = new Set();
    const sites = [];
    for (const s of kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      const k = `${(s.host || "").toLowerCase()}|${s.urlContains || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sites.push(s);
    }
    sites.sort((a, b) => String(a.label || a.host).localeCompare(String(b.label || b.host)));

    const cutoff = Date.now() - TOMB_MS;
    return { sites, tombstones: [...tombs.values()].filter((t) => t.at > cutoff) };
  }

  // 套用前先算清楚會發生什麼事，讓使用者看過再決定
  function preview(local, merged) {
    const before = new Map((local.sites || []).map((s) => [s.id, s]));
    const after = new Map(merged.sites.map((s) => [s.id, s]));
    let added = 0, changed = 0, removed = 0;
    for (const [id, s] of after) {
      const b = before.get(id);
      if (!b) added++;
      else if (AL_CRYPTO.stable(b) !== AL_CRYPTO.stable(s)) changed++;
    }
    for (const id of before.keys()) if (!after.has(id)) removed++;
    return { added, changed, removed, total: merged.sites.length };
  }

  return { V, TYPE, ITERS, genCode, makeFile, openFile, mergeAll, preview };
})();
