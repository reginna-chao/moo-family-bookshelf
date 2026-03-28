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

### 環境變數設定

各子專案提供 `.env.example` 範本，請複製後依需求修改：

```bash
cp extension/.env.example extension/.env.production
cp extension/.env.example extension/.env.development
cp pwa/.env.example pwa/.env.production
cp pwa/.env.example pwa/.env.development
```

- `.env.development` — 開發模式，通常改為 `http://localhost:8787`
- `.env.production` — 正式建置，使用預設或自建 Worker URL
- 自建後端請將 `VITE_API_ENDPOINT` 改為你的 Worker URL

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

### E2E 測試

使用 Playwright 載入已建置的 Chrome Extension，在模擬的讀墨頁面上執行完整流程測試。

```bash
pnpm test:e2e   # 自動 build Extension + 啟動本地 Worker + 執行所有 E2E 測試
```

首次執行前需安裝 Playwright 瀏覽器：

```bash
cd extension && npx playwright install chromium
```

#### 測試場景

| Spec 檔案 | 測試內容 |
|-----------|---------|
| `family-lifecycle.spec.ts` | 建立家庭 → 同步碼 → 第二使用者加入 → 驗證成員 |
| `book-sharing.spec.ts` | 書籍預設未分享 → 切換開放 → 儲存 → 家庭書櫃可見 |
| `dialog-state-machine.spec.ts` | 無家庭 → 引導 → 建立後主畫面 → 關閉重開持久化 |
| `custom-endpoint.spec.ts` | 自訂 API 端點 → 同步碼含 @host → 格式驗證 |

#### 選擇器驗證

E2E 測試依賴模擬讀墨 DOM 結構的 mock HTML。當讀墨改版時，可用以下指令驗證 `scraper.ts` 的選擇器是否仍然有效：

```bash
pnpm e2e:verify:selectors          # 連到真實讀墨頁面，檢查所有選擇器
pnpm e2e:verify:selectors:update   # 檢查 + 從真實 DOM 自動產生新的 mock HTML
```

首次執行會開啟 Chromium，需在其中手動登入讀墨。登入狀態會保留，後續執行不需再次登入。

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
