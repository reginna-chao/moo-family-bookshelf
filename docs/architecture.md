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
│                          │  │  (SHA-256 雜湊工具)      │  │  │
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

### 2.3 Crypto Module（雜湊工具）

- **職責**：使用者識別碼雜湊（deriveUserId）
- **技術**：Web Crypto API（SHA-256）
- **流程**：
  ```
  使用者 Email → 加鹽 SHA-256 雜湊 → userId → 用於 API 識別
  ```

### 2.4 Cloudflare Workers (API)

- **職責**：提供 RESTful API 進行資料的存取與管理
- **端點**：

#### 個人公開書櫃 API（v1.2.0）

| Method | Path | 說明 | 權限 |
|--------|------|------|------|
| `POST` | `/api/user/:id/public-shelf` | 建立或更新公開書櫃設定 | 本人 |
| `DELETE` | `/api/user/:id/public-shelf` | 關閉公開分享 | 本人 |
| `GET` | `/api/public/:token` | 查詢公開書櫃（明文） | 無（公開） |

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

- **職責**：儲存資料（明文 JSON）
- **Key 設計**：

| Key Pattern | Value | 說明 |
|-------------|-------|------|
| `user:{user_id}` | 個人書單 + 開放設定（JSON） | 歸屬個人，不隨家庭變動 |
| `family:{family_id}` | `{ owner_id, members[], max_members, created_at }` | 記錄家庭組成 + 管理者 |
| `member:{user_id}` | 所屬 family_id | 反向查詢用 |
| `public:{share_token}` | `{ user_id, title, books[], created_at, expires_at }` | 公開書櫃明文書單（v1.2.0） |
| `verify:{user_id}` | `{ method, hash, salt, prompted, failCount, lockedUntil }` | PWA 登入驗證設定 |
| `otp:{user_id}` | `{ code, createdAt }` | 一次性驗證碼（TTL 5 分鐘） |

- **TTL**：個人開放設定不設過期（持久化）；家庭群組可設定過期時間；公開書櫃依使用者設定（7/30/60/90 天或永久）
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
5. 用 deriveUserId（加鹽 SHA-256, `moo:` prefix）產生 userId
6. 查詢 API（GET /api/member/:userId）是否已有家庭資料
   → 有：從 chrome.storage.sync 恢復 familyId
   → 無：移除遮罩，顯示「建立新家庭」/「加入家庭」選擇
7. 建立或加入家庭完成後
8. 自動導航到 #/library，爬取個人書單並同步
9. 自動導航回原始頁面
10. 移除遮罩，進入主畫面
```

### 建立家庭流程

```
1. 使用者選擇「建立新家庭」
2. 系統生成 family_id
3. POST /api/family → 建立家庭群組（owner_id = 當前使用者，max_members = 2）
4. 組合同步碼（family_id）
5. 儲存 family_id 至 chrome.storage.sync + local
6. 顯示同步碼供複製分享
7. 進入書單同步流程
```

### 加入家庭流程

```
1. 使用者貼上同步碼
2. 解析同步碼 → family_id（+可選 API 端點）
3. POST /api/family/:id/join → 加入家庭
   → 若成員已滿（>= max_members）：回傳 403，提示家庭已滿
4. 儲存 family_id 至 chrome.storage.sync + local
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
7. PUT /api/user/:id/books → 儲存至 KV
```

### 家庭書櫃瀏覽流程

```
（前提：已加入家庭，在主畫面中操作）
1. 使用者在「家庭開放書櫃」分頁（預設）
2. GET /api/family/:id/bookshelf
3. Worker 查詢家庭成員列表
4. Worker 聚合各成員 is_shared=true 的書籍
5. 回傳聚合結果 → 顯示家庭書櫃
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
moo-{family_id_short}
```

使用自訂 API 端點時，額外編碼端點資訊：

```
moo-{family_id_short}@{api_host_encoded}
```

- `family_id_short`：家庭群組 ID 短碼
- `api_host_encoded`（可選）：自訂 API 端點的 host，無此段則使用預設端點

受邀者貼上含 `@` 的同步碼時，Extension / PWA 自動切換至對應的 API 端點，無需手動設定。

### 安全性

- 高熵隨機字串，防止暴力猜測
- 同步碼 = 家庭識別 +（可選）API 端點
- 不持有同步碼就無法加入家庭

---

## 五、安全機制

| 層面 | 措施 |
|------|------|
| **傳輸安全** | HTTPS 強制加密 |
| **儲存安全** | 明文 JSON 儲存於 KV，以 auth token 控管存取 |
| **存取控制** | 高熵同步碼作為家庭存取憑證 + auth token 驗證每次請求 |
| **隱私預設** | 所有書籍預設不開放，使用者主動選擇 |
| **防濫用** | Rate Limiting（Cloudflare 內建） |
| **資料獨立** | 個人設定不隨家庭解綁而消失 |
| **權限分離** | 家庭成員僅可瀏覽他人已開放書籍，無法修改 |
| **解綁隔離** | 離開家庭後，其他成員立即無法存取該使用者的書籍 |
| **PWA 登入驗證** | 可選式驗證機制（PIN / 圖形 / 隨機碼），防止家庭成員冒用身份 |

### PWA 登入驗證機制

#### 問題
同步碼為家庭共享秘密，家人間通常知道彼此的 Email。若不設驗證，家庭成員可用「共享同步碼 + 對方 Email」在 PWA 冒充他人登入。

#### 解決方案
使用者可選擇設定 PWA 登入驗證方式：

| 方式 | 說明 | 安全性 |
|------|------|--------|
| PIN 碼 | 4-6 位數字 | 中（需搭配暴力破解鎖定） |
| 圖形驗證 | 九宮格至少連 4 點 | 中（同上） |
| 隨機驗證碼 | Extension 產生 6 位數，有效期 5 分鐘 | 高（需要電腦在旁） |
| 不設定驗證 | 現有行為，接受風險 | 低 |

#### 安全措施
- PIN/Pattern hash 以 SHA-256(salt + secret) 儲存於 `verify:{userId}`（server 端驗證）
- 連續 5 次驗證失敗 → 鎖定 15 分鐘
- OTP 使用後立即刪除（一次性）
- Token refresh 改為 protected route（需有效 Bearer token），防止 userId + familyId 直接取得新 token
- 預設不設定；首次 PWA 登入後提醒一次，之後不再提醒

#### KV Key 設計

| Key Pattern | Value | TTL |
|-------------|-------|-----|
| `verify:{userId}` | `{ method, hash, salt, prompted, failCount, lockedUntil }` | None |
| `otp:{userId}` | `{ code, createdAt }` | 300 秒 |

#### API 端點

| Method | Path | 說明 | 權限 |
|--------|------|------|------|
| `GET` | `/api/user/:id/verify` | 查詢驗證方式（不回傳 hash） | 公開 |
| `PUT` | `/api/user/:id/verify` | 設定/變更驗證方式 | 本人 |
| `POST` | `/api/user/:id/verify/otp` | 產生一次性驗證碼 | 本人 |
| `POST` | `/api/user/:id/verify/prompted` | 標記已提醒 | 公開 |

### chrome.storage.sync 多裝置同步

**儲存於 `chrome.storage.sync` 的資料**：`familyId`（其他非敏感偏好如 `displayName` 亦同步）。

**目的**：同一 Chrome 個人檔案（profile）下的多台裝置或重新安裝後，Extension 可從 `chrome.storage.sync` 取得 familyId，執行靜默自動恢復（`tryAutoRecovery`），無需手動輸入同步碼。

**限制**：若使用者在不同 Google 帳號或不同 Chrome profile 間操作，`chrome.storage.sync` **不會跨帳號共享**；此時必須透過同步碼（手動貼上）完成還原。

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

### PWA 認證方式

PWA 無法爬取讀墨頁面，因此無法自動取得 email。提供兩種認證入口：

#### 主要入口：QR Code（推薦）

```
Extension 設定頁 → 「連結手機」按鈕
       ↓
  產生 QR Code，內容為 PWA URL + query params：
  https://pwa.example.com/?code=moo-{familyId}&uid={userId}[@host]
       ↓
  手機掃碼 → PWA 自動解析 → 儲存至 localStorage → 完成
```

- 零手動輸入，UX 最佳
- QR Code 包含 userId，不需額外步驟

#### 備用入口：手動輸入

```
PWA 首頁 → 輸入同步碼 + 輸入讀墨 Email
       ↓
  同步碼 → familyId（+ 可選 API 端點）
  Email → 前端 deriveUserId（加鹽 SHA-256）→ userId（不上傳伺服器）
       ↓
  儲存至 localStorage → 完成
```

- 適用於只有手機、無法掃碼的情境

### PWA 功能範圍

| 功能 | PWA 支援 | 備註 |
|------|---------|------|
| 瀏覽家庭書櫃 | ✅ | 核心功能 |
| 個人書櫃開關 | ✅ | 書籍須先由 Extension 同步過一次 |
| 加入/建立家庭 | ✅ | |
| 新增書籍 | ❌ | 無法爬取讀墨頁面 |
| 借閱功能（未來）| ✅ | 發送/接收借閱請求 |

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
| MINOR | 新功能 | 0.2.0（搜尋功能）、1.1.0（借閱功能）、1.2.0（公開書櫃） |
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
| 借閱功能 | v1.1.0 | v1.0 之後的新功能 |
| 個人公開書櫃分享 | v1.2.0 | 獨立網址對外分享個人開放書單 |

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

## 十一、個人公開書櫃分享（v1.2.0）

> 使用者可產生獨立網址，將個人已開放的書籍對外公開分享，訪客無須登入即可瀏覽。

### 與現有架構的關係

```
┌─────────────────────────────┐
│  Extension / PWA             │
│                             │
│  個人書櫃頁 → 分享 icon      │
│       ↓                     │
│  公開書櫃設定 Dialog          │
│  (開關/標題/過期/重設/複製)   │
│       ↓                     │
│  POST /api/user/:id/        │
│       public-shelf          │
└──────────┬──────────────────┘
           │ 儲存明文書單
           ▼
┌─────────────────────────────┐
│  Cloudflare Workers          │
│                             │
│  public:{token} → 明文書單   │
│  (KV TTL 管理過期)           │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  PWA /public/{token}         │
│                             │
│  公開頁面（不需登入）         │
│  - 自訂標題                  │
│  - 搜尋功能                  │
│  - 書籍 → 讀墨購買頁         │
│  - 說明文字：公開無須登入     │
└─────────────────────────────┘
```

### 設計重點

- **書單來源**：與家庭分享相同（`is_shared: true` 的書），不另外標記
- **明文儲存**：公開書櫃為使用者主動公開，伺服器以明文儲存
- **不依賴家庭**：不需加入家庭也能使用此功能
- **預設關閉**：公開分享預設不啟用，使用者需手動開啟
- **過期管理**：7 / 30 / 60 / 90 天 / 永久（預設 30 天），透過 KV TTL 自動清理
- **重設網址**：產生新 UUID token，舊 token 立即失效
- **購買連結**：書籍連結至 `https://readmoo.com/book/{bookId}`（另開分頁），不提供借閱
- **share_token**：UUID 32 碼（無連字號），高熵防猜測

---

## API 版本相容性策略

### 策略選擇：漸進式相容（Progressive Compatibility）

本專案不採用 URL path versioning（`/v1/`, `/v2/`）或 header versioning（`Accept: application/vnd.api+v2`），
而是採用**漸進式相容策略**，原因如下：

1. **所有客戶端皆為自控**：Extension、PWA 由同一團隊維護，可協調升級節奏
2. **自架部署考量**：self-hoster 可能延遲更新 Worker，URL path versioning 會迫使伺服器端同時維護多版路由
3. **簡單即正確**：對小型專案而言，多版本路由的維護成本遠高於漸進式遷移

### 運作機制

```
Client                          Worker
  │                               │
  ├── GET /api/version ──────────►│
  │◄──── { apiVersion: 1 } ──────│
  │                               │
  │  比對 CLIENT_MIN_API_VERSION  │
  │  apiVersion >= min? ──► 正常運作
  │  apiVersion <  min? ──► 顯示升級提示（非阻斷式黃色警告）
```

**伺服器端**：
- `API_VERSION`（整數）定義於 `worker/src/index.ts`，僅在**破壞性變更**時遞增
- `SERVER_VERSION`（語意版本）用於追蹤部署版本
- `/api/version` 端點回傳兩者，供客戶端查詢

**客戶端**：
- `MIN_API_VERSION` 定義客戶端所需的最低 API 版本（Extension: `VersionWarning.tsx`，PWA: `VersionWarning.tsx`）
- 啟動時呼叫 `/api/version`，若 `apiVersion < MIN_API_VERSION` 則顯示非阻斷式警告
- 警告僅針對自架伺服器（官方 Worker 永遠是最新版）

### 何時遞增 API_VERSION

| 變更類型 | 是否遞增 | 範例 |
|---------|---------|------|
| 新增端點 | 否 | 新增 `GET /api/user/:id/stats` |
| 新增可選欄位 | 否 | Response 多回傳 `createdAt` |
| 移除或重新命名端點 | **是** | `GET /api/books` → `GET /api/bookshelf` |
| 變更必要欄位格式 | **是** | `is_shared: boolean` → `is_shared: BoolFlag` |
| 變更認證機制 | **是** | Token 格式變更 |

### 遷移 SOP

1. 新版 Worker 同時支援新舊格式（過渡期）
2. 發布客戶端更新，使用新格式
3. 確認所有客戶端已更新後，下一版移除舊格式並遞增 `API_VERSION`

*最後更新：2026-04-08*
