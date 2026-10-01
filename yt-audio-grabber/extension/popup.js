const $ = s => document.querySelector(s);
const send = m => chrome.runtime.sendMessage(m).catch(e => ({ ok: false, error: e.message }));

function fmtBytes(b) {
  if (!b) return "";
  const u = ["B","KB","MB","GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + " " + u[i];
}

async function init() {
  $("#ver").textContent = "v" + chrome.runtime.getManifest().version;
  const c = await chrome.storage.local.get({ format: "original" });
  $("#format").value = c.format;
  $("#format").addEventListener("change", e =>
    chrome.storage.local.set({ format: e.target.value }));

  await fillCurrentTab();

  const h = await send({ type: "health" });
  if (h.ok) {
    $("#status").className = "dot ok";
    $("#status").title = "helper OK · yt-dlp " + (h.data.ytdlp_version || "?");
    $("#out").textContent = h.data.output_dir || "";
    if (!h.data.ytdlp) $("#msg").textContent = "helper 有跑，但找不到 yt-dlp（跑 install.sh）";
    if (!h.data.auth)  $("#msg").textContent = "token 未設定或不符 — 請到設定頁貼上";
  } else {
    $("#status").className = "dot bad";
    $("#msg").textContent = h.error;
  }
  refresh();
  setInterval(refresh, 1000);
}


// Grab the active tab's URL. tab.url is only populated once activeTab has been
// granted (which happens when the popup is opened); if it is still empty we ask
// the content script on the page directly.
async function fillCurrentTab() {
  const box = $("#url");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    let url = tab.url || "";
    let title = tab.title || "";
    if (!/youtube\.com|youtu\.be/.test(url)) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "geturl" });
        if (r && r.url) { url = r.url; title = r.title || title; }
      } catch { /* content script not present on this page */ }
    }
    if (/youtube\.com|youtu\.be/.test(url)) {
      box.value = url;
      box.title = title;
    }
  } catch (e) { /* ignore */ }
}

async function refresh() {
  const r = await send({ type: "jobs" });
  if (!r.ok) return;
  const jobs = r.data.jobs || [];
  const active = jobs.filter(j => j.status === "queued" || j.status === "running").map(j => j.id);
  if (active.length) send({ type: "watch", ids: active });
  $("#jobs").innerHTML = jobs.map(j => {
    const pct = Math.floor(j.progress || 0);
    const name = j.title || j.url;
    const running = j.status === "queued" || j.status === "running";
    let meta = "";
    if (j.status === "error") meta = (j.error || "").split("\n").slice(-1)[0];
    else if (j.status === "done") meta = (j.file || "").split("/").pop() + (j.bytes ? " · " + fmtBytes(j.bytes) : "");
    else if (j.status === "running") meta = j.stage === "processing"
      ? "轉檔／寫入 metadata…"
      : [j.size, j.speed, j.eta && ("ETA " + j.eta)].filter(Boolean).join(" · ");
    else meta = j.status;
    return `<div class="job ${j.status}">
      <div class="t">
        <span class="name" title="${esc(name)}">${esc(name)}</span>
        <span class="pct">${j.status === "done" ? "✓" : j.status === "error" ? "✗" : pct + "%"}</span>
        ${running ? `<span class="x" data-cancel="${j.id}">✕</span>` : ""}
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
    </div>`;
  }).join("") || `<div class="meta" style="padding-top:8px">尚無下載紀錄</div>`;

  document.querySelectorAll("[data-cancel]").forEach(el =>
    el.onclick = () => send({ type: "cancel", id: el.dataset.cancel }).then(refresh));
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

$("#go").addEventListener("click", async () => {
  $("#msg").textContent = "";
  if (!$("#url").value.trim()) await fillCurrentTab();
  const url = $("#url").value.trim();
  if (!url) { $("#msg").textContent = "抓不到目前分頁，請手動貼上 YouTube 網址"; return; }
  const r = await send({ type: "download", url, format: $("#format").value });
  if (!r.ok) $("#msg").textContent = r.error;
  refresh();
});
$("#url").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });
$("#clear").addEventListener("click", e => { e.preventDefault(); send({ type: "clear" }).then(refresh); });
$("#opts").addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

init();
