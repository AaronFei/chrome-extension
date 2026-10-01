// YT Audio Grabber - service worker
const DEFAULTS = { port: 8787, token: "", format: "original", notify: true };

async function cfg() {
  const c = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...c };
}
function base(c) { return `http://127.0.0.1:${c.port}`; }

async function api(path, { method = "GET", body = null } = {}) {
  const c = await cfg();
  const res = await fetch(base(c) + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": c.token || ""
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || res.statusText }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function notify(title, message) {
  cfg().then(c => {
    if (!c.notify) return;
    chrome.notifications.create({
      type: "basic", iconUrl: "icons/128.png", title, message
    });
  });
}

// ---- badge / polling -------------------------------------------------
let timer = null;
const watching = new Set();

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function poll() {
  if (!watching.size) { stopPolling(); setBadge(""); return; }
  let active = 0, worstPct = 100;
  for (const id of [...watching]) {
    let j;
    try { j = await api(`/job?id=${encodeURIComponent(id)}`); }
    catch { watching.delete(id); continue; }
    broadcast({ type: "job", job: j });
    if (j.status === "done") {
      watching.delete(id);
      notify("下載完成", j.title || j.file || j.url);
    } else if (j.status === "error") {
      watching.delete(id);
      notify("下載失敗", (j.error || "").split("\n").slice(-1)[0] || j.url);
    } else if (j.status === "canceled") {
      watching.delete(id);
    } else {
      active++;
      worstPct = Math.min(worstPct, j.progress || 0);
    }
  }
  if (active) setBadge(`${Math.floor(worstPct)}%`, "#cc0000");
  else { setBadge("✓", "#1a7f37"); setTimeout(() => setBadge(""), 4000); stopPolling(); }
}

function startPolling() {
  if (timer) return;
  timer = setInterval(poll, 1000);
}
function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// ---- message router --------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case "health":   return reply({ ok: true, data: await api("/health") });
        case "jobs":     return reply({ ok: true, data: await api("/jobs") });
        case "cancel":   return reply({ ok: true, data: await api("/cancel", { method: "POST", body: { id: msg.id } }) });
        case "clear":    return reply({ ok: true, data: await api("/clear", { method: "POST", body: {} }) });
        case "getconfig": return reply({ ok: true, data: await api("/config") });
        case "setconfig": return reply({ ok: true, data: await api("/config", { method: "POST", body: msg.patch || {} }) });
        case "download": {
          const c = await cfg();
          if (!c.token) {
            notify("尚未設定", "請先在 options 頁面貼上 helper token");
            chrome.runtime.openOptionsPage();
            return reply({ ok: false, error: "no token" });
          }
          const job = await api("/download", {
            method: "POST",
            body: { url: msg.url, format: msg.format || c.format, title: msg.title || "" }
          });
          watching.add(job.id);
          startPolling();
          return reply({ ok: true, data: job });
        }
        case "watch":
          (msg.ids || []).forEach(id => watching.add(id));
          if (watching.size) startPolling();
          return reply({ ok: true });
        default:
          return reply({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      const hint = /Failed to fetch/i.test(e.message)
        ? "連不到本機 helper — 請確認服務有啟動（launchctl / install.sh）"
        : e.message;
      return reply({ ok: false, error: hint });
    }
  })();
  return true; // async
});

chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
});
