"use strict";

const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").hidden = false; $("msg").textContent = t; };

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (() => { try { return new URL(tab.url); } catch { return null; } })();

  if (!url || !/^https?:$/.test(url.protocol)) {
    $("host").textContent = tab?.url || "(未知分頁)";
    $("state").innerHTML = '<span class="badge off">這個分頁不能設定</span>';
    $("learn").disabled = $("fill").disabled = true;
    $("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    return;
  }

  // 一律用 *://host/* —— 必須和 background.js / picker.js 產生的 pattern 完全一致，
  //  否則 permissions.contains() 會比不中，content script 就永遠註冊不上去。
  const pattern = `*://${url.host}/*`;
  $("host").textContent = url.host;

  const { sites = [] } = await chrome.storage.local.get("sites");
  const site = sites.find((s) => s.host?.toLowerCase() === url.host.toLowerCase());
  const granted = await chrome.permissions.contains({ origins: [pattern] });

  // 「有設定 + 有授權」不代表 content script 真的註冊上去了。
  // 註冊清單有可能是舊的（例如同步時剛好撞在一起），
  // 那狀態會顯示已啟用但其實完全不會執行 —— 這裡直接檢查並自動修好。
  let covered = true;
  if (site && granted && site.enabled !== false) {
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: ["autologin"] }).catch(() => []);
    covered = reg.some((r) => (r.matches || []).includes(pattern));
    if (!covered) {
      const res = await chrome.runtime.sendMessage({ cmd: "sync" }).catch(() => null);
      covered = !!res?.patterns?.includes(pattern);
      say(covered ? "註冊清單沒同步到，已自動修好。重新整理這一頁即可生效。"
                  : "註冊失敗，請看 service worker console 的錯誤訊息。");
    }
  }

  if (site && granted && site.enabled !== false) {
    $("state").innerHTML = covered
      ? '<span class="badge on">已啟用</span>'
      : '<span class="badge need">已授權但尚未生效</span>';
    $("learn").textContent = "重新設定這個網站";
    $("learn").classList.remove("pri");
    $("fill").classList.add("pri");
  } else if (site && !granted) {
    $("state").innerHTML = '<span class="badge need">已有設定，但還沒授權這個網域</span>';
    $("learn").textContent = "授權並啟用";
  } else if (site) {
    // 在管理頁被關掉了 —— 這裡給一個一鍵打開的捷徑
    $("state").innerHTML = '<span class="badge off">已停用</span>';
    $("learn").textContent = "重新設定這個網站";
    $("learn").classList.remove("pri");
    $("fill").textContent = "啟用這個網站";
    $("fill").classList.add("pri");
    $("fill").dataset.act = "enable";
  } else {
    $("state").innerHTML = '<span class="badge off">尚未設定</span>';
  }

  const inject = async (files) => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  };

  $("learn").onclick = async () => {
    try {
      // 沒授權的話先要授權（必須在使用者點擊的當下呼叫）
      const ok = granted || await chrome.permissions.request({ origins: [pattern] });
      if (!ok) { say("沒有授權就沒辦法在這個網域自動登入。"); return; }
      await chrome.runtime.sendMessage({ cmd: "sync" });
      if (site && !granted) { say("已授權，重新整理這一頁就會生效。"); return; }
      await inject(["lib/selector.js", "picker.js"]);
      window.close();
    } catch (e) {
      // 授權對話框有時會把 popup 關掉，這時再點一次就會直接進入設定
      say("如果剛剛跳出授權視窗，請再點一次這個按鈕。（" + e.message + "）");
    }
  };

  $("fill").onclick = async () => {
    if (!site) { say("這個網域還沒設定。"); return; }

    if ($("fill").dataset.act === "enable") {
      // permissions.request 必須在使用者手勢當下呼叫，所以排在其他 await 之前
      const ok = granted || await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!ok) { say("沒有授權就沒辦法在這個網域自動登入。"); return; }
      const { sites: cur = [] } = await chrome.storage.local.get("sites");
      const j = cur.findIndex((s) => s.id === site.id);
      if (j >= 0) { cur[j].enabled = true; await chrome.storage.local.set({ sites: cur }); }
      try { await chrome.runtime.sendMessage({ cmd: "sync" }); } catch {}
      say("已啟用，重新整理這一頁就會生效。");
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { window.__AL_FORCE__ = true; },
      });
      await inject(["lib/selector.js", "content.js"]);
      window.close();
    } catch (e) { say("填入失敗：" + e.message); }
  };

  $("opts").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
})();
