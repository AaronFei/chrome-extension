// Classroom Wake — 內容就緒偵測（isolated world），給方案 B 決定何時切回
(() => {
  const isReady = () =>
    document.body && document.body.innerText.length > 1000 &&
    document.querySelectorAll('[role=progressbar]').length === 0;
  let n = 0;
  const tick = () => {
    if (isReady()) {
      try { chrome.runtime.sendMessage({ type: 'classroom-ready' }); } catch {}
      return;
    }
    if (++n < 60) setTimeout(tick, 500);
  };
  tick();
})();
