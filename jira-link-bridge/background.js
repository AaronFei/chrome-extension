// 點工具列圖示（或 Alt+Shift+J）切換「要不要跳」。
// 靠 updateEnabledRulesets 開關整組 rules.json；狀態另存一份在 storage，
// 因為擴充功能重新載入/更新時 Chrome 會把 ruleset 還原成 manifest 的預設值。

const RULESET = "redirect";

async function getEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false; // 預設開
}

async function apply(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] }
  );
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#1a7f37" : "#8c959f" });
  await chrome.action.setTitle({
    title: enabled
      ? "內網跳板：開（Jira/Wiki 連結會跳到 chrome.a-fei.com）\n點一下關閉"
      : "內網跳板：關（直接開 jira/wiki.realtek.com）\n點一下開啟",
  });
}

async function toggle() {
  const next = !(await getEnabled());
  await chrome.storage.local.set({ enabled: next });
  await apply(next);
}

async function sync() { await apply(await getEnabled()); }

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener((cmd) => { if (cmd === "toggle-bridge") toggle(); });
