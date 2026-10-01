// YT Audio Grabber - injects a download-audio button into the YouTube player
(() => {
  const VER = chrome.runtime.getManifest().version;
  console.info("[YT Audio Grabber] content script v" + VER + " loaded");
  const SVG_DL = `<svg height="100%" viewBox="0 0 36 36" width="100%" fill="#fff">
      <path d="M18 8v11m0 0 5-5m-5 5-5-5" stroke="#fff" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <rect x="10" y="24" width="16" height="2.4" rx="1.2"/>
      <rect x="11.5" y="10.5" width="1.8" height="7" rx=".9" opacity=".85"/>
      <rect x="22.7" y="12" width="1.8" height="4" rx=".9" opacity=".85"/>
    </svg>`;

  function currentUrl() {
    const id = new URLSearchParams(location.search).get("v");
    if (id) return `https://www.youtube.com/watch?v=${id}`;
    const m = location.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    return location.href;
  }
  function currentTitle() {
    const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
               document.querySelector(".ytmusic-player-bar .title") ||
               document.querySelector("h1.title");
    return (el && el.textContent.trim()) || document.title.replace(/ - YouTube.*$/, "");
  }

  function setState(btn, state, text) {
    btn.dataset.state = state;
    const label = btn.querySelector(".ytag-label");
    if (state === "idle") { btn.innerHTML = SVG_DL; btn.title = "下載音檔 (YT Audio Grabber)"; }
    else { btn.innerHTML = `<span class="ytag-label">${text}</span>`; btn.title = text; }
  }

  async function onClick(btn) {
    if (btn.dataset.state === "busy") return;
    setState(btn, "busy", "…");
    const resp = await chrome.runtime.sendMessage({
      type: "download", url: currentUrl(), title: currentTitle()
    }).catch(e => ({ ok: false, error: e.message }));

    if (!resp || !resp.ok) {
      setState(btn, "error", "!");
      btn.title = (resp && resp.error) || "失敗";
      setTimeout(() => setState(btn, "idle"), 4000);
      return;
    }
    const jobId = resp.data.id;
    const tick = setInterval(async () => {
      const r = await chrome.runtime.sendMessage({ type: "jobs" }).catch(() => null);
      if (!r || !r.ok) return;
      const j = (r.data.jobs || []).find(x => x.id === jobId);
      if (!j) return;
      if (j.status === "done")   { clearInterval(tick); setState(btn, "done", "✓"); setTimeout(() => setState(btn, "idle"), 4000); }
      else if (j.status === "error")    { clearInterval(tick); setState(btn, "error", "!"); btn.title = j.error || "失敗"; setTimeout(() => setState(btn, "idle"), 6000); }
      else if (j.status === "canceled") { clearInterval(tick); setState(btn, "idle"); }
      else setState(btn, "busy", Math.floor(j.progress || 0) + "%");
    }, 800);
  }

  function makeBtn() {
    const btn = document.createElement("button");
    btn.className = "ytp-button ytag-btn";
    setState(btn, "idle");
    btn.addEventListener("click", e => { e.stopPropagation(); onClick(btn); });
    return btn;
  }

  // insertBefore() requires the reference node to be a DIRECT child of the
  // node it is called on. Current YouTube nests .ytp-settings-button inside a
  // wrapper (.ytp-right-controls-left), so anchoring off .ytp-right-controls
  // throws NotFoundError. Always insert relative to the anchor's own parent.
  function placeBefore(container, btn, anchor) {
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
    else container.appendChild(btn);
  }

  function inject() {
    try {
      // a page can host several players (watch, miniplayer, hover previews),
      // so mount per-container and let the presence of our button be the guard
      // — that way we re-attach if YouTube rebuilds the control bar.
      document.querySelectorAll(".ytp-right-controls").forEach(right => {
        if (right.querySelector(".ytag-btn")) return;
        placeBefore(right, makeBtn(), right.querySelector(".ytp-settings-button"));
      });
      document.querySelectorAll("ytmusic-player-bar .right-controls-buttons").forEach(bar => {
        if (bar.querySelector(".ytag-btn")) return;
        const btn = makeBtn();
        btn.classList.add("ytag-ytm");
        bar.prepend(btn);
      });
    } catch (e) {
      console.warn("[YT Audio Grabber] inject failed:", e);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === "geturl") {
      reply({ url: currentUrl(), title: currentTitle() });
    }
    return false;
  });

  let queued = false;
  const obs = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; inject(); });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", () => setTimeout(inject, 400));
  setInterval(inject, 2000);
  inject();
})();
