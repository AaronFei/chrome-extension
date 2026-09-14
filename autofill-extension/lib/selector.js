/* Auto Login — 共用工具（selector 產生 + 欄位偵測）
 * content.js 和 picker.js 都會用到，注入時放在第一個。
 */
(() => {
  "use strict";
  if (window.__AL__) return; // 已注入過就不重複定義

  // ---------- 基本工具 ----------
  const visible = (el) => {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const label = (el) =>
    ((el.innerText || el.value || el.getAttribute?.("aria-label") || "") + "").trim();

  const q = (sel) => {
    try { return sel ? document.querySelector(sel) : null; } catch { return null; }
  };

  // 像真人一樣寫入欄位（相容 React / Vue 這類會攔 setter 的框架）
  const setValue = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement   ? HTMLSelectElement.prototype :
                                          HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.blur();
  };

  // ---------- 產生穩定的 CSS selector ----------
  const cssEsc = (s) =>
    (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, (m) => "\\" + m);

  const attrVal = (v) => '"' + String(v).replace(/["\\]/g, "\\$&") + '"';

  // 看起來像框架亂數產生的 id 就別用（換頁就變了）
  const generated = (s) =>
    !s || /^\d/.test(s) || /\d{4,}/.test(s) ||
    /^(:r|react-|ember|mui-|radix-|headlessui-|v-|ng-)/i.test(s) ||
    s.length > 60;

  const buildSelector = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const uniq = (s) => {
      try { return document.querySelectorAll(s).length === 1 && document.querySelector(s) === el; }
      catch { return false; }
    };
    const tag = el.tagName.toLowerCase();

    // 1. id 最穩
    if (el.id && !generated(el.id)) {
      const s = "#" + cssEsc(el.id);
      if (uniq(s)) return s;
    }
    // 2. name（表單欄位幾乎都有，而且伺服器端要用，不會亂改）
    if (el.name && !generated(el.name)) {
      const s = `${tag}[name=${attrVal(el.name)}]`;
      if (uniq(s)) return s;
    }
    // 3. 測試用／語意化屬性
    for (const a of ["data-testid", "data-test", "data-qa", "data-cy", "autocomplete", "aria-label", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v && v.length <= 40) {
        const s = `${tag}[${a}=${attrVal(v)}]`;
        if (uniq(s)) return s;
      }
    }
    // 4. type
    if (el.type) {
      const s = `${tag}[type=${attrVal(el.type)}]`;
      if (uniq(s)) return s;
    }
    // 5. 最後才用路徑（往上找到穩定 id 就停）
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      if (node !== el && node.id && !generated(node.id)) {
        parts.unshift("#" + cssEsc(node.id));
        const s = parts.join(" > ");
        return uniq(s) ? s : null;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const s = parts.join(" > ");
      if (uniq(s)) return s;
      node = parent;
    }
    return null;
  };

  // ---------- 自動偵測欄位 ----------
  const findPassword = () =>
    [...document.querySelectorAll('input[type="password"]')].find(visible) || null;

  const findUsername = (passEl) => {
    const CAND = 'input[type="text"], input[type="email"], input[type="tel"], input:not([type])';
    const scope = passEl?.form || document;
    const inputs = [...scope.querySelectorAll(CAND)].filter(visible);
    if (!inputs.length) return null;
    if (passEl) {
      // 密碼欄「前面」最近的那個文字欄
      const before = inputs.filter(
        (el) => el.compareDocumentPosition(passEl) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (before.length) return before[before.length - 1];
    }
    const KW = /user|account|login|email|acct|uid|id$/i;
    return inputs.find((el) =>
      KW.test(`${el.name} ${el.id} ${el.autocomplete || ""}`)) || inputs[0];
  };

  // 先用文字關鍵字挑，再退回第一個 submit。
  // 這樣才不會按到同一個 form 裡的「忘記密碼 / 密碼重置 / 註冊」。
  const GOOD = /log\s?in|sign\s?in|登入|登錄|登陸|送出|確定|submit|continue|next|下一步/i;
  const BAD  = /forgot|reset|register|sign\s?up|cancel|clear|忘記|重設|重置|註冊|取消|清除|返回|back/i;

  const findSubmit = (passEl) => {
    const scope = passEl?.form || document;
    const cands = [...scope.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]'
    )].filter(visible);
    return cands.find((el) => GOOD.test(label(el)) && !BAD.test(label(el)))
        || cands.find((el) => el.type === "submit" && !BAD.test(label(el)))
        || null;
  };

  // ---------- 登入失敗訊息偵測 ----------
  // 用途：送出後又回到登入頁時，用來分辨「帳密錯」和「這次沒送成功」。
  // 這個判斷是刻意偏保守的 —— 誤判成帳密錯只會讓 extension 停手（你手動登入即可），
  // 漏判卻可能讓自動化把接 AD 的帳號重試到鎖住。兩種錯的代價差很多。
  const ERROR_SEL = [
    '[role="alert"]',
    '.error', '.errors', '.error-message', '.errorMessage', '.error-msg',
    '.alert-danger', '.alert-error', '.is-error', '.has-error',
    '.aui-message-error', '.aui-message.error',        // Atlassian
    '.validation-summary-errors',                       // ASP.NET MVC
    '[class*="error" i]', '[id*="error" i]', '[class*="invalid" i]',
  ].join(", ");

  const ERROR_TEXT =
    /密碼錯誤|帳號或密碼|使用者名稱或密碼|帳號.{0,6}密碼.{0,8}(錯誤|不正確|有誤|不符)|登入失敗|驗證失敗|認證失敗|已被鎖定|帳號鎖定|incorrect|invalid\s+(user|username|password|credential|login)|wrong\s+password|login\s+fail|authentication\s+fail|not\s+recogni[sz]ed|account\s+(is\s+)?locked/i;

  const findError = () => {
    // 1. 先找結構化的錯誤元素（要可見、要有文字，才不會被永遠存在的空容器騙到）
    try {
      for (const el of document.querySelectorAll(ERROR_SEL)) {
        if (!visible(el)) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (!t || t.length > 300) continue;
        return { text: t.slice(0, 200), via: "element" };
      }
    } catch {}
    // 2. 退而找文字，只看葉節點且限制長度，避免整頁 body 命中
    try {
      let n = 0;
      for (const el of document.querySelectorAll("span, div, p, li, td, strong, label, b, small")) {
        if (++n > 4000) break;
        if (el.children.length) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (!t || t.length > 120) continue;
        if (ERROR_TEXT.test(t) && visible(el)) return { text: t.slice(0, 200), via: "text" };
      }
    } catch {}
    return null;
  };

  const detect = () => {
    const passEl = findPassword();
    if (!passEl) return null;
    return { userEl: findUsername(passEl), passEl, submitEl: findSubmit(passEl) };
  };

  window.__AL__ = {
    visible, label, q, setValue, buildSelector,
    findPassword, findUsername, findSubmit, findError, detect, GOOD, BAD,
  };
})();
