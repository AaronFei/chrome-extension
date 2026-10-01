# YT Audio Grabber

在 YouTube 播放器上加一顆按鈕，一鍵把**音檔**（不是影片）抓下來，預設保留 YouTube 原始最高音質音軌、不重新編碼。

```
yt-audio-grabber/
├── extension/     # Chrome MV3 擴充功能（介面）
└── helper/        # macOS 本機服務（實際下載，yt-dlp + ffmpeg）
```

## 為什麼要本機 helper

YouTube 的音訊串流網址有簽章與 n-param 混淆、外加 PO token，純前端擴充功能直接抓串流在多數影片上會失敗，而且 Chrome Web Store 政策禁止 YouTube 下載類擴充（本專案只能以「載入未封裝項目」使用）。把下載交給 yt-dlp 才穩定。

## 安裝

```bash
bash ~/Workspace/autotool/yt-audio-grabber/helper/install.sh
```

會自動裝 yt-dlp / ffmpeg（需 Homebrew）、註冊 launchd 開機自動啟動、並印出 token。

然後 Chrome：`chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `extension/` 資料夾 → 進設定頁貼上 token → 按「測試連線」。

## 使用

- YouTube 播放器右下角出現 ⬇ 按鈕，按下即開始，按鈕上顯示百分比
- 或點工具列圖示，貼網址下載；可看佇列、進度、取消
- 音檔預設存到 `~/Downloads`

## 設定

`~/.config/yt-audio-grabber/config.json`（改完重啟服務）

| 欄位 | 說明 |
|---|---|
| `port` | 預設 8787 |
| `output_dir` | 輸出資料夾 |
| `filename_template` | yt-dlp 檔名樣板 |
| `embed_thumbnail` / `embed_metadata` | 嵌入封面與標題等 metadata |
| `cookies_from_browser` | 填 `chrome` 可抓年齡限制／會員影片 |
| `max_concurrent` | 同時下載數 |

重啟服務：
```bash
launchctl unload ~/Library/LaunchAgents/com.ytaudiograbber.helper.plist
launchctl load   ~/Library/LaunchAgents/com.ytaudiograbber.helper.plist
```

## 安全

服務只綁 `127.0.0.1`，要求 `X-Auth-Token` 標頭，CORS 只放行 `chrome-extension://` 來源，且只接受 YouTube 網域的網址。

## 使用範圍

請用於你自有、已授權或已明確標示可自由使用的內容（以及個人離線聆聽）。下載他人受著作權保護的內容通常違反 YouTube 服務條款，也可能侵權。
