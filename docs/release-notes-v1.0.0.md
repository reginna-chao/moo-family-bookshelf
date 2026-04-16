# v1.0.0 — 首次正式發布 🎉

MooFamily Bookshelf 是一個 Chrome Extension，在讀墨（Readmoo）網頁介面中以 Dialog 方式顯示家庭開放書櫃，讓家庭帳號成員彼此分享已購買的電子書。搭配 PWA 行動版，隨時都能查看家人的書櫃。

> **隱私優先**：所有書籍預設不開放，由使用者主動勾選；所有資料透過 TLS 安全傳輸，以認證 Token 控管存取權限。

---

## ✨ 核心功能

### Chrome Extension

- **注入式 Dialog UI**：在讀墨網頁介面中疊加顯示，不改動原有路由。
- **個人書櫃管理**：從讀墨頁面爬取個人書單，逐本勾選是否開放給家庭成員。
- **家庭書櫃聚合**：一鍵查看所有家庭成員開放的書籍合集。
- **成員過濾與搜尋**：依成員、分類、狀態（已購 / 已封存）篩選，支援關鍵字即時搜尋。
- **批次操作**：多選書籍後統一切換分享狀態。
- **已封存書籍**：支援同步已封存書籍，提供獨立檢視模式。
- **分類標籤**：自動抓取讀墨書籍分類（`main_subject`），可依分類過濾。
- **一鍵入門流程**：首次開啟 Dialog 即引導使用者建立或加入家庭，最短三步完成設定。
- **跨裝置同步**：透過 `chrome.storage.sync` 在多台電腦的 Chrome 之間同步設定。
- **自動復原**：Extension 重新安裝後可自動復原家庭成員身份。

### PWA 行動版

- **掃 QR code 登入**：從 Extension 設定頁掃描 QR code 快速綁定家庭。
- **Email 手動登入**：支援手動輸入作為備援。
- **家庭書櫃 / 個人書櫃瀏覽**：全功能對應桌面版，僅限制無法新增書籍（需從 Extension 爬取）。
- **可選登入驗證**：支援 PIN 碼、圖形鎖、Email OTP 三種方式保護 PWA 存取。
- **安裝提示與離線支援**：標準 PWA 體驗，可加入主畫面。

### 家庭群組

- **建立 / 加入家庭**：透過 Sync Code 邀請成員，支援 `@host` 區段自動配置自訂 API endpoint。
- **成員管理**：家庭擁有者可轉移 / 移除成員。
- **顯示名稱**：可自訂並即時同步至所有成員視圖。
- **離開家庭**：解綁後個人開放設定仍保留，重新加入其他家庭無需重新勾選。

---

## 🔒 安全性與隱私

- **TLS + Token 存取控制**：所有資料透過 HTTPS 安全傳輸，以認證 Token 嚴格控管存取權限。
- **預設不分享**：新購書籍一律預設 `isShared: false`，絕不自動分享。
- **Save to sync**：所有分享狀態變更都需要使用者明確按下「儲存」才會上傳。
- **無帳號、無追蹤**：不收集 Email、不註冊帳號、無任何分析或追蹤 SDK。
- **Token 自動續期**：在背景主動刷新認證 Token，無感續期。
- **API 安全強化**：Cloudflare Worker 端實作 CORS、分級 rate limiting、Body size 限制、安全 headers。

---

## ⚙️ Backend（可自架）

- **Cloudflare Workers + KV**：Serverless 架構，免費額度足夠家庭使用。
- **Hono 輕量框架**：TypeScript 全鏈路。
- **自架支援**：Fork `worker/` 後以 `wrangler deploy` 部署到自己的 Cloudflare 帳號，Sync Code 會自動附帶 `@host` 區段讓家庭成員使用相同後端。
- **詳細部署文件**：見 [worker/DEPLOY.md](../worker/DEPLOY.md)。

---

## 🎨 品牌與 UX

- **全新 Logo、Favicon、Touch Icon、OG Image**：整套品牌資產。
- **Lucide 圖示**：全面採用 Lucide icon 系統，淘汰 emoji，視覺一致。
- **Dev / Local 環境識別**：開發版本 Icon 有特殊色標與彩虹邊框，避免與正式版混淆。
- **GitHub Pages 著陸頁**：專案介紹頁部署於 [reginna-chao.github.io/moo-family-bookshelf](https://reginna-chao.github.io/moo-family-bookshelf)。

---

## 📦 技術堆疊

| 層級 | 技術 |
|---|---|
| Extension / PWA | React 19 + TypeScript 5 + Vite + Tailwind CSS |
| Backend | Cloudflare Workers + Hono |
| Storage | Cloudflare KV |
| 雜湊 | Web Crypto API（SHA-256） |
| 測試 | Vitest + React Testing Library + Playwright + Miniflare |

測試覆蓋率目標：API / Worker ≥ 80%、Dialog ≥ 70%、整體 ≥ 70%。

---

## 🚀 安裝方式

### Chrome Extension

1. 下載下方 `moo-family-bookshelf-v1.0.0.zip` 並解壓縮。
2. 開啟 Chrome，進入 `chrome://extensions/`。
3. 右上角開啟「開發人員模式」。
4. 點「載入未封裝項目」，選擇解壓縮後的資料夾。
5. 進入 [讀墨書櫃](https://read.readmoo.com/library) 即可在頁面上看到 MooFamily Bookshelf 按鈕。

### PWA 行動版

- 直接開啟 [moo-family-bookshelf-pwa URL]，依提示「加入主畫面」即可。
- 首次使用請先從 Chrome Extension 掃描 QR code 登入。

---

## ⚠️ 已知限制

- **兒童帳號不支援**：讀墨兒童帳號無法使用網頁版，暫不納入支援範圍。
- **PWA 無法新增書籍**：PWA 無 Content Script 能力，無法爬取讀墨書單，必須至少從桌面 Extension 同步過一次。
- **僅支援 `read.readmoo.com`**：Extension 僅在讀墨網頁書櫃中啟用。

---

## 🙏 致謝

感謝所有在開發過程中提供測試與意見的家人朋友。MooFamily Bookshelf 是一個純粹為家庭使用場景打造的小工具，希望讓電子書在家庭中流通得更自然。

---

**Full Changelog**: https://github.com/reginna-chao/moo-family-bookshelf/commits/v1.0.0
