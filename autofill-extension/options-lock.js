"use strict";
/* 管理頁的鎖：
 *  - 鎖著 → 整頁換成解鎖畫面，options.js 根本不載入（它會把「讀不到」當成「沒有設定」）
 *  - 沒鎖 → 載入 options.js，並處理「本機加密」那一區的按鈕
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const info = await AL_VAULT.info();

  if (info.state === "locked") {
    document.body.innerHTML = `
      <div style="max-width:420px;margin:90px auto;text-align:center">
        <div style="font-size:40px">🔒</div>
        <h1>Auto Login 已鎖定</h1>
        <div class="sub">設定在這台電腦上是加密的，用 passkey 解鎖後才看得到。</div>
        <div class="btns" style="justify-content:center"><button class="pri" id="ul">用 passkey 解鎖</button></div>
        <div id="ulMsg" class="stat" style="margin-top:12px"></div>
        ${info.rpMismatch ? `<div class="hint err">extension ID 變了（原本 ${esc(info.rpId)}），這把 passkey 已經對不上。
           請用解鎖視窗裡的「passkey 不見了？」放棄本機資料，再從 gist 接回來。</div>` : ""}
      </div>`;
    $("ul").onclick = async () => {
      $("ulMsg").textContent = "等待 Touch ID / Windows Hello…";
      try {
        const lock = await AL_VAULT.lockConf();
        await AL_VAULT.unlock(await AL_PASSKEY.evaluate(lock.credId, lock.prfSalt));
        await chrome.runtime.sendMessage({ cmd: "unlocked" }).catch(() => {});
        location.reload();
      } catch (e) {
        $("ulMsg").innerHTML = `<span class="err">${esc(e.name === "NotAllowedError" ? "取消了，或逾時。再按一次就好。" : e.message)}</span>`;
      }
    };
    return;
  }

  // 別的地方（popup / 其他分頁）把它鎖起來了 → 這頁手上的資料不能再用，重新整理成解鎖畫面
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "session" && ch.lockKey && !ch.lockKey.newValue) location.reload();
  });

  const s = document.createElement("script");
  s.src = "options.js";
  document.body.appendChild(s);

  const paint = (i) => {
    const on = i.state !== "off";
    $("lockStat").innerHTML = on
      ? `<span class="ok">已開啟</span>　·　passkey 建立於 ${new Date(i.createdAt).toLocaleString()}` +
        `${i.label ? "（" + esc(i.label) + "）" : ""}　·　硬碟上只有密文`
      : `<span>未開啟</span>　·　帳密目前以明文存在這台電腦的 Chrome profile 裡`;
    $("lockOn").hidden = on;
    $("lockNowBtn").hidden = $("lockOff").hidden = !on;
  };
  paint(info);

  $("lockOn").onclick = async () => {
    $("lockStat").textContent = "建立 passkey 中，請按 Touch ID / Windows Hello…";
    try {
      const reg = await AL_PASSKEY.register();
      await AL_VAULT.enable(reg);
      await chrome.runtime.sendMessage({ cmd: "unlocked" }).catch(() => {});
      paint(await AL_VAULT.info());
    } catch (e) {
      $("lockStat").innerHTML = `<span class="err">沒有開啟：${esc(e.name === "NotAllowedError" ? "取消了，或逾時" : e.message)}</span>`;
    }
  };
  $("lockNowBtn").onclick = async () => {
    await AL_VAULT.lockNow();
    location.reload();
  };
  $("lockOff").onclick = async () => {
    if (!confirm("關閉本機加密？\n\n帳密、PAT、同步金鑰會改回明文存在這台電腦上。")) return;
    try {
      // 關之前再驗一次本人，避免有人趁你離開座位把它關掉
      const lock = await AL_VAULT.lockConf();
      await AL_PASSKEY.evaluate(lock.credId, lock.prfSalt);
      await AL_VAULT.disable();
      paint(await AL_VAULT.info());
      await chrome.runtime.sendMessage({ cmd: "sync" }).catch(() => {});
    } catch (e) {
      $("lockStat").innerHTML = `<span class="err">沒有關閉：${esc(e.name === "NotAllowedError" ? "取消了" : e.message)}</span>`;
    }
  };
})();
