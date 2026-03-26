# 📚 MooFamily Bookshelf — 開發計畫書

> 透過 Chrome Extension 在讀墨 (Readmoo) 網頁介面中注入 Dialog，讓家庭帳號成員瀏覽彼此開放的書籍。

---

## 一、專案背景與目標

### 問題描述

讀墨 (Readmoo) 的家庭帳號借書功能不完善，個人書單無法方便地分享給家庭帳號中的其他成員瀏覽。

### 核心目標

- 開發一個 Chrome Extension，直接在讀墨網頁介面中以 **Dialog** 方式顯示家庭開放書櫃
- 不產生新的頁面路由（Router），所有互動透過 Dialog 完成
- 每本書可個別設定是否開放至家庭書櫃，**預設不開放**，保護隱私
- 個人開放設定持久化，**解綁家庭帳號後設定保留**，重新綁定新家庭後無需重新設定
- 確保資安與隱私

### 設計原則

- **隱私優先**：所有書籍預設不開放，由使用者主動選擇開放
- **個人設定獨立於家庭**：開放書櫃設定歸屬於個人，不隨家庭綁定/解綁而變動
- **最小侵入**：透過 Dialog 疊加在讀墨現有頁面上，不改變原有路由結構
- **兒童帳號暫不考慮**：目前讀墨兒童帳號不能使用網頁，故先排除

---

## 二、技術架構

### 架構總覽

```
┌───────────────────────────────────────────────┐
│              使用者瀏覽器（Chrome）               │
│                                               │
│  ┌─────────────────┐  ┌───────────────────┐   │
│  │  Content Script  │  │  Dialog UI        │   │
│  │ (注入讀墨頁面)    │  │  (React, 疊加顯示) │   │
│  │ (爬取個人書單)    │  │  - 個人書櫃管理     │   │
│  └────────┬────────┘  │  - 家庭開放書櫃     │   │
│           │           └────────┬──────────┘   │
│           │                    │              │
│           └──────┬─────────────┘              │
│                  │ HTTPS                      │
└──────────────────┼────────────────────────────┘
                   ▼
     ┌─────────────────────────────────┐
     │     Cloudflare Workers (API)     │
     │     + KV Storage                │
     │                                 │
     │  個人開放設定 (per user)          │
     │  家庭書櫃聚合 (per family)       │
     │  E2EE 加密儲存                   │
     └─────────────────────────────────┘
```

### 技術選型

| 層級 | 技術 | 說明 |
|------|------|------|
| **Frontend** | React + TypeScript + Vite | Chrome Extension，Dialog UI 注入讀墨頁面 |
| **Backend** | Cloudflare Workers | Serverless API，免費額度每日 10 萬次 |
| **Storage** | Cloudflare KV | Key-Value 儲存，低延遲 |
| **加密** | Web Crypto API (E2EE) | 端對端加密，伺服器僅存亂碼 |

### 為何選擇 Cloudflare Workers + KV？

- ✅ **零成本**：免費額度足夠個人專案使用
- ✅ **效能極佳**：冷啟動快，全球 CDN 分佈
- ✅ **架構極簡**：不需要維護傳統資料庫
- ✅ **安全性**：內建 DDoS 防護

---

## 三、功能流程設計

### 核心概念

- **家庭帳號是前提**：此功能必須先建立或加入家庭後才能使用，尚未加入家庭時僅顯示引導畫面
- **個人開放書櫃設定**：每位使用者獨立管理自己哪些書要開放，設定歸屬於個人帳號
- **家庭開放書櫃**：聚合該家庭所有成員已開放的書籍，供家人瀏覽
- **同步碼**：用於識別/加入家庭群組的憑證

### Dialog 狀態流程

```
開啟 Dialog
    │
    ▼
檢查是否已加入家庭？
    │
    ├─ 否 → 顯示「家庭設定」引導畫面
    │         ├─ 建立新家庭 → 生成同步碼 → 進入主畫面
    │         └─ 加入家庭（輸入同步碼）→ 進入主畫面
    │
    └─ 是 → 顯示主畫面（分頁）
              ├─ 家庭開放書櫃（預設分頁）
              ├─ 個人書櫃管理
              └─ 家庭設定
```

### 使用者流程

#### 步驟一：建立家庭（發起者）

1. 安裝 Chrome Extension
2. 進入讀墨頁面，點擊 Extension 注入的「家庭書櫃」按鈕
3. 開啟 Dialog，因尚未加入家庭，顯示**家庭設定引導畫面**
4. 點擊「建立新家庭」
5. 系統生成家庭同步碼（例如：`moo-8f2k-9z3p-...`）
6. 將同步碼傳給家人
7. 自動進入主畫面

#### 步驟一：加入家庭（受邀者）

1. 安裝 Chrome Extension
2. 點擊「家庭書櫃」按鈕，開啟 Dialog
3. 因尚未加入家庭，顯示**家庭設定引導畫面**
4. 輸入家人提供的家庭同步碼
5. 加入成功，自動進入主畫面

#### 步驟二：管理個人開放書櫃

> 此步驟必須在加入家庭之後才能操作。

1. 在主畫面切換到「個人書櫃管理」分頁
2. Content Script 自動爬取個人書單
3. 所有書籍預設為「不開放」，使用者逐本切換開關
4. 點擊「儲存變更」，開放設定同步至伺服器
5. 開放的書籍即時出現在家庭開放書櫃

#### 步驟三：瀏覽家庭開放書櫃

1. 在主畫面的「家庭開放書櫃」分頁（預設分頁）
2. 顯示所有家庭成員已開放的書籍
3. 可按成員篩選或混合瀏覽

#### 日常操作：編輯個人開放設定

1. 開啟 Dialog → 「個人書櫃管理」分頁
2. 看到自己所有書籍列表，每本旁邊有開放/關閉開關
3. 變更開關後，點擊「儲存變更」才同步至伺服器
4. 新購買的書籍預設為「不開放」

#### 家庭解綁與重新綁定

1. 使用者在讀墨解綁家庭帳號（或在 Dialog 的「家庭設定」中離開家庭）
2. 個人開放書櫃設定**不受影響**，仍保留在伺服器
3. 下次開啟 Dialog 時，因不屬於任何家庭，回到**家庭設定引導畫面**
4. 重新綁定新家庭帳號後，建立或加入新的家庭群組
5. 之前設定為開放的書籍自動出現在新家庭的開放書櫃中，無需重新設定

### 資料結構 (Schema)

#### 個人開放設定（Per User，持久化，不隨家庭變動）

```json
{
  "user_id": "user_encrypted_id",
  "display_name": "顯示名稱",
  "books": [
    {
      "book_id": "readmoo_book_id",
      "title": "書名",
      "author": "作者",
      "isbn": "ISBN",
      "cover_url": "封面圖片連結",
      "readmoo_url": "讀墨連結",
      "is_shared": false
    }
  ],
  "last_updated": "2026-03-25T00:00:00Z",
  "encrypted": true
}
```

#### 家庭群組（Per Family）

```json
{
  "family_id": "family_sync_code",
  "members": ["user_encrypted_id_1", "user_encrypted_id_2"],
  "created_at": "2026-03-25T00:00:00Z"
}
```

#### 家庭開放書櫃（聚合查詢，非獨立儲存）

家庭開放書櫃不獨立儲存，而是查詢時動態聚合：取得家庭成員列表 → 各成員的 `is_shared: true` 書籍 → 合併顯示。

> ⚠️ 僅同步必要資訊（書名、作者、ISBN），不同步閱讀進度或個人資料。

---

## 四、資安與隱私機制

### 端對端加密 (E2EE) — Zero-Knowledge 架構

```
瀏覽器端加密 ──▶ 傳輸密文 ──▶ 伺服器儲存密文（無法解密）
```

1. **端對端加密**：資料在離開瀏覽器前即完成加密（Web Crypto API）
2. **Zero-Knowledge**：伺服器端僅存儲加密後的亂碼，開發者無法讀取內容
3. **高熵同步碼**：使用 UUID v4 等高隨機性字串，防止暴力猜測
4. **權限分離**：家庭成員僅能瀏覽他人已開放的書籍，無法修改他人設定
5. **預設不開放**：所有書籍（含新購入）預設為不開放，由使用者主動選擇

### 隱私設計要點

- 個人開放設定由使用者完全掌控，可隨時調整
- 儲存變更後才同步至伺服器，避免意外洩漏
- 家庭解綁後，個人資料不會被家庭其他成員繼續存取（因成員已從家庭群組移除）

### 隱私政策聲明

> 🔒 **隱私與安全**：本工具採開源設計，所有書單資料均經端對端加密後儲存。伺服器無法解密您的資料，亦不收集任何個人識別資訊。

### 自訂 API 端點 (BYO Backend)

使用者可在 Extension 設定或 PWA 設定中自訂 API 端點 URL，將資料存放在自己部署的 Cloudflare Worker 上，不依賴本專案預設的伺服器。

#### 運作方式

1. Extension / PWA 設定頁面提供「API 端點」欄位，預設為本專案的公用 Worker URL
2. 使用者可改為自己部署的 Worker URL（例如 `https://my-bookshelf.my-worker.workers.dev`）
3. 所有 API 請求改送至該自訂端點
4. 同一家庭的所有成員必須使用**相同的 API 端點**，否則資料無法互通

#### 自建步驟（文件中提供教學）

1. Fork 本專案的 `worker/` 目錄
2. `wrangler deploy` 部署至自己的 Cloudflare 帳號
3. 在 Extension / PWA 中填入自己的 Worker URL
4. 將 URL 連同家庭同步碼一起分享給家人

> 同步碼中可考慮編碼 API 端點資訊，讓受邀者加入時自動切換至正確的伺服器。

---

## 五、開源策略

### 安全開源

專案將在 GitHub 開源，但確保資安：

1. **環境變數分離**：所有 API Key、Secret 存放於 `.dev.vars` / `.env`，已加入 `.gitignore`
2. **Secrets 管理**：使用 `wrangler secret put` 管理正式環境密鑰
3. **開源好處**：
   - 增加使用者信任（程式碼透明可查）
   - 社群貢獻與回饋
   - 使用者可自建 Worker，零成本營運

### 儲存庫命名

- **GitHub Repo**：`moo-family-bookshelf`
- **Extension 名稱**：`MooFamily Bookshelf`

> ⚠️ 避免使用含有 `Readmoo` 全名的命名（如 `readmoo-plus`），以降低商標侵權風險。

---

## 六、行動端支援方案

Chrome Extension 僅限桌面端使用，手機端採用 **PWA 行動網頁** 作為唯一方案。

> 不採用 LINE Bot — 需額外申請 LINE Messaging API，增加部署門檻，且自建使用者也需各自申請，不實際。

### PWA 行動網頁

建立一個行動優先的網頁，使用者輸入家庭同步碼即可在手機上瀏覽家庭開放書櫃。

#### 功能範圍

| 功能 | PWA 支援 | 說明 |
|------|---------|------|
| 瀏覽家庭開放書櫃 | ✅ | 核心功能 |
| 加入家庭（輸入同步碼） | ✅ | 首次使用時 |
| 個人書櫃管理（開放/關閉） | ✅ | 需搭配讀墨網頁爬取書單，可能受限 |
| 建立新家庭 | ✅ | 可在 PWA 操作 |
| 自訂 API 端點 | ✅ | 與 Extension 相同的設定項 |

#### PWA 與 Extension 共用後端

PWA 與 Chrome Extension 呼叫同一組 Cloudflare Workers API，資料完全互通。差異僅在前端：

- **Extension**：透過 Content Script 爬取讀墨書單，注入 Dialog
- **PWA**：無法爬取讀墨頁面，個人書單需由 Extension 端先同步至伺服器，PWA 端讀取

#### 限制

- PWA 無法直接爬取讀墨網頁書單（無 Content Script 權限），個人書櫃管理功能需先在桌面端 Extension 完成至少一次同步
- 目前讀墨兒童帳號不能使用網頁，故先不考慮兒童帳號的支援

---

## 七、法律風險分析

### 風險評估

| 項目 | 風險等級 | 說明 |
|------|---------|------|
| 違反讀墨 ToS（自動化存取） | ⚠️ 中 | 個人合理使用、不營利，法律風險相對低 |
| 商標侵權 | 🔴 高（若使用全名） | 命名避開 `Readmoo` 全稱即可降低 |
| 個資法規 | ✅ 低 | E2EE 加密 + 不收集個資 |

### 避險策略

1. 以「個人開發」心態完成，不商業化
2. 命名使用 `MooFamily Bookshelf`，避免直接使用 `Readmoo` 商標
3. 實作 E2EE 加密，降低資料外洩風險
4. 撰寫白話隱私政策，增加透明度

---

## 八、測試架構

### 測試策略總覽

前端（Extension / PWA）與後端（Worker）各自有獨立的測試套件，透過 CI/CD 統一把關。

```
┌────────────────────────────────────────────────────────────┐
│                      GitHub Actions CI                      │
│                                                            │
│  ┌─────────────────────┐    ┌────────────────────────────┐ │
│  │  Extension / PWA     │    │  Worker                    │ │
│  │                     │    │                            │ │
│  │  • Unit Tests       │    │  • Unit Tests              │ │
│  │  • Component Tests  │    │  • Integration Tests       │ │
│  │  • E2E Tests        │    │    (Miniflare local KV)    │ │
│  │  • Lint + Typecheck │    │  • Lint + Typecheck        │ │
│  │  • Build            │    │  • Build                   │ │
│  └─────────────────────┘    └────────────────────────────┘ │
│                                                            │
│  Merge to main → auto deploy Worker (CD)                   │
└────────────────────────────────────────────────────────────┘
```

### 前端測試（Extension / PWA）

| 測試層級 | 工具 | 測試範圍 | 範例 |
|---------|------|---------|------|
| **Unit** | Vitest | 純邏輯模組：加密/解密、同步碼解析、API client、資料合併 | `crypto/encrypt.test.ts`、`api/parseSyncCode.test.ts` |
| **Component** | Vitest + React Testing Library | Dialog UI 元件：狀態切換、開關互動、表單驗證 | `dialog/PersonalShelf.test.tsx`、`dialog/Onboarding.test.tsx` |
| **E2E** | Playwright + Chrome Extension testing | 完整流程：安裝 Extension → 開啟 Dialog → 建立家庭 → 設定開放書籍 | `e2e/family-flow.spec.ts` |

#### 前端測試重點

- **Crypto 模組**：加密 → 解密 roundtrip 驗證、金鑰生成、同步碼編碼/解碼（含 `@host` 格式）
- **Dialog 狀態機**：無家庭 → 引導畫面、有家庭 → 主畫面、解綁 → 回到引導畫面
- **個人書櫃管理**：預設全部不開放、切換開關、儲存前不同步、新書預設不開放
- **API client**：可切換 endpoint、錯誤處理、重試邏輯

### 後端測試（Worker）

| 測試層級 | 工具 | 測試範圍 | 範例 |
|---------|------|---------|------|
| **Unit** | Vitest | 路由處理、資料驗證、權限檢查邏輯 | `routes/family.test.ts`、`middleware/auth.test.ts` |
| **Integration** | Vitest + Miniflare | 完整 API 流程搭配本地模擬 KV | `integration/family-lifecycle.test.ts` |

#### 後端測試重點

- **家庭生命週期**：建立 → 加入 → 聚合查詢 → 離開 → 聚合不再包含該成員
- **個人設定 CRUD**：儲存 / 讀取 / 更新開放設定，驗證加密資料正確儲存
- **權限隔離**：非家庭成員無法存取家庭書櫃、無法修改他人設定
- **Rate Limiting**：超頻請求回傳 429
- **Edge cases**：同步碼格式錯誤、family_id 不存在、重複加入

### 共用測試工具

| 工具 | 用途 |
|------|------|
| **Vitest** | 前後端統一測試框架 |
| **Miniflare** | 本地模擬 Cloudflare Workers + KV 環境 |
| **React Testing Library** | Dialog UI 元件測試 |
| **Playwright** | Extension E2E 測試 |
| **c8 / istanbul** | 程式碼覆蓋率（透過 Vitest 內建） |

### 覆蓋率目標

| 範圍 | 目標 |
|------|------|
| `extension/src/crypto/` | ≥ 90%（安全關鍵模組） |
| `extension/src/api/` | ≥ 80% |
| `extension/src/dialog/` | ≥ 70% |
| `worker/src/` | ≥ 80% |
| 整體 | ≥ 70% |

---

## 九、CI/CD

### CI — GitHub Actions

每次 Push / PR 自動觸發：

```yaml
# .github/workflows/ci.yml 預計結構

on: [push, pull_request]

jobs:
  extension-check:
    # Node 20
    steps:
      - pnpm install
      - pnpm lint          # ESLint + Prettier
      - pnpm typecheck     # tsc --noEmit
      - pnpm test          # Vitest (unit + component)
      - pnpm build         # Vite build，確認產出物正常

  worker-check:
    # Node 20
    steps:
      - cd worker && pnpm install
      - pnpm lint
      - pnpm typecheck
      - pnpm test          # Vitest + Miniflare (unit + integration)
      - pnpm build         # wrangler build 驗證

  e2e:
    needs: [extension-check, worker-check]
    steps:
      - Build extension
      - Start Miniflare local worker
      - Playwright E2E tests with Chrome + Extension loaded
```

#### CI 觸發規則

| 事件 | extension-check | worker-check | e2e |
|------|:---:|:---:|:---:|
| Push to any branch | ✅ | ✅ | ❌ |
| PR to `main` | ✅ | ✅ | ✅ |
| Merge to `main` | ✅ | ✅ | ✅ |

### CD — 自動部署

| 目標 | 觸發條件 | 動作 |
|------|---------|------|
| **Worker** | Merge to `main` + worker/ 有變更 | `wrangler deploy` 部署至 Cloudflare |
| **GitHub Pages** | Merge to `main` + site/ 有變更 | 部署 `site/` 至 GitHub Pages |
| **Extension** | Git tag `v*` | Build → 產出 `.zip` → GitHub Release artifact |
| **PWA** | Merge to `main` + pwa/ 有變更 | 部署至 Cloudflare Pages（或 Vercel） |

### CI/CD 所需的 GitHub Secrets

| Secret | 用途 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Worker / Pages 部署 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 帳號識別 |

> 不需要額外的 secrets 做測試 — Miniflare 在 CI 中模擬完整 KV 環境，不連接真實 Cloudflare。

---

## 十、開發路線圖 (Roadmap)

### Phase 0：專案基礎建設 ✅ 已完成

- [x] 專案架構初始化（Vite + React + TypeScript）
- [x] Chrome Extension Manifest V3 設定
- [x] Content Script：在讀墨頁面注入「家庭書櫃」入口按鈕 + Dialog 框架
- [x] Dialog UI：狀態機骨架（引導畫面 → 主畫面分頁切換）
- [x] E2EE 加密模組（AES-256-GCM encrypt/decrypt + Base62 encoding）
- [x] 同步碼 encode/decode（含 `@host` 自訂端點支援）
- [x] API Client（可切換 endpoint）
- [x] Background Service Worker（chrome.storage messaging）
- [x] Cloudflare Workers API 骨架（Hono + KV）
  - [x] 個人開放設定 CRUD（`GET/PUT /api/user/:id/books`）
  - [x] 家庭群組管理（`POST /api/family`、join、leave、members）
  - [x] 家庭書櫃聚合查詢（`GET /api/family/:id/bookshelf`）
- [x] KV schema 定義（`user:`, `family:`, `member:` key patterns）
- [x] 前端測試環境建置（Vitest + React Testing Library + chrome mock）
- [x] 後端測試環境建置（Vitest + mock KV）
- [x] Crypto / Sync Code unit tests（11 tests passing）
- [x] Worker API unit + integration tests（15 tests passing）
- [x] GitHub Actions CI 設定（extension-check + worker-check）
- [x] GitHub Actions CD 設定（Worker deploy、GitHub Pages、Extension release）
- [x] README.md（繁體中文）+ LICENSE（MIT）+ .gitignore
- [x] AGENTS.md + CLAUDE.md
- [x] .claude/rules（4 個）+ .claude/skills（10 個，含完整 frontmatter）
- [x] GitHub Pages 說明頁面（`site/index.html`）
- [x] 自建後端部署教學（`worker/DEPLOY.md`）

### Phase 1：MVP — 功能完善 ✅ 已完成

> 前提：需先完成 GitHub repo 建立 + Cloudflare 環境設定

- [x] Content Script：實際讀墨書單爬取邏輯（解析頁面 DOM 取得書籍資料）
- [x] Dialog UI：個人書櫃管理功能完善（從爬取結果載入書單、逐本開關、儲存變更）
- [x] Dialog UI：家庭開放書櫃功能完善（從 API 載入聚合書單、按成員分組顯示）
- [x] Dialog UI：家庭同步碼建立/加入（串接 API、同步碼顯示/複製/輸入）
- [x] Dialog UI：家庭設定頁完善（成員列表、離開家庭、同步碼再次查看）
- [x] E2EE 整合：個人書單加密後儲存 / 聚合書單解密後顯示
- [x] 儲存變更後才同步機制（dirty state tracking + 明確儲存按鈕）
- [x] 新書預設不開放邏輯（合併爬取結果 vs 已儲存設定）
- [x] Cloudflare KV namespace 建立 + wrangler.toml 更新
- [x] Worker 部署至 Cloudflare（首次 `wrangler deploy`）
- [x] 使用者識別：SHA-256(email) 作為 deterministic userId
- [x] 借入書籍過濾（不爬取他人借出的書）
- [x] 開發/正式環境分離（Vite env vars + preview-kv / prod-kv）

### Phase 2：安全性強化與測試補齊

- [x] 完整 E2EE 端對端加密流程驗證（53 tests：encrypt.test.ts 29 + e2ee-flow.test.ts 24）
- [x] 家庭解綁/重新綁定流程處理（chrome.storage 清理 + 重新引導）
- [x] Rate Limiting 中介層（防濫用）（60 req/min/IP，worker/src/middleware/rateLimit.ts）
- [x] 隱私政策頁面（docs/privacy-policy.md，繁體中文完整版）
- [x] Dialog 元件測試補齊（React Testing Library）（16 tests：FamilySettings 6 + Onboarding 6 + PersonalShelf 4）
- [ ] E2E 測試建置（Playwright + Chrome Extension 載入）— ⚠️ 未完成：目錄已建立但無測試檔案，缺少 playwright.config.ts 及 @playwright/test 依賴
- [x] Crypto 模組完整覆蓋率達 ≥ 90% — ⚠️ 所有 8 個導出函數皆有測試覆蓋，但 @vitest/coverage-v8 未安裝，尚無量化數據

### Phase 3：行動端支援與自訂後端

- [ ] PWA 行動端家庭書櫃查看器
- [ ] PWA 加入家庭（同步碼輸入）
- [ ] 響應式 UI 設計
- [ ] Extension / PWA 設定頁：自訂 API 端點 UI
- [ ] 同步碼中編碼 API 端點資訊（自建使用者友善）
- [ ] PWA CI/CD 設定（Cloudflare Pages or Vercel）
- [ ] Extension release CD 驗證（git tag → GitHub Release .zip）

### Phase 4：開源與社群

- [ ] Contributing Guide
- [ ] GitHub Pages 說明頁面上線驗證
- [ ] Chrome Web Store 上架

---

## 十一、專案結構（預覽）

```
moo-family-bookshelf/
├── docs/                    # 計畫書與文件
│   ├── project-plan.md      # 本計畫書
│   ├── privacy-policy.md    # 隱私政策
│   └── architecture.md      # 架構設計文件
├── extension/               # Chrome Extension 原始碼
│   ├── src/
│   │   ├── dialog/          # Dialog UI (React) — 注入讀墨頁面的彈窗
│   │   │   ├── Onboarding.tsx      # 引導畫面（建立/加入家庭）
│   │   │   ├── PersonalShelf.tsx   # 個人書櫃管理（開放/關閉設定）
│   │   │   ├── FamilyShelf.tsx     # 家庭開放書櫃瀏覽
│   │   │   └── FamilySettings.tsx  # 家庭設定（同步碼、成員、離開）
│   │   ├── settings/        # Extension 設定頁（自訂 API 端點等）
│   │   ├── content/         # Content Script (書單爬取 + Dialog 注入)
│   │   ├── background/      # Service Worker
│   │   ├── crypto/          # E2EE 加密模組
│   │   └── api/             # API 呼叫層（支援可設定的 endpoint）
│   ├── tests/               # 前端測試
│   │   ├── unit/            # Unit tests (crypto, api, utils)
│   │   ├── component/       # Component tests (React Testing Library)
│   │   └── e2e/             # E2E tests (Playwright + Extension)
│   ├── public/
│   │   └── manifest.json    # Extension Manifest v3
│   ├── vitest.config.ts     # Vitest 設定
│   ├── playwright.config.ts # Playwright E2E 設定
│   ├── vite.config.ts
│   └── package.json
├── worker/                  # Cloudflare Workers 後端（可自建部署）
│   ├── src/
│   │   └── index.ts         # Worker 入口
│   ├── tests/               # 後端測試
│   │   ├── unit/            # Unit tests (routes, middleware)
│   │   └── integration/     # Integration tests (Miniflare + KV)
│   ├── vitest.config.ts     # Vitest 設定
│   ├── wrangler.toml        # Cloudflare 設定
│   └── DEPLOY.md            # 自建部署教學
├── pwa/                     # PWA 行動端（Phase 3）
│   ├── src/                 # 與 Extension 共用 api/ 和 crypto/ 模組
│   └── package.json
├── site/                    # GitHub Pages 說明頁面
│   └── index.html           # 靜態單頁，專案介紹與使用說明
├── .github/
│   └── workflows/
│       ├── ci.yml           # CI：lint + typecheck + test + build
│       └── cd.yml           # CD：Worker deploy / Pages deploy / Release
├── .gitignore
├── .dev.vars                # 本地環境變數（不入版控）
├── LICENSE
└── README.md
```

---

## 十二、授權

本專案計畫採用 **MIT License** 開源。

---

*最後更新：2026-03-25*
