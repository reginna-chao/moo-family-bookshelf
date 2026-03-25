# MooFamily Bookshelf

讓讀墨 (Readmoo) 家庭帳號成員輕鬆瀏覽彼此開放的書籍。

## 功能特色

- **隱私優先** — 所有書籍預設不開放，由你主動選擇要分享的書
- **端對端加密** — 資料在瀏覽器中加密後才上傳，伺服器只存密文
- **跨家庭保留設定** — 解綁家庭帳號後，開放偏好不會消失
- **可自建後端** — 部署自己的 Cloudflare Worker，完全掌控資料
- **行動端支援** — PWA 網頁讓你在手機上也能瀏覽家庭書櫃

## 運作方式

1. 安裝 Chrome 擴充功能
2. 在讀墨網頁中點擊「家庭書櫃」，建立或加入家庭
3. 在「個人書櫃管理」中選擇要開放的書籍
4. 家人即可在「家庭開放書櫃」中瀏覽你分享的書

所有互動透過 Dialog 完成，不會產生新的頁面路由。

## 技術架構

| 層級 | 技術 |
|------|------|
| 前端 | Chrome Extension (React + TypeScript + Vite) |
| 行動端 | PWA |
| 後端 | Cloudflare Workers (Hono) |
| 儲存 | Cloudflare KV |
| 加密 | Web Crypto API (AES-256-GCM) |

## 開發

### 環境需求

- Node.js 20+
- pnpm 9+

### 安裝

```bash
pnpm install
```

### 開發模式 vs 正式環境

| 模式 | 指令 | API 端點 | KV |
|------|------|---------|-----|
| 開發 | `cd worker && pnpm dev` + `cd extension && pnpm dev` | `localhost:8787` | preview-kv |
| 正式 | `cd extension && pnpm build` | prod Worker | prod-kv |

開發時請同時在兩個 terminal 分別啟動 Worker 和 Extension，資料會寫入 preview-kv，不會污染正式環境。

### Extension 開發

```bash
cd extension
pnpm dev        # 開發模式（API 指向 localhost:8787）
pnpm build      # 正式建置（API 指向 prod Worker）
pnpm typecheck  # 型別檢查
pnpm lint       # Lint
pnpm test       # 測試
```

### Worker 開發

```bash
cd worker
pnpm dev        # 本地開發 (Miniflare + preview-kv)
pnpm build      # 建置
pnpm test       # 測試 (Vitest + Miniflare)
```

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

## 授權

[MIT License](LICENSE)

---

> 本專案與 Readmoo 讀墨無官方關聯。
