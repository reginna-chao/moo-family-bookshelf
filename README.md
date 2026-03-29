# MooFamily Bookshelf

讓讀墨 (Readmoo) 家庭帳號成員輕鬆瀏覽彼此開放的書籍。

## 功能特色

- **隱私優先** — 所有書籍預設不開放，由你主動選擇要分享的書
- **端對端加密** — 資料在瀏覽器中加密後才上傳，伺服器只存密文
- **跨家庭保留設定** — 解綁家庭帳號後，開放偏好不會消失
- **可自建後端** — 部署自己的 Cloudflare Worker，完全掌控資料
- **行動端支援** — PWA 網頁讓你在手機上也能瀏覽家庭書櫃

## 安裝方式

### Chrome 擴充功能

從 [Chrome Web Store](#) 安裝（審核中），或從 [GitHub Releases](https://github.com/reginna-chao/moo-family-bookshelf/releases) 下載 `.zip` 手動載入：

1. 前往 `chrome://extensions/`
2. 開啟右上角「開發人員模式」
3. 點擊「載入未封裝項目」，選擇解壓後的資料夾

### PWA 行動端

用手機瀏覽器開啟 PWA 網址，即可加入主畫面使用。

> **注意：** PWA 無法擷取讀墨書單，需先透過電腦版 Extension 同步至少一次。

## 使用方式

1. 安裝 Chrome 擴充功能
2. 在讀墨網頁中點擊「家庭書櫃」，建立或加入家庭
3. 在「個人書櫃管理」中選擇要開放的書籍
4. 家人即可在「家庭開放書櫃」中瀏覽你分享的書

所有互動透過 Dialog 完成，不會產生新的頁面路由。

## 自建後端

不想使用預設伺服器？你可以部署自己的 Cloudflare Worker：

1. Fork 本專案
2. `cd worker && wrangler deploy`
3. 在 Extension 設定中填入你的 Worker URL
4. 同步碼會自動帶入你的 API 端點，家人無需額外設定

詳細步驟請參考 [worker/DEPLOY.md](worker/DEPLOY.md)。

## 隱私與安全

- 端對端加密 (E2EE)，伺服器為零知識架構
- 不收集任何個人識別資訊
- 所有書籍預設不公開，需手動儲存才同步
- 解綁家庭後，其他成員立即無法存取你的書籍
- 程式碼完全開源，歡迎審查

詳見 [隱私政策](docs/privacy-policy.md)。

## 專案文件

- [開發計畫書](docs/project-plan.md)
- [架構設計文件](docs/architecture.md)
- [隱私政策](docs/privacy-policy.md)
- [貢獻指南 (Contributing)](CONTRIBUTING.md)

## 授權

[MIT License](LICENSE)

---

> 本專案與 Readmoo 讀墨無官方關聯。
