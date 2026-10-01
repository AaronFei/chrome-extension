# Classroom Wake

讓在背景分頁（例如 Claude in Chrome 的分頁群組）開啟的 Google Classroom 也能自己載完，不用再靠截圖把分頁叫醒。

## 安裝
1. 打開 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 「載入未封裝項目」→ 選這個 `classroom-wake/` 資料夾
4. 已開著的 Classroom 分頁要重新整理才會生效

## 運作方式
- **方案 A（一律啟用）** `wake.js`：在 `document_start`、MAIN world 注入，讓頁面以為自己在前景：
  `visibilityState` 永遠 `visible`、`hidden` 永遠 `false`、`hasFocus()` 永遠 `true`、
  攔掉 `visibilitychange`，並讓 `requestAnimationFrame` 與 50ms timeout 賽跑（背景 rAF 不會觸發）。
  不切換分頁、不影響畫面。
- **方案 B（預設關閉）** `bg.js`：點工具列的 Classroom Wake 圖示勾選開關。
  分頁群組中的背景 Classroom 分頁開始載入時，切到前景，等內容出現（`ready.js` 回報）或 6 秒後切回原分頁。
  非群組分頁（手動開的）不受影響；若使用者在期間自己切走，就不會再切回。

## 權限與隱私
只要 `tabs`、`storage`，host 只有 `https://classroom.google.com/*`。不收集、不傳送任何資料。

## 除錯
Classroom 分頁的 console 過濾 `[ClassroomWake]`（需開啟 Verbose 等級）。service worker 的 log 在擴充功能頁的「Service Worker」檢查。
