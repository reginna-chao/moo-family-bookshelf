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
  - 問題回報連結（GitHub / Plurk）
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

採「可定址」設計，從 day-1 即以 `:shelfId` 路由，未來擴充至多組無需更動 API 形狀。

| Method   | Path                                              | 說明                                 | 權限       |
| -------- | ------------------------------------------------- | ------------------------------------ | ---------- |
| `GET`    | `/api/user/:id/public-shelf`                      | 列出所有公開書櫃（v1.2.0 最多 1 組） | 本人       |
| `POST`   | `/api/user/:id/public-shelf`                      | 建立新公開書櫃（達上限回 409）       | 本人       |
| `PUT`    | `/api/user/:id/public-shelf/:shelfId`             | 更新公開書櫃設定（標題、過期）       | 本人       |
| `POST`   | `/api/user/:id/public-shelf/:shelfId/reset-token` | 重設 shareToken（shelfId 不變）      | 本人       |
| `DELETE` | `/api/user/:id/public-shelf/:shelfId`             | 關閉指定公開書櫃                     | 本人       |
| `GET`    | `/api/public/:shareToken`                         | 查詢公開書櫃（明文）                 | 無（公開） |

#### 個人開放設定 API

| Method | Path                  | 說明                   | 權限 |
| ------ | --------------------- | ---------------------- | ---- |
| `GET`  | `/api/user/:id/books` | 取得個人書單及開放設定 | 本人 |
| `PUT`  | `/api/user/:id/books` | 更新個人開放設定       | 本人 |

#### 認證 API

| Method | Path                | 說明                                     | 權限                        |
| ------ | ------------------- | ---------------------------------------- | --------------------------- |
| `POST` | `/api/auth/lookup`  | 以 userId 查詢所屬家庭（見下方驗證閘門） | 公開（設有驗證者需通過）    |
| `POST` | `/api/auth/refresh` | 換發 auth token                          | 本人（需有效 Bearer token） |

`/api/auth/lookup` 的請求為 `{ userId, verifySecret? }`，回應 `data` 為 `{ existingFamilyId, memberCount, requiresVerification }`（`requiresVerification` 為 `BoolFlag`，0/1）。帳號設有 PWA 登入驗證但未附 `verifySecret` 時，回傳 **200** 且 `requiresVerification: 1`、不揭露任何家庭資訊（此為告知用途，非錯誤），用戶端據此提示輸入驗證後重送。

#### 家庭群組 API

| Method   | Path                          | 說明                       | 權限                            |
| -------- | ----------------------------- | -------------------------- | ------------------------------- |
| `POST`   | `/api/family`                 | 建立新家庭群組，回傳同步碼 | 任何使用者（設有驗證者需通過）  |
| `POST`   | `/api/family/:id/join`        | 以同步碼加入家庭           | 任何使用者（設有驗證者需通過）  |
| `DELETE` | `/api/family/:id/member/:uid` | 移除成員或離開家庭         | Owner（移除他人）或本人（離開） |
| `PUT`    | `/api/family/:id/transfer`    | 轉移 Owner 管理權          | Owner                           |
| `GET`    | `/api/family/:id/members`     | 取得家庭成員列表           | 家庭成員                        |

#### 家庭書櫃聚合 API

| Method | Path                        | 說明                       | 權限     |
| ------ | --------------------------- | -------------------------- | -------- |
| `GET`  | `/api/family/:id/bookshelf` | 取得家庭所有成員的開放書籍 | 家庭成員 |

### 2.5 Cloudflare KV Store

- **職責**：儲存資料（明文 JSON）
- **Key 設計**：

| Key Pattern                     | Value                                                       | 說明                                                                                                          |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `user:{user_id}`                | 個人書單 + 開放設定（JSON）                                 | 歸屬個人，不隨家庭變動                                                                                        |
| `family:{family_id}`            | `{ owner_id, members[], max_members, created_at }`          | 記錄家庭組成 + 管理者                                                                                         |
| `member:{user_id}`              | 所屬 family_id                                              | 反向查詢用                                                                                                    |
| `public:{share_token}`          | `{ userId, shelfId, title, books[], createdAt, expiresAt }` | 公開書櫃明文快照（v1.2.0）                                                                                    |
| `verify:{user_id}`              | `{ method, hash, salt, prompted, secretUpdatedAt? }`        | PWA 登入驗證設定（`secretUpdatedAt` 為驗證方式／密鑰最後變更時間，epoch 毫秒）                                |
| `verifyfail:{user_id}:{caller}` | `{ failCount, lockedUntil, startedAt? }`                    | 依「來源 + 目標帳號」計算的驗證失敗次數（TTL 900 秒）；`startedAt` 為該次失敗連續累計的起始時間（epoch 毫秒） |
| `otp:{user_id}`                 | `{ code, createdAt }`                                       | 一次性驗證碼（TTL 5 分鐘）                                                                                    |

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

| 層面             | 措施                                                        |
| ---------------- | ----------------------------------------------------------- |
| **傳輸安全**     | HTTPS 強制加密                                              |
| **儲存安全**     | 明文 JSON 儲存於 KV，以 auth token 控管存取                 |
| **存取控制**     | 高熵同步碼作為家庭存取憑證 + auth token 驗證每次請求        |
| **隱私預設**     | 所有書籍預設不開放，使用者主動選擇                          |
| **防濫用**       | Rate Limiting（Cloudflare 內建）                            |
| **資料獨立**     | 個人設定不隨家庭解綁而消失                                  |
| **權限分離**     | 家庭成員僅可瀏覽他人已開放書籍，無法修改                    |
| **解綁隔離**     | 離開家庭後，其他成員立即無法存取該使用者的書籍              |
| **PWA 登入驗證** | 可選式驗證機制（PIN / 圖形 / 隨機碼），防止家庭成員冒用身份 |

### 威脅模型與已接受的風險姿態

本節說明本專案的安全設計為何停在目前的位置。**通用安全稽核清單不會知道這些前提**，因此每次掃描都可能重新提出「應導入更強的身分驗證或原子化計數器」之類的建議。在下列前提改變之前，那些建議屬於過度工程，請以本節為討論基準，不要逐次重新推導。

#### 前提一：帳號系統不屬於本專案

使用者的帳號歸屬於讀墨（Readmoo），本專案沒有任何可掛勾的身分驗證機制——無法寄送驗證信、無法做密碼重設、無法查詢讀墨的登入狀態。這是 `userId` 必須由 email 推導（`sha256("moo:" + email)`）的根本原因，也決定了 Worker 端能用來認人的東西**只有兩種可能**：

1. 使用者在本服務自行設定的密鑰（PIN / 圖形 / 一次性驗證碼）；
2. 「持有讀墨登入狀態」——Extension 確實握有，但**無法向 Worker 證明**（讀墨未提供可供驗證的 API）。

因此 PWA 登入驗證閘門是這個架構下的**天花板，而不是中途站**。任何試圖再往上加強的機制，都只是把一個已經是天花板的東西從「大致準確」推向「完全準確」，天花板本身的高度不會改變。

#### 前提二：資產價值

本服務儲存的是「購買了哪些書」與「選擇分享哪些書」，不涉及金流、憑證、通訊內容或身分證明。

較精確的說法不是「沒有機密資訊」，而是**機密程度低，且高敏感的部分已由 opt-in 機制隔離**：書籍購買紀錄在特定情境下確實會透露訊息（宗教、政治傾向、疾病、性向相關的閱讀），而「全部預設不分享、逐本主動開放」的設計正是為此而存在——**未分享的書，恰恰是使用者主動選擇要藏起來的那些**。

這個區別有實務意義：它既支持「不需要為此導入重量級基礎設施」的結論，也說明為何繞過 opt-in 這道防線的漏洞（例如未經驗證即可取得他人 authToken）**必須**修補。

#### 已接受的殘餘風險

| 風險                                | 現況                                                                                                    | 為何接受                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未設定驗證的帳號可被 email 單獨接管 | 驗證為選用功能，`method: "none"` 直接通過閘門                                                           | 前提一使然：沒有第二因素可強制。強制設定會把「忘記 PIN 即永久失去資料」的風險轉嫁給使用者，而帳號無法透過任何管道救回                                                                                                                          |
| KV 計數器在並發下失準               | 三道煞車（per-IP、呼叫端鎖定、每帳號上限）皆為 get-then-put，無序列化；並發放大倍數取決於攻擊者的併發度 | 硬上限需 Durable Objects（Cloudflare 原生 rate-limiting binding 官方明示為 eventually consistent、且限制僅在單一節點內生效，無法用於此目的）。DO 會讓每個自建者的 `wrangler.toml` 與升級流程永久多一層 migration，而自建能力是本專案的明確賣點 |
| 最短 4 節點圖形僅 3,024 種組合      | `isValidPattern` 允許 4-9 節點                                                                          | 提高下限會影響既有使用者的既有習慣。此為所有數字中最刺眼的一項，若日後重新評估風險，**這是成本最低、效益最高的槓桿**，應優先於原子化計數器                                                                                                     |

#### 運維層的補強（不需程式碼變更）

正式部署可在 Cloudflare Dashboard 對三個閘門端點（`POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/lookup`）設定 WAF Rate Limiting 規則。該層在邊緣強制執行、不受 KV 一致性影響，且零程式碼、不增加自建者負擔。自建者可自行決定是否比照辦理。

#### 何時應重新檢視本節

- PWA 登入驗證的實際採用率顯著提高（代表它成為多數使用者的主要防線，而非少數人的加強選項）；
- 本服務開始儲存書單與分享偏好以外的資料；
- 觀察到實際的密鑰猜測流量。

### PWA 登入驗證機制

#### 問題

同步碼為家庭共享秘密，家人間通常知道彼此的 Email。若不設驗證，家庭成員可用「共享同步碼 + 對方 Email」在 PWA 冒充他人登入。

#### 解決方案

使用者可選擇設定 PWA 登入驗證方式：

| 方式       | 說明                                 | 安全性                   |
| ---------- | ------------------------------------ | ------------------------ |
| PIN 碼     | 6-12 位數字                          | 中（需搭配暴力破解鎖定） |
| 圖形驗證   | 九宮格至少連 4 點                    | 中（同上）               |
| 隨機驗證碼 | Extension 產生 6 位數，有效期 5 分鐘 | 高（需要電腦在旁）       |
| 不設定驗證 | 現有行為，接受風險                   | 低                       |

#### 安全措施

- PIN/Pattern hash 以 SHA-256(salt + secret) 儲存於 `verify:{userId}`（server 端驗證）
- **驗證閘門涵蓋三個公開端點**：`POST /api/family`（建立家庭）、`POST /api/family/:id/join`（加入家庭）、`POST /api/auth/lookup`（查詢所屬家庭）。三者共用同一個 `validateVerification`，錯誤碼與鎖定行為完全一致（`400 INVALID_VERIFY_SECRET` / `403 VERIFICATION_REQUIRED` / `403 VERIFICATION_FAILED` / `429 VERIFICATION_LOCKED` / `429 RATE_LIMITED`，兩種 429 皆附 `retryAfter`）。原因是 userId 由 email 加固定鹽推導而來、屬公開可猜的識別碼，而個人設定 `user:{userId}` 在離開家庭後仍會保留（設計如此）：
  - **建立家庭**若不設閘門，任何知道受害者 Email 的人都能為受害者的 userId 建立家庭並取得有效 auth token，進而讀取其完整書單（含未開放書籍）與修改開放設定，等同帳號接管
  - **查詢所屬家庭**若不設閘門，familyId（即同步碼本體）會直接外洩，陌生人可用自己的 userId 加入尚未額滿（上限 2 人）的家庭並瀏覽共享書櫃
  - 閘門位置：建立家庭時排在 `ALREADY_IN_FAMILY` 衝突檢查之後、**任何 KV 寫入與發放 token 之前**（含孤兒 `member:` key 清理），驗證失敗不會留下任何副作用；查詢所屬家庭時則排在讀取家庭歸屬之前，未通過者不會觸發任何家庭查詢
  - **`ALREADY_IN_FAMILY`（409）排在閘門之前，是刻意保留的極小揭露**：它等於告訴未通過驗證的呼叫方一件布林事實——「這個 Email 對應的帳號目前屬於某個家庭」（不含是哪一個）。之所以不把閘門提前：這個衝突是「便宜且終局」的，任何密鑰都無法讓該請求成功，先驗證只會白白要求使用者輸入 PIN、消耗該帳號的驗證嘗試額度，最後仍然拒絕。建立家庭與加入家庭採同一順序，行為一致。真正有價值的資訊（familyId／同步碼、auth token、成員資料）與所有寫入都仍在閘門之後
- **`verifySecret` 在 handler 邊界就統一把關**：三個入口都先用 `sanitizeVerifySecret()`（`worker/src/utils/validation.ts`）分類，再交給閘門——「未提供」（欄位缺少、`null`、空字串）走各端點原本的無密鑰行為（lookup 回 `requiresVerification: 1`，create／join 回 `403 VERIFICATION_REQUIRED`）；「有給但格式不對」（非字串，或長度超過 `VERIFY_SECRET_MAX_LENGTH` = 256）一律回 `400 INVALID_VERIFY_SECRET`。理由有二：其一，格式錯誤是「請求本身不合法」，不是「驗證失敗」，因此不該計入任何失敗額度，也不該讓超長字串走到 hash 計算；其二，同一份錯誤輸入以前在 lookup 會被當成「沒帶密鑰」（200）、在 create／join 卻落入 `403 VERIFICATION_REQUIRED`，三個入口對同一種輸入給出不同狀態碼，現已統一
- **未設定驗證的帳號行為不變（已接受的殘餘風險）**：`verify:{userId}` 不存在或 `method: "none"` 時一律直接放行，上述兩項風險對這些帳號依然成立。本次修正的目標是「有設定驗證的人真的受到保護」，而非強制所有人設定驗證；是否改為強制屬產品決策
- 連續 5 次驗證失敗 → 鎖定 15 分鐘。失敗次數與鎖定狀態是「以來源 + 目標帳號」為單位計算，記錄在獨立且有 TTL（900 秒）的 `verifyfail:{userId}:{caller}`，不會寫入帳號本身的 `verify:{userId}`。因為建立／加入家庭與 `/api/auth/lookup` 都是公開端點、userId 又由 email 推導（可猜），若把失敗次數記在帳號上，任何第三方都能靠亂送錯誤驗證把別人鎖在 PWA 登入之外（DoS）；改為記在來源後，攻擊者只會鎖住自己。註：`/api/auth/lookup` 現已納入驗證閘門，設有驗證的帳號不再從該端點外洩 familyId，但 userId 本身仍可猜，以受害者為 key 的失敗計數依舊是 DoS 槓桿，因此此設計不變
- **每個目標帳號另有「驗證嘗試上限」：每小時 10 次（`ratelimit:user:verify:{userId}:{bucket}`）**。這道限制寫在 `validateVerification` 內部，而非各個 handler，因此建立家庭、加入家庭、查詢所屬家庭三個入口一律受同一道約束，未來新增的呼叫端也不可能漏掉。**只有「猜錯的密鑰」才計數，而且額度是在比對「之後」才查看**：先執行 `matchesSecret` 比對，密鑰正確就直接放行——**即使該帳號的額度已被打滿也一樣，且不計數**；只有比對失敗的那條分支才唯讀查看額度（`peekPerUserRateLimit`）並加一（`chargePerUserRateLimit`）。猜錯時若額度已用盡，回傳 `429 RATE_LIMITED`（附 `retryAfter`，取代原本的 `403 VERIFICATION_FAILED`），且不會再寫入已滿的計數器（被拒絕的嘗試不得延長視窗）。因此沒帶密鑰（`VERIFICATION_REQUIRED`）、格式錯誤（`400`，在 handler 就擋下）、未設定驗證的帳號、以及**帳號本人輸入正確密鑰的成功流程**都不消耗額度；已被鎖定的來源仍在比對之前就被擋下（該鎖定以來源為 key，不是針對受害者的槓桿）。這不會放寬防護：攻擊者送出的每一次猜測依定義都是錯的，每小時 10 次失敗後仍然封鎖後續猜測，暴力破解的上限完全不變
  - **執行順序與代價**（由上而下，先命中者勝）：

    | 情境                 | 結果                      | KV 寫入                    |
    | -------------------- | ------------------------- | -------------------------- |
    | 未設定驗證／記錄毀損 | 通過                      | 無                         |
    | 該來源已鎖定         | 429 VERIFICATION_LOCKED   | 無                         |
    | 未帶密鑰             | 403 VERIFICATION_REQUIRED | 無                         |
    | 密鑰正確             | 通過                      | 刪除該來源失敗紀錄（若有） |
    | 密鑰錯誤，額度尚有   | 403 VERIFICATION_FAILED   | 嘗試計數器 + 失敗紀錄      |
    | 密鑰錯誤，額度已滿   | 429 RATE_LIMITED          | 僅失敗紀錄                 |

  - **為何需要**：鎖定機制以「來源」為 key（見下一點），攻擊者輪替 IPv6 前綴就能規避，等於沒有全域上限。圖形驗證最短只有 4 個節點、9×8×7×6 = 3,024 種組合，約 605 個前綴（單一 /48 配額內即可湊齊）就能試完整個空間
  - **殘餘風險（有界，且不再傷及帳號本人）**：這個計數器仍以**受害者的 userId** 為 key，第三方可以連續送出 10 次錯誤密鑰把它打滿。但打滿之後擋下的只有「針對該帳號的後續**猜測**」——帳號本人帶著正確密鑰仍然照常通過（查詢、建立、加入三個入口皆是），因為正確密鑰根本不會被拿去比對額度。也就是說，這個計數器是對付攻擊者的槓桿，不是能把帳號本人關在門外的槓桿。它與「鎖定必須以來源為 key」的原則不衝突：那條原則規範的是**誰會被鎖住**，而不是禁止存在全域嘗試上限
  - 兩個計數器互相獨立（scope 分別為 `verify` 與 `join`），語意各自清楚；`DEV_MODE=1` 下與其他速率限制一樣停用。注意 `join` 計數器的語意不同：它對**每一次**加入請求計數（`enforcePerUserRateLimit`），因此仍是以受害者為 key、會擋到本人的可用性槓桿
- **變更驗證方式／密鑰會作廢先前的失敗紀錄**：`PUT /api/user/:id/verify` 會在 `verify:{userId}` 寫入 `secretUpdatedAt`（epoch 毫秒）；`verifyfail:{userId}:{caller}` 則記錄該次連續失敗的起始時間 `startedAt`。驗證時若 `startedAt < secretUpdatedAt`，代表這筆失敗紀錄是針對「已經不存在的舊密鑰」累積的，直接視為作廢：不觸發鎖定、失敗次數不再累加。作廢是每次請求即時重算的記憶體判定，未刪除的殘留紀錄本身即失效；實際清除只發生在「驗證成功」時（刪除該來源自己的那把 key，不做 KV list 掃描），輸入錯誤密鑰時則由新的失敗紀錄整筆覆寫，未帶密鑰或鎖定中則完全不寫入。理由是 Cloudflare KV 對同一個 key 每秒僅允許一次寫入，先刪後寫可能讓剛計數的失敗被靜默丟棄，因此每次請求對 `verifyfail:{userId}:{caller}` 至多一次寫入。因此忘記 PIN 而在手機被鎖定的使用者，只要在桌面 Extension 重設 PIN／圖形，就能立即登入，不必等 15 分鐘。兩個欄位任一缺漏（舊資料）時一律**維持鎖定**，缺值永遠不會解鎖。這不會成為 DoS 手段：`secretUpdatedAt` 只能透過 `PUT /api/user/:id/verify` 更新，該端點需要有效 token 且 `callerId === userId`，只有帳號本人能作廢失敗紀錄，而且只能作廢自己帳號上的
- 來源（caller key）取自 Cloudflare 的 `cf-connecting-ip`（邊緣設定、無法偽造）。IPv4 直接使用；IPv6 正規化為 /64 前綴後才當 key，因為家用 IPv6 至少配發一個 /64，且 privacy extensions 可讓用戶端隨意更換介面識別碼——若以完整位址為 key，攻擊者每送一次請求就能換到全新的失敗額度與全新的速率限制桶。兩個例外：IPv4-mapped 位址（`::ffff:a.b.c.d`）會收斂成內嵌的 IPv4，與該 IPv4 共用同一個 key；無法解析的值則加上 `raw:` 前綴自成一個命名空間，確保不會與真正的 /64 桶撞在一起。同一套正規化也套用在 per-IP 速率限制上
- 已接受的殘餘風險（非缺陷，權衡後保留）：
  - **共用對外 IP**：CGNAT、公司／校園 NAT 之後的多個使用者（IPv6 則是同一個 /64 內的裝置）針對「同一個目標帳號」會共用同一份失敗額度，可能被同來源的其他人連帶鎖住 15 分鐘。相對於「任何陌生人都能鎖住任何帳號」，此風險範圍小很多
  - **跨來源暴力破解不再由鎖定機制擋下**：從「單一來源」發動的暴力破解仍受 per-IP 敏感端點限制（每分鐘 3 次）約束——**驗證閘門的三個入口（建立／加入／查詢所屬家庭）現已全部列為敏感端點**（`isSensitivePublicRoute()`），因為查詢所屬家庭同樣讓未驗證的呼叫方可以測試密鑰，而且是三者中最便宜的一條（純讀取、前面沒有 409 終局衝突）。分類只看路徑不看 body：速率限制中介層在解析 body 之前就執行，無從得知這次有沒有帶 `verifySecret`，而攻擊者本來就會每次都帶。**敏感端點使用同一個限額（每分鐘 3 次）但分成兩個獨立計數器**：建立／加入家庭記在 `ratelimit:sens:{ip}:{bucket}`，查詢所屬家庭記在 `ratelimit:sens:lookup:{ip}:{bucket}`。原因是一次正常的登入流程本身就會在同一分鐘內用掉 3 次敏感請求（先 lookup 探詢、再 lookup 帶密鑰、最後 create／join），若共用一個計數器，使用者只要 PIN 打錯一次要重試、或家中第二個人在同一個 NAT／IPv6 /64 之後接著設定，就會立刻收到 60 秒的 429。拆開之後這段流程是 lookup 桶 2 次、create／join 桶 1 次，重試不再互相排擠。分桶只改「記在哪個 key」，限額與嚴格程度完全不變（`rateLimitBucketFor()` 於 `worker/src/middleware/rateLimit.ts`）。攻擊者輪替來源前綴後，則由 per-userId 的驗證嘗試上限（每小時 10 次失敗，涵蓋同樣三個入口）接手擋下。注意這些限制在 `DEV_MODE=1` 的 Worker 上會被停用（見 `worker/DEPLOY.md`），因此 dev worker 不得存放真實資料
  - **最壞情況量化（圖形驗證的最短長度不足）**：以每小時 10 次的上限推算——6 位數 PIN（`^\d{6,12}$`，至少 10^6 種組合）需時以「年」為單位，實務上不可行；但圖形驗證目前允許的最短長度只有 4 個不重複節點，組合數僅 9×8×7×6 = **3,024 種**，全部試完約需 302 小時（約兩週），命中機率達 50% 只需約 151 小時（約 6 天）。這是「最短圖形長度」帶來的已知限制，不是實作缺陷；是否提高最短節點數屬產品決策，本次不更動 `isValidPattern`
  - **per-userId 速率限制以受害者的 userId 為 key**：`join`（每次加入請求都計數）第三方仍可打滿，讓受害者在該小時內收到 `429 RATE_LIMITED`；這是較輕微的可用性影響（不影響帳號狀態、隨時間自動恢復），列為已知限制。`verify` 嘗試上限則**不再是這種槓桿**：它在密鑰比對之後才查看，正確密鑰一律放行，被打滿只會擋住後續的錯誤猜測
  - **合法使用者的額度消耗：零**。一次完整登入流程（先 `/api/auth/lookup` 帶密鑰，再 create／join 帶同一組密鑰）雖然會通過閘門兩次，但兩次都比對成功，因此不消耗任何額度；就算此時該帳號的 `verify` 額度已被攻擊者打滿，本人依然通過。每小時 10 次的額度只會被「猜錯」吃掉
  - **KV 計數器沒有原子性**：所有速率限制（per-IP、per-userId、驗證嘗試上限）都是 KV get-then-put，沒有序列化。同時併發送出的請求會讀到同一個計數值而全部放行，因此爆發流量的超額幅度取決於**攻擊者自己的併發數**，不是固定的 ~2 倍；這些限制只對循序流量成立。要有硬上限必須改用 Durable Objects 或 Cloudflare 原生 rate-limiting binding（見 `docs/project-plan.md` BE-4），屬另案決策
- OTP 使用後立即刪除（一次性）。唯一例外是 `POST /api/auth/lookup`：該端點以 `consumeOtp: false` 呼叫閘門，比對成功也不刪除 OTP。因為用戶端的流程是「先 lookup 帶密鑰確認歸屬，再 create／join 帶**同一組**密鑰」，若在 lookup 就把一次性 OTP 用掉，第二個請求必然失敗且被計為一次驗證失敗，5 次就把使用者自己鎖住 15 分鐘。不刪除也不會放寬安全性：OTP 仍受自身 300 秒 TTL 約束，且呼叫方本來就已經持有它
- Token refresh 改為 protected route（需有效 Bearer token），防止 userId + familyId 直接取得新 token
- 預設不設定；首次 PWA 登入後提醒一次，之後不再提醒

#### KV Key 設計

| Key Pattern                                     | Value                                                                                 | TTL      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| `verify:{userId}`                               | `{ method, hash, salt, prompted, secretUpdatedAt? }`                                  | None     |
| `verifyfail:{userId}:{caller}`                  | `{ failCount, lockedUntil, startedAt? }`                                              | 900 秒   |
| `otp:{userId}`                                  | `{ code, createdAt }`                                                                 | 300 秒   |
| `qr:{token}`                                    | `{ userId }`（一次性 QR Token，加入家庭時比對成功即刪除）                             | 300 秒   |
| `ratelimit:user:verify:{userId}:{bucket}`       | 該時段內針對此帳號的驗證嘗試次數（字串數字）                                          | 7,200 秒 |
| `ratelimit:user:verify-write:{userId}:{bucket}` | 該時段內此帳號的驗證設定寫入次數（上限 30，PUT verify／OTP／prompted／qr-token 合計） | 7,200 秒 |
| `ratelimit:sens:{ip}:{bucket}`                  | 該分鐘內來自此來源的建立／加入家庭次數（上限 3）                                      | 120 秒   |
| `ratelimit:sens:lookup:{ip}:{bucket}`           | 該分鐘內來自此來源的查詢所屬家庭次數（上限 3，獨立）                                  | 120 秒   |

#### API 端點

| Method | Path                            | 說明                                                              | 權限 |
| ------ | ------------------------------- | ----------------------------------------------------------------- | ---- |
| `GET`  | `/api/user/:id/verify`          | 查詢驗證方式（不回傳 hash）                                       | 公開 |
| `PUT`  | `/api/user/:id/verify`          | 設定/變更驗證方式                                                 | 本人 |
| `POST` | `/api/user/:id/verify/otp`      | 產生一次性驗證碼                                                  | 本人 |
| `POST` | `/api/user/:id/verify/prompted` | 標記已提醒                                                        | 本人 |
| `POST` | `/api/user/:id/qr-token`        | 產生一次性 QR Token（PWA 掃碼加入家庭時可略過驗證，300 秒後失效） | 本人 |

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

| 入口             | 說明                              |
| ---------------- | --------------------------------- |
| Extension 設定頁 | 手動填入自訂 Worker URL           |
| PWA 設定頁       | 手動填入自訂 Worker URL           |
| 同步碼自動帶入   | 貼上含 `@host` 的同步碼時自動切換 |

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

| 功能             | PWA 支援 | 備註                            |
| ---------------- | -------- | ------------------------------- |
| 瀏覽家庭書櫃     | ✅       | 核心功能                        |
| 個人書櫃開關     | ✅       | 書籍須先由 Extension 同步過一次 |
| 加入/建立家庭    | ✅       |                                 |
| 新增書籍         | ❌       | 無法爬取讀墨頁面                |
| 借閱功能（未來） | ✅       | 發送/接收借閱請求               |

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

| 頁面     | 篩選方式         | 選項                                | 預設             |
| -------- | ---------------- | ----------------------------------- | ---------------- |
| 家庭書櫃 | Dropdown（單選） | 全部（不含自己）/ 全部 / 各成員名稱 | 全部（不含自己） |
| 個人書櫃 | Filter buttons   | 全部 / 開放 / 不開放                | 全部             |

---

## 九、版本管理

### 版本格式

Semantic Versioning：`MAJOR.MINOR.PATCH`

| 類型  | 說明                                        | 範例                                                    |
| ----- | ------------------------------------------- | ------------------------------------------------------- |
| PATCH | Bug fix                                     | 0.1.1                                                   |
| MINOR | 新功能                                      | 0.2.0（搜尋功能）、1.1.0（借閱功能）、1.2.0（公開書櫃） |
| MAJOR | Breaking change（API 不相容、資料格式變更） | 1.0.0（首次公開版）                                     |

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

| 階段             | 版本範圍 | 說明                         |
| ---------------- | -------- | ---------------------------- |
| Pre-release      | v0.x.x   | 目前階段，功能開發中         |
| 首次公開版       | v1.0.0   | Chrome Web Store 上架        |
| 借閱功能         | v1.1.0   | v1.0 之後的新功能            |
| 個人公開書櫃分享 | v1.2.0   | 獨立網址對外分享個人開放書單 |

---

## 十、問題回報連結配置

問題回報連結以 JSON 配置檔管理，方便後續增減：

```typescript
// shared/src/config/links.ts
export const reportLinks = [
  {
    name: "GitHub",
    icon: "github",
    url: "https://github.com/<owner>/moo-family-bookshelf",
  },
  { name: "Plurk", icon: "plurk", url: "https://www.plurk.com" },
] as const;
```

顯示位置：Settings 頁面底部，以 icon 排列。

---

## 十一、個人公開書櫃分享（v1.2.0）

> 使用者可產生獨立網址，將個人已開放的書籍對外公開分享，訪客無須登入即可瀏覽。
> **資料模型採可擴充設計**：v1.2.0 每位使用者僅允許 1 組公開書櫃，未來（v1.3+）可在不更動 schema 與 API 形狀的前提下擴充至多組與自選書籍模式。

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
│  POST/PUT/DELETE            │
│   /api/user/:id/            │
│        public-shelf[/:shelfId]│
└──────────┬──────────────────┘
           │ 儲存明文書單快照
           ▼
┌─────────────────────────────┐
│  Cloudflare Workers          │
│                             │
│  user:{id}.publicSharing    │
│    ↳ shelves[] (max 1)      │
│  public:{token} → 明文快照   │
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

### 資料模型

```typescript
// user:{userId} 擴充欄位
interface UserBooksRecord {
  // ... 既有欄位
  publicSharing?: {
    shelves: PublicShelf[]; // v1.2.0 強制 length <= 1
  };
}

interface PublicShelf {
  shelfId: string; // 內部識別（UUID），重設網址後仍維持
  shareToken: string; // 對外網址 token（可重設）
  title: string;
  expiresDays: number | null; // null = 永久
  createdAt: number;
  expiresAt: number | null;
  selectionMode: "all-shared"; // v1.2.0 僅此模式
  // bookIds?: string[];      // 預留：未來 "explicit" 模式啟用
}

// public:{shareToken} 快照
interface PublicShelfSnapshot {
  userId: string;
  shelfId: string;
  title: string;
  books: BookEntry[]; // is_shared=true 的書籍快照
  createdAt: number;
  expiresAt: number | null;
}
```

### 設計重點

- **書單來源**：v1.2.0 公開書櫃的書 = `isShared === BoolFlag.TRUE` 的書（`selectionMode: "all-shared"`），不另外標記
- **明文儲存**：公開書櫃為使用者主動公開，伺服器以明文儲存
- **使用前提**：曾加入過家庭以完成書單同步即可（不要求目前處於家庭中）；token refresh 邏輯需支援無家庭狀態
- **預設關閉**：公開分享預設不啟用，使用者需手動開啟
- **快照同步**：`PUT /api/user/:id/books` 時自動更新所有 active shelves 的 `public:{token}` 快照
- **過期管理**：7 / 30 / 60 / 90 天 / 永久（預設 30 天），透過 KV TTL 自動清理。建立時 `expiresAt = createdAt + expiresDays`；更新 `expiresDays` 時重算為 `更新時間 + expiresDays`（從更新時起算）
- **重設網址**：產生新 UUID token，舊 token 立即失效；shelfId 維持不變（區隔內部識別與對外連結）
- **關閉公開分享**：刪除 `public:{token}` + 移除 user record 中的 shelf 元素
- **購買連結**：書籍連結至 `https://readmoo.com/book/{bookId}`（另開分頁），不提供借閱
- **share_token**：UUID 32 碼（無連字號），高熵防猜測
- **PWA 路由**：v1.2.0 採混合路由（公開頁面 path-based，其餘 hash routing）

### 擴充路徑（v1.3+）

| 擴充項目       | 變更                                                              |
| -------------- | ----------------------------------------------------------------- |
| 多組公開書櫃   | worker 常數 `MAX_PUBLIC_SHELVES` 由 1 提升至 3；UI 增加 list view |
| 自選書籍模式   | 啟用 `selectionMode: "explicit"` + `bookIds[]`                    |
| 既有資料相容性 | 既有單組記錄無需遷移（已是 array 結構）                           |
| API 路由形狀   | 無需變更（已採 `:shelfId` 定址）                                  |

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
  │◄──── { apiVersion: 2 } ──────│
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

| 變更類型           | 是否遞增 | 範例                                         |
| ------------------ | -------- | -------------------------------------------- |
| 新增端點           | 否       | 新增 `GET /api/user/:id/stats`               |
| 新增可選欄位       | 否       | Response 多回傳 `createdAt`                  |
| 移除或重新命名端點 | **是**   | `GET /api/books` → `GET /api/bookshelf`      |
| 變更必要欄位格式   | **是**   | `is_shared: boolean` → `is_shared: BoolFlag` |
| 變更認證機制       | **是**   | Token 格式變更                               |

### 遷移 SOP

1. 新版 Worker 同時支援新舊格式（過渡期）
2. 發布客戶端更新，使用新格式
3. 確認所有客戶端已更新後，下一版移除舊格式並遞增 `API_VERSION`

### `API_VERSION = 2`：公開身分端點加上驗證閘門

- **已遞增至 2**，理由對應上表的「變更認證機制」：對**有設定 PWA 登入驗證**的帳號，`POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/lookup` 現在都要求 `verifySecret`
- **舊版客戶端的降級行為（請更新擴充功能）**：早於本次變更的 Extension／PWA 不會送出 `verifySecret`，因此在**有設定驗證**的帳號上：
  - `POST /api/auth/lookup` 會得到 `requiresVerification: 1` 且 `existingFamilyId: null`——舊版程式不認得這個欄位，會把它讀成「沒有家庭」，於是進入建立家庭流程
  - 接著的 `POST /api/family` 會被閘門擋下，回傳 `403 VERIFICATION_REQUIRED`，舊版 UI 只會顯示一般錯誤
  - 已經加入家庭、持有有效 auth token 的日常操作**不受影響**（那些端點本來就以 token 驗證）
  - **解法：更新擴充功能／PWA 至最新版**。未設定驗證的帳號完全不受影響
- **注意訊號方向**：`/api/version` 只能讓「客戶端偵測伺服器過舊」（server `apiVersion` < 客戶端 `MIN_API_VERSION`），無法反向警示「客戶端過舊」，所以這次遞增救不了舊客戶端，僅是如實記錄契約變更
- **後續（前端）**：把 Extension 與 PWA 的 `MIN_API_VERSION` 提升為 2，才會在使用者指向**尚未更新的自架 Worker**（仍缺少驗證閘門）時顯示黃色升級提示。此為前端變更，不在本次 worker 修改範圍

_最後更新：2026-08-07_
