# 整頁截圖 Full Page Capture

Chrome MV3 擴充功能。捲動整個網頁逐屏擷取，拼接成一張完整長圖，
可以直接下載 PNG、存成 PDF（自動分頁）、或複製到剪貼簿。

## 安裝（unpacked）

1. 解壓縮到一個你不會刪掉的資料夾，例如 `~/Workspace/autotool/fullpage-capture`
2. Chrome 開 `chrome://extensions`
3. 右上角打開「開發人員模式」
4. 「載入未封裝項目」→ 選那個資料夾
5. 建議把圖示釘到工具列

> 資料夾路徑決定 extension ID，之後不要搬家，搬了就要重新載入。

## 使用

點工具列圖示（或按 <kbd>⌘⇧Y</kbd> / <kbd>Ctrl+Shift+Y</kbd>）→「擷取整頁」。
面板上的「完成後」可以選：

| 選項 | 行為 |
|---|---|
| 開預覽分頁（預設） | 開新分頁顯示結果：下載 PNG / 複製到剪貼簿 / 存成 PDF / 裁切 / 實際大小 |
| 直接下載 PNG | 不開分頁，直接存檔 |
| 直接存成 PDF | A4 直式、自動分頁 |
| 複製到剪貼簿 | 開預覽分頁並自動複製（瀏覽器擋下時按面板上的按鈕即可） |

### 裁切

預覽分頁按「裁切」（或按 <kbd>c</kbd>）進入裁切模式：

- 八個控制點拉邊界，框內可整塊拖移，框外變暗、框內有三分法輔助線
- 上方四個欄位 **X / Y / 寬 / 高** 可以直接打數字。整頁截圖動輒八九千像素高，
  要裁下面某一段用拖的很難拉，直接輸入座標最快
- 方向鍵移動 1px、<kbd>Shift</kbd>+方向鍵 10px、<kbd>Alt</kbd>+方向鍵改尺寸
- <kbd>Enter</kbd> 套用、<kbd>Esc</kbd> 取消、「全選」回到整張
- 套用後 PNG / 剪貼簿 / PDF 都會用裁切後的影像，檔名多一個 `_crop`；
  按「還原原圖」隨時回到未裁切的版本（原圖一直留在記憶體裡，不會重截）

改位置就縮尺寸、改尺寸就以現在的位置為準 —— 不會發生「打了 Y 又被彈回 0」。

其他設定：

- **隱藏固定/黏性元素**：第一屏保留頂端的 header（所以 header 會正常出現一次），
  同時就先把底部工具列、cookie 條、聊天氣泡藏起來；第一屏拍完後連 header 也藏起來，
  避免每一屏都疊一次。截完自動還原。
- **先捲一遍觸發 lazy-load**：先整頁捲過一次逼出延遲載入的圖片再回到頂端開始拍。
  頁面很長時會多花幾秒，但可以避免整片灰底佔位圖。
- **每屏等待**：捲動後等多久才拍。動畫多、載入慢的站台調大一點。

## 權限

`manifest.json` 裡**沒有任何固定的 host permission**。截圖靠的是 `activeTab`：
只有在你按下圖示或快捷鍵的那一刻，才對「當下這個分頁」取得一次性權限。
沒有背景常駐監看，沒有任何資料離開瀏覽器。

截圖結果暫存在 `chrome.storage.local`，只保留最近 3 張，之後自動淘汰。

## 實作重點

- **可視高度是從截圖本身推回來的**，不是相信 `window.innerHeight`。
  瀏覽器橫幅、縮放、headless 等情況下兩者會不一致，直接用 innerHeight 當步距
  會出現週期性的白色空隙。
- `captureVisibleTab` 有**每秒 2 次**的配額，所以每屏之間至少間隔 560ms，
  撞到配額會退避重試。長頁面每屏約 0.6~0.9 秒。
- 拼接在 service worker 用 `OffscreenCanvas`，PDF 也在 service worker 產生
  （`imageToPdfBlob` 會依環境選 OffscreenCanvas 或 `<canvas>`），不需要 offscreen document。
- PDF 是自己寫的極簡產生器（`lib/pdf.js`，DCTDecode 內嵌 JPEG），沒有任何外部相依 ——
  MV3 本來就不允許載入遠端程式碼。
- 右側捲軸會裁掉（用 `documentElement.clientWidth` 當輸出寬度）。

## 已知限制

- 只處理**直向**捲動。頁面比視窗寬時只會拍到可視寬度。
- 只處理**整頁**捲動。內部 `overflow:auto` 容器（Google Docs、某些後台表格）不支援。
- `chrome://`、Chrome 線上應用程式商店、其他擴充功能的頁面不允許截圖，這是瀏覽器擋的。
- 超長頁面（單邊 > 32000px 或總像素 > 2.4 億）會等比縮小，預覽頁會標示縮到幾 %。
- 影片、canvas 動畫、會隨捲動改變的視差效果，每屏拍到的狀態可能不一致。
- PDF 內嵌的是 JPEG（品質 0.92），要完全無損請用 PNG。

## 檔案

```
manifest.json     權限與進入點
background.js     service worker：編排捲動擷取、拼接、輸出
lib/inject.js     注入到分頁的函式（量測、捲動、隱藏固定元素、還原）
lib/pdf.js        極簡 PDF 產生器（長圖自動分頁）
lib/common.js     檔名、data URL / blob、下載
popup.html/js     工具列面板與設定
preview.html/js   預覽分頁：裁切框 + 四種輸出
```
