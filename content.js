/* Auto Login — content script
 * 設定從 chrome.storage.local 讀，由 background.js 動態註冊到有授權的網域。
 *
 * 另外會在頁面上掛一個隱藏的狀態節點 #ai-auth-state，讓自動化（例如 Claude in Chrome）
 * 可以直接讀 dataset 知道現在的狀態，不用靠猜秒數、看截圖或翻 console。
 * 為什麼走 DOM：content script 在 ISOLATED world、javascript_tool 在 MAIN world，
 * 兩邊的 window 不互通，但 DOM 是共用的。
 */
(async () => {
  "use strict";

  // ================= AI 橋接狀態節點 =================
  const NODE_ID = "ai-auth-state";
  const CONTRACT = "2";

  // state:
  //   unknown        剛注入，還在判斷
  //   no-credentials content script 有跑，但這個網址沒有對應的設定
  //   logged-out     頁面上有登入表單，準備填
  //   pending        已送出，等結果（頁面通常會導頁，這個 world 就整個換掉）
  //   filled         已填入但設定成不自動送出，等人按
  //   success        頁面上沒有登入表單（＝已登入，或這頁本來就不是登入頁）
  //   error          看 data-error-code
  //
  // error-code:
  //   BRIDGE_INIT_FAILED  lib/selector.js 沒載到
  //   BAD_CREDENTIALS     送出後回到登入頁且頁面有錯誤訊息 → 帳密錯，立刻停手不再重試
  //   FORM_NOT_FOUND      有密碼欄但找不到帳號欄（多半是網站改版）
  //   CAPTCHA_REQUIRED    偵測到驗證碼，已停手，需要人處理
  //   RETRY_LIMIT         連續嘗試達上限仍停在登入頁，已停手（避免鎖帳號）
  //   SUBMIT_NO_EFFECT    送出後 15 秒頁面沒動靜，登入表單還在
  //   STORAGE_ERROR       讀不到設定

  const node = (() => {
    let el = document.getElementById(NODE_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = NODE_ID;
      el.hidden = true;
    }
    const d = el.dataset;
    d.contractVersion = CONTRACT;
    try { d.extVersion = chrome.runtime.getManifest().version; } catch { d.extVersion = "?"; }
    d.site = location.host;
    d.siteId = d.siteId || "";
    d.account = d.account || "";   // 這次用的是哪組帳號（來自設定，不從 DOM 抓）
    d.attempt = d.attempt || "0";
    d.errorCode = "";
    d.errorMsg = "";
    d.state = "unknown";
    d.logKey = "__autologin_log";   // sessionStorage 裡的轉換紀錄（跨導頁）
    d.updatedAt = new Date().toISOString();
    if (!el.isConnected) document.documentElement.appendChild(el);
    return el;
  })();

  // 狀態轉換紀錄。存 sessionStorage 是因為它跨導頁還在 —— 而登入流程一定會導頁。
  // 自動化端的工具往返延遲常常比一次狀態轉換還久，只讀「現在的狀態」會整段錯過，
  // 所以另外留一份「剛剛發生了什麼」給它事後讀。
  const LOG_KEY = "__autologin_log";
  const pushLog = (state, code) => {
    try {
      const arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      const last = arr[arr.length - 1];
      if (last && last.state === state && last.path === location.pathname) return;
      arr.push({
        at: new Date().toISOString(),
        state, code: code || "",
        path: location.pathname + location.search,
        attempt: Number(node.dataset.attempt || 0),
      });
      while (arr.length > 30) arr.shift();
      sessionStorage.setItem(LOG_KEY, JSON.stringify(arr));
    } catch {}
  };

  const setState = (state, extra = {}) => {
    // 有些網站會重繪 documentElement，掉了就補回去
    if (!node.isConnected) document.documentElement.appendChild(node);
    const d = node.dataset;
    if (extra.siteId !== undefined)  d.siteId  = String(extra.siteId ?? "");
    if (extra.account !== undefined) d.account = String(extra.account ?? "");
    if (extra.attempt !== undefined) d.attempt = String(extra.attempt ?? 0);
    d.errorCode = String(extra.errorCode ?? "");
    d.errorMsg  = String(extra.errorMsg ?? "").slice(0, 300);
    d.updatedAt = new Date().toISOString();
    d.state     = state;   // 最後才寫，讀取方以這個欄位為準
    pushLog(state, d.errorCode);
    try {
      document.dispatchEvent(new CustomEvent("ai-auth:state", { detail: { state, ...extra } }));
    } catch {}
  };
  // ==================================================

  const T0 = Date.now();   // 量測基準：content script 開跑的時間（document_idle）

  const LOG  = (...a) => console.log("%c[AutoLogin]", "color:#3b82f6;font-weight:bold", ...a);
  const WARN = (...a) => console.warn("[AutoLogin]", ...a);

  const AL = window.__AL__;
  if (!AL) {
    setState("error", { errorCode: "BRIDGE_INIT_FAILED", errorMsg: "lib/selector.js 未載入" });
    return;
  }

  const FORCE = window.__AL_FORCE__ === true;   // 從 popup 手動觸發
  window.__AL_FORCE__ = false;

  // ---------- 1. 找出這個網址對應的設定 ----------
  let sites = [], siteStats = {};
  try {
    ({ sites = [], siteStats = {} } = await chrome.storage.local.get(["sites", "siteStats"]));
  } catch (e) {
    setState("error", { errorCode: "STORAGE_ERROR", errorMsg: String(e) });
    return;
  }

  const matches = (s) => {
    if (s.enabled === false) return false;
    if (s.host && s.host.toLowerCase() !== location.host.toLowerCase()) return false;
    if (s.urlContains && !location.href.toLowerCase().includes(s.urlContains.toLowerCase())) return false;
    if (s.urlRegex) {
      try { if (!new RegExp(s.urlRegex, "i").test(location.href)) return false; } catch { return false; }
    }
    return true;
  };

  const site = sites.find(matches);
  if (!site) { setState("no-credentials"); return; }
  LOG("符合設定：", site.label || site.host);

  // ---------- 2. 失敗保護：連續 3 次仍停在登入頁就停手 ----------
  const MAX_TRIES = 3;
  const KEY = "__autologin_tries__" + site.id;
  const readTries  = () => { try { return Number(sessionStorage.getItem(KEY) || 0); } catch { return 0; } };
  const writeTries = (n) => { try { sessionStorage.setItem(KEY, String(n)); } catch {} };
  const clearTries = () => { try { sessionStorage.removeItem(KEY); } catch {} };

  // 判定「不該再試」之後要記住，否則同一分頁下一次載入又會從頭來一遍
  const HALT_KEY = "__autologin_halt__" + site.id;
  const readHalt  = () => { try { return JSON.parse(sessionStorage.getItem(HALT_KEY) || "null"); } catch { return null; } };
  const setHalt   = (code, msg) => { try { sessionStorage.setItem(HALT_KEY, JSON.stringify({ code, msg })); } catch {} };
  const clearHalt = () => { try { sessionStorage.removeItem(HALT_KEY); } catch {} };

  const tries = FORCE ? 0 : readTries();
  if (FORCE) { clearTries(); clearHalt(); }

  setState("unknown", { siteId: site.id, account: site.username || "", attempt: tries });

  window.__autologinReset = () => { clearTries(); clearHalt(); LOG("已重置嘗試次數，重新整理即可再試。"); };

  // ---------- 3. 找欄位（優先用存下來的 selector，找不到就自動偵測） ----------
  const pick = (sel, fallback) => {
    if (sel) {
      const el = AL.q(sel);
      if (el && AL.visible(el)) return el;
    }
    return fallback();
  };

  let sawPassword = false;   // 這一頁到底有沒有出現過密碼欄
  let renderMs = null;       // 密碼欄是開跑後多久才出現的（用來自動判斷這站快不快）
  let staleWarned = false;   // selector 失效的提醒只印一次

  const resolve = () => {
    const passEl = pick(site.passSel, AL.findPassword);
    if (!passEl || !AL.visible(passEl)) return null;
    if (!sawPassword) {
      sawPassword = true;
      renderMs = Date.now() - T0;
      setState("logged-out", { attempt: tries });   // 一看到密碼欄就先回報，別讓對方乾等
    }

    const userEl = pick(site.userSel, () => AL.findUsername(passEl));
    if (!userEl) return null;

    // 確定是登入頁、而且存下來的 selector 真的沒抓到時，才提醒一次
    if (!staleWarned) {
      const stale = [[site.passSel, passEl], [site.userSel, userEl]]
        .filter(([sel, el]) => sel && AL.q(sel) !== el)
        .map(([sel]) => sel);
      if (stale.length) {
        staleWarned = true;
        WARN("存下來的 selector 已失效，改用自動偵測：", stale.join(", "),
             "→ 建議點 extension 圖示重新設定這個網站");
      }
    }
    return { userEl, passEl };
  };

  // 登入失敗訊息：站台配方（errorSel）優先，沒設就用通用偵測
  const detectError = () => {
    if (site.errorSel) {
      const el = AL.q(site.errorSel);
      if (!el || !AL.visible(el)) return null;
      const t = (el.innerText || el.textContent || "").trim();
      return t ? { text: t.slice(0, 200), via: "errorSel" } : null;
    }
    return AL.findError();
  };

  // 驗證碼偵測 —— 我們不會也不該代填，看到就停手並回報
  const CAPTCHA_SEL = [
    'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]', 'iframe[src*="turnstile" i]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile',
    'img[src*="captcha" i]', 'img[src*="validatecode" i]', 'img[src*="verifycode" i]',
    'input[name*="captcha" i]', 'input[name*="validatecode" i]', 'input[name*="verifycode" i]',
    'input[id*="captcha" i]',
  ].join(", ");
  const hasCaptcha = () => {
    try { return [...document.querySelectorAll(CAPTCHA_SEL)].some(AL.visible); }
    catch { return false; }
  };

  // ---------- 4. 等欄位出現（SPA 可能慢慢 render） ----------
  const WAIT_MS = site.waitMs ?? 12000;  // 已經看到密碼欄：最多再等這麼久
  // 從頭到尾沒有密碼欄：頁面載完後只再等這麼久（不然站內每一頁都會空轉 12 秒）。
  //
  // 這個值太短會出事：慢慢 render 登入表單的 SPA 會在表單出現前就被判成 success，
  // autofill 靜默地永遠不觸發。太長只是慢。所以盲測預設偏保守，但會自己學：
  // 在登入頁量到密碼欄多久出現（renderMs），下次就用推導值。使用者手動填的一律優先。
  const stat = siteStats[site.id] || {};
  const deriveIdle = (ms) =>
    ms == null ? null : Math.min(4000, Math.max(1000, Math.round(ms * 3 + 800)));
  const IDLE_MS = site.idleMs ?? deriveIdle(stat.renderMs) ?? 4000;
  node.dataset.idleMs = String(IDLE_MS);

  // 觀測值存在 siteStats（不是 sites）—— 寫 sites 會觸發 background 重新註冊 content script，
  // 每次逛登入頁都重註冊一次太浪費。
  const persistStat = async () => {
    if (renderMs == null) return;
    if (stat.renderMs != null && Math.abs(stat.renderMs - renderMs) < 300) return;
    try {
      const cur = (await chrome.storage.local.get("siteStats")).siteStats || {};
      cur[site.id] = { renderMs, at: new Date().toISOString() };
      await chrome.storage.local.set({ siteStats: cur });
      LOG(`已記錄這站的登入表單 render 時間：${renderMs}ms → 空頁等待自動設為 ${deriveIdle(renderMs)}ms`);
    } catch {}
  };

  const waitForFields = () =>
    new Promise((resolve_) => {
      const started = Date.now();
      const check = () => {
        const found = resolve();
        if (found) { cleanup(); resolve_(found); return true; }
        const waited = Date.now() - started;
        const giveUp = waited > WAIT_MS ||
          (!sawPassword && document.readyState === "complete" && waited > IDLE_MS);
        if (giveUp) { cleanup(); resolve_(null); return true; }
        return false;
      };
      const obs = new MutationObserver(() => check());
      const timer = setInterval(check, 400);
      const cleanup = () => { obs.disconnect(); clearInterval(timer); };
      obs.observe(document.documentElement, { childList: true, subtree: true });
      check();
    });

  // ---------- 5. 主流程 ----------
  const found = await waitForFields();

  if (!found) {
    // 有看到密碼欄卻湊不出帳號欄 → 是登入頁但表單對不上，不是「已登入」
    if (sawPassword) {
      setState("error", { errorCode: "FORM_NOT_FOUND", errorMsg: "有密碼欄但找不到帳號欄" });
      WARN("有密碼欄但找不到帳號欄，可能是網站改版。");
      return;
    }
    // 這一頁沒有登入欄位 → 代表上一次登入成功（或這頁不是登入頁），把失敗計數歸零。
    // 這一步一定要在 MAX_TRIES 檢查之前，否則計數只加不減，登入幾次之後就再也不會填了。
    if (tries > 0) { clearTries(); LOG("這一頁沒有登入欄位，視為已登入，重置嘗試次數。"); }
    clearHalt();
    setState("success", { attempt: 0 });
    return;
  }

  const RESUME = " 想再試請按 extension 圖示的「立即填入」，或在 console 執行 __autologinReset() 後重新整理。";

  // 上一次已經判定不該再試（例如帳密錯）—— 同分頁後續載入直接停，不要又送一次
  const halted = readHalt();
  if (halted) {
    setState("error", { errorCode: halted.code, errorMsg: halted.msg, attempt: tries });
    return;
  }

  // 送出過卻又回到登入頁 → 看頁面上有沒有錯誤訊息。
  // 有 = 帳密錯，立刻停手且**不消耗剩下的嘗試次數**（接 AD 的系統重試就是在鎖帳號）。
  // 沒有 = 這次可能只是沒送成功，交給 MAX_TRIES 再給機會。
  if (tries > 0) {
    const err = detectError();
    if (err) {
      const msg = `登入被拒：${err.text}`;
      setHalt("BAD_CREDENTIALS", msg);
      setState("error", { errorCode: "BAD_CREDENTIALS", errorMsg: msg, attempt: tries });
      WARN(msg + "（已停止，不會再重試以免鎖帳號）" + RESUME);
      return;
    }
  }

  if (tries >= MAX_TRIES) {
    const msg = `已連續嘗試 ${tries} 次仍停在登入頁，暫停自動登入以免鎖帳號。`;
    setState("error", { errorCode: "RETRY_LIMIT", errorMsg: msg, attempt: tries });
    WARN(msg + RESUME);
    return;
  }

  persistStat();   // 確定是登入頁了，把 render 時間記起來給非登入頁用

  const { userEl, passEl } = found;
  LOG("找到欄位：", { user: userEl, pass: passEl });

  AL.setValue(userEl, site.username || "");
  AL.setValue(passEl, site.password || "");

  if (site.extra) {
    for (const [sel, val] of Object.entries(site.extra)) {
      const el = AL.q(sel);
      if (el) AL.setValue(el, val);
      else WARN("extra 找不到欄位：", sel);
    }
  }

  // 有驗證碼就只填不送 —— 硬送只會浪費一次嘗試次數
  if (hasCaptcha()) {
    setState("error", {
      errorCode: "CAPTCHA_REQUIRED",
      errorMsg: "頁面上有驗證碼，已填入帳密但不送出，需要人工完成",
      attempt: tries,
    });
    WARN("偵測到驗證碼，已填入但不送出。");
    return;
  }

  if (site.autoSubmit === false) {
    LOG("已填入，未自動送出（autoSubmit: false）。");
    setState("filled", { attempt: tries });
    return;
  }

  writeTries(tries + 1);
  setState("pending", { attempt: tries + 1 });

  setTimeout(() => {
    const btn = pick(site.submitSel, () => AL.findSubmit(passEl));
    if (btn) {
      LOG(`送出登入（第 ${tries + 1} 次嘗試）：`, btn);
      btn.click();
    } else if (passEl.form) {
      LOG("找不到按鈕，改用 form.submit()");
      passEl.form.requestSubmit ? passEl.form.requestSubmit() : passEl.form.submit();
    } else {
      LOG("找不到按鈕，改按 Enter");
      passEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    }

    // 逾時保護放在 content script，不放 background：
    // MV3 的 service worker 隨時可能被回收，timer 跟著沒了，狀態就會永遠卡在 pending。
    // content script 的生命週期綁在頁面上，頁面還在它就還在。
    // 正常情況下這裡會導頁，整個 world 連同這個 timer 一起消失，所以它只在「沒導頁」時才燒到。
    setTimeout(() => {
      if (node.dataset.state !== "pending") return;
      const stillLogin = !!AL.findPassword();
      setState("error", {
        errorCode: stillLogin ? "SUBMIT_NO_EFFECT" : "TIMEOUT",
        errorMsg: "送出後 15 秒頁面沒有變化",
        attempt: tries + 1,
      });
      WARN("送出後 15 秒頁面沒有變化。");
    }, 15000);
  }, site.delay ?? 300);
})();
