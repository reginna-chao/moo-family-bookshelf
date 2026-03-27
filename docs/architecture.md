# 🏗️ MooFamily Bookshelf — 架構設計文件

## 一、系統架構圖

```
┌───────────────────────────────────────────────────────────┐
│                  使用者瀏覽器（Chrome）                       │
│                                                           │
│  ┌─────────────────┐    ┌──────────────────────────────┐  │
│  │  Content Script  │───▶│  Dialog UI (React)           │  │
│  │ (爬取讀墨書單)    │    │                              │  │
│  │ (注入 Dialog)    │    │  ┌────────────────────────┐  │  │
│  └─────────────────┘    │  │  個人書櫃管理            │  │  │
│                          │  │  (逐本開放/關閉開關)     │  │  │
│                          │  ├────────────────────────┤  │  │
│                          │  │  家庭開放書櫃            │  │  │
│                          │  │  (聚合所有成員開放書籍)   │  │  │
│                          │  ├────────────────────────┤  │  │
│                          │  │  家庭設定               │  │  │
│                          │  │  (同步碼建立/加入)       │  │  │
│                          │  ├────────────────────────┤  │  │
│                          │  │  Crypto Module          │  │  │
│                          │  │  (Web Crypto API E2EE)  │  │  │
│                          │  └────────────────────────┘  │  │
│                          └──────────┬───────────────────┘  │
│                                     │ HTTPS                │
└─────────────────────────────────────┼─────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────┐
                    │     Cloudflare Workers (API)     │
                    │                                 │
                    │  個人開放設定 API                  │
                    │  家庭群組管理 API                  │
                    │  家庭書櫃聚合查詢 API              │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │    Cloudflare KV Store     │  │
                    │  │                           │  │
                    │  │  user:{id}  → 個人開放設定  │  │
                    │  │  family:{id} → 家庭成員列表 │  │
                    │  └───────────────────────────┘  │
                    └─────────────────────────────────┘
```

---

## 二、模組說明

### 2.1 Content Script

- **職責**：
  1. 在讀墨網站頁面中爬取使用者的書單資料
  2. 在讀墨頁面中注入「家庭書櫃」入口按鈕
  3. 管理 Dialog 的開啟/關閉
- **觸發方式**：頁面載入時自動注入入口按鈕，使用者點擊後開啟 Dialog
- **爬取內容**：書名、作者、ISBN、封面圖片 URL、讀墨連結、書籍 ID
- **注意**：僅爬取公開可見的書單資訊，不涉及帳號憑證

### 2.2 Dialog UI (React)

- **職責**：以 Dialog 形式疊加在讀墨頁面上，提供所有互動功能
- **不產生新路由**：所有操作在同一個 Dialog 內透過分頁/切換完成
- **前提條件**：家庭帳號是使用此功能的前提，未加入家庭時僅顯示引導畫面

#### 狀態機

```
┌─────────────────────────────────────┐
│  開啟 Dialog                         │
│  檢查 chrome.storage.sync / local    │
│  是否有 family_id                    │
└──────────┬──────────────────────────┘
           │
     有 family_id?
      ┌────┴────┐
      否        是
      ▼         ▼
┌──────────────┐  ┌──────────────────────┐
│ 引導畫面      │  │ 主畫面（分頁）         │
│              │  │                      │
│ 「開始使用」  │  │ • 家庭開放書櫃（預設） │
│  按鈕        │  │ • 個人書櫃管理        │
│              │  │ • 設定               │
│  ↓           │  └──────────────────────┘
│ Loading 遮罩 │
│  → 抓取帳號  │
│  → 同步書單  │
│  → 回到原頁  │
└──────────────┘
    │ 完成後
    └──────────▶ 進入主畫面
```

#### 引導畫面（未加入家庭時）
  - 顯示「開始使用」按鈕
  - 按下後顯示 Loading 遮罩（半透明背景 + 進度提示）
  - 自動導航到 `#/me` 抓取使用者名稱 + email
  - 查詢 API 是否已有既有資料
  - 若無：提供兩個選項「建立新家庭」/「加入家庭（輸入同步碼）」
  - 完成後自動導航到書櫃頁面同步書單，再返回原始頁面

#### 主畫面分頁（已加入家庭後）
  - **家庭開放書櫃**（預設分頁）：
    - 顯示所有家庭成員已開放的書籍（聚合檢視）
    - Dropdown 篩選成員（預設顯示其他成員的書籍）
    - 搜尋功能（書名 + 作者，純前端即時過濾）
    - 可查看書籍詳情、前往讀墨頁面
  - **個人書櫃管理**：
    - 顯示使用者所有書籍，每本旁邊有開放/關閉開關
    - 預設全部關閉（不開放）
    - 搜尋功能（書名 + 作者，純前端即時過濾）
    - Filter 切換：全部 / 開放 / 不開放
    - 新購買書籍自動顯示為關閉
    - 變更後需點擊「儲存變更」才同步至伺服器
  - **設定**：
    - 編輯顯示名稱（預設為讀墨使用者名稱，標註不影響讀墨帳號）
    - 查看家庭同步碼（可再次複製分享）
    - 查看家庭成員列表（標示 Owner）
    - Owner：可移除其他成員、轉移管理權
    - 離開家庭（Owner 須先轉移管理權）
    - 問題回報連結（GitHub / Plurk / Discord）
  - **Dialog Footer**：
    - 「本功能由第三方開發，非 Readmoo 官方提供」
    - 版本號（`v0.x.x`）

### 2.3 Crypto Module (E2EE)

- **職責**：端對端加密與解密
- **技術**：Web Crypto API
- **流程**：
  ```
  加密：明文書單/設定 → AES-GCM 加密 → 密文 → 上傳至 Server
  解密：下載密文 → AES-GCM 解密 → 明文 → 顯示在 UI
  ```
- **金鑰管理**：加密金鑰嵌入同步碼中，伺服器永遠不接觸金鑰

### 2.4 Cloudflare Workers (API)

- **職責**：提供 RESTful API 進行資料的存取與管理
- **端點**：

#### 個人開放設定 API

| Method | Path | 說明 | 權限 |
|--------|------|------|------|
| `GET` | `/api/user/:id/books` | 取得個人書單及開放設定 | 本人 |
| `PUT` | `/api/user/:id/books` | 更新個人開放設定 | 本人 |

#### 家庭群組 API

| Method | Path | 說明 | 權限 |
|--------|------|------|------|
| `POST` | `/api/family` | 建立新家庭群組，回傳同步碼 | 任何使用者 |
| `POST` | `/api/family/:id/join` | 以同步碼加入家庭 | 任何使用者 |
| `DELETE` | `/api/family/:id/member/:uid` | 移除成員或離開家庭 | Owner（移除他人）或本人（離開） |
| `PUT` | `/api/family/:id/transfer` | 轉移 Owner 管理權 | Owner |
| `GET` | `/api/family/:id/members` | 取得家庭成員列表 | 家庭成員 |

#### 家庭書櫃聚合 API

| Method | Path | 說明 | 權限 |
|--------|------|------|------|
| `GET` | `/api/family/:id/bookshelf` | 取得家庭所有成員的開放書籍 | 家庭成員 |

### 2.5 Cloudflare KV Store

- **職責**：儲存加密後的資料
- **Key 設計**：

| Key Pattern | Value | 說明 |
|-------------|-------|------|
| `user:{user_id}` | 加密的個人書單 + 開放設定 | 歸屬個人，不隨家庭變動 |
| `family:{family_id}` | `{ owner_id, members[], max_members, created_at }` | 記錄家庭組成 + 管理者 |
| `member:{user_id}` | 所屬 family_id | 反向查詢用 |

- **TTL**：個人開放設定不設過期（持久化）；家庭群組可設定過期時間
- **家庭人數上限**：`max_members` 預設為 2（配合讀墨官方限制）
- **管理者**：`owner_id` 記錄家庭建立者，擁有移除成員與轉移管理權的權限

---

## 三、資料流程

### Dialog 開啟流程（每次開啟的入口邏輯）

```
1. 使用者點擊「家庭書櫃」按鈕
2. 依序檢查 chrome.storage.sync → chrome.storage.local 是否有 family_id
3a. 無 family_id → 顯示「開始使用」引導畫面
3b. 有 family_id → 驗證家庭是否仍有效（GET /api/family/:id/members）
    → 有效：進入主畫面（預設顯示家庭開放書櫃）
    → 無效（已被移除/家庭已解散）：清除本地 family_id，回到引導畫面
```

### 初次使用流程（一鍵設定）

```
1. 使用者按下「開始使用」
2. 顯示 Loading 遮罩（半透明背景 + 進度提示）
3. 自動導航到 #/me
4. 抓取使用者名稱（.me-nickname）+ email
5. 用 SHA-256(email) 產生 userId
6. 查詢 API（GET /api/member/:userId）是否已有家庭資料
   → 有：從 chrome.storage.sync 恢復 familyId + encryptionKey
   → 無：移除遮罩，顯示「建立新家庭」/「加入家庭」選擇
7. 建立或加入家庭完成後
8. 自動導航到 #/library，爬取個人書單並同步
9. 自動導航回原始頁面
10. 移除遮罩，進入主畫面
```

### 建立家庭流程

```
1. 使用者選擇「建立新家庭」
2. 系統生成 family_id + 加密金鑰
3. POST /api/family → 建立家庭群組（owner_id = 當前使用者，max_members = 2）
4. 組合同步碼（family_id + 金鑰）
5. 儲存 family_id + encryptionKey 至 chrome.storage.sync + local
6. 顯示同步碼供複製分享
7. 進入書單同步流程
```

### 加入家庭流程

```
1. 使用者貼上同步碼
2. 解析同步碼 → family_id + 金鑰
3. POST /api/family/:id/join → 加入家庭
   → 若成員已滿（>= max_members）：回傳 403，提示家庭已滿
4. 儲存 family_id + encryptionKey 至 chrome.storage.sync + local
5. 進入書單同步流程
```

### 管理權轉移流程

```
1. Owner 在設定頁面選擇要轉移的目標成員
2. PUT /api/family/:id/transfer → body: { new_owner_id }
3. 伺服器更新 family.owner_id
4. UI 更新成員列表中的 Owner 標示
```

### 個人開放設定更新流程

```
（前提：已加入家庭，在主畫面中操作）
1. 使用者切換到「個人書櫃管理」分頁
2. Content Script 爬取讀墨書單 → 書單 JSON
3. 從 KV 載入現有的開放設定（若有）
4. 合併：新書預設不開放，已有設定保留
5. 使用者切換各書的開放/關閉
6. 點擊「儲存變更」
7. Crypto Module 加密更新後的設定
8. PUT /api/user/:id/books → 儲存至 KV
```

### 家庭書櫃瀏覽流程

```
（前提：已加入家庭，在主畫面中操作）
1. 使用者在「家庭開放書櫃」分頁（預設）
2. GET /api/family/:id/bookshelf
3. Worker 查詢家庭成員列表
4. Worker 聚合各成員 is_shared=true 的書籍
5. 回傳加密的聚合結果
6. Crypto Module 解密 → 顯示家庭書櫃
```

### 家庭解綁流程

```
1. 使用者在 Dialog「家庭設定」中點擊「離開家庭」
2. DELETE /api/family/:id/member/:uid → 從家庭成員列表移除
3. 清除 chrome.storage.local 中的 family_id
4. 個人開放設定（user:{user_id}）不受影響，仍保留在伺服器
5. 其他家庭成員的聚合查詢不再包含此使用者的書籍
6. Dialog 回到引導畫面（因無 family_id）
7. 使用者可建立或加入新家庭
8. 之前設定的開放書籍自動出現在新家庭書櫃中
```

---

## 四、同步碼設計

### 格式

使用預設 API 端點時：

```
moo-{family_id_short}-{encryption_key_encoded}
```

使用自訂 API 端點時，額外編碼端點資訊：

```
moo-{family_id_short}-{encryption_key_encoded}@{api_host_encoded}
```

- `family_id_short`：家庭群組 ID 短碼
- `encryption_key_encoded`：Base62 編碼的加密金鑰
- `api_host_encoded`（可選）：自訂 API 端點的 host，無此段則使用預設端點

受邀者貼上含 `@` 的同步碼時，Extension / PWA 自動切換至對應的 API 端點，無需手動設定。

### 安全性

- 高熵隨機字串，防止暴力猜測
- 同步碼 = 家庭識別 + 解密金鑰 +（可選）API 端點
- 不持有同步碼就無法加入家庭亦無法解密資料

---

## 五、安全機制

| 層面 | 措施 |
|------|------|
| **傳輸安全** | HTTPS 強制加密 |
| **儲存安全** | E2EE，伺服器儲存密文 |
| **存取控制** | 高熵同步碼作為家庭存取憑證 |
| **隱私預設** | 所有書籍預設不開放，使用者主動選擇 |
| **防濫用** | Rate Limiting（Cloudflare 內建） |
| **資料獨立** | 個人設定不隨家庭解綁而消失 |
| **權限分離** | 家庭成員僅可瀏覽他人已開放書籍，無法修改 |
| **解綁隔離** | 離開家庭後，其他成員立即無法存取該使用者的書籍 |

---

## 六、可設定 API 端點（BYO Backend）

### 架構

```
┌─────────────────────────┐
│  Extension / PWA         │
│                         │
│  API Endpoint 設定：     │
│  ┌─────────────────┐    │
│  │ 預設：官方 Worker │◀── 一般使用者
│  │ 自訂：自建 Worker │◀── 進階使用者
│  └────────┬────────┘    │
└───────────┼─────────────┘
            │ HTTPS
            ▼
┌─────────────────────────────┐
│  Cloudflare Worker          │
│  （官方或自建，API 完全相同） │
│  + KV Store                 │
└─────────────────────────────┘
```

### 設定方式

| 入口 | 說明 |
|------|------|
| Extension 設定頁 | 手動填入自訂 Worker URL |
| PWA 設定頁 | 手動填入自訂 Worker URL |
| 同步碼自動帶入 | 貼上含 `@host` 的同步碼時自動切換 |

### 限制

- 同一家庭的所有成員必須使用相同的 API 端點
- 同步碼中的 `@host` 段可解決此問題：發起者設定一次，受邀者自動跟隨

---

## 七、PWA 行動端架構

### 與 Extension 的關係

```
┌────────────────────┐    ┌────────────────────┐
│  Chrome Extension   │    │  PWA 行動網頁       │
│                    │    │                    │
│  ✅ 爬取讀墨書單    │    │  ❌ 無法爬取書單    │
│  ✅ 注入 Dialog     │    │  ✅ 獨立網頁介面    │
│  ✅ 個人書櫃管理    │    │  ✅ 瀏覽家庭書櫃    │
│  ✅ 家庭書櫃瀏覽    │    │  ✅ 加入/建立家庭   │
│  ✅ 自訂 API 端點   │    │  ✅ 自訂 API 端點   │
└────────┬───────────┘    └────────┬───────────┘
         │                         │
         └────────┬────────────────┘
                  ▼
        同一組 Cloudflare Workers API
```

### PWA 特有限制

- 無法直接爬取讀墨網頁書單（沒有 Content Script 權限）
- 個人書櫃管理依賴 Extension 端先同步書單至伺服器
- PWA 可修改已同步書籍的開放/關閉狀態，但無法新增伺服器上沒有的書

### PWA 部署

- 部署於 Cloudflare Pages（與 Worker 同帳號，零額外成本）
- 或任何靜態網站託管服務（Vercel、Netlify 等）

---

## 八、搜尋與篩選架構

### 設計原則

所有搜尋與篩選功能均在**前端完成**，不額外呼叫 API。原因：
- 書籍資料已全部載入前端（家庭書櫃從 API 一次拉回、個人書櫃從頁面 scrape）
- 資料量有限（單一家庭數百到數千本書），前端完全能處理
- 減少 Cloudflare Workers API 呼叫，節省免費額度

### 搜尋

- **搜尋欄位**：書名（title）+ 作者（author）
- **比對方式**：大小寫不敏感的子字串比對
- **觸發方式**：即時過濾，keyup debounce 300ms
- **UI**：Search input 置於書櫃上方

### 篩選

| 頁面 | 篩選方式 | 選項 | 預設 |
|------|---------|------|------|
| 家庭書櫃 | Dropdown（單選） | 全部（不含自己）/ 全部 / 各成員名稱 | 全部（不含自己） |
| 個人書櫃 | Filter buttons | 全部 / 開放 / 不開放 | 全部 |

---

## 九、版本管理

### 版本格式

Semantic Versioning：`MAJOR.MINOR.PATCH`

| 類型 | 說明 | 範例 |
|------|------|------|
| PATCH | Bug fix | 0.1.1 |
| MINOR | 新功能 | 0.2.0（搜尋功能）、0.3.0（借閱功能） |
| MAJOR | Breaking change（API 不相容、資料格式變更） | 1.0.0（首次公開版） |

### Single Source of Truth

`extension/package.json` 的 `version` 欄位。

### 版本同步機制

```
extension/package.json (version: "0.2.0")
    │
    ├──▶ Vite build: define __APP_VERSION__ 環境變數
    │    → Dialog footer 顯示版本號
    │
    └──▶ Build script: 同步到 manifest.json version 欄位
         → Chrome Web Store 版本號
```

### 版本策略

| 階段 | 版本範圍 | 說明 |
|------|---------|------|
| Pre-release | v0.x.x | 目前階段，功能開發中 |
| 首次公開版 | v1.0.0 | Chrome Web Store 上架 |
| 借閱功能 | v1.1.0+ | v1.0 之後的新功能 |

---

## 十、問題回報連結配置

問題回報連結以 JSON 配置檔管理，方便後續增減：

```typescript
// extension/src/config/links.ts
export const reportLinks = [
  { name: 'GitHub', icon: 'github', url: 'https://github.com/<owner>/moo-family-bookshelf' },
  { name: 'Plurk',  icon: 'plurk',  url: 'https://www.plurk.com' },
  { name: 'Discord', icon: 'discord', url: 'https://discord.gg/placeholder' },
] as const;
```

顯示位置：Settings 頁面底部，以 icon 排列。

---

*最後更新：2026-03-27*
