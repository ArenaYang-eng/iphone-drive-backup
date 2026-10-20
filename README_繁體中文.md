# iPhone 我的備份中心（第一階段 MVP）

## 已包含
- 可加入 iPhone 主畫面的 PWA 網頁介面
- 手動選取照片／影片與文件
- Google OAuth 登入（前端使用 Google Identity Services）
- 在 Google Drive 建立「iPhone 手動備份」資料夾
- 逐檔上傳、進度顯示、成功／失敗紀錄
- Service Worker 快取基本頁面

## 重要限制
1. 這是第一階段原型，尚未完成正式安全審查。
2. 本版本使用 Drive `drive.file` 範圍。Google OAuth 同意畫面及 API 啟用必須由部署者設定。
3. 目前採 multipart 上傳；大量或超大型影片可能需要改為 resumable upload。
4. iOS 可能在切換 App、鎖定螢幕或網路中斷時暫停頁面工作。備份期間請保持頁面開啟。
5. 網頁只能上傳使用者明確選取的檔案，不會自動讀取整個相簿。
6. 本版遇到同名檔案會新增另一份，不會覆寫或自動去重。
7. 若要提供公眾使用，請完成 OAuth 同意畫面、隱私權政策、必要的 Google 驗證與安全檢查。

## 部署概略（Cloudflare Pages 或 GitHub Pages）
1. 將本資料夾內檔案上傳至支援 HTTPS 的靜態網站託管服務。
2. 在 Google Cloud Console 建立專案並啟用 **Google Drive API**。
3. 設定 OAuth 同意畫面（外部測試時將自己的 Google 帳號加入測試使用者）。
4. 建立 OAuth 用戶端 ID，應用程式類型選 **Web application**。
5. 將實際部署網站的 origin 加入「已授權的 JavaScript 來源」（例如 `https://your-site.pages.dev`），不要加路徑。
6. 開啟部署網址，在頁面輸入用戶端 ID，按「儲存用戶端 ID」再按「連線 Google」。
7. 登入授權後，選取照片／影片或文件，再按「備份所選資料到 Google Drive」。
8. 在 iPhone Safari 開啟部署網址，使用分享選單的「加入主畫面」。

## 安全建議
- 不要在前端放 Google Client Secret。
- 僅使用自己信任的 HTTPS 網址。
- 不要在公共或共用裝置上保留登入狀態；本原型不會持久保存 access token。
- 正式使用前，建議再加入檔案大小限制、分段續傳、重試與完整性驗證。
