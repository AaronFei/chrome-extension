# Jira 內網跳板（瀏覽器擴充功能）

同事貼給你的 `https://jira.realtek.com/browse/PCSSD-12345`，在公司網路外的裝置上
點下去會失敗（連不到內網）。這支擴充功能把那類連結**自動改導**到
`https://chrome.a-fei.com/browse/PCSSD-12345`，也就是你自己的跳板。

Jira 和 Wiki 都會轉：

| 原始網址 | 轉成 |
|---|---|
| `jira…/browse/PCSSD-12345` | `chrome.a-fei.com/browse/PCSSD-12345` |
| `wiki…/pages/viewpage.action?pageId=N` | `chrome.a-fei.com/wiki/N` |
| `wiki…/display/空間/標題` | `chrome.a-fei.com/w/display/…`（前端查 API 換成 pageId）|
| `wiki…/x/短碼` | `chrome.a-fei.com/w/x/…`（同上）|

標題網址與短網址沒辦法靜態換算（要查 API 才知道 pageId），所以先原樣搬到
`/w/` 底下再由前端解析。刻意保留路徑結構而不是塞進 query，
這樣標題裡有 `+` `&` `#` 之類的字元也不會壞掉。

只動**頁面導覽**。Dashboard、REST API、其他網域、頁面內的圖片與 API 請求
都不碰（規則限定 `main_frame`）。

## 安裝（Chrome / Edge，桌機）

1. 開 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打開「開發人員模式」
3. 按「載入未封裝項目」，選這個 `extension` 資料夾
4. 完成。之後點 Jira 連結就會自動跳到你的介面

在公司網路內、想直接開真正的 Jira 時，到擴充功能頁把它關掉即可。

## 不要裝在辦公室那台的遠端 Chrome 上

那台是唯一連得到內網的瀏覽器，裝了會把你在上面手動開 Jira 的動作也導走。

## 手機

iOS 與 Android 的瀏覽器不支援這類擴充功能，沒辦法自動改導。
變通做法：把 PWA 加到主畫面，需要時手動把網址的 `jira.realtek.com`
換成 `chrome.a-fei.com`，路徑一模一樣。

## 版本

- **1.1.1** — 補上 `wiki.realtek.com` 的主機權限。1.1.0 有規則卻沒權限，
  Chrome 會靜默忽略那幾條，wiki 連結完全不會轉。
- 1.1.0 — 加上 Wiki（Confluence）的三種網址形狀（權限漏了，請直接用 1.1.1）
- 1.0.0 — 只轉 Jira 議題連結

更新之後記得到 `chrome://extensions` 按那張卡片的「重新載入」，
不然瀏覽器還在用舊規則。版本號可以在同一張卡片上確認。
