# Auto Login — Chrome Extension

在登入頁**點三下**就設定完成，之後開那個網站就自動填入帳密並按下登入。
不用寫程式、不用改 manifest、不用重新載入 extension。

## 安裝

1. Chrome 開 `chrome://extensions`
2. 右上角打開「開發人員模式 / Developer mode」
3. 點「載入未封裝項目 / Load unpacked」，選這個 `autofill-extension` 資料夾

## 新增一個網站

1. 開啟那個網站的**登入頁**
2. 點瀏覽器右上角的 extension 圖示 →「設定這個網站」
3. Chrome 會問你要不要授權這個網域 → 允許
4. 面板會顯示它**自動偵測到的帳號欄 / 密碼欄 / 登入鈕**（滑鼠移過去會 highlight 在頁面上）
   - 對的話 → 直接「下一步」
   - 不對 → 按「手動點選」，依序點一下帳號欄、密碼欄、登入鈕
     （沒有明確的登入鈕可以按 `S` 跳過，改用自動偵測）
5. 填入帳號密碼 → 儲存 → 重新整理，就會自動登入了

一般的 `<form>` + `input[type=password]` 登入頁，第 4 步通常直接按「下一步」就好。

## 管理設定

extension 圖示 →「管理全部設定」，可以改帳密、停用、刪除，
「進階」裡可以手動填 selector、限制網址、調整送出延遲。

## AI / 自動化橋接：`#ai-auth-state`

每個有設定的頁面都會掛一個隱藏節點，讓自動化（Claude in Chrome 之類）直接讀 `dataset` 就知道狀態，
不用靠猜秒數、截圖或翻 console。

走 DOM 是因為 content script 在 ISOLATED world、`javascript_tool` 在 MAIN world，
兩邊的 `window` 不互通，但 DOM 是共用的。

```js
document.getElementById('ai-auth-state').dataset
```

| 屬性 | 說明 |
|---|---|
| `state` | `unknown` / `no-credentials` / `logged-out` / `pending` / `filled` / `success` / `error` |
| `errorCode` | `BAD_CREDENTIALS` `BRIDGE_INIT_FAILED` `FORM_NOT_FOUND` `CAPTCHA_REQUIRED` `RETRY_LIMIT` `SUBMIT_NO_EFFECT` `TIMEOUT` `STORAGE_ERROR` |
| `errorMsg` | 人類可讀補充 |
| `extVersion` | 目前跑的版本 —— 改完有沒有 reload 一看就知道 |
| `account` | 這次用的是哪組帳號（來自設定，不從 DOM 抓） |
| `siteId` / `site` / `attempt` / `updatedAt` / `contractVersion` | |
| `logKey` | sessionStorage 的鍵名，裡面是跨導頁的狀態轉換紀錄 |

`state` 是最後才寫的欄位，以它為判讀依據。

### 空頁等待（`idleMs`）為什麼會自己調

頁面上沒有密碼欄時，要等多久才敢判定「已登入」？這個值兩邊的錯不對稱：

- **太短** → 慢慢 render 登入表單的 SPA 會在表單出現前就被判成 `success`，
  autofill **靜默地永遠不觸發**，而且從外面完全看不出來
- **太長** → 站內每一頁都多等幾秒。只是慢，功能沒壞

所以盲測預設偏保守（4000ms），但會自己學：content script 在**登入頁**上會量密碼欄是
開跑後多久出現的（`renderMs`），存進 `chrome.storage.local` 的 `siteStats`，
下次非登入頁就用 `clamp(renderMs × 3 + 800, 1000, 4000)`。

伺服器渲染的站（`renderMs` ≈ 0）會自動收斂到 1000ms，真正的 SPA 則誠實地留在 4000ms。
管理頁那格填了值就一律以你填的為準，清空就交還給自動判斷。
目前生效的值可以從節點的 `data-idle-ms` 讀到。

> 觀測值刻意存在 `siteStats` 而不是 `sites` —— 寫 `sites` 會觸發 background 重新註冊
> content script，每逛一次登入頁就重註冊一次太浪費。

**轉換紀錄**：自動化端的工具往返延遲常常比一次狀態轉換還久（登出→自動登回只要 2~3 秒），
只讀「現在的狀態」會整段錯過。所以另外把每次轉換寫進 `sessionStorage['__autologin_log']`
（跨導頁保留，最多 30 筆），事後讀一次就知道完整經過：

```js
JSON.parse(sessionStorage.getItem('__autologin_log') || '[]')
// [{at, state, code, path, attempt}, ...]
```

**節點不存在** 代表 content script 根本沒跑 —— 沒設定、沒授權、或 extension 沒開。
這跟「有跑但沒動作」是完全不同的問題，要分得出來。

> ⚠️ 改任何東西都記得 **bump `manifest.json` 的 `version`**，否則 `data-ext-version` 就失去意義，
> 沒人分得出來 reload 到底有沒有生效。


## 權限設計

extension **預設沒有任何網站的權限**。每加一個網站，Chrome 才會問你要不要授權那一個網域，
content script 也只會被注入到你授權過的網域。刪除設定時會一併收回權限。

## 內建保護

**帳密錯只會試一次。** 送出後又回到登入頁時，會先看頁面上有沒有錯誤訊息；
有的話直接判為 `BAD_CREDENTIALS` 停手，**不消耗剩下的嘗試次數** ——
接 AD / LDAP 的系統重試就是在鎖帳號，而且是自動化在你不在場的時候鎖。

錯誤訊息偵測預設是通用的（`[role=alert]`、各種 error class、加上中英文常見的失敗字樣）。
偵測刻意偏保守：誤判成帳密錯只會讓 extension 停手（你手動登入即可），
漏判卻可能把帳號重試到鎖住 —— 兩種錯的代價差很多。
站台如果抓不準，到管理頁「進階」填 `錯誤訊息` selector 就好，**不用改程式碼**。

只有「回到登入頁但完全沒有錯誤訊息」才算暫時性失敗，交給下面的次數上限。

同一個分頁、同一組設定連續嘗試 **3 次** 還停在登入頁，就會自動停手。
成功登入後（頁面上不再有登入欄位）計數會自動歸零。
想手動再試：點 extension 圖示 →「立即填入」，或在該頁 console 執行 `__autologinReset()` 後重新整理。

## 檔案結構

| 檔案 | 作用 |
|---|---|
| `manifest.json` | MV3 設定。沒有固定的 `host_permissions`，全部走 `optional_host_permissions` |
| `background.js` | 依設定動態註冊 content script；第一次安裝時從舊的 `credentials.js` 匯入 |
| `lib/selector.js` | 共用：欄位自動偵測 + 穩定 selector 產生（id → name → data-* → 路徑） |
| `content.js` | 實際填入與送出 |
| `picker.js` | 學習模式的點選 UI（closed shadow DOM，不會被網頁 CSS 影響） |
| `popup.*` | 點圖示跳出的小面板 |
| `options.*` | 管理頁 |
| `credentials.js` | **舊版**設定檔，只在第一次安裝時被讀來匯入。匯入完可以刪掉 |

## 從舊版（v1）升級

第一次載入 v2 時，`background.js` 會自動把 `credentials.js` 裡的設定匯進 `chrome.storage`。
匯入時**只保留網域、丟掉路徑**（舊版把 `/Login.aspx` 寫進 match 是 bug 來源 —— 很多網站的根網址
就直接是登入頁，帶路徑會比不中）。匯入後到 extension 圖示按「設定這個網站」授權一次即可。
確認一切正常後，`credentials.js` 就可以刪掉。

## 什麼情況還是要手動處理

- **多步驟登入**（先打帳號按下一步、再打密碼）— 目前只處理單頁表單
- **iframe / shadow DOM 包起來的登入表單** — 自動偵測看不到
- **Canvas 或自繪鍵盤**（部分網銀）
- **OTP / 2FA / 圖形驗證碼** — 這類本來就不該自動化

## 安全提醒

帳密存在 `chrome.storage.local`：網頁**讀不到**，也不會同步到雲端，但它**沒有加密** ——
能存取你電腦帳號的人就讀得到。

- 不要用在網銀、主要 email 這類高風險帳號
- 如果只是想少打字，Chrome 內建密碼管理員或 Bitwarden 更安全（密碼有加密）；
  這個 extension 真正不可取代的是**自動按下送出**那一步
- `credentials.js`（舊版明文設定檔）已列入 `.gitignore`，不要 commit
