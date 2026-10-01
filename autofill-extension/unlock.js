"use strict";
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const tabId = q.get("tab") || "";
if (q.get("reason")) $("why").textContent = "要登入：" + q.get("reason");

const say = (t, cls) => { $("msg").className = "msg " + (cls || ""); $("msg").textContent = t; };

async function go() {
  $("go").disabled = true;
  say("等待 Touch ID / Windows Hello…");
  try {
    const info = await AL_VAULT.info();
    if (info.state !== "locked") { say("已經是解鎖狀態", "ok"); return done(); }
    if (info.rpMismatch) throw new Error(`extension ID 變了（原本 ${info.rpId}），這把 passkey 對不上。只能放棄本機資料，從 gist 接回來。`);
    const lock = await AL_VAULT.lockConf();
    const prf = await AL_PASSKEY.evaluate(lock.credId, lock.prfSalt);
    const r = await AL_VAULT.unlock(prf);
    say(`已解鎖（${r.count} 個網站）`, "ok");
    done();
  } catch (e) {
    const m = e.name === "NotAllowedError" ? "取消了，或逾時。再按一次就好。" : (e.message || String(e));
    say(m, "err");
    $("go").disabled = false;
  }
}

async function done() {
  await chrome.runtime.sendMessage({ cmd: "unlocked", tabId }).catch(() => {});
  setTimeout(() => window.close(), 600);
}

$("go").onclick = go;
$("abandon").onclick = async () => {
  if (!confirm("確定放棄這台的本機設定？\n\n只有 gist 上有的東西救得回來。")) return;
  await AL_VAULT.abandon();
  await chrome.runtime.sendMessage({ cmd: "unlocked" }).catch(() => {});
  chrome.runtime.openOptionsPage();
  window.close();
};

// 視窗一打開就直接跳 Touch ID（視窗本身是使用者點「解鎖」開的）。被擋的話就等人按按鈕。
window.addEventListener("load", () => { if (document.hasFocus()) go(); });
