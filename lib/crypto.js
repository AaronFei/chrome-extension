/* Auto Login — 加密工具（service worker 與 extension 頁面共用）
 *
 * 信封加密：
 *   DEK  256-bit 亂數，AES-GCM 加密整包設定
 *   KEK  passphrase 經 PBKDF2-SHA256 導出，只用來包住 DEK
 * 非對稱在這裡沒有意義：每台機器都要讀也要寫，私鑰註定要複製過去，
 * 那它就只是一把對稱金鑰。真正的關鍵是 KDF 夠慢、IV 不重用。
 */
"use strict";

(function (g) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const toB64 = (buf) => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function deriveKEK(passphrase, saltB64, iters) {
    const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: fromB64(saltB64), iterations: iters, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  const importKey = (keyB64) =>
    crypto.subtle.importKey("raw", fromB64(keyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  // 每次都給新的 96-bit IV。GCM 的 IV 重用會直接洩漏明文，這條沒有討價還價空間。
  async function encrypt(key, plaintext) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function decrypt(key, box) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct));
    return dec.decode(pt);
  }

  async function sha256(str) {
    return toB64(await crypto.subtle.digest("SHA-256", enc.encode(str)));
  }

  // 穩定序列化：欄位順序不影響雜湊，才能拿來判斷「內容有沒有真的變」
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  g.AL_CRYPTO = { toB64, fromB64, rand, deriveKEK, importKey, encrypt, decrypt, sha256, stable,
                  newKeyB64: () => toB64(rand(32)) };
})(globalThis);
