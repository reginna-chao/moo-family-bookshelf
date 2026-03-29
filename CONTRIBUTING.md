# 貢獻指南

感謝你有興趣參與 MooFamily Bookshelf 的開發！本文件說明如何參與貢獻。

## 開發環境

- **Node.js** 20+
- **pnpm** 作為套件管理工具
- **Git**

```bash
# Clone 專案
git clone https://github.com/reginna-chao/moo-family-bookshelf.git
cd moo-family-bookshelf

# 安裝依賴
pnpm install
```

## 專案結構

| 目錄 | 說明 |
|------|------|
| `extension/` | Chrome Extension（React + Vite） |
| `pwa/` | PWA 行動端（React + Vite） |
| `worker/` | Cloudflare Workers 後端（Hono） |
| `site/` | GitHub Pages 靜態說明頁面 |
| `docs/` | 專案文件（計畫書、架構、隱私政策） |
| `assets/brand/` | 品牌素材（Logo、Favicon、OG Image） |

## 開發指令

```bash
# Extension
pnpm dev              # 開發伺服器
pnpm build            # 正式建置
pnpm typecheck        # 型別檢查
pnpm lint             # ESLint + Prettier
pnpm test             # 單元 + 元件測試
pnpm test:e2e         # E2E 測試（Playwright）

# Worker
cd worker
pnpm dev              # 本地 Wrangler 開發
pnpm test             # 單元 + 整合測試
pnpm typecheck

# PWA
cd pwa
pnpm dev
pnpm test
pnpm typecheck

# 全專案覆蓋率
pnpm test:coverage
```

## 提交 Pull Request

### 分支命名

使用描述性的分支名稱：

- `feat/add-book-search` — 新功能
- `fix/sync-code-parsing` — Bug 修復
- `docs/update-privacy-policy` — 文件更新
- `refactor/extract-crypto-utils` — 重構

### Commit 格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add personal shelf search
fix: correct sync code parsing for custom endpoints
docs: update self-hosting guide
refactor: extract shared validation helpers
test: add crypto roundtrip tests
chore: update dependencies
```

### PR 流程

1. Fork 本專案並建立功能分支
2. 開發並撰寫測試
3. 確保所有檢查通過：
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   cd worker && pnpm test
   ```
4. 提交 PR，說明變更內容與動機

### CI 會自動執行

- ESLint + Prettier 格式檢查
- TypeScript 型別檢查
- 單元 + 元件測試
- E2E 測試（PR to `main` 時）

## 測試

- 測試商業行為，而非實作細節
- 新功能需附帶對應測試
- 覆蓋率目標：crypto >= 90%, API/Worker >= 80%, Dialog UI >= 70%
- 整合測試使用 Miniflare 模擬 KV，不連接真實 Cloudflare
- E2E 測試使用 Playwright 載入完整 Extension

## 程式碼風格

- **TypeScript**：嚴格模式，避免 `any`
- **React**：函式元件 + Hooks，不使用 Class Component
- **CSS**：Tailwind CSS utility classes
- **命名**：`camelCase` 變數/函式、`PascalCase` 元件/型別、`UPPER_SNAKE` 常數
- **語言**：程式碼識別符用英文，UI 文字用繁體中文
- 每個檔案盡量不超過 300 行

## 安全注意事項

- 所有書籍資料預設不開放，使用者主動選擇才分享
- 資料在瀏覽器端加密（AES-256-GCM）後才上傳
- 不要在程式碼中硬編碼任何密鑰或敏感資訊
- `.env`、`.dev.vars` 等檔案不可提交至 Git
- Content Script 僅讀取公開可見的書籍資訊，不觸碰帳號認證

## 自建後端

如果你想使用自己的 Cloudflare Worker：

1. 參考 `worker/DEPLOY.md` 部署指南
2. 在 Extension / PWA 設定中填入你的 Worker URL
3. 同步碼會自動帶入 API 端點（`@host` 格式）

## 問題回報

請到 [GitHub Issues](https://github.com/reginna-chao/moo-family-bookshelf/issues) 回報 Bug 或提出功能建議。

## 授權

本專案採用 [MIT License](LICENSE) 開源。提交 PR 即表示你同意將貢獻以相同授權釋出。
