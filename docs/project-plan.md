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
     └─────────────────────────────────┘
```

### 技術選型

| 層級 | 技術 | 說明 |
|------|------|------|
| **Frontend** | React + TypeScript + Vite | Chrome Extension，Dialog UI 注入讀墨頁面 |
| **Backend** | Cloudflare Workers | Serverless API，免費額度每日 10 萬次 |
| **Storage** | Cloudflare KV | Key-Value 儲存，低延遲 |
| **雜湊** | Web Crypto API (SHA-256) | 使用者識別碼雜湊 |

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
- **同步碼**：用於識別/加入家庭群組的憑證（備用恢復方式）
- **多裝置同步**：透過 `chrome.storage.sync` 自動同步至同 Google 帳號的所有裝置

### Dialog 狀態流程

```
開啟 Dialog
    │
    ▼
檢查 chrome.storage.sync 或 local 是否有 family_id？
    │
    ├─ 否 → 顯示「開始使用」引導畫面
    │         │
    │         ▼ 使用者按「開始使用」
    │         顯示 loading 遮罩
    │         → 自動導航到 #/me，抓取帳號名稱 + email
    │         → 查詢 API 是否有既有資料
    │         │
    │         ├─ 有既有家庭資料 → 自動恢復（從 chrome.storage.sync）
    │         │                   → 導航到書櫃頁面，同步書籍
    │         │                   → 導航回原始頁面
    │         │                   → 移除遮罩，進入主畫面
    │         │
    │         └─ 沒有既有資料 → 移除遮罩，顯示選擇畫面
    │                          ├─ 建立新家庭 → 生成同步碼
    │                          └─ 加入家庭（輸入同步碼）
    │                          → 導航到書櫃頁面，同步書籍
    │                          → 導航回原始頁面，進入主畫面
    │
    └─ 是 → 顯示主畫面（分頁）
              ├─ 家庭開放書櫃（預設分頁）
              ├─ 個人書櫃管理
              └─ 設定
```

### 多裝置同步機制

提供兩種同步方式，使用者不需額外操作：

| 方式 | 運作原理 | 適用場景 |
|------|---------|---------|
| `chrome.storage.sync` | Chrome 自動同步到同 Google 帳號的所有裝置 | 主要方式，零操作恢復 |
| 同步碼（Sync Code） | 手動輸入同步碼恢復 | 備用方式，不同 Google 帳號時使用 |

- `familyId` 同時存入 `chrome.storage.sync` 和 `chrome.storage.local`
- 新裝置安裝 Extension 後，自動從 sync storage 讀取，無感恢復
- `chrome.storage.sync` 上限 100KB，我們的資料不到 1KB，綽綽有餘

### 使用者流程

#### 初次使用（一鍵設定）

1. 安裝 Chrome Extension
2. 進入讀墨頁面，點擊 Extension 注入的「家庭書櫃」按鈕
3. 開啟 Dialog，顯示「開始使用」按鈕
4. 按下「開始使用」後，顯示 loading 遮罩（半透明背景 + 進度提示）
5. 系統自動：
   - 導航到 `#/me`，抓取使用者名稱（`.me-nickname`）及 email
   - 用 deriveUserId（加鹽 SHA-256, `moo:` prefix）產生 userId
   - 查詢 API 是否已有此 userId 的資料
   - 若已有家庭資料：自動恢復，跳至步驟 7
   - 若無：移除遮罩，顯示「建立新家庭」或「加入家庭（輸入同步碼）」選擇
6. 使用者選擇建立或加入家庭
7. 系統自動導航到書櫃頁面（`#/library`），爬取個人書單並同步
8. 導航回原始頁面，移除遮罩
9. 進入主畫面

#### 換裝置恢復

1. 在新裝置安裝 Extension，使用相同 Google 帳號登入 Chrome
2. `chrome.storage.sync` 自動同步 `familyId`
3. 開啟 Dialog 即可直接使用，無需重新設定
4. 若使用不同 Google 帳號，可手動輸入同步碼恢復

#### 管理個人開放書櫃

> 此步驟必須在加入家庭之後才能操作。

1. 在主畫面切換到「個人書櫃管理」分頁
2. Content Script 自動爬取個人書單
3. 所有書籍預設為「不開放」，使用者逐本切換開關
4. 可透過搜尋（書名/作者）快速找到書籍
5. 可透過 Filter（全部/開放/不開放）篩選書籍
6. 點擊「儲存變更」，開放設定同步至伺服器
7. 開放的書籍即時出現在家庭開放書櫃

#### 瀏覽家庭開放書櫃

1. 在主畫面的「家庭開放書櫃」分頁（預設分頁）
2. 顯示所有家庭成員已開放的書籍
3. 可透過 Dropdown 篩選成員（預設顯示其他成員的書籍）
4. 可透過搜尋（書名/作者）快速找到書籍

#### 日常操作：編輯個人開放設定

1. 開啟 Dialog → 「個人書櫃管理」分頁
2. 看到自己所有書籍列表，每本旁邊有開放/關閉開關
3. 變更開關後，點擊「儲存變更」才同步至伺服器
4. 新購買的書籍預設為「不開放」

#### 家庭解綁與重新綁定

1. 使用者在 Dialog 的「設定」中離開家庭
2. 個人開放書櫃設定**不受影響**，仍保留在伺服器
3. 下次開啟 Dialog 時，因不屬於任何家庭，回到引導畫面
4. 重新建立或加入新家庭群組
5. 之前設定為開放的書籍自動出現在新家庭的開放書櫃中，無需重新設定

### 資料結構 (Schema)

#### 個人開放設定（Per User，持久化，不隨家庭變動）

```json
{
  "user_id": "user_hashed_id",
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
}
```

#### 家庭群組（Per Family）

```json
{
  "family_id": "family_sync_code",
  "owner_id": "user_hashed_id_1",
  "members": ["user_hashed_id_1", "user_hashed_id_2"],
  "max_members": 2,
  "created_at": "2026-03-25T00:00:00Z"
}
```

#### 家庭管理規則

- **人數上限**：每個家庭最多 2 人（配合讀墨官方家庭帳號限制：1 成人 + 1 成人）
- **管理者（Owner）**：建立家庭的人自動成為 Owner
- **移除成員**：Owner 可以移除其他成員；一般成員只能移除自己（離開家庭）
- **管理權轉移**：Owner 離開家庭前，必須先將管理權轉移給另一位成員
- **加入限制**：當家庭成員數已達上限時，`POST /api/family/:id/join` 回傳 403

#### 家庭開放書櫃（聚合查詢，非獨立儲存）

家庭開放書櫃不獨立儲存，而是查詢時動態聚合：取得家庭成員列表 → 各成員的 `is_shared: true` 書籍 → 合併顯示。

> ⚠️ 僅同步必要資訊（書名、作者、ISBN），不同步閱讀進度或個人資料。

---

## 四、資安與隱私機制

### 安全架構

1. **傳輸安全**：所有 API 通訊透過 HTTPS 加密傳輸
2. **存取控制**：以 auth token 驗證每次請求，確保只有授權使用者可存取資料
3. **高熵同步碼**：使用高隨機性字串，防止暴力猜測
4. **權限分離**：家庭成員僅能瀏覽他人已開放的書籍，無法修改他人設定
5. **預設不開放**：所有書籍（含新購入）預設為不開放，由使用者主動選擇

### 隱私設計要點

- 個人開放設定由使用者完全掌控，可隨時調整
- 儲存變更後才同步至伺服器，避免意外洩漏
- 家庭解綁後，個人資料不會被家庭其他成員繼續存取（因成員已從家庭群組移除）

### 隱私政策聲明

> 🔒 **隱私與安全**：本工具採開源設計，所有資料透過 HTTPS 安全傳輸並以 auth token 控管存取權限，不收集任何個人識別資訊。

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
| 個資法規 | ✅ 低 | 不收集個資 |

### 避險策略

1. 以「個人開發」心態完成，不商業化
2. 命名使用 `MooFamily Bookshelf`，避免直接使用 `Readmoo` 商標
3. 以 TLS + auth token 保護資料存取
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
| **Unit** | Vitest | 純邏輯模組：雜湊、同步碼解析、API client、資料合併 | `crypto/hash.test.ts`、`api/parseSyncCode.test.ts` |
| **Component** | Vitest + React Testing Library | Dialog UI 元件：狀態切換、開關互動、表單驗證 | `dialog/PersonalShelf.test.tsx`、`dialog/Onboarding.test.tsx` |
| **E2E** | Playwright + Chrome Extension testing | 完整流程：安裝 Extension → 開啟 Dialog → 建立家庭 → 設定開放書籍 | `e2e/family-flow.spec.ts` |

#### 前端測試重點

- **Crypto 模組**：deriveUserId 雜湊、同步碼編碼/解碼（含 `@host` 格式）
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
- **個人設定 CRUD**：儲存 / 讀取 / 更新開放設定，驗證資料正確儲存
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
- [x] Crypto 雜湊工具（SHA-256 deriveUserId）
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
- [x] Crypto / Sync Code unit tests（passing）
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
- [x] 個人書單儲存 / 聚合書單載入顯示
- [x] 儲存變更後才同步機制（dirty state tracking + 明確儲存按鈕）
- [x] 新書預設不開放邏輯（合併爬取結果 vs 已儲存設定）
- [x] Cloudflare KV namespace 建立 + wrangler.toml 更新
- [x] Worker 部署至 Cloudflare（首次 `wrangler deploy`）
- [x] 使用者識別：deriveUserId（加鹽 SHA-256, `moo:` prefix）作為 deterministic userId
- [x] 借入書籍過濾（不爬取他人借出的書）
- [x] 開發/正式環境分離（Vite env vars + preview-kv / prod-kv）

### Phase 2：安全性強化與測試補齊

- [x] 家庭解綁/重新綁定流程處理（chrome.storage 清理 + 重新引導）
- [x] Rate Limiting 中介層（防濫用）（60 req/min/IP，worker/src/middleware/rateLimit.ts）
- [x] 隱私政策頁面（site/privacy-policy.html，繁體中文完整版）
- [x] Dialog 元件測試補齊（React Testing Library）（16 tests：FamilySettings 6 + Onboarding 6 + PersonalShelf 4）
- [x] E2E 測試建置（Playwright + Chrome Extension 載入）— 15 個測試（4 個 spec）：家庭生命週期（含多用戶）、書籍分享、Dialog 狀態機、自訂端點 + 選擇器驗證工具 + CI 整合
- [x] Crypto 模組測試覆蓋

### Phase 2.5：桌面版 UX 改善（v1.0 前必要）✅ 已完成

> 在進入 PWA 行動端之前，先完善桌面版 Chrome Extension 的使用體驗。

#### 初次使用流程簡化
- [x] 「開始使用」一鍵引導（取代多步驟 Onboarding）— `useAutoSetup` hook + `LoadingOverlay` 元件
- [x] Loading 遮罩 UI（半透明背景 + 進度提示文字）
- [x] 自動導航抓取帳號資料（`#/me` 頁面 `.me-nickname` + email）
- [x] 自動導航到書櫃頁面同步書單（`#/library`）
- [x] 完成後自動導航回原始頁面

#### 多裝置同步
- [x] `chrome.storage.sync` 支援（自動同步 familyId）— 寫入 sync + local，讀取 sync 優先
- [x] 保留 Sync Code 作為備用恢復方式

#### 顯示名稱
- [x] 可編輯顯示名稱（Settings 頁面）— `DisplayNameEditor` + `useDisplayName` hook
- [x] 初次使用時預設抓取讀墨使用者名稱（`.me-nickname`）
- [x] UI 標註「此名稱僅用於家庭書櫃，不影響讀墨帳號」

#### 家庭管理
- [x] 家庭人數上限 2 人（後端驗證 + 前端提示）— 後端已於 Phase 2 完成
- [x] Owner 角色（建立者 = 管理者）— `MemberList` 元件顯示 Owner 標記
- [x] Owner 可移除其他成員 — `removeMember` API + 確認對話框
- [x] Owner 離開前須轉移管理權 — `transferOwnership` API + 確認對話框

#### 搜尋功能（純前端，不呼叫 API）
- [x] 家庭書櫃：搜尋書名 + 作者（即時過濾，debounce 300ms）— `SearchBar` + `useSearch` hook
- [x] 個人書櫃：搜尋書名 + 作者（即時過濾，debounce 300ms）

#### 篩選功能
- [x] 家庭書櫃：Dropdown 篩選成員（預設顯示其他成員）— `MemberDropdown` 元件
- [x] 個人書櫃：Filter 切換 全部/開放/不開放 — `StatusFilterBar` 元件

#### Dialog UI 補充
- [x] Footer 標註「本功能由第三方開發，非 Readmoo 官方提供」— `DialogFooter` 元件
- [x] Footer 顯示版本號（`v0.x.x`）
- [x] 問題回報連結（GitHub / Plurk icons）— `config/links.ts` 配置檔管理

#### 版本管理
- [x] 版本格式：Semantic Versioning（MAJOR.MINOR.PATCH）
- [x] Single Source of Truth：`extension/package.json` 的 `version` 欄位
- [x] Build 時注入 `__APP_VERSION__` 環境變數（Vite `define`）
- [x] `manifest.json` 的 `version` 在 build script 中從 `package.json` 同步 — `scripts/sync-version.ts`
- [x] Dialog footer 顯示版本號

### Phase 3：行動端支援與自訂後端 ✅ 已完成

#### PWA 認證設計
- [x] Extension 設定頁：「連結手機」按鈕，產生 QR Code（PWA URL + familyId + userId）
- [x] PWA Landing Page：掃碼自動解析 URL params → 儲存至 localStorage → 自動 join 取得 auth token
- [x] PWA 備用入口：手動輸入同步碼 + 讀墨 Email（前端 deriveUserId → userId，不上傳伺服器）

#### PWA 核心功能
- [x] PWA 專案建置（React + TypeScript + Vite + Tailwind，共用 api/ 模組）
- [x] PWA 家庭書櫃瀏覽（成員篩選 + debounce 搜尋 + 2 欄書籍卡片）
- [x] PWA 個人書櫃管理（開關已同步書籍的開放狀態，無法新增書籍）
- [x] PWA 家庭設定（成員列表、Owner 管理（轉移/移除）、離開家庭、同步碼複製）
- [x] 響應式 UI 設計（手機優先，底部導覽列，Tailwind CSS）

#### 自訂後端
- [x] Extension 設定頁：自訂 API 端點 UI（可展開「進階設定」，URL 驗證 + 儲存/重設）
- [x] PWA 設定頁：自訂 API 端點 UI（同上，使用 localStorage）
- [x] 同步碼中編碼 API 端點資訊（自建使用者友善）— 已於 Phase 0 實作 encode/decode

#### 安全性強化（Security Audit 修復）
- [x] API 認證 middleware（Bearer token，建立/加入家庭時產生 token）
- [x] familyId 路徑參數驗證（`^[a-z0-9]{4}-[a-z0-9]{4}$`）
- [x] 家庭成員授權檢查（非成員回傳 403）
- [x] .env 檔案從 git 移除 + .gitignore 修正
- [x] Sync code 解析器修復（正確處理含 dash 的 familyId）
- [x] Auth token 端對端整合（Extension + PWA + Worker）
- [x] Token TTL 90 天 + 格式驗證 + 離開時清除
- [x] 移除 production console.log 中的敏感資料

#### 部署與發布
- [x] PWA CI 設定（pwa-check job：lint + typecheck + test + build）
- [x] PWA CD 設定（Cloudflare Pages，merge to main 自動部署）
- [x] Extension release CD 已設定（git tag `v*` → build → zip → GitHub Release）

### Phase 4：開源與社群

- [x] Contributing Guide（`CONTRIBUTING.md`）
- [x] GitHub Pages 說明頁面上線驗證（品牌 Logo、OG 標籤、SVG 圖示替換 emoji、正確 GitHub URL）
- [x] Chrome Web Store 上架（v1.0.0）— [商店頁面](https://chromewebstore.google.com/detail/ogclfjfjdiminibemhbckobeapnohjnk)

### Phase 5：借閱功能（v1.1.0）✅ 已完成

> 允許家庭成員申請借閱對方的書籍，整合讀墨原生借書功能（Scope B：Content Script 自動化）。
> **完整規格**：見 [`docs/v1.1.0-borrow-feature.md`](./v1.1.0-borrow-feature.md)
> **發布日期**：2026-04-28（commit `b6b5615`）

#### 後端
- [x] KV schema：新增 `borrow:{requestId}` + `borrows:family:{familyId}` 索引
- [x] FamilyMember 擴充 `canLend` + `readmooName` 欄位（含向後相容，`normalizeFamilyRecord` 補回 legacy 紀錄的 canLend=TRUE）
- [x] `POST /api/family/:id/borrow`（建立申請，含 canLend 雙向檢查 + duplicate 防護）
- [x] `GET /api/family/:id/borrow`（家庭請求列表）
- [x] `PATCH /api/borrow/:requestId`（狀態轉移 + 權限驗證 + FSM）
- [x] `PATCH /api/family/:id/member/:uid`（更新 canLend / readmooName）
- [x] `DELETE /api/family/:id/member/:uid` 新增 side effect：成員移除時 PENDING 自動 CANCELLED（先於 family 變更執行，確保 Invariant 4）
- [x] Rate limiting（reusable `enforcePerUserRateLimit` helper，套用於借閱 + `PUT /api/user/:id/books`）
- [x] Unit + Integration tests（≥ 80% coverage，新增 borrow / member-settings / rateLimit 測試）

#### 前端 Extension
- [x] BookCard hover overlay「申請借閱」按鈕（僅 FamilyShelf context + 雙方 canLend）
- [x] 第 4 個分頁「借閱」：收件匣/寄件匣 + status FSM 操作
- [x] FamilySettings 新增 per-member canLend 切換（ownerId only）
- [x] readmooName 一次性設定 UI（同意借閱時 lazy 觸發）
- [x] Content Script `readmoo-lend.ts` 自動化模組（找書 → 開 modal → 借出 → 選成員 → 偵測 dialog 關閉）
- [x] 浮動按鈕 badge（page ready 後查 pending count）+ 「借閱」分頁 PENDING badge
- [x] Component tests（≥ 70% coverage，新增 BorrowTab / MemberList canLend / BookCard borrow button 測試）

#### 前端 PWA
- [x] 借閱 tab（共用設計，無「同意借閱」按鈕，引導書主回到桌面 Extension 操作）
- [x] 申請 / 取消 / 標記已歸還（無同意 / 拒絕）

#### 共用
- [x] BorrowStatus enum + BorrowRequest 型別
- [x] API client `createBorrowRequest` / `listBorrowRequests` / `updateBorrowStatus` / `updateMemberSettings`
- [x] 版本 bump 至 `1.1.0`（Extension + PWA 同步）

### Phase 6：個人公開書櫃分享（v1.2.0）✅ 已完成

> 使用者可產生獨立網址，將個人開放書櫃對外公開分享。訪客無須登入即可瀏覽。
> **資料模型採可擴充設計**：v1.2.0 每位使用者僅允許 1 組公開書櫃，未來（v1.3+）可在不更動 schema 與 API 形狀的前提下擴充至多組（規劃上限 3 組）。
> **發布日期**：2026-05-03（commit `c546277`）

#### 核心功能
- [x] 個人書櫃頁面新增「分享」icon，點擊開啟公開書櫃設定 Dialog
- [x] 公開書櫃設定 Dialog：開啟/關閉公開分享（預設關閉）
- [x] 公開書櫃設定 Dialog：自訂標題（預設「{display_name} 的公開書櫃」，可修改）
- [x] 公開書櫃設定 Dialog：設定過期時間（7 / 30 / 60 / 90 天 / 永久，預設 30 天）
- [x] 公開書櫃設定 Dialog：重設網址（產生新 share token，舊網址立即失效；shelfId 不變）
- [x] 公開書櫃設定 Dialog：複製公開連結

#### 公開書櫃頁面（PWA 路由 `/public/{share_token}`）
- [x] 不需登入即可瀏覽
- [x] 頁面上方說明文字：「此為對外公開書櫃，無須登入即可瀏覽」
- [x] 標題顯示使用者自訂的公開書櫃名稱
- [x] 書單搜尋功能（書名 + 作者，純前端即時過濾）
- [x] 書籍連結至讀墨購買介紹頁（`https://readmoo.com/book/{bookId}`，另開新分頁）
- [x] 不提供借閱功能
- [x] 顯示封面圖片（來源：讀墨 CDN，含 onError fallback）

#### 後端 API（採「可定址」設計，從 day-1 即用 `:shelfId` 路由）
- [x] `GET /api/user/:id/public-shelf` — 列出所有 shelves（v1.2.0 最多 1 組）
- [x] `POST /api/user/:id/public-shelf` — 建立新 shelf（達上限時回 409 Conflict）
- [x] `PUT /api/user/:id/public-shelf/:shelfId` — 更新指定 shelf 設定（標題、過期）
- [x] `POST /api/user/:id/public-shelf/:shelfId/reset-token` — 重設 shareToken（shelfId 不變）
- [x] `DELETE /api/user/:id/public-shelf/:shelfId` — 關閉指定 shelf
- [x] `GET /api/public/:shareToken` — 查詢公開書櫃（不需認證）

#### KV Schema 擴充
- [x] `public:{share_token}` → `{ userId, shelfId, title, books[], createdAt, expiresAt }` （明文快照，KV TTL 管理過期）
- [x] `user:{id}` 擴充 `publicSharing` 欄位（array 結構）：
  ```typescript
  publicSharing?: {
    shelves: PublicShelf[];  // v1.2.0 強制 length <= 1
  };
  interface PublicShelf {
    shelfId: string;          // 內部識別（UUID），重設網址後仍維持
    shareToken: string;       // 對外網址 token（可重設）
    title: string;
    expiresDays: number | null;  // null = 永久
    createdAt: number;
    expiresAt: number | null;
    selectionMode: "all-shared";  // v1.2.0 僅此模式；未來加 "explicit" 支援自選書籍
    // bookIds?: string[];     // 預留：未來 "explicit" 模式啟用
  }
  ```

#### 設計考量
- **書單來源**：v1.2.0 公開書櫃的書 = 個人書櫃中 `isShared === BoolFlag.TRUE` 的同一組書（`selectionMode: "all-shared"`）
- **資料同步**：採快照模式，`PUT /api/user/:id/books` 時自動更新所有 active shelves 的 `public:{token}` 快照
- **使用前提**：曾加入過家庭以完成書單同步即可（不要求目前處於家庭中），詳見 Q2 解讀 B
- **share_token 格式**：UUID 32 碼（無連字號），高熵防猜測
- **shelfId 與 shareToken 分離**：shelfId 為內部識別，shareToken 為對外連結；重設網址僅替換 shareToken，shelfId 不變
- **過期語義**：建立時 `expiresAt = createdAt + expiresDays`；更新 `expiresDays` 時 `expiresAt = 更新時間 + expiresDays`（從更新時起算，而非建立時）
- **封面圖片**：hotlink 讀墨 CDN，需測試可用性，必要時 fallback placeholder
- **重設網址**：刪除舊 `public:{old_token}` + 建立新 `public:{new_token}`，更新 user record 中對應 shelf 的 `shareToken`
- **關閉公開分享**：刪除 `public:{token}` + 移除 user record 中的 shelf 元素
- **PWA 路由**：v1.2.0 採混合路由（公開頁面 path-based `/public/:token`，其餘維持 hash routing）；全面遷移至 path-based 留待獨立 refactor

#### 擴充路徑（v1.3+ 多組公開書櫃）
- 將 worker 常數 `MAX_PUBLIC_SHELVES` 由 1 提升至 3（或設定值）
- UI 增加 list view 管理多組 shelves
- 啟用 `selectionMode: "explicit"` + `bookIds[]` 支援自選書籍
- 既有 API 路由形狀無需變更

### Phase 7：v1.3.0 — 簡易修正 + 影響現有使用者的修正 + 開發者體驗（規劃中）

> 正式上線（v1.0.0 / v1.2.x）後使用者回饋。**v1.3 範圍只放三類**：
> 1. **簡易修正與驗證**：純 CSS / 文案 / 已實作項目的驗證（風險低，可快速放出）
> 2. **影響現有使用者的修正**：補齊既有功能在實際使用上的痛點（爬不到 >200 本書、需要手動取名、借閱前置設定、>100 本書儲存卡頓）
> 3. **開發者體驗（DX）**：dev 環境的 API 測試介面（不影響正式環境使用者）
>
> 「新增功能」類項目延後到 v1.4 / v1.5 / v1.6 漸進釋出（見 Phase 8–10），避免一次塞太多在同一個 minor。
>
> **狀態**：僅完成計畫，**尚未開始實作**。

#### 7.1 簡易修正與驗證

##### Wave A — UI 修正與小幅樣式調整（風險最低，先行）

- [ ] **#12 PWA `<select>` 箭頭跑版修復**
  - 純 CSS 修正，影響 PWA 數個下拉欄位
- [ ] **#14 PWA「個人書櫃」儲存按鈕 sticky 至視窗底部**
  - 目前必須滑到最下方才看得到「儲存變更」bar；改為 `position: sticky; bottom: 0`（或 fixed）
  - 確保 safe-area-inset-bottom（iOS）
- [ ] **#13 PWA hover 樣式以 `@media (hover: hover) and (pointer: fine)` 限制**
  - 觸控裝置不應殘留 hover 樣式
- [x] **#5 site `index.html` 增加問題回報表單入口**
  - Google 表單已於 v1.2.1 上線，僅補入官網說明頁
- [x] **#4 Extension 書籍封面 100→120 寬調整**
  - 規格：`width: 120px; height: 180px`（修正：原始需求 100→120 寬，等比放大高度）；待 RWD 手動驗證 grid 在小視窗下不爆版

##### Wave H — 基礎設施驗證（CORS / OPTIONS）

- [x] **#15 CORS preflight 確認與長期方向**
  - **現況**：[`worker/src/index.ts:68-78`](../worker/src/index.ts#L68-L78) 已套用 Hono `cors` middleware，並設定 `maxAge: 86400`，與外部建議的「方法①」等價 → **此項主要為驗證、無立即工作**
  - 待辦：
    - 觀察 production preflight log，確認 24h max-age 對使用者連續操作生效（Chromium 上限 7200s，但仍能達到「短時間連續操作只發一次 OPTIONS」效果）
    - 文件記錄此設計決策（避免未來誤改）
  - **中期選項（非 v1.3 必做）**：申請自有 domain 將 Worker 從 `*.workers.dev` 移至 `api.<own-domain>`；同源化是長期解，但前端寄生於 `read.readmoo.com`，本質上仍跨來源，僅是中期收斂選項。優先級 **低**。
  - **不採用**：
    - 改用 cookie / form-encoded body 規避 preflight（API 設計受損，得不償失）
    - 反向代理（無法控制 readmoo 網域）

#### 7.2 影響現有使用者的修正

##### Wave E — 顯示名稱自動帶入

> **資料現況回答**：`displayName` 主要記錄在 `user:{userId}` 的 `UserBooksRecord.displayName`（source of truth），同時 denormalized 到 `family:{familyId}.members[].displayName`。兩者已於 v1.2.x（PR #14）保證同步。

- [ ] **#1 初次建立 / 加入家庭時自動以讀墨會員名稱填入 `displayName`**
  - 行為：
    - **桌面 Extension 流程**：`scrapeDisplayName()` 已存在，在 `useAutoSetup` 完成後將其作為 `displayName` 預設值（取代目前的「使用者-{id 前 4 碼}」 fallback）
    - **PWA 先行加入**：尚無讀墨頁面可爬 → 維持 fallback；待使用者後續從 Extension 開啟時，若偵測到 `displayName` 仍為「使用者-xxxx」格式且讀墨可抓到名稱，自動升級
    - **使用者已自訂名稱不覆寫**：僅在 fallback pattern (`/^使用者-[a-z0-9]{4}$/`) 命中時才升級
  - 升級時同步寫入 `user:{userId}.displayName` 與 `family:{familyId}.members[].displayName`（沿用 PR #14 同步機制）
  - **保留事項**：「家庭成員管理」UI 中的讀墨名稱欄位仍需保留 — 讀墨名稱（用於借閱自動化匹配讀墨成員下拉選單）與 displayName（UI 顯示）是兩個不同概念

##### Wave G — 書籍分頁讀取 + 顯示量控制（>200 本，本版本最大改動）

> **根因更新（2026-05-15）**：使用者回報「按下儲存後桌電主機轟轟轟運作」 — 客端 CPU/GPU 持續滿載，**根因是 1000 本書 row + 書封 `<img>` 全部在 DOM 內**，儲存只是引爆 re-render / repaint。Load More 直接砍 DOM 數量，**同時解掉瀏覽與儲存兩個卡頓場景**，並順帶取代 Wave K 原本規劃的虛擬化。

- [ ] **#10 移除 200 本爬取上限**
  - 讀墨爬取邏輯：偵測下一頁並逐頁爬取至完成
  - 影響：[`extension/src/content/scraper.ts`](../extension/src/content/scraper.ts) 的 `scrapeBooks` 與 [`scraper-archive.ts`](../extension/src/content/scraper-archive.ts)
  - 風險：scrape 時間延長 → `LoadingOverlay` 文案需明確顯示「正在讀取第 N 頁」進度
- [ ] **#10a 顯示層改用「Load More」按鈕**
  - **不採用**虛擬化（`@tanstack/react-virtual`）— 實作複雜、與既有 search / filter 互動容易出 bug；對「DOM 太多」這個根因，砍量比虛擬化更直接
  - 預設顯示首 **100 本**；底部「載入更多」按鈕，每次 +100 本
  - 影響：[`extension/src/dialog/PersonalShelf.tsx`](../extension/src/dialog/PersonalShelf.tsx)、[`extension/src/dialog/FamilyShelf.tsx`](../extension/src/dialog/FamilyShelf.tsx)、PWA 對應頁面
  - 搜尋 / Filter / 成員 Dropdown 套用於**完整書單**而非當前可見頁；匹配結果直接全部顯示（搜尋 + filter 後通常本來就少）
  - 切換 tab / 重新打開 Dialog 時 reset 回首 100（不持久化捲動位置，避免狀態複雜）
- [ ] **#10b 書封圖載入優化**
  - 所有書封 `<img>` 加 `loading="lazy"` + `decoding="async"`
  - 載入前 placeholder：純色背景 + 中央 spinner（與 LoadingOverlay 風格一致），onLoad 後淡入封面、onError 仍走既有 fallback
  - 影響：BookCard / 個人書櫃 row / 家庭書櫃 grid
- KV 容量：單筆 25MB 上限 vs 一本書約 500B → 數萬本仍有空間，無需後端分頁；家庭聚合查詢仍一次回傳，前端 Load More 即可

> ⚠️ Wave G 是 v1.3 中工程量最大的一項，但 Wave K 已大幅縮小（虛擬化併入此處），兩者不再強耦合。建議分批發布：v1.3.0（A + H + E）→ v1.3.1（J）→ v1.3.2（G）→ v1.3.3（K + I）。

##### Wave J — 借閱流程簡化（取消手動填讀墨名稱）

> **目標**：v1.1.0 的「首次借閱前先填讀墨名稱」是大多數使用者的卡點。讀墨家庭多為 2 人，借出 dialog 通常只列出另一位（非書主自己） → 用「依清單長度自動決策」取代手動設定。
> **行為總綱**：n=1 自動借、n≥2 提示並記錄、設定只能刪不能改、找不到自動重選。

- [ ] **#20 借出 dialog 依成員數自動決策**
  - 影響：[`extension/src/content/readmoo-lend.ts`](../extension/src/content/readmoo-lend.ts)、[`extension/src/dialog/BorrowTab.tsx`](../extension/src/dialog/BorrowTab.tsx)
  - 流程改寫：
    - **n=1**：自動點擊該唯一成員，繼續借出流程，**不顯示 MooFamily UI、不寫入 `readmooName`**（每次借閱重新偵測即可，避免不必要 KV 寫入）
    - **n≥2 + 有 `readmooName` 且找得到匹配**：自動點擊匹配成員（沿用 v1.1.0 fast-match 路徑）
    - **n≥2 + 無 `readmooName` 或找不到匹配**：彈出「請確認要借給誰」選擇 UI → 使用者選擇 → `PATCH /api/family/:id/member/:uid { readmooName }` 寫入記錄 → 點擊
  - 取消 v1.1.0 的「同意借閱前先跑 readmooName setup」前置流程
  - 實作注意：先實測讀墨借出 dialog 是否包含書主自己，若包含則 #20 的「n」需先排除自己再判斷
- [ ] **#21 「找不到」即自動重選**
  - [`extension/src/content/readmoo-lend.ts:184-198`](../extension/src/content/readmoo-lend.ts#L184-L198) 既有的「找不到名稱 → throw」改為觸發 #20 的選擇 UI（與「使用者刪除設定」、「讀墨改名」共用同一 fallback path）
  - 選擇後 **覆蓋** user record 中舊的 `readmooName`，不再要求使用者去設定頁手動更新
- [ ] **#22 設定頁 readmooName 改為「顯示 + 刪除」（不可編輯）**
  - 影響：[`extension/src/dialog/MemberList.tsx:338-385`](../extension/src/dialog/MemberList.tsx#L338-L385)
  - 取消可編輯輸入框（避免使用者自填導致與讀墨名稱對不上）
  - 顯示：目前記錄的 `readmooName`（2 人家庭可能始終為空 — 因為 #20 在 n=1 不寫入）
  - 操作：僅提供「刪除」按鈕；刪除即清空 `readmooName`，下次借閱（在 n≥2 情境）重新觸發選擇
  - 後端 API `PATCH /api/family/:id/member/:uid { readmooName }` 不變
- [ ] **#23 PWA 同步調整**
  - PWA 無 content script，本就無法跑借出自動化；此 Wave 主要影響 Extension
  - PWA MemberList 的 readmooName 欄位同步改為「顯示 + 刪除」，維持兩端一致

##### Wave K — 儲存路徑的 re-render 防爆（補 Wave G 之後的尾巴）

> **範圍縮小說明（2026-05-15）**：原本規劃的「前端虛擬化」併入 Wave G #10a Load More；「fetch-then-put 折衷」對使用者回報的卡頓無實質幫助（多一次 GET roundtrip 反而拖慢），移除。本 Wave 只保留**儲存成功後**的 re-render 防爆，作為 Wave G 之後的補強。
> **與 v1.4 Wave L 關係**：v1.3 不動 API 形狀；v1.4 PATCH 上線後上行流量才真正下來。

- [ ] **#24 儲存成功後不以 response 覆寫本地 state**
  - 影響：個人書櫃儲存流程（Extension `PersonalShelf` + PWA 對應頁面）
  - 現況推測：`setBooks(response.data.books)` 觸發 reconciliation across 全 list → re-render avalanche → 風扇
  - 改為：儲存成功後僅清掉 dirty set（本地 state 已是權威），不重新 `setBooks`
  - 例外：若 server 端有 normalization 邏輯（例如後端清理欄位）需要同步回前端，改為「比對是否真有差異，僅在不同時才 setBooks」
- [ ] **#25 BookRow / BookCard 套 `React.memo`**
  - 確保 toggle 一本書時，僅該 row 重新 render
  - props 比對以 `bookId` + `isShared` + `isDirty` 為 key；避免 inline function / object 破壞 memo
- [ ] **#26 Dirty state 採 `Map<bookId, BoolFlag>` 或 `Set<bookId>`**
  - 取代「整包 array 對比」，未變更的 book 不參與 dirty 計算
  - 與 #25 的 React.memo 配合：dirty 變化的 row 才會 re-render

#### 7.3 開發者體驗（DX）

##### Wave I — API 測試介面（dev-only）

> **目標**：提供類 Swagger 的互動式 API 文件，讓開發 / debug 過程不必反覆寫 curl 或 Postman collection。**僅 dev 環境開啟，production 完全關閉**，避免誤觸正式資料。
> **使用場景**：v1.4 Wave L 規劃新 PATCH endpoint、Wave G 驗證 >200 本書聚合行為時，互動式介面最省力。

- [ ] **#27 Worker routes 改用 zod schema + OpenAPI 註解**
  - 工具：`@hono/zod-openapi`
  - 涵蓋範圍：`auth` / `user` / `family` / `borrow` / `publicShelf` / `verify` 全部 API
  - 輸出：`GET /api/_openapi.json`（dev only）
  - 改寫過程中順便補齊既有 routes 的 input validation（既有部分用手寫 `isValidUserId` 等，可逐步收斂）
- [ ] **#28 掛載 Swagger UI（或 Scalar UI）**
  - 路由：`GET /api/_docs`
  - 選型偏好：`@hono/swagger-ui` 最輕（Hono 官方）；若要更現代外觀可選 Scalar
  - UI bundle 以 CDN 載入，避免增加 worker deploy size
- [ ] **#29 環境隔離（嚴格）**
  - 條件：`c.env.ENVIRONMENT !== "production"` 才**註冊** `/api/_docs` 與 `/api/_openapi.json` routes
  - prod 端：route 完全不存在 → 直接 404，不是回 403（降低暴露面）
  - 本機 `wrangler dev`：開啟
  - dev worker（部署在 `*.workers.dev` 的 dev 子環境）：開啟 → 使用者可直接從瀏覽器訪問 dev URL `/api/_docs`，**不需啟動 `pnpm dev` 或 `pnpm dev:remote`**
- [ ] **#30 文件與安全提醒**
  - [`worker/DEPLOY.md`](../worker/DEPLOY.md) 補充：自建者如何在自己的 dev environment 開啟此功能
  - 安全提醒：自建者若要在 prod 開啟（不建議），須自行加上 IP 白名單 / Basic Auth
  - 不放在 PWA Cloudflare Pages 的理由：OpenAPI spec 與 API 同源（worker 端）最自然，避免 spec 漂移與 CORS preflight 額外開銷（與 Wave H 一致原則）

### Phase 8：v1.4.0 — 顯示偏好、借閱流程提示、書本 PATCH API（規劃中）

> 新增使用者可控的設定項、PWA 借閱手動流程的 UX 改善，以及後端書本 PATCH API（接續 v1.3 Wave K 解決上行流量）。資料模型不動。
> **狀態**：規劃中，待 v1.3 釋出後再啟動。

##### Wave B — 顯示模式與本地偏好（純前端持久化，無 API 變更）

- [ ] **#3 家庭書櫃 Row / Grid 顯示模式記憶**
  - 預設 Grid；偏好寫入 Extension 的 `chrome.storage.local`、PWA 的 `localStorage`
  - Extension 與 PWA 各自記錄，**不互通**（避免增加 sync storage 用量）
  - 影響：`extension/src/dialog/FamilyShelf.tsx`、`pwa/src/...`
- [ ] **#8 Extension 浮動 icon 大小可縮小**
  - 設定頁新增 icon size 選項（small / medium / large 或 px 值）
  - 寫入 `chrome.storage.local`，由 content script 注入時讀取
- [ ] **#9 書籍排序選項**
  - 選項：文字順序（書名、作者）/ 讀墨預設（爬取原順序，現行行為）
  - 個人書櫃 + 家庭書櫃皆需，且各自記憶
- [ ] **#7 設定新增「借閱歷史不顯示封面，純文字呈現」**
  - 預設關閉
  - 影響：「借閱」分頁的「歷史紀錄」區塊；Extension + PWA 同步處理

##### Wave C — PWA 借閱流程提示（行為調整，無 API 變更）

- [ ] **#6 PWA「同意借閱」改為「手動借閱」流程**
  - 點擊「同意借閱」後彈窗警告：手機板無法自動操作讀墨借書，需自行從讀墨網頁 / APP 借出
  - checkbox「不再顯示此通知」→ 寫入 PWA `localStorage`（不上 server）
  - 按鈕：[取消] / [我知道了]
  - 按下「我知道了」即發送借出通知給對方（呼叫既有 `updateBorrowStatus → APPROVED`，與 Extension 自動化路徑共用 API）

##### Wave L — 後端書本 PATCH API（解上行流量）

> **目標**：v1.3 Wave K 已解前端體感與整包重送上行流量的部分（透過 fetch-then-put）；本 Wave 改為真正的部分更新 API，client 只送 diff 給 worker，worker 內部仍維持 KV 整包寫（KV 無 partial update）。
> **與資料庫換型的關係**：本 Wave **不**換 DB，僅改 API 形狀。換 DB 的評估留至 #33。

- [ ] **#31 新增 `PATCH /api/user/:id/books`**
  - 影響：[`worker/src/routes/user.ts`](../worker/src/routes/user.ts)
  - Body：`{ changes: Array<{ bookId: string; isShared: BoolFlag }>, displayName?: string }`
  - Worker 邏輯：read existing record → apply changes → write（同步更新 `publicSharing` 快照）
  - 既有 `PUT /api/user/:id/books` 保留（整包覆寫仍用於 Extension 首次同步全爬書單的情境）
- [ ] **#32 Client 切換 PUT → PATCH**
  - Extension PersonalShelf 儲存：改用 PATCH，body 只含 v1.3 Wave K 算出的 dirty 本數
  - PWA PersonalShelf 同步切換
  - 首次同步（爬完全部書單）仍用 PUT
  - v1.3 Wave K 的「fetch-then-put」折衷邏輯可在此版本整段移除
- [ ] **#33 觀察與決策點：是否需要換 DB**
  - 在 PATCH 上線後加上匿名 telemetry：使用者書本數分佈、單次儲存 dirty count、KV write latency p50 / p95
  - 收集一個 minor 週期（約 4-6 週）後評估
  - **僅在實測證明 KV 整包寫真的吃緊**（例如 p95 > 500ms 或常態觸發 quota 警告）才討論 D1 遷移，否則延後到 v2.0
  - 不在 v1.4 內做 DB 遷移本身

### Phase 9：v1.5.0 — 隱藏書籍可逆（規劃中）

> 補齊「隱藏書籍」流程，使其可逆且可重新顯示。

##### Wave D — 隱藏書籍可逆與篩選

- [ ] **#2 隱藏書籍可重新顯示 + 篩選顯示已隱藏書籍**
  - 個人書櫃 `StatusFilterBar` 增加「已隱藏」篩選選項（現有：全部 / 已開放 / 未開放）
  - 已隱藏視圖支援「取消隱藏」操作
  - 影響：`extension/src/dialog/PersonalShelf.tsx`、PWA 對應頁面
  - 注意：「隱藏」目前的存放欄位需確認是否已有，或需擴充 `BookEntry`（schema 微調）

### Phase 10：v1.6.0 — 我的最愛（規劃中）

> schema 擴充與借閱前 UX 強化。

##### Wave F — 我的最愛

- [ ] **#11 個人書籍可標記「我的最愛」，家庭書櫃可快速篩選對方的最愛**
  - schema：`BookEntry` 新增 `isFavorite: BoolFlag`（與 `isShared` 並列）
  - 個人書櫃 toggle；家庭書櫃成員篩選下方加「只看最愛」開關
  - **設計問題**：是否要對家人公開「最愛」標記？
    - 選項 A：僅自己可見（最愛 ≠ 開放，純個人筆記）
    - 選項 B：對家人公開（家人借書前可優先借「對方推薦」的書）
  - 預設建議 **B**（與借閱目的一致；若使用者不希望公開，仍可不勾「分享」）

---

## 十一、專案結構（預覽）

```
moo-family-bookshelf/
├── docs/                    # 計畫書與文件
│   ├── project-plan.md      # 本計畫書
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
│   │   ├── crypto/          # 雜湊工具（SHA-256）
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
│   ├── src/                 # 與 Extension 共用 api/ 模組
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

*最後更新：2026-05-15（v1.3 新增 Wave I / J / K + 修訂 Wave G：API 測試介面 + 借閱流程簡化 + Load More 顯示 + 書封 lazy load + 儲存 re-render 防爆；v1.4 新增 Wave L：書本 PATCH API）*
