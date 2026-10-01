/* Auto Login — passkey（WebAuthn PRF）。只能在 extension 頁面跑，service worker 沒有 navigator.credentials。
 * rpId = extension ID：unpacked extension 的 ID 是由資料夾路徑算出來的，
 * 換路徑 / 重新安裝 → ID 變了 → 這把 passkey 就對不上了（資料要靠 gist 救回）。
 */
"use strict";

(function (g) {
  const C = () => g.AL_CRYPTO;
  const rpId = () => chrome.runtime.id;

  const prfOf = (cred) => {
    const r = cred.getClientExtensionResults().prf;
    return r && r.results && r.results.first ? r.results.first : null;
  };

  async function evaluate(credIdB64, prfSaltB64) {
    const a = await navigator.credentials.get({ publicKey: {
      rpId: rpId(),
      challenge: C().rand(32),
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: C().fromB64(credIdB64) }],
      extensions: { prf: { eval: { first: C().fromB64(prfSaltB64) } } },
    }});
    const prf = prfOf(a);
    if (!prf) throw new Error("這把 passkey 不支援 PRF，沒辦法拿來加密");
    return prf;
  }

  // 註冊一把新的，回傳 enable() 要的東西
  async function register() {
    const prfSalt = C().toB64(C().rand(32));
    const host = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { id: rpId(), name: "Auto Login 本機加密" },
      user: { id: C().rand(16), name: `autologin-${host}`.toLowerCase(), displayName: `Auto Login（${host}）` },
      challenge: C().rand(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: C().fromB64(prfSalt) } } },
    }});
    const ext = cred.getClientExtensionResults().prf;
    if (!ext || ext.enabled === false) throw new Error("這把 passkey 不支援 PRF（換一個存放位置再試，例如 iCloud 鑰匙圈 / Google 密碼管理工具）");
    const credId = C().toB64(cred.rawId);
    // 有些 authenticator 註冊時就給 PRF，有些要再驗證一次才給
    const prf = prfOf(cred) || await evaluate(credId, prfSalt);
    return { credId, prfSalt, prf, rpId: rpId(), label: host };
  }

  g.AL_PASSKEY = { register, evaluate, rpId };
})(globalThis);
