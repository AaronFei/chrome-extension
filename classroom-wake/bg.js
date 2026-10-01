// Classroom Wake — 方案 B：背景群組分頁載入時切到前景幾秒再切回（預設關閉）
const TAG = '[ClassroomWake]';
const HOLD_MS = 6000;
const active = new Map(); // wakingTabId -> { prevTabId, timer }

async function enabled() {
  const { planB = false } = await chrome.storage.local.get('planB');
  return planB;
}

async function restore(tabId, why) {
  const st = active.get(tabId);
  if (!st) return;
  active.delete(tabId);
  clearTimeout(st.timer);
  try {
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    // 使用者若已自己切到別的分頁就不要再動
    if (cur && !cur.active) return;
    await chrome.tabs.update(st.prevTabId, { active: true });
    console.debug(TAG, 'restored', st.prevTabId, 'after', why);
  } catch (e) {
    console.debug(TAG, 'restore ignored:', e?.message);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = changeInfo.url || tab.url || tab.pendingUrl || '';
  if (!url.startsWith('https://classroom.google.com/')) return;
  if (tab.active || tab.groupId === -1 || active.has(tabId)) return;
  if (!(await enabled())) return;

  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!prev) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) { return; }
  console.debug(TAG, 'woke', tabId, 'prev', prev.id);
  active.set(tabId, {
    prevTabId: prev.id,
    timer: setTimeout(() => restore(tabId, 'timeout'), HOLD_MS),
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'classroom-ready' && sender.tab) restore(sender.tab.id, 'ready');
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const st = active.get(tabId);
  if (st) { clearTimeout(st.timer); active.delete(tabId); }
});
