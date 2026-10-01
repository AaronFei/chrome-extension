document.querySelector("#overs").textContent = "v" + chrome.runtime.getManifest().version;
const $ = s => document.querySelector(s);
const DEFAULTS = { port: 8787, token: "", format: "original", notify: true };

chrome.storage.local.get(DEFAULTS).then(c => {
  $("#port").value = c.port;
  $("#token").value = c.token;
  $("#format").value = c.format;
  $("#notify").checked = !!c.notify;
});

$("#save").onclick = async () => {
  await chrome.storage.local.set({
    port: parseInt($("#port").value, 10) || 8787,
    token: $("#token").value.trim(),
    format: $("#format").value,
    notify: $("#notify").checked
  });
  show("已儲存。", "ok");
  loadHelperConfig();
};

$("#test").onclick = async () => {
  show("測試中…");
  const r = await chrome.runtime.sendMessage({ type: "health" }).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) return show("✗ " + r.error, "bad");
  const d = r.data;
  const lines = [
    (d.auth ? "✓ 連線成功，token 正確" : "⚠ 連線成功，但 token 不符"),
    "yt-dlp : " + (d.ytdlp ? d.ytdlp + "  (" + (d.ytdlp_version || "?") + ")" : "找不到 — 請跑 install.sh"),
    "ffmpeg : " + (d.ffmpeg ? "OK" : "找不到 — 轉檔/嵌入封面會失敗"),
    "輸出   : " + d.output_dir
  ];
  show(lines.join("\n"), d.auth && d.ytdlp ? "ok" : "bad");
};

function show(t, cls) { const r = $("#result"); r.textContent = t; r.className = cls || ""; }


// ---- helper-side config (output folder etc.) ------------------------
async function loadHelperConfig() {
  const r = await chrome.runtime.sendMessage({ type: "getconfig" }).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) {
    $("#hcfg").classList.add("hidden");
    $("#hcfgoff").classList.remove("hidden");
    $("#hcfgoff").textContent = "讀不到 helper 設定：" + r.error;
    return;
  }
  const c = r.data;
  $("#outdir").value = c.output_dir || "";
  $("#cookies").value = c.cookies_from_browser || "";
  $("#embedmeta").checked = c.embed_metadata !== false;
  $("#embedthumb").checked = c.embed_thumbnail !== false;
  $("#hcfg").classList.remove("hidden");
  $("#hcfgoff").classList.add("hidden");
}

$("#hsave").onclick = async () => {
  const el = $("#hresult");
  el.textContent = "套用中…"; el.className = "";
  const r = await chrome.runtime.sendMessage({
    type: "setconfig",
    patch: {
      output_dir: $("#outdir").value.trim(),
      cookies_from_browser: $("#cookies").value,
      embed_metadata: $("#embedmeta").checked,
      embed_thumbnail: $("#embedthumb").checked
    }
  }).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { el.textContent = "✗ " + r.error; el.className = "bad"; return; }
  $("#outdir").value = r.data.output_dir;
  el.textContent = r.data._saved
    ? "✓ 已套用並寫入 config.json\n輸出資料夾：" + r.data.output_dir
    : "⚠ 已套用到執行中的服務，但寫入 config.json 失敗（重啟後會還原）";
  el.className = r.data._saved ? "ok" : "bad";
};

loadHelperConfig();
