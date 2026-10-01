"use strict";
const out = document.getElementById("out");
const log = (s, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = s; out.append(d); };
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const SALT = new TextEncoder().encode("autologin-prf-test-v1".padEnd(32, "\0"));
const rpId = chrome.runtime.id;

log(`瀏覽器：${navigator.userAgent}`);
log(`origin：${location.origin}　rpId：${rpId}`);

document.getElementById("reg").onclick = async () => {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { id: rpId, name: "Auto Login (PRF test)" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "autologin-test", displayName: "Auto Login 測試" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: SALT } } },
    }});
    const ext = cred.getClientExtensionResults();
    localStorage.setItem("prfTestCred", b64(cred.rawId));
    log(`註冊成功，credential ${b64(cred.rawId).slice(0, 16)}…　authenticatorAttachment=${cred.authenticatorAttachment}`, "ok");
    log(`prf.enabled = ${ext.prf && ext.prf.enabled}`, ext.prf && ext.prf.enabled ? "ok" : "err");
    if (ext.prf && ext.prf.results) log(`（註冊時就拿到 PRF：${b64(ext.prf.results.first).slice(0, 16)}…）`, "ok");
  } catch (e) { log(`註冊失敗：${e.name}: ${e.message}`, "err"); }
};

document.getElementById("get").onclick = async () => {
  try {
    const id = localStorage.getItem("prfTestCred");
    const a = await navigator.credentials.get({ publicKey: {
      rpId, challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "required",
      allowCredentials: id ? [{ type: "public-key", id: Uint8Array.from(atob(id), (c) => c.charCodeAt(0)) }] : [],
      extensions: { prf: { eval: { first: SALT } } },
    }});
    const r = a.getClientExtensionResults().prf;
    if (r && r.results && r.results.first) {
      const v = b64(r.results.first);
      const prev = sessionStorage.getItem("prfPrev");
      log(`PRF 值：${v.slice(0, 16)}…（${r.results.first.byteLength} bytes）` +
          (prev ? (prev === v ? "　✔ 跟上次一樣" : "　✘ 跟上次不一樣！") : ""), prev && prev !== v ? "err" : "ok");
      sessionStorage.setItem("prfPrev", v);
    } else {
      log("驗證成功，但沒有 PRF 結果 → 這把 passkey／這個 authenticator 不支援 PRF", "err");
    }
  } catch (e) { log(`驗證失敗：${e.name}: ${e.message}`, "err"); }
};
