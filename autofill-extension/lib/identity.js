/* Auto Login — 裝置金鑰（ECDH P-256）
 *
 * 這裡是整份程式碼裡唯一非對稱真的不可取代的地方：
 * A 要把憑證加密給「還不是自己、也還沒有共同金鑰」的 B。加密者 ≠ 解密者。
 * （gist 那邊每台機器又讀又寫，非對稱在那裡會退化成對稱，所以沒用上。）
 *
 * 私鑰 extractable:false，原始 bytes 存在瀏覽器的 crypto store，JS 匯不出來 ——
 * 翻 extension 資料夾、讀任何檔案都拿不到。
 * 誠實的邊界：它不是硬體綁定的，能整份複製走 Chrome profile 的人還是能用。
 */
"use strict";

const AL_ID = (() => {
  const DB = "autologin-id", STORE = "keys", KEY = "device";
  const CURVE = { name: "ECDH", namedCurve: "P-256" };
  const INFO = new TextEncoder().encode("autologin-enroll-v1");

  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const q = fn(t.objectStore(STORE));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };

  // 只產一次，之後一直是同一把。extractable:false 只套用在私鑰上，公鑰永遠匯得出來。
  async function keypair() {
    let pair = await tx("readonly", (s) => s.get(KEY));
    if (!pair) {
      pair = await crypto.subtle.generateKey(CURVE, false, ["deriveBits"]);
      await tx("readwrite", (s) => s.put(pair, KEY));
    }
    return pair;
  }

  const rawPub = async (pubKey) => new Uint8Array(await crypto.subtle.exportKey("raw", pubKey));

  // 8 碼指紋，給你用眼睛核對用的（防的是「有人把公鑰換成自己的」）
  async function fingerprint(raw) {
    const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return [...h.slice(0, 8)].map((n) => ALPHA[n % ALPHA.length]).join("").replace(/(.{4})/, "$1-");
  }

  async function me() {
    const pair = await keypair();
    const raw = await rawPub(pair.publicKey);
    return { pub: AL_CRYPTO.toB64(raw), fp: await fingerprint(raw) };
  }

  const importPub = (b64) =>
    crypto.subtle.importKey("raw", AL_CRYPTO.fromB64(b64), CURVE, true, []);

  // salt 綁住雙方公鑰（transcript binding），同一把金鑰在別的情境下推不出同一把 AES key
  async function sharedKey(privKey, peerPub, epkRaw, theirRaw) {
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, privKey, 256);
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new Uint8Array([...epkRaw, ...theirRaw])));
    const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: INFO },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
  }

  // 封給某一台機器。用臨時金鑰 → 就算這台之後被翻，也推不回舊的發卡內容
  async function sealTo(theirPubB64, obj) {
    const theirPub = await importPub(theirPubB64);
    const theirRaw = await rawPub(theirPub);
    const eph = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
    const epkRaw = await rawPub(eph.publicKey);
    const key = await sharedKey(eph.privateKey, theirPub, epkRaw, theirRaw);
    return {
      v: 1,
      type: "autologin-enroll",
      to: await fingerprint(theirRaw),
      epk: AL_CRYPTO.toB64(epkRaw),
      payload: await AL_CRYPTO.encrypt(key, JSON.stringify(obj)),
      at: Date.now(),
    };
  }

  async function openSealed(blob) {
    if (!blob || blob.type !== "autologin-enroll") throw new Error("這不是發卡檔");
    const pair = await keypair();
    const myRaw = await rawPub(pair.publicKey);
    const myFp = await fingerprint(myRaw);
    if (blob.to !== myFp) throw new Error(`這張卡不是發給這台機器的（發給 ${blob.to}，這台是 ${myFp}）`);
    const epk = await importPub(blob.epk);
    const key = await sharedKey(pair.privateKey, epk, AL_CRYPTO.fromB64(blob.epk), myRaw);
    try {
      return JSON.parse(await AL_CRYPTO.decrypt(key, blob.payload));
    } catch {
      throw new Error("解不開 —— 發卡檔壞了，或不是用這台的公鑰封的");
    }
  }

  return { me, fingerprint, fingerprintOf: async (b64) => fingerprint(AL_CRYPTO.fromB64(b64)),
           sealTo, openSealed };
})();
