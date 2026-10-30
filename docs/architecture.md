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
- **讀墨網址**：讀墨把書櫃前端搬到新主機並加上路徑前綴（新站 `https://next.readmoo.com/read/#/library`，注意 `/read`），舊站 `https://read.readmoo.com/#/library` 仍在線，兩者都必須支援。讀墨主機與 hash 路由只定義在 `shared/src/config/readmoo.ts`；書櫃、個人資料、篩選、搜尋、借出、頁面載入用到的 DOM selector 只定義在 `shared/src/config/readmooSelectors.ts`（由 `readmoo.ts` 轉出）。任何地方都不得另行寫死

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
│ 引導畫面      │  │ 確認讀墨帳號（見下方） │
│              │  └──────────┬───────────┘
│ 「開始使用」  │   相同／無法確認 │ 不同 → 帳號不符畫面
│  按鈕        │             ▼
│              │  ┌──────────────────────┐
│  ↓           │  │ 主畫面（分頁）         │
│ Loading 遮罩 │  │ • 家庭開放書櫃（預設） │
│  → 抓取帳號  │  │ • 個人書櫃管理        │
│  → 同步書單  │  │ • 設定               │
│  → 回到原頁  │  └──────────────────────┘
└──────────────┘
    │ 完成後
    └──────────▶ 進入主畫面
```

#### 讀墨帳號確認（已加入家庭時）

擴充功能的身分（`moo:userId` / `moo:familyId`）存在瀏覽器設定檔裡，不是跟著讀墨帳號走。同一個設定檔換了另一個讀墨帳號登入時，Dialog 不能沿用原本的身分（issue #271）。

- 開啟 Dialog、讀到 familyId 與 userId 後，先導航到 `#/me` 抓 email，算出 `deriveUserId(email)` 與存好的 userId 比對，再回到原頁；比對期間維持「載入中」。邏輯在 `extension/src/dialog/accountIdentityCheck.ts`，純比對在 `extension/src/content/accountIdentity.ts`。
- **`#/me` 上不只一個像 email 的節點**（issue #368）：抓 email 時只看 `.me-panel` 裡沒有子元素的 `div[style]`，去掉前後空白後，只留長度不超過 254 字元且像 email 的文字，完全相同的合併成一個；剛好一個才採用。零個或不只一個都當作沒抓到 email，也就是「無法確認」：照常進主畫面，但不自動同步（見下方「無法確認」）。抓取邏輯在 `extension/src/content/scraper-profile.ts` 的 `scrapeUserEmail`；email 格式規則與登入 cookie 的解析、PWA 登入頁共用 `shared/src/account/emailShape.ts` 的 `isEmailShaped`。
- **相同**：進主畫面。結果記在模組層級，只用來省下開啟 Dialog 時的導航：同一次頁面載入重開 Dialog 不再導航；不寫進 storage，重新載入頁面就重新確認。透過引導畫面建立／加入家庭時，沿用上傳書單前重新確認的結果（issue #281）：相同就記為相同；不同就顯示帳號不符畫面（issue #284）；無法確認就照常進主畫面，但不自動同步。
- **每次同步前都重新確認**（issue #277）：自動同步與手動同步上傳書單前，都會先導航到 `#/me` 重新比對（`verifyAccountIdentity`），不採用模組層級的結果，因為同一個瀏覽器的另一個分頁可能已經換了帳號。比對到不同帳號就切到帳號不符畫面，並丟掉模組層級的結果，下次開啟 Dialog 會重新確認。`#/me` 比對相同後，還會再看讀墨的登入 cookie（`ReadmooNext.email`），以防讀墨的單頁程式把舊帳號的個人資料留在記憶體、`#/me` 仍顯示舊帳號：cookie 解得出 email 且算出的 userId 跟存好的不同時，這次當作「無法確認」、不上傳。cookie 只能擋、不能確認：沒有 cookie 或解不開時，仍只看 `#/me`。開啟 Dialog 時第一次的確認走同一個函式，也會被 cookie 擋成「無法確認」。
- **兩個入口與模組層級的結果**（`extension/src/dialog/accountIdentityCheck.ts`）：`checkAccountIdentity` 是開啟 Dialog 時的確認，只有它會用模組層級記住的「相同」省下導航；`verifyAccountIdentity` 一律導航、不看快取，每次同步上傳書單前都呼叫它，引導畫面第一次上傳書單也在爬完書單後立刻呼叫它（issue #281）。記住的「相同」以它確認過的 userId 為 key，不可能替另一個存好的使用者擔保；什麼都不寫進 storage。最近一次 `verifyAccountIdentity` 比對到的「不同」也會記住，但只給 `cachedIdentity` 用（引導畫面交給 App 的結果，issue #284），從不用來省略導航。
- **不同**：顯示帳號不符畫面（`AccountMismatchScreen`），不掛載 `FamilyDataProvider` / `MainContent`，因此不讀書櫃資料、不自動同步，也碰不到任何寫入動作。「改用這個帳號重新設定」只清除本機的身分與家庭綁定（`familyBindingReset.ts` 的 `forgetStoredAccount`），不呼叫任何 API，原帳號仍留在家庭裡、伺服器資料不動，然後回到引導畫面。
- **無法確認**（沒登入、頁面改版、載入太慢、任何錯誤）：照常進主畫面，但這次頁面載入不做個人書櫃的自動同步。同步前的重新確認若無法確認，自動同步直接略過、不顯示任何訊息；手動同步不上傳，並顯示原本的提示。
- **尚未在真實的讀墨上驗證**（issue #277）：另一個分頁換了帳號後，沒有重新載入的讀墨分頁實際上會不會抓到新帳號的書、`#/me` 會不會顯示新帳號，都沒有實測過。同步前的重新確認是防禦性的保護；若 `#/me` 仍顯示舊帳號，登入 cookie 的否決就是針對這個未驗證情況的第二道防線。
- Content Script 在 `#/me` 順手快取顯示名稱時（`extension/src/content/profileCache.ts`），若 storage 已有 userId 且與這頁 email 算出的不同，就什麼都不寫——顯示名稱會跟著原帳號的書單一起上傳。email 只用來比對，不會存進 storage（#359）。

浮動按鈕上的待處理借閱數字（issue #275）用另一個訊號確認帳號：讀墨自己的登入 cookie。按鈕靠這個 cookie 確認相同；上面的 Dialog 帳號確認只認 `#/me` 判定相同，cookie 只用來否決（issue #277）。

- **按鈕只在 cookie 確認相同時查詢**（`extension/src/content/pendingBorrowBadge.ts`）：每次頁面載入／hashchange 注入按鈕時，從 cookie 解出 email，算出 `deriveUserId(email)` 與存好的 userId 相同才送出 `/api/family/…/borrow` 請求；不同或無法確認（沒有 cookie、解不開、雜湊失敗）時不送任何請求，並移除按鈕上已有的數字（fail-closed）。按鈕不做 `#/me` 導航，所以 cookie 無法使用時寧可不顯示。
- **cookie 格式**（`extension/src/content/pageAccountCookie.ts`）：讀墨在 next.readmoo.com 設有 `ReadmooNext.email`，不是 HttpOnly，`document.cookie` 讀得到；值是 `encodeURIComponent(base64(email))`，未登入時不存在。這個格式只用**一個**帳號實測過（解出的 email 與 `#/me` 抓到的完全相同）。read.readmoo.com 目前會轉址到 next.readmoo.com/read。
- cookie 是頁面可寫的輸入，一律當成不可信：不存在、`decodeURIComponent` 或 base64 解不開、解出來不是 UTF-8 或不像 email、同名 cookie 出現兩個不同的值，都當作「無法確認」，不丟例外，按鈕就不顯示數字。讀墨若改了 cookie 的名稱或格式，結果也只是按鈕不再顯示數字。
- **cookie 能被誰寫入沒有驗證過**（安全掃描指出）：cookie 的寫入範圍比 `#/me` 的頁面內容大。其他 `*.readmoo.com` 子網域可以設定上層網域的同名 cookie；讀墨這個 cookie 是否為 host-only、readmoo.com 是否送出含 `includeSubDomains` 的 HSTS，都**沒有驗證過**。同名 cookie 出現兩個不同的值已當作無法確認，擋不住的是只剩單一錯誤值的情況，例如換帳號後只留下原帳號的舊值。
- **Dialog 為什麼不採信 cookie**：cookie 一旦替錯的人確認相同，Dialog 會讓頁面上的帳號以存好帳號的身分操作——用存好的 userId 同步書單、產生 PWA 登入用的 QR Code 與驗證碼、離開家庭；同樣的情況 `#/me` 會顯示帳號不符畫面。這個代價太大，所以 Dialog 的帳號確認維持 issue #271 的做法，「相同」只認 `#/me`。issue #277 起 cookie 可以否決：`#/me` 相同但 cookie 指向另一個帳號時，結果改為「無法確認」，不上傳書單。否決只會讓結果更嚴格，不會替錯的人確認，也不會只憑 cookie 就切到帳號不符畫面，所以不違反上面的理由。
- **按鈕的最壞情況**：cookie 替錯的人確認時，頁面上的帳號看到的是存好帳號的待處理借閱**數字**，看不到書名或借閱內容；修正前不管誰登入，按鈕都會顯示這個數字。這個代價可以接受，所以按鈕採信 cookie。
- **Dialog 也會更新按鈕上的數字**：Dialog 掛載主畫面後（`#/me` 確認相同或無法確認），`MainContent` 讀完借閱清單就經 `onPendingBorrowCountChange`（`extension/src/dialog/App.tsx`）更新數字，不看 cookie。所以 Dialog 的結果是無法確認時，按鈕可能顯示存好帳號的待處理數字，直到下次頁面載入或 hashchange 重新注入按鈕；Dialog 開著時的 hashchange 不重新注入按鈕，但仍會用 cookie 重新確認，不相同或無法確認就移除數字。帳號不符時不掛載主畫面，不會回報數字。
- **已手動實測**（2026-10-05，repo 擁有者在 Chrome 載入 dev build 的擴充功能）：同一個瀏覽器登出後改用另一個讀墨帳號登入，浮動按鈕沒有數字、沒有送出 `/api/family/…/borrow` 請求，Dialog 顯示帳號不符畫面。仍未驗證：這次用的是哪一種登入方式沒有記錄（讀墨的帳號密碼表單，或 Google／Apple／Facebook／QR Code 登入），非 ASCII 的 email 也沒有測過。
- **Dialog 造成的 hash 切換不再查詢**（issue #280）：Dialog 開著時，它自己造成的 hash 切換——開啟時的 `#/me` 帳號確認、issue #277 起每次同步（自動與手動）上傳前的 `#/me` 重新確認、同步書單本身——都不再重新注入按鈕、不再查詢數字，只用 cookie 重新確認帳號，不送請求（`recheckBadgeIfDialogOpen`）。先前每一趟往返最多會多送 2 次 GET。

#### 引導畫面（未加入家庭時）

- 顯示「開始使用」按鈕
- 按下後顯示 Loading 遮罩（半透明背景 + 進度提示）
- 自動導航到 `#/me` 抓取使用者名稱 + email
  - 抓不到 email（包括像 email 的節點不只一個，issue #368）時不建立身分，顯示「無法取得帳號信箱，請確認已登入讀墨帳號。」。
  - 讀墨的登入 cookie（`ReadmooNext.email`）解得出 email，且它算出的 userId 與 `#/me` 的 email 算出的不同時，同樣不建立身分，顯示「讀墨頁面顯示的帳號與目前登入的帳號不同，請重新整理頁面後再試。」（issue #368，`extension/src/dialog/useAutoSetup.ts` 的 `scrapeProfile`，否決判斷是 `pageAccountCookie.ts` 的 `cookieVetoesUserId`）。沒有 cookie 或解不開時照常只看 `#/me`。
  - 已加入家庭時的帳號確認不變：cookie 仍只能否決 `#/me` 的「相同」，不能確認（issue #277，見〈讀墨帳號確認（已加入家庭時）〉）。
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
- **位置**：實作只有一份，位於 `shared/src/crypto/hash.ts`，擴充功能與 PWA 共用；輸出就是既有使用者的 userId，演算法不可更動——包括其中的兩次正規化（`deriveUserId` 與 `sha256Hex` 各自做一次轉小寫加去頭尾空白）
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

| Method | Path                             | 說明                   | 權限 |
| ------ | -------------------------------- | ---------------------- | ---- |
| `GET`  | `/api/user/:id/books`            | 取得個人書單及開放設定 | 本人 |
| `PUT`  | `/api/user/:id/books`            | 更新個人開放設定       | 本人 |
| `PUT`  | `/api/user/:id/new-book-default` | 設定「新書預設開放」   | 本人 |

`PUT /api/user/:id/books` 接受選填欄位 `expectedLastUpdated`（#249），值為先前 `GET /api/user/:id/books` 讀到的 `lastUpdated`（GET 原樣回傳 KV 內儲存的值）。附上非空字串時，Worker 讀出現有紀錄後以字串完全相等比對；不相等（紀錄不存在也算）回 `409 BOOKS_CONFLICT`，不寫入 `user:{id}`，也不刷新公開快照。未附、`null` 或空字串視為沒有前提條件，行為與先前完全相同（#249 之前的 Extension 與 PWA 都不送這個欄位）；其他非字串值或超過 64 字元回 `400 INVALID_FIELDS`，在 handler 讀取 `user:{id}`、`member:{id}` 與 `publicshelves:{id}` 之前判斷；不過此時這次請求已計入 `put-books` 的次數上限（速率限制計數器已讀寫各一次），`409` 亦同。此欄位不會被儲存；`PATCH /api/user/:id/books` 與 `PUT /api/user/:id/family-prefs` 不支援它。

Extension 的書單同步（讀取 → 合併 → 整份 PUT）會帶上它讀到的 `lastUpdated`；收到 `BOOKS_CONFLICT` 時重新讀取、重新合併後重送，上傳最多 3 次（含第一次），3 次都衝突就讓這次同步失敗：書單不會寫入，也不記錄同步成功時間。加入家庭後的第一次同步（`extension/src/dialog/onboardingBooksUpload.ts`）照同一套規則：帶上讀到的 `lastUpdated`，衝突時重新讀取、重新合併後重送，最多 3 次，放棄時顯示同步失敗。

個人書櫃的儲存（對話框與 PWA）在 `decideSaveStrategy` 判定 PATCH 不安全、改走整份 PUT 時（#259），也帶上畫面最後一次讀到的 `lastUpdated`（沒有紀錄時不帶）。收到 `BOOKS_CONFLICT` 時重新讀取，再以重讀的紀錄重組要送出的書單：書籍集合維持畫面上的清單；這次儲存的未儲存改動（送出當下的 dirty 集合）保留畫面上的設定；其餘的書改用伺服器上的現值；這次沒改過、而且重讀時伺服器已經沒有的書，一律以不分享送出——那個 id 是在畫面讀取之後被別處移除的（例如書籍編號變更，#236），不能由這次儲存把它以分享狀態寫回。然後帶著新的 `lastUpdated` 重送，每次儲存最多 3 次 PUT（含第一次）。重讀失敗、重讀找不到紀錄（`409` 表示紀錄存在，重讀卻讀不到，例如跨 colo 的讀取落差），或第 3 次仍衝突就放棄：不寫入，畫面顯示儲存失敗，未儲存的改動維持未儲存。重組與重試的邏輯放在 `shared/src/personal/fullPutConflict.ts`，兩端各自注入自己的讀取解析（Extension 與載入時一樣先解析舊編號重複項目，PWA 把分享旗標正規化成 `BoolFlag`）。PUT 成功後，畫面上目前沒有未儲存改動的書改顯示這次實際寫入的設定，否則之後一次帶著新 `lastUpdated` 的整份 PUT 會把畫面上的舊值寫回去；記住的 `lastUpdated` 改用 PUT 回應中的新值，回應沒有時沿用最後一次讀到的值。PATCH 儲存不帶此欄位，回應也不含新的 `lastUpdated`，所以 PATCH 之後的第一次整份 PUT 會先收到一次衝突，重讀後就能送出。對話框套用同步結果時，記住的 `lastUpdated` 改用那次同步自己上傳成功時 PUT 回應中的值，回應沒有時沿用原值（不清掉，沒有值就等於不帶前提條件）。原因：同步結果可能在一次較晚落地的儲存之後才套用，若沿用儲存留下的較新 `lastUpdated`，畫面上就是較新的 `lastUpdated` 配上同步讀到的較舊分享設定，下一次整份 PUT 會通過比對，把舊設定寫回去；改用同步自己的值，那次 PUT 會先收到衝突，重讀後以伺服器現值重組。載入時伺服器還沒有紀錄的對話框，也是從套用第一次同步結果起才開始帶前提條件。

`decideSaveStrategy` 的 `includePromoted`（預設 `false`：不送、也不計入 PATCH 的數量上限）只有 Extension 可以開：它在載入時就解析舊編號重複項目，本機清單可能在使用者沒有切換任何書的情況下與快照不同，被「提升」的那本書必須一起送出，分享才不會遺失。**PWA 不得開啟**：PWA 以 truthiness 正規化本機的分享旗標，快照卻保留伺服器原始值（這裡以嚴格相等比較），伺服器上存成 `true` 或 `"1"` 的書就會被讀成「有差異」，使用者儲存任何其他書時，它會在沒有本人選擇的情況下被分享出去。

被拒的每一次上傳都計入 `put-books` 每小時 30 次的上限。剩下的窗口見「已接受的殘餘風險」。

`user:{id}` 另有一個只由伺服器維護的欄位 `removedUnsharedBookIds`（#312）：以不分享狀態從書單移除的書的 id，最舊的在前。只有 `PUT /api/user/:id/books` 會重新計算它（`worker/src/services/removedUnsharedBooks.ts` 的 `nextRemovedUnsharedBookIds`）：從已存的清單出發（KV 紀錄只是轉型、沒有驗證，所以先只留通過 `isRealBookId`、長度不超過 32 字元的字串並去重，不是陣列就當成空清單），去掉這次寫入的書單裡有的 id（書回來了，它自己的 `isShared` 就代表使用者的選擇），再依原書單的順序補上原本存著、`isShared` 不是 `1`、bookId 是真正讀墨 id 且不超過 32 字元（`MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH`；讀墨的 id 是 15 位數，超過的 id 不會記進清單）、這次寫入卻沒有的書（已在清單上的不重複加入），最後只保留最新的 1000 筆（`MAX_REMOVED_UNSHARED_BOOK_IDS`）。兩個上限一起限制大小：每筆序列化後最多 35 bytes（32 字元加引號與逗號），整份清單最多約 35KB；只限筆數不限長度的話，PUT 一本 id 極長的不分享書再移除，清單就能跨次 PUT 一直變大。沒有時間上的過期：清單只會讓一本書維持不分享，留得再久也不會讓任何書被看見。結果是空的就不寫這個欄位，所以從沒以不分享狀態移除過書的使用者，紀錄的形狀和以前相同。用戶端送來的同名欄位一律忽略（Extension 同步會把讀到的紀錄整份帶回 PUT，所以一定會收到），不驗證、也不回 `400`；`409 BOOKS_CONFLICT` 與所有 4xx 都不寫入。`PATCH /books`、`PUT /family-prefs` 與家庭暱稱的寫入都以讀到的整份紀錄寫回，原樣保留這個欄位；刪除帳號時隨 `user:{id}` 一起刪除。`GET /api/user/:id/books` 原樣回傳，Extension 的「新書預設開放」不會自動開放清單上的書（見〈書單同步〉）。這些寫入都沒有 compare-and-set：一筆讀到舊紀錄的整份寫回會蓋掉較新的清單，但那份舊紀錄裡通常仍有那本書（以原本的不分享狀態），只有在約 60 秒的跨機房讀取落差內新增又移除的書，才可能同時從書單與清單消失。

`PUT /api/user/:id/new-book-default`（#238）只寫獨立的 `newbookdefault:{id}`（`{ newBookDefaultShared: 0 | 1 }`；沒有這個 key 等於 `0`），不讀也不寫 `user:{id}`，所以書單紀錄還不存在時也能設定。請求為 `{ newBookDefaultShared: 0 | 1 }`，成功回 `{ ok: true, newBookDefaultShared }`；格式不對回 `400 INVALID_JSON`／`INVALID_PAYLOAD`／`INVALID_NEW_BOOK_DEFAULT`，每位使用者每小時最多 60 次（`429`）。這個 key 只有這個端點會寫：`GET /api/user/:id/books` 讀取時把它合併成回應裡的 `newBookDefaultShared`（沒設過就沒有這個欄位），`PUT`／`PATCH /api/user/:id/books`、`family-prefs` 與家庭暱稱的寫入都碰不到它——拆成獨立 key 的理由和 `publicshelves:{id}` 相同：整份寫回的路徑沒有 compare-and-set，別台裝置的同步若讀到舊值會把剛關掉的設定蓋回開啟。剩下的殘餘只有 `GET` 的跨機房約 60 秒舊值：切換後緊接著的一次同步可能照前一個值執行。不認得這個路徑的舊版 Worker 回 `404 NOT_FOUND`，Extension 把 404 顯示成「伺服器尚未支援這個設定」。同步如何使用這個設定見〈書單同步〉的「新書預設開放」。

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
| `DELETE` | `/api/family/:id/kicked/:uid` | 解除移除限制（清除墓碑）   | Owner                           |
| `PUT`    | `/api/family/:id/transfer`    | 轉移 Owner 管理權          | Owner                           |
| `GET`    | `/api/family/:id/members`     | 取得家庭成員列表           | 家庭成員                        |

`DELETE /api/family/:id/kicked/:uid` 是誤移除的補救管道：Owner 呼叫後即刪除該成員的 kicked 墓碑，對方可立即持同步碼重新加入，不必等 6 小時 TTL 到期。此動作**等冪**——不先讀墓碑，沒有墓碑（從未被移除或已過期）同樣回 200 `{ cleared: 1 }`，回應不揭露墓碑是否存在；也**只解除限制、不會把人加回家庭**（重新加入仍須對方自己操作，Inv-4 不受影響）。刪除的 key 由路徑 `:id` 決定，而呼叫者必須是該 `:id` 的 Owner，因此無法解除其他家庭的墓碑。

#### 家庭書櫃聚合 API

| Method | Path                        | 說明                       | 權限     |
| ------ | --------------------------- | -------------------------- | -------- |
| `GET`  | `/api/family/:id/bookshelf` | 取得家庭所有成員的開放書籍 | 家庭成員 |

### 2.5 Cloudflare KV Store

- **職責**：儲存資料（明文 JSON）
- **Key 設計**：

| Key Pattern                     | Value                                                                     | 說明                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user:{user_id}`                | 個人書單 + 開放設定（JSON）                                               | 歸屬個人，不隨家庭變動                                                                                                                                                                                         |
| `newbookdefault:{user_id}`      | 「新書預設開放」設定（`{ newBookDefaultShared: 0 \| 1 }`）                | 歸屬個人、不隨家庭變動（#238）；只有 `PUT /api/user/:id/new-book-default` 會寫，`GET /api/user/:id/books` 讀取時合併回傳，帳號刪除時一併刪除                                                                   |
| `family:{family_id}`            | `{ owner_id, members[], max_members, created_at }`                        | 記錄家庭組成 + 管理者                                                                                                                                                                                          |
| `member:{user_id}`              | 所屬 family_id                                                            | 反向查詢用                                                                                                                                                                                                     |
| `publicshelves:{user_id}`       | `{ shelves: PublicShelf[] }`                                              | 公開書櫃清單（現行連結的唯一來源；僅公開書櫃的四個寫入端點會寫入）                                                                                                                                             |
| `public:{share_token}`          | `{ userId, shelfId, title, books[], createdAt, expiresAt }`               | 公開書櫃明文快照（v1.2.0）                                                                                                                                                                                     |
| `verify:{user_id}`              | `{ method, hash, salt, prompted, secretUpdatedAt?, version?, pepperId? }` | PWA 登入驗證設定（`secretUpdatedAt` 為驗證方式／密鑰最後變更時間，epoch 毫秒；`version` 缺或 1 為 SHA-256 雜湊、2 為以 pepper 為金鑰的 HMAC，`pepperId` 為該 pepper 的指紋，見「PWA 登入驗證機制」→ 安全措施） |
| `verifyfail:{user_id}:{caller}` | `{ failCount, lockedUntil, startedAt? }`                                  | 依「來源 + 目標帳號」計算的驗證失敗次數（TTL 900 秒）；`startedAt` 為該次失敗連續累計的起始時間（epoch 毫秒）                                                                                                  |
| `otp:{user_id}`                 | `{ code, createdAt }`                                                     | 一次性驗證碼（TTL 5 分鐘）                                                                                                                                                                                     |
| `kicked:{family_id}:{user_id}`  | `{ removedAt, removedBy }`                                                | Owner 移除成員時寫入的墓碑（TTL 6 小時）；存續期間 join 一律拒絕該 userId（`403 MEMBER_REMOVED`）。僅 key 的存在與否有語意，欄位為診斷用；Owner 可經 `DELETE /api/family/:id/kicked/:uid` 提前刪除             |

- **TTL**：個人開放設定不設過期（持久化）；家庭群組可設定過期時間；公開書櫃依使用者設定（7/30/60/90 天或永久）
- **家庭人數上限**：`max_members` 預設為 2（配合讀墨官方限制）
- **管理者**：`owner_id` 記錄家庭建立者，擁有移除成員與轉移管理權的權限
- **存取層**：上表中 route 會觸及的 key family 都有對應的存取模組（`worker/src/kv/families.ts`、`users.ts`、`publicShelves.ts`、`verify.ts`、`auth.ts`；函式第一個參數為 `kv: KVNamespace`，一個函式一次 KV 操作並註明 key 與 TTL）。只在 `services/`、`middleware/` 內部使用的 key 刻意沒有存取模組：`verifyfail:{user_id}:{caller}` 與驗證閘對 `otp:{user_id}` 的讀取只存在於 `worker/src/services/verification.ts`，`public:{share_token}` 的寫入只走 `worker/src/services/publicShelf.ts`（該處同時負責網址白名單過濾與動態 TTL）。route 模組一律不直接呼叫 `c.env.KV`、不 import `kvKeys`，改為呼叫這些存取函式或 `worker/src/services/*`；此界線由 `worker/eslint.config.js` 中 `src/routes/**` 的 lint 規則（僅涵蓋靜態寫法）與 `worker/tests/unit/kvAccessBoundary.test.ts` 的原始碼掃描共同把關
- **驗證相關 key 的存取範圍**：`worker/src/kv/verify.ts` 給 route handler 使用，唯一的例外是 `services/verification.ts` 的 `upgradeVerifyRecordHash`（v1 → v2 雜湊升級，由建立家庭、加入家庭、查詢所屬家庭的 handler 在過期檢查之後呼叫）以 `putVerifyRecord` 寫入 `verify:{userId}`——`routes/verify.ts` 讀寫 `verify:{userId}`，寫入 `otp:{userId}` 與 `qr:{token}`，並在設成 PIN／圖形時以 `deleteOtpRecord` 刪除 `otp:{userId}`；`routes/family.ts` 的加入家庭 handler 在 QR Token 略過驗證的路徑上，先讀取再刪除 `qr:{token}`（`getQrTokenRecord`／`deleteQrToken`）；`routes/user.ts` 的帳號刪除 handler（`DELETE /api/user/:id`）先以 `getVerifyRecord` 讀取 `verify:{userId}` 交給目前密鑰的確認（`enforceCurrentSecret`，#396），通過後以 `deleteVerifyRecord`／`deleteOtpRecord` 刪除 `verify:{userId}` 與 `otp:{userId}`；`routes/auth.ts` 的查詢所屬家庭 handler 未附密鑰時以 `getVerifyRecord` 讀取 `verify:{userId}`，再交給 `isVerificationConfigured`（只判斷讀到的紀錄，不讀 KV）。驗證閘門（`worker/src/services/verification.ts`）不經過這個模組，自己直接存取 KV：讀取 `verify:{userId}`（呼叫端以 `record` 選項交入已讀到的紀錄時不讀，目前只有 `enforceCurrentSecret` 這樣做）；讀取 `otp:{userId}`，比對成功且 `consumeOtp` 未關閉時刪除它；讀取、寫入與刪除 `verifyfail:{userId}:{caller}`。OTP 的讀取與「要不要消耗」是閘門邏輯的一部分，不屬於存取層；`verifyfail:*` 只在閘門內寫入，因此也沒有存取函式。建立家庭、加入家庭、查詢所屬家庭、`PUT /api/user/:id/verify` 與 `DELETE /api/user/:id` 另外會讀 `auth:{userId}`，`auth:{userId}`、`token:{hash}` 與 `tokenidx:{userId}:{hash}` 的每一次 KV 操作都在 `worker/src/kv/auth.ts`（#425：`getRawAuthRecord`、`putAuthRecord`、`deleteAuthRecord`、`getAuthTokenRecord`、`putAuthTokenRecord`、`deleteAuthTokenKey`；#431：`putAuthTokenIndex`、`deleteAuthTokenIndex`、`listAuthTokenIndexPage`），舊形狀紀錄的正規化（`normalizeAuthRecord`）、索引的分頁列舉（`listAuthTokenIndexHashes`）與多把 key 的讀寫刪則在 `worker/src/services/authRecord.ts`／`authTokens.ts`／`authRenewal.ts`（`readAuthRecord`、`mintAuthToken`、`readPresentedAuth`、`renewPresentedAuthToken`、`revokeAuthTokenKeys`、`revokeAllAuthTokens`、`readAndRevokeAllAuthTokens`、`isQrBoundToListedToken`）：加入家庭以 `readAuthRecord` 讀取（QR 路徑在閘門內讀、其餘在交出 token 前讀，各一次），建立家庭與查詢所屬家庭在閘門通過後以 `readAuthRecord` 讀一次，QR 略過後由 handler 以 `getAuthTokenRecord` 讀一次綁定那把的 `token:{hash}`；`PUT /api/user/:id/verify`、`DELETE /api/user/:id` 與 `POST /api/auth/refresh` 共用 `readPresentedAuth`（見「PWA 登入驗證機制」→ 安全措施）

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
   → 若成員已滿（>= max_members）：回傳 409 FAMILY_FULL，提示家庭已滿
   → 若曾被管理者移出且墓碑（kicked:{family_id}:{user_id}）仍存續：回傳 403 MEMBER_REMOVED
   → 若是 client 的自動復原加入（body 帶 recovery: 1）且使用者不在名單上：
     回傳 409 RECOVERY_NOT_MEMBER（自動復原只讓名單上的成員重新連線，見「家庭解綁流程」）
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
4. 合併：新書預設不開放，已有設定保留（打開「新書預設開放」時，同步會把伺服器上沒有的新書設為開放，見〈書單同步〉）
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
4. Worker 聚合各成員 is_shared=true 的書籍（只收錄名單上、且歸屬紀錄指向本家庭的成員）
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

（自願離開**不會**寫入 kicked 墓碑——「先離開再加入新家庭」是合法流程，離開後隨時可持同步碼重新加入。）

**自動復原只讓名單上的成員重新連線（#263）**：同一個 userId 每台裝置各有一把 auth token（#425，最多 5 把）。在一台裝置上離開家庭（或刪除帳號、被 Owner 移除）會撤銷該帳號全部的 token，另一台裝置上仍開著的舊工作階段下次發出請求時就拿到 401，前端隨即在背景自動重新加入（自動復原）；這時名單上已經沒有他，若當成新成員處理，等於把他加回家庭，離開沒有生效（違反 Inv-4）。因此：

- 加入端：body 新增選填欄位 `recovery`（`BoolFlag`；不帶視為 0，0／1 以外在讀取任何 KV 之前回 `400 INVALID_RECOVERY_FLAG`），前端只在自動復原時帶 1（PWA 被要求重新驗證之後的那次重新登入也算，見下方 #266）。通過驗證閘門與墓碑檢查之後、成員上限檢查之前，若 `recovery` 為 1 而使用者不在名單上，回 `409 RECOVERY_NOT_MEMBER`（訊息「你已經不是這個家庭的成員」），不多讀、也不寫任何 key。名單上的成員以自動復原重新連線不受影響；手動加入（`recovery` 不帶或為 0）與修正前完全相同，離開後隨時可持同步碼重新加入。
- 不需要額外標記：名單本身就說明他已經不是成員，不論是自行離開、刪除帳號還是被移除，也不論過了多久。有時限的標記擋不住這件事：另一台裝置的舊工作階段可能在標記過期後才發出請求，被移除的人在 6 小時墓碑過期後也一樣。自動復原唯一正當的用途是「名單上的成員 token 失效後重新連線」，所以直接以名單判斷。
- PWA 的重新驗證標記（#266）：設有登入驗證的帳號，自動復原會先被驗證閘門擋下（`VERIFICATION_REQUIRED` 排在 `recovery` 規則之前），PWA 只能登出、請使用者重新驗證；若起因是他在其他裝置離開了家庭，登入頁那次不帶 `recovery` 的加入就會把他當新成員加回。因此 `acquireNewToken` 在這條分支先執行 `logout()`（若在 `logout()` 之前多插一個 `await`，就會重新打開 #258），之後才於 `localStorage` 的 `moo:reauthPending` 寫入被結束的工作階段 `(familyId, 伺服器位址, userId)` 的 SHA-256 摘要，且只留前 4 個十六進位字元（16 bit）（伺服器位址照 `ApiClient` 的方式正規化，缺省即預設伺服器；不存原始值，因為使用者可能關掉了「記住同步碼」；familyId 可能值不多，完整摘要可被離線暴力反推，截短後就推不回 familyId）。這個 key 存的是一組標記，每個仍待重新驗證的身分各占一個（以 `,` 串接，格式不對的項目一律忽略），所以同一台裝置上另一個帳號也被要求重新驗證時，只會多加一個標記，不會蓋掉前一個帳號的；最多保留 16 個，超過時捨棄最舊的。代價是每個標記都有 1/65,536 機率與無關的身分誤判相符（16 個全滿時約 16/65,536），那次加入會多帶 `recovery: 1`：名單上的成員照常登入，新成員會收到一次 `409 RECOVERY_NOT_MEMBER`，相符的標記隨之清除，再送出一次即可加入。登入頁 `completeJoin` 對同一組身分加入時帶 `recovery: 1`：仍在名單上就照常登入；不在名單上回 `409 RECOVERY_NOT_MEMBER`，PWA 清掉這組身分的標記並在表單上說明，使用者再送出一次才是一般的手動加入。標記只在三種情況下清除：同一組身分那次帶了 `recovery` 的重新登入成功、收到這個 409（這兩種只清掉該身分自己的標記，其他身分的保留），或 `forceClearStorage`（刪除帳號或開啟 QR Code；整組清空。開啟可解析的邀請連結只結束目前的工作階段，標記保留；解析不出同步碼的邀請連結什麼都不清除）；同一台裝置上換另一個帳號登入成功不會清掉別人的標記（共用裝置），留下的標記也無害，只會讓相符身分的那次加入多帶 `recovery: 1`；自願登出、刪除帳號與 `JOIN_BLOCKED_MESSAGES` 那條分支都不寫入。這是純前端的標記，伺服器規則不變。實作：`pwa/src/utils/reauthPending.ts`。
- 不涵蓋：不帶 `recovery` 的舊版 client，以及尚未更新、會忽略這個欄位的自架伺服器，自動復原仍會把人當成新成員加回，與修正前相同。
- 殘餘：(a) 加入請求若在離開寫入名單之前就讀了家庭紀錄（或所在資料中心仍持有舊名單，約 60 秒），會走既有成員重連分支，不受這條規則約束，與 no-CAS 整筆覆寫是同一類既有殘餘；(b) 沒有 CAS 的整筆覆寫若把已離開的人重新列回名單（空殼成員，見「已接受的殘餘風險」），他的自動復原會走重連分支並補回歸屬紀錄，等於重新加入；(c) 設有登入驗證的帳號，帶著驗證密鑰、卻沒有帶 `recovery` 的加入視為手動加入，照常放行。被要求重新驗證之後的那次重新登入，Extension（#263 的 `runReauthJoin`）與 PWA（#266 的重新驗證標記）都已帶 `recovery`；仍算手動加入的是：自願登出後再登入、標記沒寫成或已被清除（開啟了 QR Code、刪除帳號；同一台裝置上換另一個帳號登入成功或被要求重新驗證都不會清除它）、同一台裝置上待重新驗證的身分超過 16 個而最舊的標記被捨棄，以及在另一台裝置或瀏覽器上加入；(d) 反方向：合法成員若暫時不在讀到的名單上（跨資料中心約 60 秒的舊名單，或沒有 CAS 的整筆覆寫把剛加入的人擠出名單），他的自動復原會收到 `409 RECOVERY_NOT_MEMBER`，前端清掉本機的家庭資料；伺服器上的個人設定不受影響，持同步碼手動加入即可恢復。

### 移除成員流程（Owner 移除他人）

```
1. Owner 在成員列表對目標成員點擊「移除」
2. DELETE /api/family/:id/member/:uid → 先結算借閱紀錄，再寫入 kicked:{family_id}:{user_id}
   墓碑（TTL 6 小時；寫入失敗 fail-open 並記 log，不擋移除本身），接著寫入新的成員名單，
   最後才刪除 member:{uid} 反向查詢與該成員全部的 auth token
3. 墓碑刻意排在讀取與刪除反向查詢之前：加入家庭先讀反向查詢、後查墓碑，因此看到反向查詢已刪的
   加入請求必定也看到墓碑，回 403 MEMBER_REMOVED，不會把反向查詢補回來（同一資料中心內成立；
   跨資料中心的傳播延遲見「已接受的殘餘風險」）。成員名單排在刪除反向查詢之前：名單一寫入，
   移除就已生效，之後刪除反向查詢若失敗，只會留下一筆讀不到任何家庭資料的反向查詢，
   任何一次重試都會清掉它。代價：若寫入墓碑之後、名單寫入失敗（回 500），
   目標仍在名單上、卻最多 6 小時無法重連；owner 看得到他，重試移除即可收斂，或以步驟 6 解除。
   若前次移除的墓碑寫入失敗（成員已不在名單、墓碑未寫入），owner 重試移除會走
   404 MEMBER_NOT_FOUND——該分支對「owner 指向他人」會先等冪補寫墓碑、再清掉殘留的反向查詢，
   然後回 404，確保禁令補得上
4. 墓碑存續期間，該 userId 對此家庭的 POST /api/family/:id/join 一律回 403 MEMBER_REMOVED
   （涵蓋 client 自動重連、手動輸入同步碼與 QR token bypass 三條路徑；檢查位於驗證閘門之後）
5. 被移除成員的 client 收到 MEMBER_REMOVED：Extension 清除本地家庭資料並還原伺服器設定，
   回到引導畫面並說明原因，PWA 顯示訊息並登出——不再無聲重試
6. 誤移除的補救：Owner 呼叫 DELETE /api/family/:id/kicked/:uid 立即刪除墓碑（等冪，
   只解除限制、不會自動把人加回家庭），該使用者隨即可持同步碼重新加入
7. 無人操作時，墓碑過期後該使用者亦可持同步碼重新加入（Inv-4 認可的合法再加入路徑；
   TTL 即這條自然回復的界線）
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

受邀者貼上含 `@` 的同步碼時，Extension / PWA 會在加入時切換至對應的 API 端點，無需手動設定。加入前，兩端的加入畫面都會顯示該同步碼所指向的自訂伺服器位址（見 §六「同步碼位址的驗證與揭露」），讓使用者在按下「加入」之前就看得到自己將連往何處。

### 安全性

- 高熵隨機字串，防止暴力猜測
- 同步碼 = 家庭識別 +（可選）API 端點
- 不持有同步碼就無法加入家庭

---

## 五、安全機制

| 層面             | 措施                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **傳輸安全**     | HTTPS 強制加密                                                                                                                                                                                                                                           |
| **儲存安全**     | 明文 JSON 儲存於 KV，以 auth token 控管存取                                                                                                                                                                                                              |
| **存取控制**     | 高熵同步碼作為家庭存取憑證 + auth token 驗證每次請求                                                                                                                                                                                                     |
| **隱私預設**     | 所有書籍預設不開放，使用者主動選擇；唯一例外是使用者自己打開的「新書預設開放」（預設關閉，見〈書單同步〉）                                                                                                                                               |
| **防濫用**       | Rate Limiting（Cloudflare 內建）                                                                                                                                                                                                                         |
| **資料獨立**     | 個人設定不隨家庭解綁而消失                                                                                                                                                                                                                               |
| **權限分離**     | 家庭成員僅可瀏覽他人已開放書籍，無法修改                                                                                                                                                                                                                 |
| **解綁隔離**     | 離開家庭後，其他成員立即無法存取該使用者的書籍；Owner 移除成員後，kicked 墓碑（TTL 6 小時）阻擋被移除者（含其 client 的自動重連）重新加入，Owner 可隨時解除以補救誤移除；帶 `recovery: 1` 的自動復原不會把名單上已沒有的人加回（殘餘見「家庭解綁流程」） |
| **PWA 登入驗證** | 可選式驗證機制（PIN / 圖形 / 隨機碼），防止家庭成員冒用身份                                                                                                                                                                                              |

### 威脅模型與已接受的風險姿態

本節說明本專案的安全設計為何停在目前的位置。**通用安全稽核清單不會知道這些前提**，因此每次掃描都可能重新提出「應導入更強的身分驗證或原子化計數器」之類的建議。在下列前提改變之前，那些建議屬於過度工程，請以本節為討論基準，不要逐次重新推導。

#### 前提一：帳號系統不屬於本專案

使用者的帳號歸屬於讀墨（Readmoo），本專案沒有任何可掛勾的身分驗證機制——無法寄送驗證信、無法做密碼重設、無法查詢讀墨的登入狀態。這是 `userId` 必須由 email 推導（`sha256("moo:" + email)`）的根本原因，也決定了 Worker 端能用來認人的東西**只有兩種可能**：

1. 使用者在本服務自行設定的密鑰（PIN / 圖形 / 一次性驗證碼）；
2. 「持有讀墨登入狀態」——Extension 確實握有，但**無法向 Worker 證明**（讀墨未提供可供驗證的 API）。

因此 PWA 登入驗證閘門是這個架構下的**天花板，而不是中途站**。任何試圖再往上加強的機制，都只是把一個已經是天花板的東西從「大致準確」推向「完全準確」，天花板本身的高度不會改變。

#### 前提二：資產價值

本服務儲存的是「購買了哪些書」與「選擇分享哪些書」，不涉及金流、憑證、通訊內容或身分證明。

較精確的說法不是「沒有機密資訊」，而是**機密程度低，且高敏感的部分已由 opt-in 機制隔離**：書籍購買紀錄在特定情境下確實會透露訊息（宗教、政治傾向、疾病、性向相關的閱讀），而「全部預設不分享、逐本主動開放」的設計正是為此而存在（唯一例外是使用者自己在 Extension 設定打開的「新書預設開放」：之後同步到的新書會自動開放，但第一次同步、封存的書與一次超過 100 本的新書不在此列）——**未分享的書，恰恰是使用者主動選擇要藏起來的那些**。

這個區別有實務意義：它既支持「不需要為此導入重量級基礎設施」的結論，也說明為何繞過 opt-in 這道防線的漏洞（例如未經驗證即可取得他人 authToken）**必須**修補。

#### 已接受的殘餘風險

| 風險                                                                                                                   | 現況                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 為何接受                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 未設定驗證的帳號可被 email 單獨接管                                                                                    | 驗證為選用功能，`method: "none"` 直接通過閘門                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 前提一使然：沒有第二因素可強制。強制設定會把「忘記 PIN 即永久失去資料」的風險轉嫁給使用者，而帳號在沒有任何裝置登入時無法自助救回（人工救援流程見 `worker/DEPLOY.md` → 使用者忘記登入驗證時）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 速率限制不是硬上限                                                                                                     | **每分鐘**的限制（per-IP 三層 60／10／3，以及 per-userId 的 `bookshelf` 30、`borrow-create` 10、`borrow-list` 60、`borrow-update` 30）改由 Cloudflare 原生 Rate Limiting binding 計數，零 KV 操作；官方明示它是「在單一 Cloudflare 節點內計算、eventually consistent、permissive by design」，因此依然不是硬上限——失準的來源只是從「KV 沒有原子性」換成「分節點且最終一致」。**每小時**的 per-userId 計數器（`verify`、`verify-write`、`verify-set`、`put-books`、`family-prefs`、`new-book-default`、`family-write`、`public-shelf`）與以來源為 key 的呼叫端鎖定仍是 KV get-then-put、無序列化，並發放大倍數取決於攻擊者的併發度；自建者若未在 `wrangler.toml` 加上 binding，每分鐘的限制也退回同一條 KV 路徑（每道每分鐘的限流檢查各輸出一行 `RATE_LIMIT_BINDING_MISSING`；家庭書櫃與借閱路由同時受 per-IP 與 per-userId 兩道檢查，因此單一請求最多兩行）。限額數字與分桶完全不變，敏感層仍是同一個限額下的兩個獨立計數器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 先前不採用 binding 的理由（eventually consistent、僅在單一節點內生效、因此不是硬上限）依然成立，現在轉為**明示接受**的姿態：既然原本的 KV 計數器同樣不是硬上限，就沒有理由為同一個強度每個請求多付一次 KV 讀＋一次 KV 寫（#160 的讀取放大）。硬上限仍需 Durable Objects，而 DO 會讓每個自建者的 `wrangler.toml` 與升級流程永久多一層 migration，自建能力是本專案的明確賣點。要在邊緣取得真正的強制力，作法是下方「運維層的補強」的 WAF Rate Limiting 規則                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 未設 pepper 的自架伺服器維持 v1 雜湊，備份外洩時仍可離線猜                                                             | 沒有設定 `VERIFY_PEPPER` 的 Worker，PIN／圖形紀錄維持 SHA-256(salt + secret)（v1），salt 與雜湊同在 `verify:{userId}` 並隨每日備份進 R2；備份或 KV 內容外洩時，可以不經伺服器逐一試完（PIN 至少 10^6 種、最短圖形 3,024 種）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pepper 一旦設定就要永久保管，遺失會讓已升級的帳號全部回 503、無法自助救回，這個責任不宜在升級時默默加給自架者，所以維持選用；設定方式見 `worker/DEPLOY.md` →「設定 PIN 雜湊的 pepper（建議）」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 最短 4 節點圖形僅 3,024 種組合                                                                                         | `isValidPattern` 允許 4-9 節點                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 提高下限會影響既有使用者的既有習慣。此為所有數字中最刺眼的一項，若日後重新評估風險，**這是成本最低、效益最高的槓桿**，應優先於原子化計數器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 被移除成員於墓碑過期後可重新加入                                                                                       | `kicked:{family_id}:{user_id}` TTL 6 小時；同步碼即 family_id，無法旋轉；Owner 可經 `DELETE /api/family/:id/kicked/:uid` 提前解除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 同步碼與 family_id 同體，旋轉等同重建家庭（波及所有 KV key 與全體成員的 client 儲存）。墓碑已封死被證實的攻擊路徑「無聲自動重加入」：更新後的 client 收到 `403 MEMBER_REMOVED` 即清除本地家庭資料、不再重試；TTL 過後的重新加入需人為持同步碼操作（帶 `recovery: 1` 的自動復原不會把名單上沒有的人加回，見「家庭解綁流程」），而這正是 Inv-4 認可的合法再加入路徑。誤移除不必再等 TTL——Owner 可用 un-kick 端點立即解除，TTL 只是「無人操作時」的自然回復界線。已知殘餘：未更新的舊版 client 視 MEMBER_REMOVED 為暫時錯誤而持續重試，墓碑過期後仍可能自動補位；KV 跨 colo ~60 秒傳播窗內，與移除同時發生的 join 可能搶在墓碑可見之前成功，解除方向同理（剛解除後約 60 秒內，持有舊值的 colo 仍可能拒絕該次加入，重試即可）。若要永久排除某人，唯一手段是解散重建家庭                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| borrow 紀錄無 TTL：已完成的每人只留最近 50 筆，進行中的長期保留於 KV；成員離開只清掉他自己借的那一側，對手方那一側續存 | 紀錄含當事人的 userId（email 推導、跨家庭可連結）、暱稱、書名與封面 URL。`GET /api/family/:id/borrow` 已過濾為僅回傳呼叫者為 borrower / owner 的紀錄，因此前成員資料僅交易對手方（經 API）與 KV 操作者可見——而且成員離開家庭時（被移除、自行離開或刪除帳號）`settleDepartingBorrower` 會把「他自己借書」那一側的終態紀錄（已歸還／已拒絕／已取消）連同各自的 `borrow:{requestId}` 指標一併移出索引，家庭裡因此只剩下「別人向他借書」那一側的紀錄與尚未歸還的 LENT；`PATCH /api/borrow/:requestId` 對未知 requestId 回 404、對已知但非當事人回 403，雖構成存在性 oracle，但無實務可達的揭露面（requestId 為 `crypto.randomUUID()`，約 122 bit，且 `borrow-update` 每 userId 30 次/分）。借閱索引 `borrows:family:{id}` 現在是單一真相來源（完整 `BorrowRequest[]`），`borrow:{requestId}` 退化為只含 `familyId` 的指標；每次寫入都會修剪：PENDING／LENT 全數保留，終態（已歸還／已拒絕／已取消）依 `borrowerId` 分組，每人只留 `updatedAt` 最新的 `BORROW_HISTORY_KEEP`（50，定義在 `shared/src/borrow/history.ts`，由 `worker/src/kv/schema.ts` 再匯出；同一個模組也提供兩則借閱分頁用的提示文案，UI 顯示的數字與後端修剪的數字因此是同一個值）筆，被淘汰者離開索引並刪除其 `borrow:{requestId}` key（該刪除為 fail-open：失敗只記錄 `BORROW_POINTER_DELETE_FAILED`，不會讓已經寫入成功的索引變成 500），因此「無 TTL 長期保留」現在只對進行中的紀錄與每人最近 50 筆歷史成立。分組在 borrower 而非家庭，是為了讓成員只擠得掉自己的舊紀錄而非家人的，家庭層級的界因此是「成員數 × 50」筆終態加上全部活紀錄。而「成員數」本身也必須有界，否則這個上限等於沒有：borrowerId 可以無限製造（安全發現 F-1——持有同步碼者以全新 userId 加入、開滿待處理申請、離開，那些申請變成已取消紀錄，但其 borrowerId 從此不再寫入，該分組因此永遠輪不到修剪，如此反覆），所以離開時的清除不是附加功能，而是這個界成立的前提。索引另有兩道在建立端的界：同一借閱者的待處理申請上限 `BORROW_MAX_PENDING_PER_BORROWER`（20，超過回 `409 TOO_MANY_PENDING_REQUESTS` 且不寫入——PENDING 依設計不被修剪，是單一成員唯一能無界成長的部分），以及欄位長度上限（`bookId`／`bookTitle` ≤ 200、`bookAuthor` ≤ 500（書名與作者上限直接沿用 `PUT /api/user/:id/books` 的上限，家庭書櫃上顯示的書不會因為太長而無法借閱，#331；上限生效前就存進去、被保留下來的超長舊資料，借閱時仍會被拒絕）、非空 `bookCoverUrl` ≤ 2048 字元，超過回 `400 INVALID_FIELDS`，與型別檢查同一關卡、在計費之前），兩者都以呼叫者自己的資料計算，第三方無法代為消耗（Inv-6）。家庭解散（單人 owner 離開，或單人 owner 刪除帳號）改為呼叫 `deleteBorrowIndex`：先 fail-open 刪掉索引裡每筆紀錄的 `borrow:{requestId}` 指標，再刪掉 `borrows:family:{id}` 本身，且都排在刪除 family key 之前，因此解散不再留下無人會再經過的孤兒索引——只有清理本身失敗（fail-open，記 `BORROW_POINTER_DELETE_FAILED`／`BORROW_INDEX_DELETE_FAILED`）時才殘留，此時剩下的孤兒指標沒有任何讀取端看得到；`generateFamilyId()` 在 create 前不查 `family:{id}` 是否已存在，約 41 bit 空間又帶 modulo 偏差，familyId 的唯一性是機率保證（生日界約 170 萬個家庭）而非制度保證。帳號刪除（`DELETE /api/user/:id`）除了 user、publicshelves、newbookdefault、member、auth token、公開快照、驗證設定（`verify:`）與一次性驗證碼（`otp:`），也走同一組清理：家庭還有其他成員時呼叫 `settleDepartingBorrower`，名單上只剩自己時（通常是單人 owner）解散家庭、呼叫 `deleteBorrowIndex`，兩者都 fail-open——刪帳號沒有「什麼都沒發生」這個答案可回，清理失敗只記錄而不阻擋刪除。接受的殘餘：有 TTL 的 `verifyfail:`、各 scope 的 `ratelimit:user:{scope}:{userId}:{bucket}`、`qr:`，以及其他家庭寫下的 `kicked:{familyId}:{userId}` 不刪除——鍵名需要 userId 以外的部分（呼叫者、時間桶、QR token、familyId），無法從 userId 推出，各自的 TTL 到期後自然消失。本版部署前已刪除的帳號，其 `verify:{userId}` 不會回填刪除：同一個 email 之後重新建立或加入家庭仍會被要求舊的驗證，忘記時只能由 KV 管理者手動刪除該 key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 終態紀錄已由每次寫入的修剪自然淘汰，離開家庭與解散又補上兩條回收路徑，代價是接受下一列的 no-CAS 覆寫取捨；仍未做的是使用者自己的「主動刪除」：它一樣要重寫 borrow index，會撞上同一個 race 而可能弄丟並發建立中的活紀錄，且會摧毀對手方的交易紀錄（「已取消」「已歸還」的訊號隨之消失）。解散與刪帳號留下的孤兒已由 `deleteBorrowIndex` 在同一個請求內清掉，不必再掃過全部 KV key；剩下的只有 fail-open 清理失敗留下的孤兒指標，沒有讀取端看得到，代價是一把浪費的 key。殘留資料僅交易對手方（經 API）與 KV 操作者可見，與上方安全設計表「儲存安全：明文 JSON + auth token 控管」的既有姿態一致。為 familyId 加碰撞檢查需在每次 create 多一次 KV 讀取與重試迴圈，在 170 萬個家庭的量級之前不划算                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| borrow index 為 read-modify-write，無 CAS：同一家庭的並發寫入會互相覆蓋                                                | `borrows:family:{familyId}` 是單一 KV value，三條寫入路徑——建立借閱、`PATCH /api/borrow/:requestId`、成員離開時的 `settleDepartingBorrower`（移除成員與刪除帳號共用同一支）——都是「讀出整份 → 改 → 寫回」，而 KV 沒有 compare-and-set。同一個家庭在同一瞬間有兩個寫入者時後寫的會覆蓋先寫的，可能弄丟一筆剛建立的借閱、一次狀態變更，或一次自動取消；KV 跨 colo 讀取還可能落後約 60 秒，讓這個窗口比字面上的「同時」更寬。此 race 本身早已存在，但 denormalize 之前它只弄丟索引裡的一個 requestId（紀錄本身另存於 `borrow:{requestId}`），現在弄丟的是整筆紀錄或整次狀態變更。至於「同一個請求內兩次 KV 寫入之間半途失敗」則已不是殘餘：建立借閱改為先寫 `borrow:{requestId}` 指標、再寫索引，修剪則是先寫索引、再刪除被淘汰者的指標（且該刪除 fail-open），兩者方向一致，最壞只會留下孤兒指標——沒有任何讀取端看得到它，對它的 PATCH 與未知 requestId 一樣回 404，重試會以新的 UUID 建立乾淨的紀錄。反方向的「索引裡有、指標沒有」才是要避免的狀態：那是雙方都看得到卻無人能處理的 PENDING 幽靈，修剪不會清掉它（PENDING 免修剪），還會永久卡住同一本書的重新申請                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 家庭規模是兩人到數人，借閱是低頻的手動動作（每一筆都要對方按下同意），兩個寫入者在同一秒撞上同一個家庭的機率極低。撞上時的後果對使用者是可見的（借閱沒出現在清單、狀態沒變），重做一次即可修復；索引是整份覆寫，不會留下寫到一半的索引。要真正消除得改用 Durable Objects（每個家庭一個物件序列化寫入），代價與上方速率限制那一列相同：所有自建者的 `wrangler.toml` 與升級流程永久多一層 migration，而自建能力是本專案的明確賣點。改成 per-borrower 分片索引可縮小碰撞面，但會讓列表與重複檢查退回多次讀取，正是這次改動要移除的成本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| borrow 當事人 PATCH 與踢除之間的 KV 傳播窗；解散清理失敗後的孤兒紀錄仍由當事人收尾                                     | `PATCH /api/borrow/:requestId` 自 #159 起在解析指標後，與 `borrows:family:{id}` 平行重讀 `family:{id}` 並重驗成員資格：家庭仍存在而呼叫者已不是有效成員（不在成員名單上，或自 #222 起雖在名單上、歸屬紀錄卻未指向本家庭）時回 `403 NOT_FAMILY_MEMBER`——被踢、自行離開、之後另建家庭取得新 token 都一樣，前成員不再能把舊紀錄的 LENT 單方面改成終態 `RETURNED`（FSM 無任何轉移可離開，也沒有刪除或更正端點）。剩下兩個窗口：（一）KV 跨 colo 傳播約 60 秒，踢除寫入尚未抵達某個 colo 時，前成員在那個 colo 上對舊紀錄發的 PATCH 仍會以踢除前的家庭紀錄通過重驗——最多一次，因為 `RETURNED` 之後 FSM 沒有任何轉移可用；那一次寫入會重寫整份索引（同上一列的 no-CAS 覆寫），但他碰得到的仍只有自己所屬的那一份——`readBorrowPointer` 以 `isValidFamilyId` 驗過指標值才拿去組 key，指標與索引內紀錄的 `familyId` 不一致時一律回 404 且不寫入。（二）家庭解散時 fail-open 的 `deleteBorrowIndex` 失敗（`BORROW_INDEX_DELETE_FAILED`）留下的孤兒索引：`family:{id}` 已不存在，無成員名單可驗，PATCH 因此略過重驗、只比對紀錄自身的 borrowerId / ownerId，讓任一當事人仍能把該筆收尾（非當事人仍回 `403 FORBIDDEN`）。另一側維持對稱：踢除、自行離開與刪除帳號都會呼叫 `settleDepartingBorrower` 取消 PENDING（刪帳號那一側是 fail-open，失敗只記 `BORROW_CLEANUP_FAILED` 並繼續刪除），因此「已刪帳號的 PENDING 仍被對手方核准成 LENT」只在該清理失敗時才可能發生                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 借閱狀態不涉及金流或憑證（前提二），可被竄改的僅是雙方本就都能觸發的終態（`RETURNED` 由 borrower 或 owner 任一方標記），對手方看到的是一筆狀態不如預期的歷史，而非資料外洩，且對手方仍可自行把該筆 LENT 標記為已歸還收尾。傳播窗的寬度是 KV 平台特性（與上一列相同的約 60 秒落後），要消除得改用 Durable Objects，代價與上列相同。孤兒路徑刻意不封：封掉等於把解散清理失敗的後果轉嫁給仍在等對方歸還的當事人，而該路徑只在清理失敗後才存在、又只對紀錄裡的當事人開放。成員資格重驗的代價是每次狀態更新多一次 `family:{id}` 讀取，與索引讀取平行發出，不增加延遲；#222 起家庭仍存在時再多一次呼叫者歸屬紀錄的讀取，排在家庭紀錄讀到之後；已於 #159 修正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 舊資料殘留的非白名單封面 URL                                                                                           | 封面 URL 白名單（`sanitizeCoverUrl`）在寫入邊界生效，判準共四項：https、Readmoo 註冊網域、預設 port，以及 base 不變性（同一字串在「有 base 文件」與「無 base 文件」下必須解析出同一個 href）。第四項擋的是「Worker 驗的是字串、瀏覽器解的是該字串對渲染文件的 base」這道落差：`https:readmoo.com/…` 這類寫法單獨解析時主機看起來是 readmoo.com，實際渲染時卻會落到檢視者自己的 origin。判準是「解析結果是否依賴 base」而非「字面上有沒有 `//`」——`https:\\readmoo.com/x`、`https:/\readmoo.com/x` 這類 base 穩定的寫法在任何瀏覽器都解析成 `https://readmoo.com/x`，屬貨真價實的絕對網址，放行才是正確的。所有 `public:` 快照經 `buildSnapshot` 收斂；既有資料不主動回填                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 洗淨綁在「該帳號的下一次真正寫入」（書單 PUT 同步、有效的 PATCH、或家庭書櫃偏好儲存）之上，休眠帳號的舊值因此原地保留——主動回填得掃過全部 `user:` key，成本與風險都高於效益。修復前已鑄出的 `public:{share_token}` 快照同樣維持原樣，直到下次刷新或 TTL 到期（永久快照沒有到期日），這段期間由公開頁讀取端 `GET /api/public/:shareToken` 也經 `sanitizeCoverUrl` 消毒（回應轉換，零 KV 寫入）中和：舊快照即使留著外部網址，也在送出前被清空。PWA 的 CSP `img-src` 白名單（`pwa/public/_headers` 已收斂到 Readmoo 網域）因此從載重緩解降為**縱深防禦**——`_headers` 僅在支援它的託管（如 Cloudflare Pages）生效，自建於其他靜態主機時沒有 CSP，仍有讀取端消毒兜底。家庭書櫃聚合的讀取端也經 `sanitizeCoverUrl` 消毒（與 `buildSnapshot` 對稱），休眠帳號的舊毒值不會經由聚合端點外洩給家庭成員。餘下的殘餘：KV 舊值仍留存至該帳號下次真正寫入；上述三個渲染面（公開頁讀取端消毒、家庭書櫃聚合消毒、快照重建）已中和。尚未涵蓋：修復前建立的借閱紀錄（`borrow:{requestId}.bookCoverUrl`，無 TTL）保留當時複製的毒值，並在擴充功能借閱分頁原樣渲染——該路徑由 borrow 封面白名單分支另行處理，不在本次修復的範圍內                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 舊資料殘留的非白名單書籍連結 URL                                                                                       | 書籍連結白名單（`sanitizeReadmooUrl`，與封面共用 `shared/src/config/readmoo.ts` 內同一個判斷核心，因此同樣是 https、Readmoo 註冊網域、預設 port、base 不變性四項條件——判準為「解析是否依賴 base」，不是「有沒有 `//`」，詳見上一列）在寫入邊界生效，所有 `public:` 快照經 `buildSnapshot` 收斂；既有資料不主動回填                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 與封面同構的一條路徑，差別在渲染面是可點擊的 `<a href>` 而非 `<img src>`：惡意家庭成員繞過 UI 直接呼叫 API，即可把 `readmooUrl` 指向釣魚站或任意第三方網站，受害者點擊後就落在攻擊者控制的內容上，目的地也因此取得其 IP 與 User-Agent。**不會**外洩的是 Referer：四個渲染點的 `<a>` 都同時帶 `target="_blank"` 與 `rel="noopener noreferrer"`，而 `noreferrer` 會完全抑制該標頭——那個屬性在此是載重設計而非樣板，日後若有人想拿掉，請先回到本列。要「使用者點擊」才觸發（不像封面會自行載入），但這降低的是發生率而非嚴重性：點擊正好發生在使用者相信自己要打開 Readmoo 的那一刻。CSP 的 `img-src` 對這一面毫無作用（它從來就不管導航），伺服器端消毒是主要防線。洗淨同樣綁在「該帳號的下一次真正寫入」（書單 PUT 同步、有效的 PATCH、或家庭書櫃偏好儲存）之上，白名單上線前寫入的舊值因此在休眠帳號中原地保留——理由與封面相同：主動回填得掃過全部 `user:` key，成本與風險都高於效益。已鑄出的 `public:{share_token}` 快照同樣維持原樣，直到下次刷新或 TTL 到期（永久快照沒有到期日）。這段期間由兩個讀取端消毒中和：公開頁 `GET /api/public/:shareToken`（回應轉換，零 KV 寫入）與家庭書櫃聚合 `GET /api/family/:id/bookshelf`，兩者皆再經 `sanitizeReadmooUrl`，因此休眠帳號的舊毒值不會經由這兩個面外洩。渲染端另有兜底：Extension 與 PWA 在 `<a href>` 前以 `safeBookUrl` 再過濾一次（與既有的 `safeCoverUrl` 對稱），所以即使使用者連的是尚未更新的自建 Worker，連結也不會指向站外。餘下的殘餘：KV 舊值仍留存至該帳號下次真正寫入。借閱紀錄（`borrow:{requestId}`）不含書籍連結欄位，不受此路徑影響                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 家庭多鍵寫入沒有交易：移除成員若在寫入名單之後、刪除歸屬紀錄之前失敗，會留下一筆讀不到任何資料的歸屬紀錄               | KV 沒有交易，建立、加入、移除成員與解散家庭都要寫不只一把 key。寫入順序刻意安排成「先寫重試能偵測並修補的那一邊」：建立先寫 `member:{userId}` 再寫 `family:{id}`，解散先刪 `family:{id}` 再刪歸屬紀錄與 auth token，兩者半途失敗都只會留下指向不存在家庭的孤兒歸屬紀錄；加入先寫 `family:{id}` 再寫歸屬紀錄，半途失敗後重試會走既有成員重連分支，把歸屬紀錄補回來；移除成員時（owner 踢人）先寫墓碑，再寫入新的成員名單，最後讀目標的歸屬紀錄，指向本家庭才刪除它與 auth token（自行離開不寫墓碑，其餘順序相同）。建立與加入把「指向的家庭不存在，或名單上已沒有自己」的歸屬紀錄都視為失效（建立會在閘門之後清掉，加入視同沒有家庭而放行、成功時覆寫），`POST /api/auth/lookup` 也套用同一條規則，對這種歸屬紀錄回報沒有家庭。書櫃與成員清單的讀取除了比對歸屬紀錄，還要求呼叫者列在 `family:{id}` 的名單上，歸屬紀錄不再是唯一依據；反過來，自 #222 起名單也不再是唯一依據（見本列末段）。名單因此排在刪除歸屬紀錄之前寫入：名單一寫入，移除就已生效，家庭書櫃也不再收錄他分享的書；之後刪除歸屬紀錄若失敗，只會留下一筆指向本家庭、名單上卻已沒有他的歸屬紀錄（連同他的 auth token），讀不到任何家庭資料，建立、加入與 lookup 也都把它視為失效。重試會清掉它：他已不在名單上，owner 再踢一次，或本人在 token 仍有效時再按一次離開，都會走 `404 MEMBER_NOT_FOUND` 分支，把這筆歸屬紀錄連同 token 一起刪除。若刪除只成功了 token 那一半，本人的下一個請求會拿到 401 而不是 404，前端的自動復原會先嘗試重新加入這個家庭：帶 `recovery: 1` 的新版 client 因為已不在名單上而被拒絕（`409 RECOVERY_NOT_MEMBER`，見「家庭解綁流程」），殘留的歸屬紀錄維持無作用；不帶此欄位的舊版 client 則照舊重新加入（自行離開不寫墓碑，殘留的歸屬紀錄指向同一個家庭，也不會擋下），再按一次離開仍會成功；沒有再按的話，他會維持在家庭裡，與他看到的失敗訊息一致。在清掉之前，殘留的歸屬紀錄同樣讀不到任何資料。名單寫入本身失敗時（踢人的墓碑已寫入），目標仍在名單上、最多 6 小時無法重連，owner 看得到他，重試即可收斂。「被踢的人不會連同補回的歸屬紀錄一起回到名單」靠的是兩端對稱的寫入順序：踢除先寫墓碑、再讀目標的歸屬紀錄；加入在寫入歸屬紀錄（重連補回或新成員加入）之後，再查一次墓碑，查到就刪掉自己剛寫的歸屬紀錄（只在它仍指向本家庭時才刪，本人已改加入其他家庭的歸屬紀錄不會被刪；但這是先讀再刪、不是原子操作，讀與刪之間若剛好寫入另一個家庭的歸屬紀錄，仍可能被刪掉），回 `403 MEMBER_REMOVED`，不換發 token。踢除在這兩步之間寫入名單，不影響這個配對。兩端都是先寫自己那把 key、再讀對方那把，所以至少有一端會看到另一端：踢除讀到補回的歸屬紀錄而刪掉它，或加入看到墓碑而撤回。只靠踢除端的順序不夠：目標若原本就在名單上卻沒有歸屬紀錄（先前加入半途失敗），加入可能在墓碑寫入前通過墓碑檢查，踢除讀到空的歸屬紀錄而什麼都不刪，補回的歸屬紀錄隨後才寫入，再碰上一筆以踢除前名單覆寫的寫入，就等於繞過墓碑重新加入。補回歸屬紀錄的那次重連另外一律不寫回成員名單（暱稱變更留到下次重連），作為第二道防線。這個保證只在同一資料中心內成立，仍有兩個例外：跨資料中心時 KV 各把 key 各自傳播（約 60 秒）；墓碑寫入失敗（fail-open）會讓那一次踢除失去這層保護。這兩種情況下上述競速仍可能發生。移除時讀到過時的歸屬紀錄而漏刪，留下的是同一種指向本家庭、但名單上已沒有他的歸屬紀錄：書櫃、成員清單與借閱路由都會比對名單而拒絕，owner 再踢一次（走 `404 MEMBER_NOT_FOUND` 分支，先補墓碑再刪歸屬紀錄）就會刪掉它；`POST /api/auth/refresh` 只看歸屬紀錄、不讀名單，仍可能替這種殘留換發 token，但那個 token 讀不到任何家庭範圍的資料。仍存在的是 #213 之前就有的 no-CAS 覆寫：`family:{id}` 是整筆讀改寫、沒有 CAS，踢除會與任何同時進行的整筆寫入競速——歸屬紀錄完好的重連帶著新暱稱寫回名單，或本人呼叫暱稱、成員設定端點，只要在墓碑寫入前就讀了名單，都可能在 owner 寫入之後把被踢的成員重新列回名單。加入端在墓碑寫入前通過複查、踢除端隨後刪掉它剛寫的歸屬紀錄，也會留下同樣的狀態。他沒有歸屬紀錄，但若那次重連在撤銷之前讀到歸屬紀錄，仍可能拿到新的 token。自 #222 起這個空殼成員不再有任何作用：成員層級的家庭授權都要求「列在名單上，而且歸屬紀錄指向本家庭」（`worker/src/services/membership.ts` 的 `isActiveMember`）。家庭書櫃只收錄這種有效成員的書；借閱的建立、列表與 PATCH（家庭仍存在時）都拒絕他，建立借閱時也不能指定他為出借方；暱稱與成員設定端點不讓他寫回整份紀錄；轉移管理權也不能交給他。管理者專屬的操作（移除成員、解散家庭、解除移除限制、轉移管理權）同樣要求呼叫者是 `ownerId` 而且是有效成員：同一種覆寫若讀在轉移管理權之前，會把 `ownerId` 一併改回已被新管理者踢出的前管理者，這個空殼前管理者仍拿不到任何管理權（得到的是非管理者的 `403 NOT_OWNER`）。唯一的例外是「管理者不能在還有其他成員時離開」這條限制：它只看 `ownerId` 與名單、不讀歸屬紀錄，所以名單上還有別人時，他對自己按離開同樣得到 `403 OWNER_CANNOT_LEAVE`，會一直留在名單上、卻沒有任何作用。這條限制刻意不要求「有效成員」：真正的管理者若剛好讀不到自己的歸屬紀錄（跨資料中心傳播或未命中結果的快取），否則會被當成一般成員離開，留下 `ownerId` 仍指向他、名單上卻沒有管理者的家庭。他只有在名單上只剩自己時才能離開，這時走的是下面的「最後一人」解散，而不是單人管理者解散（後者會無條件刪掉他的歸屬紀錄）。他拿不到管理權的代價是這時家庭裡沒有任何有效的管理者：現任成員都不是 `ownerId`，而移除成員、解除移除限制與轉移管理權都要求有效的管理者，所以沒有任何補救手段，只能等他在 6 小時的移除限制過後重新加入；他一重新加入，就拿回完整的管理權。任何一次移除（離開家庭或刪除帳號）都不會把名單寫成空的：`normalizeFamilyRecord` 遇到空名單會丟錯，這個家庭之後的每次讀取（持同步碼加入、成員清單、家庭書櫃、借閱）都會回 500 且無法復原，所以離開的人若是名單上最後一人（例如上述空殼前管理者，在其他人都離開後按離開），改走解散：步驟與順序同單人管理者解散（fail-open 刪借閱索引、刪 `family:{id}`，再刪歸屬紀錄與 auth token——只在歸屬紀錄指向本家庭時才刪）。刪除帳號（`DELETE /api/user/:id`）也一樣：`ownerId` 指向已不在名單上的人時（各處自己的移除不會寫出這種紀錄，但整筆覆寫沒有 CAS，`ownerId` 與名單可能不一致），名單上最後一人刪除帳號會改走同一個解散（`worker/src/services/familyDissolve.ts` 的 `dissolveFamily`），不寫回空名單，之後照常刪除自己的歸屬紀錄與 auth token。刪除帳號時「是不是管理者」也要求他列在名單上（歸屬紀錄已指向本家庭，所以這就等於有效成員，不必多讀）：`ownerId` 指向他、名單上卻沒有他時，改走一般成員的分支，名單不變，也不寫回家庭紀錄，不會因為 `OWNER_CANNOT_DELETE` 刪不了帳號，也不會把唯一還在名單上的人所在的家庭當成單人家庭解散。修改家庭 API 端點（`PUT /api/family/:id/endpoint`）同理：讀到家庭紀錄後，除了歸屬紀錄，還要求呼叫者列在名單上（不多讀），否則與歸屬紀錄不符時一樣回 `404 NOT_FOUND`。「有效成員」檢查也帶來一個新的短暫窗口：有人剛加入後約 60 秒內，其他資料中心可能還看不到他的歸屬紀錄（KV 跨 colo 傳播，以及未命中結果的快取），那裡的其他成員暫時看不到他分享的書，向他借書會得到 `INVALID_OWNER`，把管理權轉給他會得到 `INVALID_MEMBER`；傳播完成後自行恢復。`NOT_FAMILY_MEMBER`／`INVALID_OWNER` 不在前端視為「家庭已不存在」的錯誤碼之列，前端不會因此清掉本地的家庭資料。成員清單刻意照樣列出空殼成員，owner 才看得到並再踢一次（走一般移除分支就會清掉）；如果藏起來，他會默默佔住一個成員名額，加入的人收到 `FAMILY_FULL` 卻找不到人可以移除。重新列回名單這件事本身仍擋不住（沒有 CAS），要消除得改用 Durable Objects | 名單寫入之後殘留的歸屬紀錄讀不到任何家庭資料、不佔成員名額，也不擋本人建立或加入家庭，不構成外洩；owner 再踢一次，或本人在 token 仍有效時再按一次離開，都會經 `404 MEMBER_NOT_FOUND` 分支把它清掉；若本人的 token 已刪，新版前端的自動復原會因他已不在名單上而被拒絕，舊版前端則會先重新加入，之後的離開照常完成。反過來的順序（先刪歸屬紀錄、後寫名單）在寫名單失敗時會留下更糟的狀態：目標仍在名單上，他分享的書繼續出現在其他成員的家庭書櫃；自行離開時本人的 token 已刪，要等前端自動復原重新加入、拿到新 token 之後才能重試。更早的做法（各處的多筆寫入平行送出）可能留下同一種歸屬紀錄，但當時讀取端只看歸屬紀錄，被移除者因此仍能換發 token 並讀取家庭書櫃；也可能留下無人指向、永遠無法清除的 `family:{id}`。要真正消除得改用 Durable Objects 序列化寫入，代價與「速率限制不是硬上限」那一列相同；已於 #213 改為目前的寫入順序（踢除時墓碑最先寫入，成員名單先於刪除歸屬紀錄），並在讀取端加上名單檢查；#222 再讓名單上、歸屬紀錄卻未指向本家庭的成員失去所有家庭範圍的存取，代價是每次授權多讀一次歸屬紀錄（家庭書櫃聚合的這些讀取與書單讀取平行發出，不增加延遲）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 個人書櫃 PUT 放寬到 2MB：免費方案 Worker 可能因 CPU 上限中止大書單的儲存，並波及家人的家庭書櫃讀取                     | 請求本文上限改為逐路由判斷（`worker/src/utils/bodyLimit.ts` 的 `bodyLimitFor`）：只有 `PUT /api/user/:id/books` 用 `PUT_BOOKS_MAX_BODY_SIZE`（2MB，以每本約 400–500 bytes JSON 估算約 4000–5000 本），其餘路由（含同一路徑的 PATCH 與 `/family-prefs`）維持 `DEFAULT_MAX_BODY_SIZE`（256KB），超過回 `413 PAYLOAD_TOO_LARGE`。（一）CPU：在 Node／V8（**不是** Workers）量測，4500 本、1.64MB 的 PUT 光是 `JSON.parse` + `parseBooks`（每本兩個欄位的 URL 白名單檢查）+ `JSON.stringify` 就約 17–25ms，還不含公開快照重建與回應；Workers 免費方案每個請求只有 10ms CPU，因此在免費方案的 Worker 上，大約 1000–1500 本以上的書單（推估值，尚未在 Workers 上量測）可能被平台中止——回的是平台的非 JSON 錯誤頁、不帶 CORS 標頭，client 看到的是網路錯誤，而不是 413 的中文說明。波及面不只本人：`GET /api/family/:id/bookshelf`（`worker/src/routes/bookshelf.ts`）會讀出每位有效成員完整的 `user:{id}` 紀錄，這筆紀錄先前受 256KB 請求上限約束，現在可達約 1.3MB 以上，所以一位成員的大書單可能讓**另一位**家人讀家庭書櫃時超過 CPU 上限（聚合端讀整份紀錄的問題見 #214）。（二）儲存：每個 userId 的 `user:{id}`（無 TTL、永久保存）單筆上限估計從約 0.35MB 增為約 3MB；帳號可以免費製造（既有的已接受殘餘），所以既有的 KV 寫入額度／儲存空間消耗槓桿每次寫入放大約 8 倍，但沒有開出新的槓桿；`put-books` 的 per-userId 上限（每小時 30 次，計在已驗證的呼叫者身上）不變                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 對擁有大書單的本人沒有變差：修正前同一份書單 100% 回 413、存不進去；現在付費方案的 Worker 存得下，免費方案最壞也只是同樣存不進去（錯誤從 413 說明變成網路錯誤）。調低請求上限修不了 CPU 問題，只會把付費方案 Worker 原本存得下的書單一起拒絕。真正新增的是家庭書櫃聚合的外溢，根治要靠聚合端不再讀整份紀錄（#214），不在本次範圍。寫不出穩定的失敗檢查：Miniflare 與 Node 都不強制 CPU 上限，所以上述數字都是 Node 量測加推估，日後應在實際的 Workers 上量測後修正本列。儲存放大是既有槓桿的倍數變化，寫入速率仍受 `put-books` 每小時 30 次的上限約束；於 #233 改為逐路由上限。#321 起，新寫入的書名／作者／分類／ISBN 超過 200／500／100／32 字元即拒絕（上限只定義在 `shared/src/api/bookFieldLimits.ts`，Worker 與 Extension 共用，#326）、`coverUrl`／`readmooUrl` 超過 2048 字元即清成空字串（`worker/src/utils/validation.ts`），新的寫入無法再讓單一欄位夾帶好幾 MB；#326 起，Extension 上傳前會略過書名超過上限的新書（伺服器不再收新的過長書名，除了上限之前存入的舊資料，這種書名不會與伺服器上的書名相同，不影響同名比對），作者或分類超過上限的新書則照常上傳、該欄位清成空字串，已存過的書則是作者／分類超過上限沿用伺服器上原本的值，書名超過上限時（不論有沒有改名）送固定的佔位書名「（書名太長，無法顯示）」（只有已存的書會帶這個書名，新書與短的舊 id 條目（#234）都不可能有，所以同名比對永遠不會配上它；截短或沿用舊書名都可能剛好等於另一本書的書名而移轉開放設定；爬到的已存書不再帶超過上限的書名，沒爬到的已存書保留原值；書名超過上限的舊 id 條目（#234）一律不併入真書（`extension/src/sync/legacyBooks.ts`），同步與載入都適用，所以上限前的超長舊資料只會少開放，不會多開放），單一本這樣的書不會再讓整次同步失敗。此版本之前存入的過長文字欄位不會回填（PATCH 原樣保留）；PUT 對同一 bookId 原樣送回伺服器上既有的值時照收（`worker/src/routes/user.ts` 的 `overLongBookFieldMessage`），有這類舊資料的帳號仍能同步，改過的值或新書的過長值則一樣拒絕（此檢查在 `expectedLastUpdated` 比對之後：舊值已被另一台裝置改短時回 409 重讀，不回 400；個人書櫃整份 PUT 的儲存重讀後只重套分享設定，仍會收到 400），過長網址則在該帳號下一次書單寫入時清成空字串；每筆紀錄的上限並未因此降低 |
| 個人書單整份 PUT 的前提條件不是 CAS：同步與儲存仍可能在 Worker 的讀寫之間互相覆蓋                                      | `expectedLastUpdated`（#249）把「同步讀到舊的開放設定、再整份寫回」的窗口，從 client 端整段「GET → 合併 → PUT」縮小到 Worker handler 自己「讀出 `user:{id}` → 寫回」之間（中間至多再隔一次家庭紀錄讀取）。剩下的窗口：（一）KV 沒有 compare-and-set，兩個寫入者若都在對方寫入之前通過比對，後寫的仍會覆蓋先寫的；（二）KV 跨 colo 讀取可能落後約 60 秒，handler 讀到的 `lastUpdated` 本身可能是舊值，另一個 colo 在這段時間內的寫入因此比對不出來；（三）只偵測得到會更新 `lastUpdated` 的寫入：書單 PUT／PATCH 與家庭暱稱 PUT 會更新，`PUT /api/user/:id/family-prefs` 與 `PUT /api/user/:id/new-book-default` 刻意保留原值，所以家庭書櫃偏好的儲存若落在同步的 GET 與 PUT 之間，帶著 `familyShelfPrefs` 的同步 PUT 仍會把它覆蓋回舊值（「新書預設開放」存在獨立的 `newbookdefault:{id}`，書單的寫入路徑碰不到它，不受影響）；（四）加入家庭時的快取搬移（`extension/src/dialog/personalBooksCacheMigration.ts`：伺服器上還沒有紀錄時，把舊版留在本機的書單上傳一次）不帶前提條件。契約只能表達「紀錄的 `lastUpdated` 必須等於某值」，沒有「紀錄必須不存在」可用，所以它的 GET 與 PUT 之間若有另一個寫入者先建立了紀錄，這次上傳仍會整份覆蓋它；（五）整份 PUT 只有在讀到過 `lastUpdated` 時才帶前提條件：畫面載入時伺服器還沒有紀錄、之後也還沒套用任何同步結果，或套用的同步結果來自 PUT 回應不帶可用 `lastUpdated` 的伺服器（不符合契約的自架後端）時，送出的整份 PUT 不帶前提條件，照舊整份覆蓋。整份 PUT 儲存衝突後重讀卻找不到紀錄時直接放棄、不再重送，因為沒有 `lastUpdated` 可帶，重送就成了不帶前提條件的整份寫入。Extension 同步、加入家庭後的第一次同步，以及對話框與 PWA 的整份 PUT 儲存（#259）都帶前提條件，衝突時重新讀取後重送，最多上傳 3 次：同步 3 次都衝突就放棄，不寫入書單、不記錄成功時間，留待下次同步；儲存放棄時不寫入，畫面顯示儲存失敗，未儲存的改動保留。PATCH 儲存本身不帶前提條件，但它只改送出的那幾本書，不會把別的書的舊值寫回去。每一次上傳（含被拒的）都計入 `put-books` 每小時 30 次的上限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 引發 #249 的情境（使用者剛關閉某本書的分享，進行中的同步隨即把它寫回開放）發生在 client 端的讀取與寫入之間，那段時間包含合併等 client 端處理；handler 內的讀寫間隔只剩 KV 往返。要完全消除得改用 Durable Objects 序列化寫入，代價與「速率限制不是硬上限」那一列相同。家庭書櫃偏好是檢視者自己的私人設定，被覆蓋的後果是偏好回到舊值、不改變任何書的分享範圍，而 family-prefs 端點本身已接受跨裝置的 lost-update（見該 handler 的註解）。快取搬移只在加入家庭、伺服器上還沒有紀錄時執行一次，窗口只有它自己一次 GET 到 PUT 之間；要封住得在契約加上「紀錄必須不存在」的前提條件，屬於 API 契約變更。於 #249 加入前提條件，#259 擴及個人書櫃的整份 PUT 儲存與加入家庭後的第一次同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

#### 運維層的補強（不需程式碼變更）

正式部署可在 Cloudflare Dashboard 對三個閘門端點（`POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/lookup`）設定 WAF Rate Limiting 規則。該層在邊緣強制執行、不受 KV 一致性影響，且零程式碼、不增加自建者負擔。自建者可自行決定是否比照辦理。

#### 何時應重新檢視本節

- PWA 登入驗證的實際採用率顯著提高（代表它成為多數使用者的主要防線，而非少數人的加強選項）；
- 本服務開始儲存書單與分享偏好以外的資料；
- 觀察到實際的密鑰猜測流量。

### KV 操作數觀測（per-request kv_ops log）

`worker/src/middleware/kvOpCounting.ts` 為每個 `/api/*` 請求輸出一行結構化 log：`{ event: "kv_ops", method, route, status, reads, writes, deletes, lists }`。計數方式是把 `c.env.KV` 換成一層純轉發的 Proxy——只累加 `get` / `getWithMetadata`（reads）、`put`（writes）、`delete`（deletes）、`list`（lists；Cloudflare 把 list 另列一類計費，#431 起撤銷全部會在請求路徑上呼叫它，見「PWA 登入驗證機制」），不快取、不合併、不改變任何呼叫語意。它註冊在 `/api/*` 上，且刻意排在 `rateLimit`、`authMiddleware` **之前**，因此兩道限流計數器**仍走 KV 的部分**、以及 auth token 的 get，都與 handler 自身的操作記在同一行——那份固定成本正是需要被看見的部分。（每分鐘的限制改用原生 Rate Limiting binding 之後已不再產生 KV 操作，剩下的只有每小時的 per-userId scope，以及自建者未設定 binding 時的退回路徑。）

`route` 取 `routePath(c, -1)`，也就是實際命中的**路由樣式**（未命中時為 `/api/*`），永遠不是 `c.req.path`：原始路徑帶著機密與可連結的識別碼（`:shareToken` 即公開書櫃的密鑰本身，`:id` 是 email 推導的 userId），寫進 log 等於把它們留在可長期查詢的欄位裡。

同樣的理由，`wrangler.toml` 關閉了 Cloudflare 的 invocation log（`[observability.logs] invocation_logs = false`，頂層與 `[env.production.observability.logs]` 各一份——production 的 observability 區塊會整段覆蓋頂層設定），因為它會記下每個請求的完整網址；錯誤 log（`BORROW_CLEANUP_FAILED` 等）也只記事件名稱與錯誤，不記 familyId 或 userId（userId 可經 `POST /api/auth/lookup` 換回 familyId；familyId 約 41 bit，未加密鑰的雜湊可被暴力還原）。`wrangler tail` 走的是即時串流，不經 Workers Logs 保存，依 Cloudflare 文件判斷不受這個設定影響（未實測）。

#### 為何 Cloudflare 內建遙測無法取代

- **KV analytics**：維度只有 namespace × actionType × 日期，沒有路由，也看不出單次請求的操作數。
- **Workers Metrics**：整個 Worker 的彙總數字，同樣分辨不出是哪條路由造成的。
- **Invocation log**：有請求本身的資訊，但完全不含 KV 操作數；本專案也已將它關閉（見上文）。

Workers Logs 在本專案採用的方案上也無法對自訂欄位設定警示，因此這份資料的消費方式是**主動查詢**（拉），而非被動告警（推）。

#### 已接受的殘餘風險：log 量與請求量 1:1

`[observability]` 的 `head_sampling_rate = 1`（`wrangler.toml:5-8`、`:72-74`），加上中介層排在限流之前，被 429 擋下的請求同樣會輸出一行——per-IP 上限節流的是回應，不是 log 事件。免費方案下，Worker 自身的請求上限（約 100k 次/日）會比 log 額度（200k events/日，見 `wrangler.toml:5` 註解）先觸頂，因此代價是「一天的額度有一半被雜訊吃掉，真正重要的 `console.error`（例如 kicked 墓碑寫入失敗的 `KICK_TOMBSTONE_WRITE_FAILED`）被埋在其中」；付費方案下則是一筆 log 帳單。影響僅止於偵測能力下降，不涉及資料揭露、權限繞過，也不改變使用者可感知的可用性。不緩解的理由：調低取樣率會稀釋每一條路由的樣本，而略過 429 只約束得了單一 IP。

#### 生產環境基準（2026-09-23，v1.7.1，#178）

以 `wrangler tail --env production --format=json` 接住 `kv_ops` 行，由一個 2 人家庭用擴充功能與 PWA 把每條路由各走一次。有預算測試的六條路由，生產數字與 `worker/tests/integration/budget/` 釘住的值完全一致；唯一的差異是借閱索引的一次性遷移，屬設計行為：

| 路由                            | 預算（reads / writes） | 生產實測                                                                     |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `GET /api/family/:id/bookshelf` | 5 / 0                  | 5 / 0                                                                        |
| `PUT /api/user/:id/books`       | 6 / 2                  | 6 / 2（當下沒有公開書櫃；每多一個公開書櫃 +1 write）                         |
| `GET /api/family/:id/borrow`    | 3 / 0                  | 遷移前 14 / 0（舊形狀索引 11 筆，逐筆 fan-out）；遷移後 3 / 0                |
| `POST /api/family/:id/borrow`   | 3 / 2                  | 14 / 2（這一次寫入同時完成遷移，讀取端仍付了最後一次 fan-out；之後為 3 / 2） |
| `PATCH /api/borrow/:requestId`  | 4 / 1                  | 4 / 1                                                                        |
| `GET /api/family/:id/members`   | 3 / 0                  | 3 / 0                                                                        |

沒有預算測試、同一次觀測順帶記下的路由：`GET /api/user/:id/books` 2 / 0、`PATCH /api/user/:id/books` 5 / 2、`GET /api/user/:id/verify` 1 / 0、`GET /api/user/:id/public-shelf` 3 / 0、`POST /api/user/:id/public-shelf` 4 / 3、`GET /api/public/:shareToken` 2 / 0。整段觀測沒有出現 `RATE_LIMIT_BINDING_MISSING` 或任何 `*_FAILED` 行，每分鐘限流確實走原生 binding。

遷移那一段值得留著當證據：v1.7.0 時期建立的家庭，其 `borrows:family:{id}` 仍是舊的 `string[]` 形狀，v1.7.1 上線後第一次列表付了 3 + 11 次讀取，下一個寫入（建立借閱）把索引改寫成新形狀，之後的列表立刻回到 3 次——與 `.claude/rules/backend.md` 所述「lazy、只在寫入路徑遷移、GET 不寫 KV」逐字相符。

是否再加上「超出預算」的事件（例如額外一行 `console.warn`）：基準已存在，且六條路由零偏差，暫不加；下一次預算數字改變時再回頭評估。

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

- **PIN／圖形的雜湊存於 `verify:{userId}`（server 端驗證），依 `version` 分兩種**：`version` 缺或為 1 是 v1 = SHA-256(salt + secret)；Worker 設了 secret `VERIFY_PEPPER`（trim 後非空才算）時，新設定的密鑰寫成 v2 = HMAC-SHA256(pepper, salt + secret)，帶 `version: 2` 與 `pepperId`（pepper 的指紋：SHA-256(`"pepper-id:" + pepper`) 的前 16 個 hex 字元）。salt 與雜湊在同一筆紀錄，又隨每日備份進 R2，所以 v1 紀錄一外流就能離線猜（PIN 的組合數少）；v2 還要拿到 pepper，而 pepper 只存在 Worker secret。v1 紀錄在本人下一次以正確密鑰通過三個閘門之一（建立家庭、加入家庭、帶密鑰的查詢所屬家庭），而且通過 `passedAgainstStaleVerifyRecord` 之後，由 handler 以同一個 salt 改寫成 v2（`upgradeVerifyRecordHash`，`worker/src/services/verification.ts`）：`method`、`salt`、`prompted`、`secretUpdatedAt` 都不動，寫入失敗不影響這次請求（fail-open，只記不含識別碼的 `VERIFY_HASH_UPGRADE_FAILED`）。閘門本身仍不寫 `verify:{userId}`；QR Token 略過的加入沒有比對密鑰，不升級；目前密鑰的確認（`PUT /api/user/:id/verify`、`DELETE /api/user/:id`）也不升級，前者接著寫入新紀錄、後者接著刪除。v2 紀錄而 Worker 沒有 pepper、`pepperId` 與目前 pepper 的指紋不符，或 `version` 是 1、2 以外的值時，閘門回 `503 VERIFY_UNAVAILABLE`（「伺服器的驗證設定不完整，請聯絡管理者」），有沒有帶密鑰都一樣，不計數、不寫 KV，並輸出不含識別碼的 log `VERIFY_PEPPER_MISSING`／`VERIFY_PEPPER_MISMATCH`／`VERIFY_HASH_VERSION_UNSUPPORTED`。用錯的雜湊去比對，會把本人正確的密鑰當成猜錯、一路累積到鎖定，所以寧可明確拒絕；這個判定也排在「紀錄毀損就放行」之前，絕不會落到那條路徑。不支援更換 pepper。設定方式與遺失的後果見 `worker/DEPLOY.md` →「設定 PIN 雜湊的 pepper（建議）」
- **驗證閘門涵蓋三個公開端點**：`POST /api/family`（建立家庭）、`POST /api/family/:id/join`（加入家庭）、`POST /api/auth/lookup`（查詢所屬家庭）。三者共用同一個 `validateVerification`，錯誤碼與鎖定行為完全一致（`400 INVALID_VERIFY_SECRET` / `403 VERIFICATION_REQUIRED` / `403 VERIFICATION_FAILED` / `429 VERIFICATION_LOCKED` / `429 RATE_LIMITED` / `503 VERIFY_UNAVAILABLE`，兩種 429 皆附 `retryAfter`）。原因是 userId 由 email 加固定鹽推導而來、屬公開可猜的識別碼，而個人設定 `user:{userId}` 在離開家庭後仍會保留（設計如此）：
  - **建立家庭**若不設閘門，任何知道受害者 Email 的人都能為受害者的 userId 建立家庭並取得有效 auth token，進而讀取其完整書單（含未開放書籍）與修改開放設定，等同帳號接管
  - **查詢所屬家庭**若不設閘門，familyId（即同步碼本體）會直接外洩，陌生人可用自己的 userId 加入尚未額滿（上限 2 人）的家庭並瀏覽共享書櫃
  - 閘門位置：建立家庭時排在 `ALREADY_IN_FAMILY` 衝突檢查之後、**任何 KV 寫入與發放 token 之前**（含孤兒 `member:` key 清理），驗證失敗不會留下任何副作用；查詢所屬家庭時則排在讀取家庭歸屬之前，未通過者不會觸發任何家庭查詢。查詢所屬家庭帶密鑰而通過時，同樣會在過期檢查之後把 v1 紀錄升級成 v2：它是 PWA 登入第一個呼叫的閘門。不帶密鑰的探詢不經過閘門，也不升級
  - **`ALREADY_IN_FAMILY`（409）排在閘門之前，是刻意保留的極小揭露**：它等於告訴未通過驗證的呼叫方一件布林事實——「這個 Email 對應的帳號目前屬於某個仍存在、且名單上有他的家庭」（不含是哪一個）。歸屬紀錄 `member:{userId}` 若指向已不存在的 `family:{id}`（建立或解散半途失敗留下的孤兒），或指向名單上已沒有他的家庭（加入與踢除交錯留下的殘留），都不算有家庭：建立會在閘門之後清掉它，加入則直接放行、成功時覆寫它，因此揭露的範圍比「有歸屬紀錄」更小。之所以不把閘門提前：這個衝突是「便宜且終局」的，任何密鑰都無法讓該請求成功，先驗證只會白白要求使用者輸入 PIN、消耗該帳號的驗證嘗試額度，最後仍然拒絕。建立家庭與加入家庭採同一順序，行為一致。真正有價值的資訊（familyId／同步碼、auth token、成員資料）與所有寫入都仍在閘門之後
- **`MEMBER_REMOVED`（403）排在閘門之後**：加入家庭在驗證閘門通過後才檢查 kicked 墓碑，「此帳號最近被移出此家庭」這件事實只對通過該帳號驗證的呼叫方（或未設驗證的帳號）揭露，不構成新的 pre-gate 揭露。此檢查刻意同時涵蓋 QR token bypass（開踢前幾分鐘鑄造的 QR token 不得凌駕開踢意圖）與「家庭紀錄尚含此成員」的重連分支（墓碑存續期間仍在名單上，只可能是移除仍在進行中（墓碑先寫）、移除在寫入墓碑後失敗，或與移除競速的 stale KV 讀取，一律以較新的移除意圖為準，fail-closed）
- **`verifySecret` 在 handler 邊界就統一把關**：三個入口都先用 `sanitizeVerifySecret()`（`worker/src/utils/validation.ts`）分類，再交給閘門——「未提供」（欄位缺少、`null`、空字串）走各端點原本的無密鑰行為（lookup 回 `requiresVerification: 1`，create／join 回 `403 VERIFICATION_REQUIRED`）；「有給但格式不對」（非字串，或長度超過 `VERIFY_SECRET_MAX_LENGTH` = 256）一律回 `400 INVALID_VERIFY_SECRET`。理由有二：其一，格式錯誤是「請求本身不合法」，不是「驗證失敗」，因此不該計入任何失敗額度，也不該讓超長字串走到 hash 計算；其二，同一份錯誤輸入以前在 lookup 會被當成「沒帶密鑰」（200）、在 create／join 卻落入 `403 VERIFICATION_REQUIRED`，三個入口對同一種輸入給出不同狀態碼，現已統一
- **未設定驗證的帳號行為不變（已接受的殘餘風險）**：`verify:{userId}` 不存在或 `method: "none"` 時一律直接放行，上述兩項風險對這些帳號依然成立。本次修正的目標是「有設定驗證的人真的受到保護」，而非強制所有人設定驗證；是否改為強制屬產品決策
- 連續 5 次驗證失敗 → 鎖定 15 分鐘。失敗次數與鎖定狀態是「以來源 + 目標帳號」為單位計算，記錄在獨立且有 TTL（900 秒）的 `verifyfail:{userId}:{caller}`，不會寫入帳號本身的 `verify:{userId}`。因為建立／加入家庭與 `/api/auth/lookup` 都是公開端點、userId 又由 email 推導（可猜），若把失敗次數記在帳號上，任何第三方都能靠亂送錯誤驗證把別人鎖在 PWA 登入之外（DoS）；改為記在來源後，攻擊者只會鎖住自己。註：`/api/auth/lookup` 現已納入驗證閘門，設有驗證的帳號不再從該端點外洩 familyId，但 userId 本身仍可猜，以受害者為 key 的失敗計數依舊是 DoS 槓桿，因此此設計不變
- **每個目標帳號另有「驗證嘗試上限」：每小時 10 次（`ratelimit:user:verify:{userId}:{bucket}`）**。這道限制寫在 `validateVerification` 內部，而非各個 handler，因此建立家庭、加入家庭、查詢所屬家庭三個入口一律受同一道約束；#396 的目前密鑰確認（`PUT /api/user/:id/verify`、`DELETE /api/user/:id`）也經由 `enforceCurrentSecret` 呼叫同一個閘門，同樣受每小時 10 次的限制。未來新增的呼叫端也不可能漏掉。**只有「猜錯的密鑰」才計數，而且額度是在比對「之後」才查看**：先執行 `matchesSecret` 比對，密鑰正確就直接放行——**即使該帳號的額度已被打滿也一樣，且不計數**；只有比對失敗的那條分支才唯讀查看額度（`peekPerUserRateLimit`）並加一（`chargePerUserRateLimit`）。猜錯時若額度已用盡，回傳 `429 RATE_LIMITED`（附 `retryAfter`，取代原本的 `403 VERIFICATION_FAILED`），且不會再寫入已滿的計數器（被拒絕的嘗試不得延長視窗）。因此沒帶密鑰（`VERIFICATION_REQUIRED`）、格式錯誤（`400`，在 handler 就擋下）、未設定驗證的帳號、以及**帳號本人輸入正確密鑰的成功流程**都不消耗額度；已被鎖定的來源仍在比對之前就被擋下（該鎖定以來源為 key，不是針對受害者的槓桿）。這不會放寬防護：攻擊者送出的每一次猜測依定義都是錯的，每小時 10 次失敗後仍然封鎖後續猜測，暴力破解的上限完全不變
  - **執行順序與代價**（由上而下，先命中者勝）：

    | 情境                                          | 結果                      | KV 寫入                                                                                  |
    | --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
    | 未設定驗證                                    | 通過                      | 無                                                                                       |
    | 該來源已鎖定                                  | 429 VERIFICATION_LOCKED   | 無                                                                                       |
    | v2 紀錄而 pepper 缺或不符，或未知的 `version` | 503 VERIFY_UNAVAILABLE    | 無                                                                                       |
    | 未帶密鑰                                      | 403 VERIFICATION_REQUIRED | 無                                                                                       |
    | 記錄毀損（沒有 hash／salt）                   | 通過                      | 無                                                                                       |
    | 密鑰正確                                      | 通過                      | 刪除該來源失敗紀錄（若有）；v1 紀錄另由 handler 在過期檢查之後升級寫入 `verify:`（一次） |
    | 密鑰錯誤，額度尚有                            | 403 VERIFICATION_FAILED   | 嘗試計數器 + 失敗紀錄                                                                    |
    | 密鑰錯誤，額度已滿                            | 429 RATE_LIMITED          | 僅失敗紀錄                                                                               |

  - **為何需要**：鎖定機制以「來源」為 key（見下一點），攻擊者輪替 IPv6 前綴就能規避，等於沒有全域上限。圖形驗證最短只有 4 個節點、9×8×7×6 = 3,024 種組合，約 605 個前綴（單一 /48 配額內即可湊齊）就能試完整個空間
  - **殘餘風險（有界，且不再傷及帳號本人）**：這個計數器仍以**受害者的 userId** 為 key，第三方可以連續送出 10 次錯誤密鑰把它打滿。但打滿之後擋下的只有「針對該帳號的後續**猜測**」——帳號本人帶著正確密鑰仍然照常通過（查詢、建立、加入三個入口皆是），因為正確密鑰根本不會被拿去比對額度。也就是說，這個計數器是對付攻擊者的槓桿，不是能把帳號本人關在門外的槓桿。它與「鎖定必須以來源為 key」的原則不衝突：那條原則規範的是**誰會被鎖住**，而不是禁止存在全域嘗試上限
  - 這個計數器的 scope 為 `verify`，與其他 scope 的 per-userId 計數器（`put-books`、`family-prefs`、`new-book-default`（每小時 60 次）、`family-write`、`public-shelf`、`borrow-*` 等）命名空間各自獨立、語意清楚；`DEV_MODE=1` 下與其他速率限制一樣停用。三個閘門入口（建立／加入／查詢所屬家庭）在此 gate 內共用這同一道 `verify` 上限，加入端點不再另設獨立的 per-userId 計數器（詳見下方已知限制）
- **變更驗證方式／密鑰會作廢先前的失敗紀錄**：`PUT /api/user/:id/verify` 會在 `verify:{userId}` 寫入 `secretUpdatedAt`（epoch 毫秒）；`verifyfail:{userId}:{caller}` 則記錄該次連續失敗的起始時間 `startedAt`。驗證時若 `startedAt < secretUpdatedAt`，代表這筆失敗紀錄是針對「已經不存在的舊密鑰」累積的，直接視為作廢：不觸發鎖定、失敗次數不再累加。作廢是每次請求即時重算的記憶體判定，未刪除的殘留紀錄本身即失效；實際清除只發生在「驗證成功」時（刪除該來源自己的那把 key，不做 KV list 掃描），輸入錯誤密鑰時則由新的失敗紀錄整筆覆寫，未帶密鑰或鎖定中則完全不寫入。理由是 Cloudflare KV 對同一個 key 每秒僅允許一次寫入，先刪後寫可能讓剛計數的失敗被靜默丟棄，因此每次請求對 `verifyfail:{userId}:{caller}` 至多一次寫入。因此在手機上連續打錯而被鎖定、但仍記得目前密鑰的使用者，在桌面 Extension 輸入目前的 PIN／圖形後重設，就能立即登入，不必等 15 分鐘（#396 起，PIN／圖形帳號改驗證設定都要先出示目前的密鑰；忘記密鑰的人無法這樣重設，見「忘記驗證方式時」。電腦與手機若在同一個對外 IP 之後，這次確認會與手機共用同一份鎖定，要等鎖定結束）。兩個欄位任一缺漏（舊資料）時一律**維持鎖定**，缺值永遠不會解鎖。這不會成為 DoS 手段：`secretUpdatedAt` 只能透過 `PUT /api/user/:id/verify` 更新，該端點需要帳號目前的 token 且 `callerId === userId`，PIN／圖形帳號還要出示目前的密鑰，只有帳號本人能作廢失敗紀錄，而且只能作廢自己帳號上的
- **設定新的 PIN／圖形會撤銷帳號的全部 token（#378、#425）**：同一帳號每台裝置各有一把 auth token，`auth:{userId}` 記著這些 token 的雜湊清單（`{ tokens: [{ hash, createdAt }], secretAt? }`，最多 5 把），每把 token 另有自己的 `token:{hash}`（hash 為 `hashAuthToken`，token 原文不存）。`PUT /api/user/:id/verify` 的新方式是 `pin`／`pattern` 時，先寫入 `verify:{userId}`，再以 `revokeAuthTokenKeys` 刪掉清單上每一把、以及 `tokenidx:{userId}:` 索引列得到的每一把 token 的 `token:{hash}`（含這次出示的那把；索引見下方「撤銷全部也刪得到不在清單上的 token」），接著以 `mintAuthToken` 為發出這次變更的裝置鑄一把新的，回應多帶 `authToken` 與 `expiresAt`。鑄造是這個請求對 `auth:{userId}` 唯一的一次寫入（整筆覆寫成只有新的那把，不先刪除：KV 對同一個 key 每秒只允許一次寫入）。其他裝置手上的 token 從此回 401，要輸入新的密鑰才能再登入；否則用舊密鑰登入過的裝置會一直握有有效 token，還能繼續續期。改成 `code` 或 `none` 不撤銷任何 token，回應維持 `{ method, prompted }`：
  - **`none`**：之後不需要密鑰就能登入，撤銷也保護不了什麼
  - **`code`**：擴充功能的重新驗證畫面（`extension/src/dialog/VerificationPrompt.tsx`）遇到 `code` 只顯示說明、沒有輸入驗證碼的欄位，而驗證碼（`POST /api/user/:id/verify/otp`）只能由還握有 token 的裝置產生。若改成驗證碼也撤銷 token，帳號底下每一個擴充功能都會被鎖在外面，沒有任何裝置能再產生驗證碼。已接受的殘餘風險：從 PIN／圖形改成驗證碼時，用舊 PIN／圖形登入的裝置仍保有 token
  - **順序：先寫驗證紀錄，後換 token**。換 token 失敗時密鑰已經換掉、請求回 500，使用者再儲存一次就會再換一次；反過來的話，驗證紀錄寫入失敗時呼叫方會先失去自己的 token，密鑰卻還是舊的
  - **QR Token 綁定產生它的 token**：`POST /api/user/:id/qr-token` 在 `qr:{token}` 記下這次出示的 auth token 的雜湊 `tokenHash`（`hashAuthToken`，與它在 `auth:{userId}` 清單裡的 `hash` 相同；只存雜湊，不存 token 本身）。加入家庭時 QR Token 比對到同一個 userId，會讀 `auth:{userId}`，由 `isQrBoundToListedToken`（`worker/src/services/authRecord.ts`）確認清單上仍有綁定的那把 token 才略過驗證。#425 之前產生的 QR Token（`tokenHash` 缺漏，或是舊式加了 `qr:` salt 的雜湊，最多 300 秒）對不上任何一把，一律不略過。不論是否略過，QR Token 都會刪除（一次性），沒略過時照常走密鑰驗證。QR 略過後，重連與新成員兩個分支在任何寫入之前，以 `getAuthTokenRecord` 讀一次綁定那把的 `token:{hash}`，仍對應到這個 userId 才繼續；不見了（撤銷的刪除已到、清單還是舊的節點），就回 `403 VERIFICATION_REQUIRED`，要求改用密鑰。通過之後為 PWA **鑄一把新的** token（`mintAuthToken`），與發 QR 的 Extension 那把是不同的兩把，兩把都有效；帳號已有 5 把時，這次鑄造可能淘汰掉最早的一把（見下方「同一帳號最多 5 把 token」）。同樣地，擴充功能剛建立或加入家庭後約 60 秒內，手機所在的節點可能還讀不到列入那把 token 的 `auth:{userId}`，QR Token 會被用掉並改走密鑰驗證（有 PIN 的帳號要輸入 PIN，而不是直接略過），結果安全、只是多一次輸入。否則握有舊 token 的裝置可以先產生 QR Token，等本人換掉 PIN 之後拿它加入家庭，拿到一把有效的新 token
  - **以過期驗證紀錄通過的加入、建立與查詢會被拒絕**：設成 `pin`／`pattern` 撤銷全部 token、再鑄新的一把時，新的 `auth:{userId}` 清單紀錄記下這次 `verify:{userId}` 的 `secretUpdatedAt`（欄位 `secretAt`，與 `tokens` 同在一筆；之後每次鑄造都沿用讀到那筆的值；續期只在空窗分支（沒有紀錄或清單是空的）經 `mintAuthToken` 寫 `auth:{userId}`，其餘不寫）。加入家庭以密鑰通過（或因沒有驗證紀錄而放行）時，那個節點讀到的驗證紀錄若比 `secretAt` 舊——沒有紀錄、沒有 `secretUpdatedAt`，或時間較早——代表它比對的是換掉之前的密鑰（過期節點），回 `403 VERIFICATION_REQUIRED`、不交出 token（`passedAgainstStaleVerifyRecord`，`worker/src/services/verification.ts`）。這個拒絕在那個節點看到新的驗證紀錄之後就會解除，重試即可；標記已提示（`POST /api/user/:id/verify/prompted`）不再把換密鑰之前的紀錄寫回去（見下一點），所以在已看到新 `auth:{userId}` 的節點上，不會因此一直被拒。重連與新成員兩個分支都在任何寫入之前檢查，用的是該分支本來就要讀的 `auth:{userId}`，不多讀；QR 略過時不檢查（綁定已證明是目前的 token），沒有 `auth:{userId}` 或沒有 `secretAt` 的紀錄也不檢查。建立家庭（`POST /api/family`）套用同一個檢查，排在閘門之後、孤兒 `member:` key 清理與任何寫入之前，同樣回 `403 VERIFICATION_REQUIRED`、不交出 token；讀到的 `auth:{userId}` 直接沿用給發 token，不多讀。查詢所屬家庭（`POST /api/auth/lookup`）在讀取家庭歸屬之前檢查，判定過期時回與未附密鑰相同的「需要驗證」回應（200、`requiresVerification: 1`、`existingFamilyId: null`），不揭露 familyId 與成員數；這會多讀一次 `auth:{userId}`。否則在 `verify:{userId}` 還讀不到、`auth:{userId}` 卻已是新紀錄的節點上，不知道 PIN 的人就能從查詢取得同步碼；若那個節點的 `member:{userId}` 也還讀不到，還能建立新家庭並拿到有效 token（同時把 `member:{userId}` 指向新家庭）
  - **只有帳號目前的 token 能改驗證設定**：「目前的」指這次出示的 Bearer token 的雜湊在 `auth:{userId}` 的清單上（#425）。`PUT /api/user/:id/verify`（不分方式）以 `readPresentedAuth` 讀一次 `auth:{userId}`，出示的不在清單上時回 `401 UNAUTHORIZED`，不寫入驗證紀錄；`token:{hash}` 還在、卻不在清單上的 token（在還沒傳到撤銷的節點上通過驗證中介層，或兩台裝置同時鑄造時被擠掉的那把——後者撤銷全部時經由索引刪除，#431）也不算目前的。沒有紀錄、或清單是空的時照常放行（空窗：例如 #425 以前帶 90 天 TTL 的舊紀錄已到期，或節點還讀不到剛寫入的紀錄；#425 之後寫入的 `auth:{userId}` 不設 TTL）。設成 `pin`／`pattern` 時，撤銷沿用這次讀到的紀錄，不再多讀，並且一定連這次出示的那把 token 的 `token:{hash}` 一起刪，否則空窗時它在改完密鑰後還能繼續用；`code`／`none` 因此多一次 KV 讀取（與 `verify:{userId}` 的讀取並行）。否則在還沒傳到 token 刪除的節點上，舊 token 仍能把驗證改成 `none`，或改成自己知道的 PIN。`POST /api/user/:id/verify/prompted` 適用同一條規則：出示的不是目前的 token 時回 `401 UNAUTHORIZED`，不寫入；讀到的紀錄已標記過提示就不寫入；讀到的紀錄比 `auth:{userId}` 的 `secretAt` 舊（`passedAgainstStaleVerifyRecord`）也不寫入。後兩種都直接回 `prompted: 1`，在已看到新 `auth:{userId}` 的節點上不會把換密鑰之前的紀錄（或讀不到紀錄時的預設值 `none`）寫回去蓋掉新的 PIN／圖形；完全過期的節點、以及改成 `code`／`none` 之後的情況見下方殘餘風險。

    **#396 起再加一道目前密鑰的確認（step-up）**：帳號目前是 PIN／圖形時（`isVerificationConfigured` 為真且方式是 `pin`／`pattern`），`PUT /api/user/:id/verify` 不論改成哪一種方式（包括再設一次 PIN），body 都要帶 `currentSecret`（目前的 PIN，或以 `serializePattern` 序列化的圖形，與登入閘門同一格式）。處理順序：`callerId === userId`（否則 401）→ 解析 body 與格式檢查（`400 INVALID_JSON`／`INVALID_METHOD`／`INVALID_SECRET`；`currentSecret` 以 `sanitizeVerifySecret()` 分類，格式錯誤回 `400 INVALID_VERIFY_SECRET`；這一步不讀寫 KV、不扣任何額度）→ 並行讀 `auth:{userId}` 與 `verify:{userId}`，出示的不是目前的 token 回 401 → `enforceCurrentSecret`（`worker/src/services/verification.ts`）→ 扣 `verify-set` 額度 → 寫入驗證紀錄、撤銷全部 token 並鑄新的一把、刪驗證碼（不變）。`enforceCurrentSecret` 把 handler 已讀到的驗證紀錄交給登入閘門判定（`validateVerification` 的 `record` 選項，`verify:{userId}` 不重讀），錯誤碼與閘門完全相同：沒帶回 `403 VERIFICATION_REQUIRED`、錯誤回 `403 VERIFICATION_FAILED`、來源鎖定或猜錯上限已滿回 `429 VERIFICATION_LOCKED`／`429 RATE_LIMITED`（附 `retryAfter`）；Worker 無法驗證 v2 紀錄（沒有 pepper、pepper 不符或版本未知）時回 `503 VERIFY_UNAVAILABLE`，不計數；猜對永遠放行、不計數（Invariant 6）。`enforceCurrentSecret` 第一步先查過期：讀到的驗證紀錄比 `auth:{userId}` 的 `secretAt` 舊（`passedAgainstStaleVerifyRecord`；沒有紀錄、`none`、`code` 也一樣）時直接回 `403 VERIFICATION_REQUIRED`，不比對、不計數、不寫 KV。否則在 `auth:{userId}` 已是新紀錄、`verify:{userId}` 還沒跟上的節點上，握有目前 token 卻不知道 PIN 的人（用 QR Code 登入的手機、共用的已登入裝置）不必出示密鑰就能把驗證改成 `none` 或刪除帳號；PIN／圖形紀錄若拿來比對，本人剛設的新密鑰也會被當成猜錯。節點追上之後重試即可。沒有過期時，`none`、`code`、沒有紀錄都不需要確認（帶了也忽略）：從沒設過 PIN／圖形的帳號，`auth:{userId}` 沒有 `secretAt`；從 PIN／圖形改成 `none`／`code` 時寫下的 `secretUpdatedAt` 不早於 `secretAt`；沒有 `auth:{userId}`（空窗）時沒有東西可比。`code` 不要求，是因為驗證碼任何持 token 的裝置都能自己產生，要求它等於沒有要求。毀損的 PIN／圖形紀錄（沒有 hash／salt）與閘門相同：不帶回 403，帶任何值都放行。

    `DELETE /api/user/:id` 套用同一條規則：body 可帶 `{ currentSecret }`（空 body 視為沒帶；不是 JSON 回 `400 INVALID_JSON`，不是物件回 `400 INVALID_PAYLOAD`，`currentSecret` 格式錯誤回 `400 INVALID_VERIFY_SECRET`），接著並行讀 `member:{userId}`、`verify:{userId}` 與 `auth:{userId}`，出示的不是目前的 token 回 401（沒有 `auth:` 紀錄時照常放行），再做 `enforceCurrentSecret`。這些都排在任何 KV 寫入（解散家庭、借閱結算、寫回家庭紀錄、刪除）之前，被拒絕時不留下任何副作用。否則持 token 的人可以先刪除帳號（驗證設定隨之刪除），再以本人身分重新加入、設定自己的 PIN，繞過 PUT 的確認。

    已接受的取捨：猜錯與 PWA 登入閘門共用同一把 `verifyfail:{userId}:{caller}` 鎖定（不另設前綴，否則持 token 的人每個來源又多出兩份 5 次的猜測額度；代價是同一來源在登入被鎖時，也暫時不能改驗證設定或刪除帳號）；`DELETE /api/user/:id` 不另設每帳號寫入上限（失敗分支只花讀取，猜錯仍受 `verify` 每小時 10 次與來源鎖定約束）；PUT 與 DELETE 的 401 和 `403 VERIFICATION_REQUIRED` 分支每次花 KV 讀取（PUT 2～3 次、DELETE 3～4 次）、不扣每帳號額度——免費方案讀取每日 100,000 次、寫入只有 1,000 次，而「解析之前就扣額度」本身就是一次寫入

  - **設成 PIN／圖形時刪除待用的驗證碼**：與撤銷 token 同時以 `deleteOtpRecord` 刪掉 `otp:{userId}`。驗證閘門只在方式為 `code` 時才看驗證碼，刪掉之後，300 秒內再改回驗證碼，先前產生的驗證碼也不能用
  - **`POST /api/auth/refresh` 只續期出示的那把 token**：handler 讀 `auth:{userId}`，出示的 Bearer token 不在清單上時回 `401 REFRESH_FAILED`（與其他續期失敗同一個錯誤碼），絕不延長或交出另一台裝置的 token。這條判定就是 `readPresentedAuth`，`renewPresentedAuthToken`、`PUT /api/user/:id/verify`、`POST /api/user/:id/verify/prompted` 與 `DELETE /api/user/:id`（#396）共用。因此在 KV 傳播空窗內，舊 token 即使還能通過驗證中介層，也拿不到本人的新 token：所有會動到 `verify:{userId}` 或交出 token 的路徑（refresh、QR 兌換、`PUT /api/user/:id/verify`、`POST /api/user/:id/verify/prompted`、`DELETE /api/user/:id`）都只認 `auth:{userId}` 清單上的 token。例外見下方殘餘風險。在清單上時（`renewPresentedAuthToken`，#425）：
    - 只重寫這把的 `token:{hash}` 與它的索引 `tokenidx:{userId}:{hash}`（#431，先寫索引、同一個 TTL），不寫 `auth:{userId}`；回傳的 `token` 是同一個字串
    - 新的到期時間 = min（現在 + 90 天，`createdAt` + 180 天）：滑動 90 天（`TOKEN_TTL_SECONDS`），另有自鑄造時起算的絕對上限 180 天（`TOKEN_MAX_AGE_SECONDS`）。剩下的 TTL 不到 `KV_MIN_TTL_SECONDS`（60 秒）時視為已到上限，回 `401 REFRESH_FAILED`，客戶端走既有的 401 → 復原加入，設了 PIN／圖形的帳號要再輸入一次密鑰
    - 驗證碼（`code`）帳號不受絕對上限，只有滑動 90 天：上限會咬到時才多讀一次 `verify:{userId}`，方式是 `code` 就照滑動續期。驗證碼只能由握有 token 的裝置產生，若幾把 token 同一天到期，整個帳號就再也產生不了驗證碼
    - 新的到期時間與 `token:{hash}` 已記的 `expiresAt` 差不到 1 小時（`TOKEN_RENEW_SKIP_WINDOW_MS`）就不寫，回已記的 `expiresAt`。上限前最後 30 天 PWA 每次回前景都會呼叫 refresh（見「PWA 主動續期」），這條讓那些呼叫只花讀取、不寫入
    - `token:{hash}` 已不見或對應到別的 userId 時回 `401 REFRESH_FAILED`
    - 沒有 `auth:{userId}` 或清單是空的（空窗）時鑄一把新的（`mintAuthToken`），回傳的 `token` 是新字串
    - #425 以前的舊形狀紀錄（`{ token, createdAt, secretAt? }`）讀取時當作空清單（`secretAt` 保留），走上面的空窗分支鑄新；它記的明文 token 本身在中介層就回 401（#432 起不再讀 `token:{明文}`）
  - **同一帳號最多 5 把 token（#425）**：建立家庭、加入家庭（重連與新成員都算）、QR 兌換與設定 PIN／圖形都會鑄一把新的 token，不再把既有的交給另一台裝置（`MAX_AUTH_TOKENS_PER_USER`）。清單已有 5 把時，鑄造先讀一次清單上每把的 `token:{hash}`，先淘汰已不存在的，再淘汰 `createdAt` 最早的，並刪掉它的 `token:{hash}`。後果：同一帳號最多 5 個登入，第 6 次登入會登出最早的那個；超過 5 台裝置同時使用時會輪替。觸發鑄造的不只是新裝置登入：復原加入、QR 兌換、PWA 重新登入都會鑄，`none` 帳號的復原加入使用者不會察覺；QR 兌換為 PWA 鑄的那把也可能淘汰掉剛發 QR 的那台。舊形狀紀錄讀成空清單，鑄造時只寫新的那把。淘汰的刪除先完成（先刪 `token:{hash}`，再刪它的索引 `tokenidx:{userId}:{hash}`），接著寫新 token 的索引，才寫入 `auth:{userId}` 與新的 `token:{hash}`；淘汰的 `token:{hash}` 刪除失敗時這次鑄造回 500，索引的寫入失敗也回 500（這時新的 `token:{hash}` 與 `auth:{userId}` 都還沒寫）；淘汰的索引刪除失敗只記一行 `AUTH_TOKEN_INDEX_DELETE_FAILED`、不影響鑄造（留下的索引指向已刪的 `token:{hash}`，無害）
  - **撤銷全部也刪得到不在清單上的 token（#431）**：每把 `token:{hash}` 另有一個索引 key `tokenidx:{userId}:{hash}`（值固定 `"1"`），寫在那次 `token:{hash}` 之前、TTL 與它相同——鑄造會寫，續期真的重寫 `token:{hash}` 時也以同一個 TTL 重寫索引，所以索引永遠跟著 token 到期；撤銷完成之後才落地的續期寫回也帶著索引（寫回若在撤銷進行中落地，索引可能被這次撤銷刪掉，見下方殘餘 (d)）。`revokeAuthTokenKeys` 先以 `kv.list({ prefix: "tokenidx:{userId}:" })` 列出索引（逐頁讀，依 KV 的字典序最多取 400 個（`MAX_REVOKE_INDEX_HASHES`），取滿就不再讀下一頁；回應形狀不對、沒下一頁的 cursor、cursor 重複或超過 10 頁都視為失敗），只取尾巴是 64 位十六進位的雜湊，與清單上的雜湊、`alsoKeys` 合併後一起刪 `token:` key；全部刪成功後才刪列到的那些索引（失敗只記 `AUTH_TOKEN_INDEX_DELETE_FAILED`），任一把 `token:` 刪除失敗就拋錯、索引全部保留，重試找得到。列舉在設 PIN 的新鑄造之前執行，所以刪不到這次新鑄的那把。`kv.list` 本身失敗時記 `AUTH_TOKEN_INDEX_LIST_FAILED`（不帶任何 id），照常刪已知的那些、不刪任何索引，請求不失敗：撤銷全部與 `deleteAuthRecord` 並行，若在這裡拋錯，會留下「`auth:` 已刪、每把 `token:` 都還活著」。400 個的上限來自 Cloudflare 每次 Worker 執行最多 1,000 次 KV 操作（[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)）：400 把 `token:` 刪除加 400 個索引刪除，再加請求本身的操作與之後鑄造的 3 次寫入，設 PIN 約 830 次、踢除約 900 次，仍在上限內（解散與刪帳號還要先刪每一筆借閱指標，借出中的沒有筆數上限，指標極多再加上滿 400 個索引時可能超過，後果同 (f) 在刪掉 `auth:` 的路上）；沒有上限時，索引一多，撤銷的刪除與之後的鑄造就整批超過上限而失敗。取滿時記 `AUTH_TOKEN_INDEX_CAPPED`（只帶列到的數量），照常處理這 400 個，其餘留給下一次撤銷（見下方殘餘 (f)）。驗證中介層不讀索引，每個請求的成本不變。**發版前提**：本修正與 #425 在同一個 tag 釋出；#425 已部署到 dev 時鑄出、沒有索引的 `token:{hash}` 不回填（見下方殘餘風險）
    - 成本：鑄造從 2 次寫入變 3 次（新 token 的索引），真的寫入的續期多 1 次寫入（每把每小時最多一次，見上方跳過範圍），撤銷全部多 1 次 list，並為列到的每把索引多 1 次刪除。鑄造（建立、加入、QR 兌換、設 PIN／圖形）與撤銷每天合計以數十次計，遠低於免費方案每天寫入、刪除、list 各 1,000 次的額度（[KV 價格](https://developers.cloudflare.com/kv/platform/pricing/)）；`kv_ops` 的 `lists` 欄位看得到 list 用量（見「KV 操作數觀測」）
  - 已接受的殘餘風險：KV 的刪除要 60 秒以上才傳遍各節點（這是下限，不是上限）。撤銷全部之後，還沒傳到的節點上 `auth:{userId}` 仍是舊清單、被撤銷的 `token:{hash}` 也還讀得到：這時用被撤銷的 token 續期（`POST /api/auth/refresh`），可能把它的 `token:{hash}` 寫回並再續最多 90 天（不超過自 `createdAt` 起 180 天的上限；驗證碼帳號沒有上限），這次撤銷對這把就失效（#431 起這次寫回連同索引一起寫；寫回若在撤銷進行中落地，這次撤銷可能刪掉它剛重寫的索引，見下方殘餘 (d)）。續期先讀再寫，中間沒有 CAS，撤銷的刪除剛好落在讀與寫之間也一樣。在這種節點上鑄造（兌換用被撤銷的 token 產生的 QR Token、通過驗證的加入）會以舊清單為底整筆寫回 `auth:{userId}`，帶著舊的 `secretAt`：被撤銷的雜湊重新列回清單（它們的 `token:{hash}` 一旦刪除傳到就沒有作用），做這次設定的那台裝置的新 token 卻不在清單上；`verify:{userId}` 也是舊的時，用舊密鑰就做得到。建立家庭與查詢所屬家庭在 `auth:{userId}` 也是舊的節點上同樣放行（`secretAt` 的檢查只在 `auth:{userId}` 已更新時有東西可比）：建立會把 `member:{userId}` 指向新家庭並以舊清單與舊 `secretAt` 覆寫 `auth:{userId}`，查詢會揭露 familyId 與成員數。本人用新 PIN 在 `auth:{userId}` 過期的節點重新登入，也會這樣寫回舊清單。做這次設定的裝置之後續期會回 `401 REFRESH_FAILED`（清單上已沒有它那把）；補救是再儲存一次驗證設定。撤銷若在驗證紀錄寫入之後失敗，儲存會回錯誤：沒刪到的 token 會一直有效到使用者再次儲存成功；若撤銷已完成、新的一把沒寫成，發出變更的裝置也要用新密鑰重新登入
  - 已接受的殘餘風險：`POST /api/user/:id/verify/prompted` 只在 `auth:{userId}` 的 `secretAt` 比讀到的紀錄新時拒絕寫回。所以在 `auth:{userId}` 與 `verify:{userId}` 都過期的節點，或改成 `code`／`none` 之後（不撤銷 token，`secretAt` 不前進）讀到過期紀錄時，它仍會把換之前的紀錄寫回；讀不到紀錄時則寫回 `none`。前者會讓新 PIN／圖形的加入一直回 `403 VERIFICATION_REQUIRED`。本人能不能自己再儲存一次，看寫回的紀錄是否比 `auth:{userId}` 的 `secretAt` 舊，與它是哪一種方式無關：在完全過期的節點把換 PIN／圖形之前的紀錄寫回時，它就比 `secretAt` 舊（`none`／`code` 紀錄也一樣），目前密鑰的確認會一直回 `403 VERIFICATION_REQUIRED`，本人無法自己再儲存一次，只能依 `worker/DEPLOY.md` →「使用者忘記登入驗證時」由管理者改寫驗證設定；寫回的紀錄不比 `secretAt` 舊時（帳號從沒設過 PIN／圖形，或寫回的就是最近一次設定的 PIN／圖形紀錄），本人用自己的 token 再儲存一次即可恢復，後者要輸入那組 PIN／圖形。PWA 的設定提示存方法時已在 `PUT /api/user/:id/verify` 一併帶 `prompted: 1`，不再接著送 POST（#399），所以剛選的方式不會因此被改回 `none`；仍會寫回 `none` 的情況只剩：還沒更新的舊版 PWA，以及「之後再說」與「保持現狀」（只送 POST）在另一台裝置剛設定驗證方式、約 60 秒內讀到過期的空紀錄時。本人自己的兩台裝置在幾毫秒內同時送出 `PUT /api/user/:id/verify`（一台設 PIN、另一台改成別的方式，後者先通過確認、寫入卻較晚落地）也可能留下同樣「紀錄比 `secretAt` 舊」的狀態，處理方式相同；這不是攻擊路徑：對方要握有目前的 token，還要在毫秒內搶先，就算成功，本人再設一次 PIN／圖形、撤銷全部 token 後，對方的 token 也隨即失效
  - 已接受的殘餘風險：在完全過期的節點上（`token:{hash}` 與 `auth:{userId}` 都還是舊的），`PUT /api/user/:id/verify`、`DELETE /api/user/:id` 與 `POST /api/user/:id/verify/prompted` 會把舊 token 當成目前的 token。#396 之後，PUT 與 DELETE 在 PIN／圖形帳號上還要通過目前密鑰的確認；那個節點的 `verify:{userId}` 若也是舊的，比對的就是換掉之前的密鑰，所以要同時握有舊 token 與舊密鑰，才能改掉驗證設定或刪除帳號、接管帳號。這只在那個節點讀到的是 PIN／圖形紀錄時成立：讀到的若是 `none`、`code` 或沒有紀錄（最常見的情況是本人第一次設定 PIN，想把握有 token 的人趕出去，#378），而舊的 `auth:{userId}` 沒有 `secretAt`、或 `secretAt` 不比那筆紀錄新，就沒有東西可比，不需要確認目前的密鑰，單憑舊 token 仍能改掉驗證設定或刪除帳號，這段空窗沒有縮小。`auth:{userId}` 已是新紀錄、只有 `verify:{userId}` 落後的節點不在此列：讀到過期的 `none`、`code` 或讀不到紀錄，都會回 `403 VERIFICATION_REQUIRED`（見上方「只有帳號目前的 token 能改驗證設定」）。`POST /api/user/:id/verify/prompted` 的寫回不要求密鑰，仍只憑舊 token 就能把換之前的紀錄寫回（見上一點）。被接管之後，本人的 token 續期與改驗證設定都會收到 401，新密鑰也已被改掉，無法再自己儲存一次，只能依 `worker/DEPLOY.md` →「使用者忘記登入驗證時」由管理者改寫驗證設定
  - 已接受的殘餘風險：v1 → v2 的升級寫回與 `PUT /api/user/:id/verify` 交錯。`verify:{userId}` 沒有 CAS，升級是把閘門讀到的那筆紀錄換上新雜湊後整筆寫回。本人在一台裝置換了 PIN，約 60 秒內又在另一台裝置用**舊** PIN 登入，而那個節點的 `verify:{userId}` 與 `auth:{userId}` 都還是舊的（過期檢查因此放行），或換 PIN 的寫入剛好落在升級請求的讀與寫之間，升級就會把舊 PIN（v2）連同舊的 `secretUpdatedAt` 寫回、蓋掉新 PIN。之後 `auth:{userId}` 的 `secretAt` 比這筆紀錄新，所有閘門與目前密鑰的確認都回 `403 VERIFICATION_REQUIRED`，本人無法自助修復，只能依 `worker/DEPLOY.md` →「使用者忘記登入驗證時」由管理者寫入臨時 PIN。變體：`PUT /api/user/:id/verify` 改成 `none`／`code` 時不撤銷 token、`secretAt` 不前進，同樣的交錯會讓舊 PIN 以 v2 悄悄復活，而且不會被當成過期：使用者關掉了驗證卻仍被要求舊 PIN，用它再儲存一次即可。觸發的人不限本人：知道舊 PIN 的第三方（例如同家庭成員）也能在本人改成 `none`／`code` 之後的傳播視窗內，對還沒更新的節點用舊 PIN 查詢所屬家庭，讓舊 PIN 以 v2 復活並一直有效，直到本人再儲存一次驗證設定。接受理由：對方必須本來就知道 PIN、紀錄還在 v1 的遷移期、要對準多節點的更新時間差，而且本人剛好在這時改驗證方式；改成 `none`／`code` 本來就不撤銷任何 token，不是驅逐手段，所以新增的傷害只是舊 PIN 多活到本人察覺為止；升級寫回已移到 handler 的過期檢查之後，視窗只剩請求內的讀寫間隔與跨節點傳播。讓 `PUT /api/user/:id/verify` 改成任何方式都推進 `auth:{userId}` 的 `secretAt` 可以把這個變體也擋成 403，但會動到 #378／#396 的等號語意，列在 `docs/secret-token-storage-plan.md` 第 5 節待決
  - 已接受的殘餘風險：啟用 pepper 之前已進 R2 的備份裡，`verify:` 仍是 v1，保留期內可以離線猜；本人換過 PIN／圖形後那些雜湊才失效。
  - 已接受的殘餘風險：`pepperId` 是 pepper 未加鹽的指紋前 64 bit，跟著 `verify:` 進每日備份。pepper 是隨機產生的值時沒有影響；自架者若手打一個好記的字串當 pepper，拿到備份的人可以用字典比對指紋把它猜出來，v2 的保護隨之失效。所以 `worker/DEPLOY.md` 要求以 `openssl rand -hex 32` 產生
  - 已接受的殘餘風險：`POST /api/user/:id/verify/prompted` 整筆寫回它讀到的紀錄，讀到升級之前的 v1 紀錄時，會把剛升級的 v2 滾回 v1。無害：v1 照樣驗得過，下次登入再升級一次（多一次 KV 寫入）
  - 已接受的殘餘風險：`DELETE /api/user/:id` 與另一台裝置登入時的升級寫回交錯，可能讓 `verify:{userId}` 在刪除之後又被寫回，同一個 Email 之後重新建立或加入家庭會被要求那組舊 PIN。接受理由：要同一個人在傳播視窗內一邊在一台裝置登入、一邊在另一台刪除帳號，而那組 PIN 是他自己的；忘了的話由管理者依「使用者忘記登入驗證時」處理
  - 已接受的殘餘風險（#425、#431）：兩台裝置幾乎同時鑄造（KV 沒有 CAS）時，兩個請求讀到同一份清單、各自加上自己那把再整筆寫回 `auth:{userId}`，後寫的蓋掉先寫的，輸的那把有 `token:{hash}` 卻不在清單上（孤兒 token）。孤兒仍會產生，能通過驗證中介層、照常使用，但不算目前的 token：不能續期（自鑄造起最多 90 天後失效）、`PUT /api/user/:id/verify` 與 `DELETE /api/user/:id` 回 401、它發的 QR Token 對不上清單、不能略過驗證。孤兒有自己的索引，所以撤銷全部（改 PIN／圖形、離開、被移出、解散、刪除帳號）會經由索引列舉把它一起刪掉（見上方「撤銷全部也刪得到不在清單上的 token」）。機制與 #425 以前兩台裝置同時發 token 相同，但頻率較高：現在每次加入（含重連）都會鑄造；知道受害者 PIN 的人也能刻意製造孤兒（#425 的安全掃描指出：先在一個節點讀過 `auth:{userId}`，再到另一個節點用正確 PIN 加入，60 秒內回到第一個節點再加入一次），受害者之後改 PIN 時，這把會和其他 token 一起被撤銷。#432 上線當天每個多裝置帳號都可能觸發一次（兩台在 KV 傳播空窗內同時重連，都把舊形狀讀成空清單）。仍剩下的缺口：
    - (a) `kv.list` 也是最終一致（[KV 運作方式](https://developers.cloudflare.com/kv/concepts/how-kv-works/)）：撤銷前約 60 秒內在別的節點剛鑄出的孤兒，它的索引可能還列不到，這次撤銷就漏掉它
    - (b) (a) 漏掉的孤兒在設 PIN／圖形這條路上最多活到自己的 90 天 TTL（`auth:{userId}` 已是新清單，它不能續期）；在會刪掉 `auth:{userId}` 的路上（離開、被移出、解散、刪除帳號），之後它的續期走空窗分支、會鑄出一把新的，壽命不止 90 天——與 #425 以前空窗時的續期相同，本次不改
    - (c) 更新前已鑄的 `token:{hash}` 沒有索引，也不回填：在清單上的仍由清單刪，不在清單上的孤兒最多活到自己的 90 天 TTL。本修正與 #425 同一個 tag 釋出時，只有已部署 #425 的 dev 環境有這種 key
    - (d) 索引寫入與 `token:{hash}` 寫入之間有毫秒級的間隙：另一個撤銷若剛好在這時列到新索引並刪掉它，token 才落地，這把從此沒有索引；在設 PIN 的路上它還要再輸掉 `auth:{userId}` 的後寫覆蓋，才會成為撤銷不到的孤兒。續期的重寫也一樣：它的兩次寫入若剛好跨在一次撤銷的 `token:` 刪除與索引刪除之間（撤銷列出 → 刪 `token:` → 續期寫索引、寫 `token:` → 撤銷刪索引），`token:{hash}` 寫回了、索引卻被刪掉，下一次撤銷列不到它。「刪索引前先讀一次 `token:`」每把多 1 次讀取、只換到毫秒級的視窗，不採用
    - (e) `kv.list` 本身失敗時（KV 拒絕、額度用完、回應形狀不對），撤銷只刪清單上已知的那些並記 `AUTH_TOKEN_INDEX_LIST_FAILED`，孤兒留到下一次撤銷或自己的 TTL
    - (f) 索引超過 400 個的帳號（`MAX_REVOKE_INDEX_HASHES`，上限的理由見上方「撤銷全部也刪得到不在清單上的 token」），每次撤銷依字典序只處理前 400 個、記一行 `AUTH_TOKEN_INDEX_CAPPED`；處理過的索引會刪掉，所以多撤銷幾次（例如再儲存一次驗證設定）就會清完；兩次儲存至少隔一分鐘（`kv.list` 最終一致，太快重存可能列到同一批），而一批約 810 次刪除、免費方案每天全部署只有 1,000 次，所以免費方案一天大約只清得了一批。正常帳號遠不到這個數字：要做到，得能以受害者身分鑄造（知道 PIN／圖形、帳號還沒設定驗證時知道 Email 與同步碼，或握有清單上的 token 以 QR 兌換製造競態），從多個 IP 平行重連加入灌出數百個孤兒，每 400 個約花掉整個部署一天以上的免費寫入額度（每次鑄造 3 次寫入）。還沒輪到的那些在設 PIN／圖形這條路上不能續期；在刪掉 `auth:{userId}` 的路上和 (b) 一樣，可以經空窗分支續期
    - 接受理由：(a)(d) 都要求鑄造與撤銷落在很短的視窗裡，(c) 隨 TTL 消失，(e) 是 KV 本身出錯，(f) 要先能以受害者身分加入（知道 PIN／圖形，或帳號還沒設定驗證）並花掉大量寫入額度、而且再撤銷幾次就會收斂；孤兒除了 (b)(f) 刪掉 `auth:` 的那條路，都不能續期，也不能改驗證設定或刪除帳號。孤兒裝置下次收到 401 時，Extension 與 PWA 都會走復原加入，重鑄一把就恢復正常
  - 已接受的殘餘風險（#425）：一把 token 的兩次續期幾乎同時送達時，兩者都可能寫 `token:{hash}` 與它的索引 `tokenidx:{userId}:{hash}`（#431），任一個 key 撞上 KV 同一個 key 每秒只能寫一次的限制，其中一個請求失敗；續期失敗不會登出（見「PWA 主動續期」→ 失敗什麼都不改），下次再續。先後送達的重複續期不會撞：第二次落在 1 小時的跳過範圍內，不寫入
  - 已接受的殘餘風險（#432）：#425 以前發出的 token 仍以 `token:{明文}` 存在 KV 直到寫入時的 90 天 TTL 到期；中介層不再讀它、撤銷也不再刪它，所以它是惰性的，但在到期前有 KV 讀取權的人仍讀得到原文
  - 已接受的殘餘風險（#425）：驗證碼（`code`）帳號的 token 不受 180 天上限，可能已續到超過 `createdAt` 起 180 天。改成 `none` 之後（不撤銷 token），這把 token 下次續期時上限就會生效：剩下的 TTL 不到 60 秒（`KV_MIN_TTL_SECONDS`）就回 `401 REFRESH_FAILED`，所以最多再活到上一次續期寫下的期限（至多 90 天），不會無限延長。改成 PIN／圖形會撤銷清單上與索引列到的全部 token，只剩上面殘餘 (a)(c)(d)(e)(f) 漏掉的孤兒 token 有同樣的 90 天上限
  - 已接受的殘餘風險（#425、#431）：`DELETE /api/user/:id` 在 `auth:{userId}` 空窗（沒有紀錄或清單是空的）時，`revokeAllAuthTokens` 沒有清單可刪：出示的那把一定刪得到（它的雜湊以 `alsoKeys` 帶入），#431 起其他有索引的 token 也經由索引列舉刪除。剩下的是沒有索引、或這次沒列到的其他 token（更新前鑄的，見上方殘餘 (c)；或 (a)(d)(e)(f) 漏掉的）：已刪除的帳號上，它最多還能通過驗證中介層 90 天，期間它的續期同樣走空窗分支
  - 已接受的殘餘風險（#425）：同一帳號超過 5 台裝置輪流使用時會互相登出（見上方「同一帳號最多 5 把 token」）。每一輪（一台被登出 → 401 → 復原加入、鑄造）約 3 次讀取、3 次寫入、2 次刪除（#431 起各多一次索引的寫入與刪除），淘汰時另加最多 5 次讀取；一個 6 台裝置、每台一天開 10 次的帳號最多約 60 輪／天，約 180 次寫入與 120 次刪除（免費方案每日寫入、刪除各 1,000 次）。5 是一個常數（`MAX_AUTH_TOKENS_PER_USER`），可以調整
  - **已修正（#396）**：先前 `PUT /api/user/:id/verify` 不要求出示目前的密鑰，握有 token 的人可以搶先改掉密鑰、把本人鎖在外面；現在 PIN／圖形帳號改驗證設定與刪除帳號都要先出示目前的密鑰（見上方「只有帳號目前的 token 能改驗證設定」）。仍然存在的殘餘風險：未設驗證（`none`）或設成驗證碼（`code`）的帳號沒有目前密鑰可以確認，握有 token 的人仍可以搶先設定 PIN／圖形；這一步會撤銷帳號全部的 token（#378、#425），本人的每一台裝置因此被鎖在外面
- 來源（caller key）取自 Cloudflare 的 `cf-connecting-ip`（邊緣設定、無法偽造）。IPv4 直接使用；IPv6 正規化為 /64 前綴後才當 key，因為家用 IPv6 至少配發一個 /64，且 privacy extensions 可讓用戶端隨意更換介面識別碼——若以完整位址為 key，攻擊者每送一次請求就能換到全新的失敗額度與全新的速率限制桶。兩個例外：IPv4-mapped 位址（`::ffff:a.b.c.d`）會收斂成內嵌的 IPv4，與該 IPv4 共用同一個 key；無法解析的值則加上 `raw:` 前綴自成一個命名空間，確保不會與真正的 /64 桶撞在一起。同一套正規化也套用在 per-IP 速率限制上
- 已接受的殘餘風險（非缺陷，權衡後保留）：
  - **共用對外 IP**：CGNAT、公司／校園 NAT 之後的多個使用者（IPv6 則是同一個 /64 內的裝置）針對「同一個目標帳號」會共用同一份失敗額度，可能被同來源的其他人連帶鎖住 15 分鐘。相對於「任何陌生人都能鎖住任何帳號」，此風險範圍小很多
  - **跨來源暴力破解不再由鎖定機制擋下**：從「單一來源」發動的暴力破解仍受 per-IP 敏感端點限制（每分鐘 3 次）約束——**驗證閘門的三個入口（建立／加入／查詢所屬家庭）現已全部列為敏感端點**（`isSensitivePublicRoute()`），因為查詢所屬家庭同樣讓未驗證的呼叫方可以測試密鑰，而且是三者中最便宜的一條（純讀取、前面沒有 409 終局衝突）。分類只看路徑不看 body：速率限制中介層在解析 body 之前就執行，無從得知這次有沒有帶 `verifySecret`，而攻擊者本來就會每次都帶。**敏感端點使用同一個限額（每分鐘 3 次）但分成兩個獨立計數器**：建立／加入家庭記在 `ratelimit:sens:{ip}`，查詢所屬家庭記在 `ratelimit:sens:lookup:{ip}`（兩者都是原生 Rate Limiting binding 上的 key，共用同一個 3 次/分鐘的 binding；未設定 binding 而退回 KV 計數時，key 尾端再接一個分鐘桶）。原因是一次正常的登入流程本身就會在同一分鐘內用掉 3 次敏感請求（先 lookup 探詢、再 lookup 帶密鑰、最後 create／join），若共用一個計數器，使用者只要 PIN 打錯一次要重試、或家中第二個人在同一個 NAT／IPv6 /64 之後接著設定，就會立刻收到 60 秒的 429。拆開之後這段流程是 lookup 桶 2 次、create／join 桶 1 次，重試不再互相排擠。分桶只改「記在哪個 key」，限額與嚴格程度完全不變（`rateLimitBucketFor()` 於 `worker/src/middleware/rateLimit.ts`）。攻擊者輪替來源前綴後，則由 per-userId 的驗證嘗試上限（每小時 10 次失敗，涵蓋同樣三個入口）接手擋下。注意這些限制在 `DEV_MODE=1` 的 Worker 上會被停用（見 `worker/DEPLOY.md`），因此 dev worker 不得存放真實資料
  - **最壞情況量化（圖形驗證的最短長度不足）**：以每小時 10 次的上限推算——6 位數 PIN（`^\d{6,12}$`，至少 10^6 種組合）需時以「年」為單位，實務上不可行；但圖形驗證目前允許的最短長度只有 4 個不重複節點，組合數僅 9×8×7×6 = **3,024 種**，全部試完約需 302 小時（約兩週），命中機率達 50% 只需約 151 小時（約 6 天）。這是「最短圖形長度」帶來的已知限制，不是實作缺陷；是否提高最短節點數屬產品決策，本次不更動 `isValidPattern`
  - **per-userId 速率限制以受害者的 userId 為 key**：加入家庭端點過去另設一個 `join` scope 的 per-userId 計數器，對**每一次**加入請求計數（不論呼叫方是否證明擁有該帳號），第三方只要知道受害者的 userId 就能打滿，讓受害者本人在該小時內重連時直接收到 `429 RATE_LIMITED`——由於加入是既有成員唯一的發 token 重連路徑，這等同把本人鎖在門外，違反 Auth Token 不變式。此「對每次請求計數」的計數器已**移除**。加入端點現在唯一的 per-userId 煞車是 `verify` 嘗試上限，它是「猜錯才計數」：在密鑰比對之後才查看，正確密鑰一律放行（帳號本人永遠通過，即使額度已被攻擊者打滿），被打滿只會擋住後續的錯誤**猜測**，因此不再是傷及帳號本人的可用性槓桿
  - **合法使用者的額度消耗：零**。一次完整登入流程（先 `/api/auth/lookup` 帶密鑰，再 create／join 帶同一組密鑰）雖然會通過閘門兩次，但兩次都比對成功，因此不消耗任何額度；就算此時該帳號的 `verify` 額度已被攻擊者打滿，本人依然通過。每小時 10 次的額度只會被「猜錯」吃掉
  - **沒有任何一道限制是硬上限**：每分鐘的限制（per-IP 三層，以及 per-userId 的 `bookshelf`／`borrow-*`）已改用 Cloudflare 原生 Rate Limiting binding，它在單一 Cloudflare 節點內計算、eventually consistent，官方明示 permissive by design。每小時的 per-userId 計數器與驗證嘗試上限則仍是 KV get-then-put、沒有序列化：同時併發送出的請求會讀到同一個計數值而全部放行，超額幅度取決於**攻擊者自己的併發數**，不是固定的 ~2 倍。兩條路徑都只對循序流量成立。要有硬上限必須改用 Durable Objects，屬另案決策，目前不在 backlog 內（`docs/project-plan.md` BE-4 只涵蓋「改用原生 binding」，已完成）；邊緣層則可用上方「運維層的補強」所述的 WAF Rate Limiting 規則
  - **公開的驗證方式查詢仍透露 `method`**：`GET /api/user/:id/verify` 不需登入，因為 PWA 登入頁／QR Code 加入與擴充功能的初次設定、重新驗證，都要先知道該不該向使用者要密鑰，才能呼叫閘門。手上有 Email 清單的第三方因此能算出 userId，查出某個帳號有沒有設定驗證、設的是哪一種（`method` 不是 `none`），速度只受公開端點的 per-IP 限制約束（每分鐘 10 次，`worker/src/middleware/rateLimit.ts` 的 `RATE_LIMIT_PUBLIC`）。帳號是否用過 PWA（`prompted`）則不再公開，改由只有本人能讀的 `GET /api/user/:id/verify/prompted` 回傳（#343）
- OTP 使用後立即刪除（一次性）。唯一例外是 `POST /api/auth/lookup`：該端點以 `consumeOtp: false` 呼叫閘門，比對成功也不刪除 OTP。因為用戶端的流程是「先 lookup 帶密鑰確認歸屬，再 create／join 帶**同一組**密鑰」，若在 lookup 就把一次性 OTP 用掉，第二個請求必然失敗且被計為一次驗證失敗，5 次就把使用者自己鎖住 15 分鐘。不刪除也不會放寬安全性：OTP 仍受自身 300 秒 TTL 約束，且呼叫方本來就已經持有它
- Token refresh 改為 protected route（需有效 Bearer token），防止 userId + familyId 直接取得新 token
- 預設不設定；首次 PWA 登入後提醒一次，之後不再提醒

#### KV Key 設計

| Key Pattern                                     | Value                                                                                                                                                                                                                                                                | TTL                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `verify:{userId}`                               | `{ method, hash, salt, prompted, secretUpdatedAt?, version?, pepperId? }`（`version` 缺或 1 = SHA-256，2 = HMAC-SHA256(pepper)，`pepperId` 為 pepper 的指紋）                                                                                                        | None                                                           |
| `verifyfail:{userId}:{caller}`                  | `{ failCount, lockedUntil, startedAt? }`                                                                                                                                                                                                                             | 900 秒                                                         |
| `otp:{userId}`                                  | `{ code, createdAt }`                                                                                                                                                                                                                                                | 300 秒                                                         |
| `qr:{token}`                                    | `{ userId, tokenHash? }`（一次性 QR Token，加入家庭時比對成功即刪除；`tokenHash` 為產生它的 auth token 的 `hashAuthToken`，`auth:{userId}` 清單上已沒有那把、或它的 `token:{hash}` 已不見時不略過驗證；#425 以前的值一律不略過）                                     | 300 秒                                                         |
| `auth:{userId}`                                 | `{ tokens: [{ hash, createdAt }], secretAt? }`（帳號的 token 清單，每裝置一把、最多 5 把；寫入者只有鑄造（`putAuthRecord`）與撤銷全部（`deleteAuthRecord`）；#425 以前的形狀 `{ token, createdAt, secretAt? }` 讀取時當作空清單（`secretAt` 保留），下次鑄造時改寫） | 無（離開、被移出、解散、刪除帳號時刪除）                       |
| `token:{hash}`                                  | `{ userId, createdAt, expiresAt }`（hash 為 `hashAuthToken(token)`，token 原文不存；`createdAt` 是絕對上限的起點，`expiresAt` 對應這次寫入的 TTL）                                                                                                                   | 滑動 90 天，自 `createdAt` 起最長 180 天（驗證碼帳號不設上限） |
| `tokenidx:{userId}:{hash}`                      | `"1"`（#431；每把 `token:{hash}` 一個，寫在它之前；撤銷全部時以 `kv.list` 列舉這個帳號的 token，每次最多 400 個；不備份）                                                                                                                                            | 跟著 `token:{hash}`（同一次寫入的 TTL）                        |
| `ratelimit:user:verify:{userId}:{bucket}`       | 該時段內針對此帳號的驗證嘗試次數（字串數字）                                                                                                                                                                                                                         | 7,200 秒                                                       |
| `ratelimit:user:verify-write:{userId}:{bucket}` | 該時段內此帳號的驗證相關寫入次數（上限 30，OTP／prompted／qr-token 三個端點合計）                                                                                                                                                                                    | 7,200 秒                                                       |
| `ratelimit:user:verify-set:{userId}:{bucket}`   | 該時段內此帳號變更驗證設定（`PUT /api/user/:id/verify`）的次數（上限 30；格式檢查、token 檢查與目前密鑰確認都通過後才計數）                                                                                                                                          | 7,200 秒                                                       |
| `ratelimit:sens:{ip}:{bucket}`                  | 該分鐘內來自此來源的建立／加入家庭次數（上限 3）。**僅在未設定原生 Rate Limiting binding 時才寫入**；正常部署下這個 key 不再產生                                                                                                                                     | 120 秒                                                         |
| `ratelimit:sens:lookup:{ip}:{bucket}`           | 該分鐘內來自此來源的查詢所屬家庭次數（上限 3，獨立）。同上，僅退回 KV 時才寫入                                                                                                                                                                                       | 120 秒                                                         |

#### API 端點

| Method | Path                            | 說明                                                                                                                                                                      | 權限 |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `GET`  | `/api/user/:id/verify`          | 查詢驗證方式（只回 `method`，不回 hash 與 `prompted`）                                                                                                                    | 公開 |
| `PUT`  | `/api/user/:id/verify`          | 設定/變更驗證方式（出示的 token 必須是帳號目前的 token；目前是 PIN／圖形時需帶 `currentSecret`）；設為 PIN／圖形時撤銷帳號全部 token，回應附新的 `authToken`／`expiresAt` | 本人 |
| `POST` | `/api/user/:id/verify/otp`      | 產生一次性驗證碼                                                                                                                                                          | 本人 |
| `GET`  | `/api/user/:id/verify/prompted` | 查詢是否已提醒過設定驗證                                                                                                                                                  | 本人 |
| `POST` | `/api/user/:id/verify/prompted` | 標記已提醒                                                                                                                                                                | 本人 |
| `POST` | `/api/user/:id/qr-token`        | 產生一次性 QR Token（PWA 掃碼加入家庭時可略過驗證，300 秒後失效）                                                                                                         | 本人 |

#### 忘記驗證方式時

驗證閘門不只擋手機：擴充功能初次設定與重新驗證（`extension/src/dialog/Onboarding.tsx`、`extension/src/dialog/ReauthModal.tsx`）走的是同一組建立／加入／查詢端點，同樣要求這組密鑰。忘記之後能不能自己解決，取決於還有沒有一台裝置握有有效的 auth token：

- **還記得目前的密鑰**（例如只是在手機上連續打錯而被鎖定）：在擴充功能設定（`VerificationSettings`）先輸入目前的 PIN／圖形，再重新設定驗證方式；`PUT /api/user/:id/verify` 會寫入新的 `secretUpdatedAt`，舊密鑰累積的鎖定隨之作廢。電腦與手機若在同一個對外 IP 之後，這次輸入目前密鑰的確認會與手機共用同一份鎖定（`verifyfail:{userId}:{IP}`），要等鎖定結束（15 分鐘）才能進行。設成 PIN／圖形時也會撤銷帳號全部的 token，只有這台電腦拿到新的，其他裝置（包括手機）要輸入新的密鑰才能繼續用；改成驗證碼或不驗證則不撤銷（見上方「設定新的 PIN／圖形會撤銷帳號的全部 token」）。PWA 只在帳號還沒被提示過（`GET /api/user/:id/verify/prompted` 回 `prompted: 0`）時顯示提示：帳號已是 PIN／圖形時，提示先問要不要改，要改就先輸入目前的密鑰再選新方式；之後 PWA 沒有修改驗證的入口。兩端的設定提示文字相同：要改成別的方式得先輸入目前的 PIN 碼或圖形。提示下方依採用中的伺服器位址分流：官方伺服器顯示「沒辦法完成驗證？填寫救援申請」（連到回報表單），自架伺服器顯示「忘記的話，請找伺服器管理者協助。」（即下方「目前的政策」），文案在 `shared/src/recovery/messages.ts`。
- **還有登入中的電腦，但忘了目前的 PIN／圖形**（#396 起）：無法自己重設。改驗證設定與刪除帳號都要先輸入目前的密鑰，握有 token 也一樣，因此與下一點「沒有任何裝置握有 token」走同一條路（見下方「目前的政策」）。這台電腦在 token 有效期間仍可照常使用，也還能產生 QR Code，讓手機略過驗證加入。
- **沒有任何裝置握有 token**（自己離開家庭、被移出都會撤銷該帳號全部裝置的 token；每台裝置的 token 各自計時，90 天沒有續期就會到期，PIN／圖形與不驗證的帳號另有自鑄造起 180 天的上限，驗證碼帳號沒有）：目前沒有自助救援路徑。閘門要密鑰、改密鑰要 token、發 token 要過閘門，`DELETE /api/user/:id` 也要 token（PIN／圖形帳號還要目前的密鑰）。刪除帳號不會造成這個狀態：它連驗證設定一起刪（#341），之後同一個 Email 重新開始時不需要密鑰。

**目前的政策（#342）**：沒有 token 時（#396 起，握有 token 但忘了目前密鑰時也一樣），Worker 無從分辨申請人是不是本人（見「威脅模型與已接受的風險姿態」→ 前提一），不另外證明身分的自助重設等於「知道 Email 就能拿掉驗證」，因此不提供。唯一的出口是 KV 管理者把 `verify:{userId}` 改寫成一組臨時 PIN（直接刪除會留下沒有驗證的空窗：知道 Email 與同步碼的家人可以搶先登入，在本人設定新的 PIN／圖形、由 `PUT /api/user/:id/verify` 撤銷對方的 token 之前（改成驗證碼不會撤銷；KV 傳播空窗內的撤銷也可能失效，見上方殘餘風險），都能讀取完整書單、修改開放設定；改寫成臨時 PIN 就沒有空窗）：自架伺服器由管理者自行判斷，步驟見 `worker/DEPLOY.md` → 使用者忘記登入驗證時；官方伺服器走人工流程：使用者從登入驗證畫面或設定頁的「填寫救援申請」進回報表單，管理者依同一份步驟處理，臨時 PIN 只回信到表單上的讀墨註冊 Email（收得到那個信箱的信，就是家人冒充不了的證明），伺服器本身仍不接觸明文 Email。Email 自動救援的評估保留在 `docs/verify-email-recovery-plan.md`，未採用。

### chrome.storage.sync 多裝置同步

**儲存於 `chrome.storage.sync` 的資料**：`familyId`（`displayName` 儲存時也會盡力寫一份到 `chrome.storage.sync`，但沒有任何地方從那裡讀回，所以不會帶到其他裝置）。

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

目前**沒有任何手動填入 Worker URL 的 UI**（Extension 與 PWA 皆然）。端點只透過下列兩條路徑改變：

| 入口                   | 適用範圍        | 說明                                                                       |
| ---------------------- | --------------- | -------------------------------------------------------------------------- |
| 同步碼 `@host`         | Extension / PWA | 貼上含 `@host` 的同步碼加入家庭時，一併切換至該端點                        |
| 家庭記錄 `apiEndpoint` | Extension       | 家庭管理者設定的端點；成員端**需經確認**才會套用（見下方「端點切換確認」） |

自建者目前的做法是 fork `worker/` 部署後，由第一位成員以自訂端點建立家庭，再用同步碼把其他成員帶進來。

### 端點切換確認

家庭記錄上的 `apiEndpoint` 由**家庭管理者**單方面決定，且會分送給所有成員。Worker 端只擋掉最廉價的內網位址形式（IPv4 私有網段、IPv6 literal，以及 `localhost` / `127.0.0.1` 以外的 HTTP），對「解析到內網的網域名稱」無能為力——這是刻意留下的缺口，由**用戶端確認**補上。

Extension 的行為：

- 成員端偵測到家庭記錄的端點與目前連線不同時，在「設定」分頁最上方顯示確認面板，列出「目前連線」與「將切換至」兩個位址，並說明切換後認證資訊與完整書單（含未開放的書籍）都會送往新伺服器。
- **兩個方向都要確認**：套用自訂端點、以及回復官方預設端點，都不會自動發生。
- 使用者選擇「暫不切換」時，該次拒絕的目標值會記在本機（`moo:declinedFamilyEndpoint`，僅 `storage.local`）；**唯有家庭記錄改成不同的值時才會再次詢問**，不會每次重新整理都打擾。
- 使用者選擇「確認切換」時，端點直接寫入 `storage.local`（並非只靠背景訊息，以免 Firefox 休眠中的事件頁遺失這次寫入），同時清除拒絕記錄。
- 若家庭記錄裡的值無法通過用戶端 URL 驗證（格式錯誤、帶有帳密、或非 HTTPS／私網 HTTP），確認面板**不會把該位址印出來**——印出來等於替一個偽造位址背書；面板改在「將切換至」的位置顯示警告文字，並提示向家庭管理者確認。按下「確認切換」仍然一律失敗（fail-closed）：端點維持不變，該值同時記為「已拒絕」以免每次重新整理都重複詢問，並在原面板位置顯示錯誤提示，不會讓使用者誤以為已經切換成功。
- **離開家庭時一併清除**：本機已保存的端點與「暫不切換」記錄都會在離開家庭（含刪除帳號）時清空，端點回到官方預設。端點是**家庭範圍**的設定，不應比成員資格活得久：已無家庭卻仍指向前一個家庭伺服器的裝置，下一次建立／加入會把登入憑證與完整書單（含未開放的書籍）送往該處，並把該位址烙進它接著發出的同步碼；殘留的拒絕記錄則會讓下一個家庭的確認提示被誤判為「已問過」而不再出現。
- **實作細節**（`extension/src/dialog/useEndpointSwitch.ts`，面板是 `EndpointSwitchPanel.tsx`）：
  - 家庭記錄的 `apiEndpoint` 是伺服器資料：不是字串或空白都視為「記錄沒有端點」（回復官方預設的方向），絕不當成要切換的目標。比較前先把它轉進 client 自己的比較空間（`ApiClient` 存的是 `validateEndpointUrl` 的回傳值），結尾斜線不會讓相同的端點看起來像要切換；驗不過的值原樣保留並標為無效，面板靠這個旗標不把它印出來。判斷結果裡的目標是正規化後的值，也就是確認／拒絕時保存的值，與同步碼加入路徑對同一個端點保存的值一致。
  - 每次掛載只讀一次拒絕記錄，讀到之前什麼都不問，曾經拒絕的值不會先閃出面板再被壓下。
  - 新的詢問會清掉過時的錯誤提示，但只在真的有新詢問時：失敗的確認會把目標記為已拒絕，這會以「沒有要問的」重新跑一次判斷，若無條件清除，提示會在使用者看到之前就被抹掉。
  - 同步碼、邀請與 QR Code 一律用**這台裝置實際採用**的端點產生（`FamilySettings.tsx`），不用家庭記錄的值：拒絕切換的成員不能再把他拒絕的端點散布出去（或掃進第二台裝置）。`apiClient.setEndpoint()` 改動 client 不會觸發 React 重新 render，所以採用中的端點以 state 呈現：初始值取自 client（啟動時已套用存好的端點），只在確認成功時更新，而且鏡射 client **實際**的值（含正規化）而不是要求的值；確認後不必重開，同步碼就反映切換結果。
- Extension 的這些讀寫集中在 `extension/src/storage/familyEndpointChoice.ts`（確認、拒絕、讀取、重設四種），全部直接存取 `storage.local`：確認時直接寫入（與背景的 `handleSetApiEndpoint` 寫法相同），之後的 `SET_API_ENDPOINT` 背景訊息只是盡力而為的第二條路徑；開啟 Dialog 時讀取已接受的端點（`readStoredApiEndpoint`）也直接讀，因為 `GET_API_ENDPOINT` 往返有同樣的 Firefox 失敗模式，會讓 Dialog 沒有任何提示就以預設端點啟動。直接存取的理由與 `extension/src/dialog/persistJoinCredentials.ts` 的 `persistJoinCredentials` 相同。

PWA **不會**自動套用家庭記錄的端點，也沒有這個確認面板——PWA 只認同步碼帶進來的端點。這是刻意的：少一條可被管理者操控的通道，攻擊面就小一分。

### 同步碼位址的驗證與揭露

同步碼的 `@host` 是另一條「別人給你的位址」通道，因此 Extension 與 PWA 共用同一套規則：

- **驗證邏輯只有一份**：`shared/src/api/endpointUrl.ts` 的 `validateEndpointUrl()` 同時被 Extension 與 PWA 的 API client 使用（各自 re-export），規則為「一律允許 HTTPS；HTTP 僅限 localhost／私有網段／`.local`；一律拒絕網址內嵌帳密（`https://real.example@evil.com` 這種會讓顯示字串與實際連線主機不一致的形式）」，回傳值正規化為 `origin + pathname`（去除結尾斜線、IDN 轉 punycode、收斂大小寫與預設埠）。兩端不得各留一份實作——規則不一致等於防護沒做。顯示側的分類同樣只有一份：`shared/src/api/syncCodeHost.ts` 的 `classifySyncCodeApiHost()` 把同一份驗證結果轉成三種可直接渲染的狀態（沒有自訂位址／可揭露的正規化位址／應顯示警告），因此同一組同步碼在 Extension 與 PWA 上看到的說明必然一致。
- **加入前先揭露**：兩端的加入畫面都會顯示同步碼將連往的位址，且顯示的是**正規化後的 `origin + pathname`**（不是單純的 host），所以 `http://` 的區網位址與同名的 `https://` 位址在畫面上分得出來，homograph 網域也會以 `xn--…` 現形。PWA 的驗證畫面（PIN／圖形／驗證碼）同樣會顯示，因為 QR Code／邀請連結進來的使用者從沒看過輸入表單；QR Code 自動加入還有兩條連驗證畫面都不會經過的零互動出口，另由下方「QR Code 自動加入的確認閘門」補上揭露。
- **驗不過就不揭露、也不連線**：位址無法通過驗證時，畫面顯示警告而非那句令人安心的「將連線至自訂伺服器」，加入動作直接中止並回報錯誤——不會發出任何請求到該位址（PWA 連查詢驗證方式的探詢請求都不會送出），也不會寫入本機設定。
- **警告等輸入靜止才顯示，正面揭露不延遲**：手打 `@host` 的過程中幾乎每個中間狀態都驗不過（`…@http://192.168.`；只是「幾乎」——URL 解析器會展開簡寫 IPv4，再多打一個字元的 `…@http://192.168.1` 會解析成主機 `192.168.0.1`，落在放行的私有網段內，反而驗得過），若每一次按鍵都閃一次警告，使用者很快就學會忽略它——而這正是對抗偽造位址的最後一道人工防線。因此**只有 `invalid` 的警告會等目前的值「靜止」才顯示**，`valid` 那句「將連線至自訂伺服器」是對當前值的正面資訊，一律即時。靜止有四個觸發點，任一成立即可：值維持不變達 `SYNC_CODE_HOST_SETTLE_DELAY_MS`（600 ms，定義於 `shared/src/api/syncCodeHost.ts`，是任何輸入方式都繞不過的安全網）、貼上、離開欄位或按下加入／送出、以及**首次渲染時就非空的值**（邀請連結／QR Code 帶進來，使用者從沒打過字，沒有可閃爍的輸入過程）。**不變量：等待期間該處一律什麼都不顯示（`kind: "none"`），絕不沿用上一次的判定**——把先前的「將連線至 api.example」留在畫面上，等於在使用者剛把 `@evil.com` 接到後面的那一刻替偽造位址背書；我們只延後警告，永遠不顯示與當前輸入矛盾的內容。可顯示什麼的政策（`displayedSyncCodeApiHost()`）與延遲常數同樣只有一份放在 `shared/`，兩端各自的 `useSyncCodeHostVerdict` hook 只負責觸發時機；兩份 hook 的一致性不靠註解自律，而是由 parity 測試（`extension/tests/unit/useSyncCodeHostVerdict.parity.test.ts` 與 PWA 對應的一份，兩個套件各有一份，只動單邊的 PR 也跑得到）把兩個檔案讀進來、正規化 import 路徑與空白後逐字比對，任一側新增、移除或改寫觸發點都會讓測試變紅。不過這道保護只涵蓋 hook 的檔案級一致性，不涵蓋呼叫端：觸發點 4（首次渲染就非空的值）有一半取決於呼叫端是否把值帶進第一次渲染（PWA 是 `pwa/src/hooks/useLandingFormFields.ts` 的 `useState(initialSyncCode)`，Extension 是由上層以 prop 傳入），單邊在這裡改壞時 parity 測試仍會是綠的。因此 Extension 與 PWA「同時示警」在 hook 層有測試釘住，呼叫端那一段則仍要靠審查把關。
- **QR Code 自動加入的確認閘門**：PWA 的 QR Code 自動加入原有兩條零互動出口——帶 QR 權杖時直接加入、以及帳號沒設驗證時探詢完直接加入——兩條都會在使用者毫無察覺的情況下採用同步碼帶來的位址並寫進本機。因此同步碼帶有 `@host` 時，PWA 會先停在確認畫面（`pwa/src/components/CustomHostConsent.tsx`，位址一律交給同一個 `SyncCodeHostNote` 呈現，與表單、驗證畫面同一份文案與同一份分類結果），使用者按下「確認並加入」之後才接上原本的出口邏輯。**確認之前不會發出任何請求**——連查詢驗證方式的探詢都不送，因為那個請求本身就會把裝置的 IP／UA 交給尚未經過同意的位址。按「取消」則落回手動輸入表單（同步碼已預填，表單上的揭露照常顯示），不寫入任何本機設定，語意與上一條的拒絕路徑一致。沒有 `@host` 的同步碼（官方預設端點）維持零互動，這是 PWA 的主要入門路徑；位址驗不過時仍走上一條的拒絕路徑，不會進到確認畫面——確認畫面只出現在「有效但陌生」的位址上，不替一個驗不過的位址提供任何「同意」的機會。同意結果**刻意不做持久化**（PWA 沒有 Extension `moo:declinedFamilyEndpoint` 的等價機制），每一次 QR Code 進來都重新詢問。
- **加入成功才保存**：`@host` 會立刻套用到記憶體中的用戶端（加入請求本來就得送往該處），但**唯有後端接受加入之後才寫入本機**。同步碼過期／輸入錯誤、或該伺服器刻意回覆「找不到家庭」時，用戶端還原成這次嘗試之前的端點，本機則自始沒有被寫入——一個什麼都沒證明的位址若留在裝置上，使用者接著按「建立家庭」就會把登入憑證與完整書單送往該處，並把它烙進之後發出的同步碼。唯一的例外是驗證挑戰：它是同一次嘗試的延續（要向同一台伺服器問驗證方式再重試），因此端點保留到該次嘗試真正結束（加入成功、失敗或使用者放棄）為止。Extension 的 `performJoin`（`extension/src/dialog/onboardingFlow.ts`）在加入成功後，經 `persistAcceptedFamilyEndpoint` 寫入——與「確認切換」同一個 helper：直接寫入 `storage.local`（以它為準），再送一則 best-effort 的 `SET_API_ENDPOINT` 背景訊息（Firefox 休眠中的事件頁可能遺失這則訊息，只靠它曾讓成員沒有任何提示就回到預設端點），並清除殘留的「暫不切換」記錄——透過帶 `@host` 的同步碼加入，本身就是明確選擇了這個端點。`performJoin` 失敗時刻意讓 `@host` 維持套用（驗證挑戰要向同一台伺服器查詢驗證方式再重試），交還端點是呼叫端 `handleJoin`（`extension/src/dialog/useOnboardingJoinFlow.ts`）的責任：每個沒有加入成功就結束嘗試的出口——一般失敗、放棄驗證挑戰、通過驗證後家庭仍拒絕、例外——都以 `restoreApiEndpoint` 把 client 放回嘗試前的端點，否則使用者接著按下的「建立家庭」會把 userId、它發出的 token 與完整書單送往那台拒絕過的伺服器。
- **本機既有值也會複檢**：PWA 從 `localStorage` 還原工作階段時會重新驗證存下來的 `apiHost`；舊版存下、如今已不被接受的位址會被視為沒有工作階段（要求重新輸入同步碼），而不是讓 `new ApiClient()` 拋錯把整個 App 打掛。
- **預設端點同樣走驗證**：`DEFAULT_API_ENDPOINT`（兩端的 `constants.ts`）在定義時就套用 `validateEndpointUrl()`，讓它與 `ApiClient.getEndpoint()` 落在同一個比較空間；建置時給了無效的環境變數會在載入當下直接拋錯，而不是等到第一次請求才以難以歸因的形式爆開。

### 限制

- 同一家庭的所有成員必須使用相同的 API 端點
- 同步碼中的 `@host` 段可解決此問題：發起者設定一次，受邀者在加入時跟隨（加入畫面會先顯示該位址；位址驗不過則中止加入，加入未成功則不保存）
- 管理者事後變更家庭端點時，成員端不會自動跟隨，必須各自確認
- 用戶端與 Worker 允許的位址範圍**刻意不同**：用戶端為了讓區網自架仍然可用，放行整個私有網段（含 `*.local`）的 HTTP，HTTPS 下也不對 IP literal 做分類；Worker 則為了避免管理者把其他成員的用戶端指向他們自己的內網，擋掉全部私有 IPv4 網段（10/8、172.16/12、192.168/16、169.254/16、127/8、0/8，僅保留 `127.0.0.1`）與所有 IPv6 literal，HTTP 只放行 `localhost` 與 `127.0.0.1`
- 因此區網位址**可以被用戶端套用（同步碼 `@host`），卻永遠寫不進家庭記錄**——`PUT /api/family/:id/endpoint` 一律回 400，而建立家庭時那次寫入是 fire-and-forget，失敗不會有任何提示；家庭記錄就此長期停在「沒有端點」，確認面板把它讀成「回復官方預設」的方向，對每台裝置各問一次（拒絕會被記住，是一次提示而非重複迴圈），選「暫不切換」即可，區網自架本身並沒有壞掉（面板在這個方向的標題寫「家庭未指定 API 端點」而非宣稱端點已變更，正是為了這個情形）
- 想完全避開這個提示，請讓自建 Worker 使用公開的 HTTPS 網域：這類位址 Worker 會接受並寫入家庭記錄，家庭記錄驅動的端點流程對每位成員都能正常運作

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
│  ✅ 家庭書櫃瀏覽    │    │  ✅ 加入家庭        │
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
  產生 QR Code，內容為 PWA URL，認證資料一律放在 fragment（#）：
  https://pwa.example.com/#code={syncCode}&uid={userId}[&qrt={qrToken}]
  syncCode 即 moo-{familyId}，自訂端點時為 moo-{familyId}@{host}
  （各參數值以 encodeURIComponent 編碼，故 @ 會以 %40 出現）
       ↓
  手機掃碼 → PWA 自動解析 → 儲存至 localStorage → 完成
```

- 參數只有三個（`extension/src/constants.ts` 的 `buildPwaUrl()` 組裝、`pwa/src/utils/authUrlParams.ts` 的 `tryParseQrParams()` 解析）：`code`（同步碼；`@host` 是**同步碼本身的一部分**，不是獨立參數）、`uid`（Extension 已算好的 userId）、`qrt`（一次性 QR 權杖，可選；有效時可略過 PIN／圖形／驗證碼挑戰）
- **用 fragment 而不是 query string 是刻意的**：`#` 之後的內容不會送到伺服器，同步碼與 userId 因此不會進入伺服器 access log 與 referrer header。寫成 query param 會讓這個保證整個失效
- 零手動輸入、UX 最佳——**前提是同步碼指向官方預設端點**（沒有 `@host`），這也是絕大多數使用者走的路徑
- 同步碼帶自訂 `@host` 時多一次確認：PWA 會先停在確認畫面揭露該伺服器位址，按下「確認並加入」之後才接回上述自動流程（按「取消」則落回手動輸入表單）。詳見上方〈同步碼位址的驗證與揭露〉的「QR Code 自動加入的確認閘門」
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

| 功能         | PWA 支援 | 備註                            |
| ------------ | -------- | ------------------------------- |
| 瀏覽家庭書櫃 | ✅       | 核心功能                        |
| 個人書櫃開關 | ✅       | 書籍須先由 Extension 同步過一次 |
| 加入家庭     | ✅       |                                 |
| 建立家庭     | ❌       | 需使用 Extension                |
| 新增書籍     | ❌       | 無法爬取讀墨頁面                |
| 借閱功能     | ✅       | 發送/接收借閱請求，v1.1.0 起    |

### PWA 特有限制

- 無法直接爬取讀墨網頁書單（沒有 Content Script 權限）
- 個人書櫃管理依賴 Extension 端先同步書單至伺服器
- PWA 可修改已同步書籍的開放/關閉狀態，但無法新增伺服器上沒有的書

### PWA 部署

- 部署於 Cloudflare Pages（與 Worker 同帳號，零額外成本）
- 或任何靜態網站託管服務（Vercel、Netlify 等）

### PWA 用戶端的設計理由

`pwa/src/` 的程式碼註解最多兩行，較長的設計理由集中在下列各小節，註解以「`docs/architecture.md → <小節名稱>`」指回這裡。Extension 與 PWA 必須保持一致的成對檔案，以及刻意不一致之處，列在 `.claude/rules/frontend.md` → Extension ↔ PWA twins。

#### 背景自動復原的防護

背景自動復原指 401 時的 token refresher（`pwa/src/hooks/useRecoveryJoin.ts` 回傳、`pwa/src/App.tsx` 命名為 `acquireNewToken` 的函式）在背景帶 `recovery: 1` 重新加入家庭。要不要送出由 `pwa/src/hooks/recoveryJoinGate.ts` 判斷：429 冷卻中、使用者自己的離開／刪除帳號請求仍在進行、或工作階段已結束時都不送。

- **429 冷卻**（`pwa/src/utils/recoveryCooldown.ts`，對應 Extension `extension/src/api/recoveryCooldown.ts` 的冷卻函式；Extension 存在 `browser.storage.local`，PWA 只在瀏覽器執行，等價的儲存是 `localStorage`）：
  - key `moo:recoveryCooldownUntil` 是全域的、不分使用者：它節流的是 Worker 的 per-IP 敏感端點額度（每分鐘 3 次），同一台裝置上所有帳號共用這份額度。
  - 只有自動復原會查看冷卻；使用者手動發起的加入絕不能被它擋下。手動加入成功（`App.tsx` 傳給 `LandingPage` 的 `onAuth`）會清除殘留的冷卻：這次成功證明憑證可用，下一次背景復原不該被舊冷卻擋住（與 Extension `extension/src/dialog/useReauth.ts` 相同）。
  - 每次存取都包在 try/catch：storage 拋錯（私密模式、配額）一律當作「沒有冷卻」，而不是讓整個 App 掛掉。
- **自己的離開請求進行中**（#263，`pwa/src/utils/selfDeparture.ts`，對應 `extension/src/storage/selfDeparture.ts`）：伺服器可能在回覆使用者自己的「離開家庭」或「刪除帳號」請求之前就撤銷 token，這段期間他的其他請求可能拿到 401，背景自動復原就會把他加回正在離開的家庭。`useLeaveFamily`／`useDeleteAccount` 透過 `runGuardedDeparture` 送出請求，在請求結束前持有標記，期間不送自動復原。
  - 標記存在 `localStorage`（`moo:selfDepartureUntil`），PWA 的每個分頁都看得到。值是到期時間（epoch ms）而不是旗標：請求途中分頁被關掉，最多擋住復原 `SELF_DEPARTURE_TTL_MS`（60 秒）。
  - 每次存取都像 `recoveryCooldown.ts` 一樣包住：寫入被拒只失去這道保護、不影響離開本身；讀不到時視為「沒有在離開」，讓復原照常運作。
- **強制重新驗證標記**（#266，`pwa/src/utils/reauthPending.ts`）：規則見〈家庭解綁流程〉的「PWA 的重新驗證標記」。實作補充：
  - 只有 `acquireNewToken` 的驗證分支會寫入，而且寫在該分支的 `logout()` 之後；`clearStorage` 不動這個 key，所以標記在登出後仍在。讀取只在 `completeJoin`（`pwa/src/hooks/useLandingCompleteJoin.ts`）。
  - 清空整個 key 的 `clearReauthPending` 放在不含任何 import 的 `pwa/src/utils/reauthPendingKey.ts`（由 `reauthPending.ts` 再匯出），`useAuth.ts` 的 `forceClearStorage` 才能呼叫它而不牽連 `constants.ts`（見 `.claude/rules/frontend.md` → PWA import chain）。
  - 為什麼只存截短的摘要：完整摘要也藏不住原值——familyId 只有約 2.8e12 種可能、預設伺服器位址是公開的、userId 又出現在其他 key 的名稱裡，可以離線暴力反推。摘要的輸入經過 `sha256Hex`，它會轉成小寫，對相等比較無害。伺服器位址照 `ApiClient` 的解析方式正規化（缺省 → `DEFAULT_API_ENDPOINT`），所以預設位址或結尾斜線的差異不會讓比對落空。
  - 每次存取都像 `recoveryCooldown.ts` 一樣包住：讀不到當作「沒有標記」（一般加入），寫入被拒只失去這道保護。讀—改—寫跨分頁不是原子操作，刻意不上鎖：遺失一次更新最多少一個標記（變成一般加入），不會把人鎖在外面。
- **加入失敗的說明文案**（`pwa/src/utils/joinErrorMessages.ts`）：這些失敗必須向使用者說明原因，不能把人丟回一個什麼都沒說的登入表單。背景復原（`acquireNewToken`）與登入頁的手動加入（`completeJoin`）兩條路徑都會碰到，所以共用同一份文案，措辭不會分歧。
- **Extension 的「自己的離開請求進行中」標記**（`extension/src/storage/selfDeparture.ts`，#263）：本機的 familyId 要等「離開家庭」／「刪除帳號」的回應回來才清除，伺服器卻可能先撤銷 token，這段期間別的請求拿到 401 時，背景加入（`extension/src/api/auth-refresh.ts` 的 `attemptJoinRecovery`）就會把使用者加回正在離開的家庭。`extension/src/dialog/useFamilySettingsLeave.ts`／`useFamilySettingsDelete.ts` 透過 `runGuardedDeparture` 送出請求，請求結束前持有標記，`doRefreshToken` 在標記有效時跳過加入。標記直接讀寫 `browser.storage.local`，絕不經背景訊息（Firefox 休眠中的事件頁可能遺失訊息），所以擴充功能的每個 context（包括每個分頁的 Dialog）都看得到。值是到期時間（epoch ms）而不是旗標，與 PWA 相同：請求途中 context 結束，最多擋住復原 `SELF_DEPARTURE_TTL_MS`（60 秒）。失敗時往不擋住使用者的方向吞掉：寫入被拒只失去這道保護、不影響離開本身；讀不到時視為「沒有在離開」，復原照常運作。

#### PWA 主動續期

token 有效 90 天（`worker/src/kv/schema.ts` 的 `TOKEN_TTL_SECONDS`）；PIN／圖形與不驗證的帳號另有自鑄造起 180 天的絕對上限（`TOKEN_MAX_AGE_SECONDS`，#425），接近上限時 refresh 回的 `expiresAt` 會少於現在 + 90 天，到了上限 refresh 回 `401 REFRESH_FAILED`，token 到期後由下一個一般請求的 401 走背景自動復原（設有登入驗證的帳號會被要求重新驗證）。#364 之前 PWA 只在收到 401 時走背景自動復原，設有登入驗證的帳號在那條路上會被驗證閘門擋下、只能登出重新驗證；所以 PWA 改成在 token 到期前先用 `POST /api/auth/refresh` 延長它（`pwa/src/hooks/useProactiveTokenRefresh.ts`）。這個端點只延長送出的那顆 token 的期限，回傳的 `token` 就是送出的那顆（伺服器上沒有該帳號的 token 清單時例外，會回一把新的；見「PWA 登入驗證機制」→ `POST /api/auth/refresh` 只續期出示的那把 token），不需要驗證密鑰。

- **觸發時機**：工作階段開始時（有 auth 的 mount，或換成另一個 userId／familyId／伺服器位址），以及 `visibilitychange` 變成 `visible` 時檢查一次；兩者都要求當下 `document.visibilityState === "visible"`，分頁還原或背景啟動時延到第一次切回前景。沒有計時器，背景分頁不送任何請求。
- **門檻 30 天**（`PROACTIVE_REFRESH_THRESHOLD_MS`）：剩不到 30 天才送。PWA 只在使用者打開或切回時檢查，門檻要大到「隔幾週才開一次」也來得及續期。
- **沒有到期時間就續一次**：到期時間存在 `namespacedKey(userId, "tokenExpiresAt")`（`pwa/src/hooks/authStorage.ts`），讀到缺少或格式不對都當作沒有。#364 之前存下的工作階段全都沒有這個值，跳過等於這次修正對既有使用者無效，所以直接送一次 refresh，從回應取得到期時間。背景自動復原與登入頁的加入成功時存下回應的 `expiresAt`；PIN／圖形變更換 token（#378）時 `useRotatedTokenPersistence` 會刪掉這個值（新 token 的到期時間沒有往上傳），代價是換完後下次檢查多送一次 refresh。
- **401 不先試 refresh**：refresh 需要有效的 Bearer，401 代表 token 已經失效，先試只會多一個必敗的請求；401 照舊直接走背景自動復原，它就是續期沒趕上時的退路。
- **不送的情況**：沒有 token（交給 `useAutoAcquireToken`）、使用者自己的離開／刪除帳號請求進行中（`isSelfDepartureActive`）、工作階段已結束（`isLiveSession`，`localStorage` 拋錯當作已結束）。刻意不看 429 冷卻：refresh 不在 per-IP 敏感額度裡，冷卻只該擋加入。同一個分頁進行中的 refresh 不會再送第二次；換工作階段時這個進行中標記會被清掉，新工作階段的檢查不會被舊請求擋住。
- **臨時 client，沒有 refresher**：比照背景自動復原另建 `new ApiClient(current.apiHost)` 並設上目前的 token，不用工作階段的 client。這個 client 沒掛 `tokenRefresher`，refresh 的 401 不可能觸發背景加入、花掉加入額度；`refreshAuthToken` 本身也以 `isRetry = true` 送出，作為第二道保險。
- **失敗什麼都不改**：401、429、5xx、網路錯誤、`INVALID_RESPONSE`，以及建立 client 或檢查 userId 時拋出的例外，都保留工作階段、不登出、不加入、不清 token，也不改到期時間。下一個一般請求若收到 401 會走既有的背景自動復原，下次切回前景會再試一次。
- **只在同一顆 token 上寫入**：回應回來時，工作階段必須仍是送出時那一個（#258），而且目前的 token 仍是送出的那顆；途中 PIN／圖形變更或背景復原已經換了 token 時，舊回應不得蓋掉新 token。這兩項比的是本分頁記憶體裡的工作階段（`localStorage` 只看 userId），所以寫入前還要確認 `localStorage` 裡存的 userId／familyId／伺服器位址／token 仍與送出時相同（`authStorage.ts` 的 `persistedSessionMatches`，讀取拋錯當作不同）：另一個分頁換了 PIN／圖形（#378 會換 token）、換了家庭或伺服器位址時，較早送出的 refresh 回應不會把那些較新的值蓋回舊的。寫入時先刪掉舊的 `expiresAt`，回應的到期時間格式正確才寫回，不沿用舊值。
- **effect 只依賴工作階段身分**：依賴是 userId、familyId、伺服器位址（加上參照不變的 `authRef` 與 `login`），不含 token 與到期時間。伺服器若回傳仍不足 30 天的期限（自架伺服器、裝置時間偏差），依賴它們會讓「續期 → `login` → effect 重跑 → 再續期」變成無限迴圈；現在同一個工作階段只在切回前景時重查。
- **與 Extension 刻意分歧的三點**（`extension/src/dialog/useTokenRefresh.ts` 與 `extension/src/api/client.ts` 的 `proactiveRefresh`）：門檻 30 天對 5 分鐘（Extension 在 Dialog 開著時有計時器）；沒有到期時間時 PWA 續一次、Extension 跳過；refresh 失敗時 PWA 什麼都不做，Extension 清掉 token、走分段復原加入（PWA 的 401 路徑已經在做同一件事，主動續期失敗不該再花加入額度）。列在 `.claude/rules/frontend.md` → Extension ↔ PWA twins。
- **已接受的殘餘風險**：手機時間被調到未來時，每次打開或切回都會判定快到期而送一次 refresh。次數受使用者操作次數限制，不會自己重複；多個分頁同時續期最多多送一次，伺服器端的續期本身可重複執行。
- **成本**：活躍使用者約每 60 天一次 refresh；既有工作階段多一次；每次換 PIN／圖形多一次；沒有輪詢。

#### 登入頁的加入流程

- **狀態型別**（`pwa/src/hooks/joinState.ts`）放在 hooks 旁邊而不是頁面裡：頁面 import 這些 hooks，依賴只能單向。
- **唯一入口**：`completeJoin`（`pwa/src/hooks/useLandingCompleteJoin.ts`）是表單、驗證畫面與 QR 三條路徑共用的加入入口。用戶端會拒絕的位址在這裡被擋下，拿不到任何請求、token 或 `localStorage` 項目。
- **`joinOrigin`**：進行中的嘗試沿用它開始時的來源（QR 路徑會先設成 `"qr"` 再呼叫進來）；從驗證畫面新開始的嘗試是使用者觸發的，算作表單。成功的出口刻意不清除它：上層會在 `onAuth` 時把整個頁面換掉，在那之前「處理中」才是誠實的畫面；所有留在本頁的出口都會清除它。
- **QR 路徑**（`pwa/src/hooks/useQrJoin.ts`）：
  - `startQrJoin` 由官方預設端點的快速路徑與自訂位址的同意處理共用，分支邏輯只有一份——兩者只差在「何時可以開始」，做的事完全相同。帶 QR 權杖時略過驗證、直接把權杖送去加入；伺服器拒絕（過期或無效）時回 `VERIFICATION_REQUIRED`／`VERIFICATION_FAILED`，由 `completeJoin` 退回一般驗證畫面。
  - `completeJoin` 整個函式包在 try/catch 並自行回報失敗，從不 reject，所以兩個呼叫處都刻意不接 `.catch`（接了也是死碼）。
  - 查詢驗證方式的探詢是送往這個位址的第一個請求，所以 `startQrJoin` 自己也套用 `completeJoin` 那道位址拒絕：這是它本身的不變量，不仰賴呼叫端剛好守住。
  - 同意畫面按「取消」會落回手動表單：同步碼保留在欄位裡（表單自己的 `SyncCodeHostNote` 繼續顯示位址），使用者可以修改或直接離開，與驗不過位址的拒絕路徑同一形狀。`qrTriggered` 已經鎖住，effect 不會在這個決定之後重新觸發。
- **畫面順序**（`pwa/src/pages/LandingPage.tsx`）：
  - 同意畫面排在驗證畫面之前：同意解鎖的正是可能引發驗證挑戰的那個請求，兩者不可能同時合法地等待中。
  - QR 的全頁「處理中...」畫面排在 `pendingAuth` 之後：加入途中出現的驗證挑戰必須留在畫面上。QR 進來的使用者會被自動推過表單，加入進行時沒有送出按鈕可以顯示「處理中...」；這時若顯示表單，等於要剛掃完碼（或剛按下「確認並加入」）的人輸入 Email，所以改由整個畫面擔任進度提示。
- **`CustomHostConsent.tsx`**：同意閘門本身見〈同步碼位址的驗證與揭露〉的「QR Code 自動加入的確認閘門」。元件只負責呈現，何時掛載、兩個答案各做什麼都由呼叫端決定；呼叫端只為 `valid` 判定掛載它，`invalid` 在上游就被直接拒絕，永遠不會出現在請使用者同意的畫面上。位址交給表單與驗證畫面共用的 `SyncCodeHostNote` 呈現（揭露的值與用戶端實際連線的位址只有一個來源），並使用 `variant="verify"`：QR 進來的人從沒輸入過同步碼，畫面上也沒有，`join` 的引導語會指向使用者看不到的東西。
- **`SyncCodeHostNote.tsx`**：只負責呈現，判定從哪裡來由呼叫端決定（表單是輸入中的同步碼，驗證畫面是 `pendingAuth.apiHost`），所以同一個元件涵蓋自己輸入同步碼與邀請連結／QR（使用者從沒打過位址）兩條路徑。`variant` 只改變 valid 分支的引導語，規則見〈共用文案的產品語意〉；`onboarding` 目前只有 Extension 的引導畫面使用，PWA 還沒有對應的畫面。Extension 的對應元件（`extension/src/dialog/SyncCodeHostNote.tsx`）同樣只負責呈現：加入畫面用輸入中的同步碼；驗證挑戰、重新驗證視窗與引導畫面容器的提示用 client 已採用的端點（見〈揭露採用中的伺服器位址〉）——這些畫面上沒有同步碼，使用者卻即將把密鑰（或整個家庭設定）交給那台伺服器。三種結果：預設端點或還不是有效的同步碼時什麼都不顯示；會被採用的 `@host` 顯示正規化端點（`origin + pathname`：homograph 顯示成 `xn--…`、內嵌帳密的網址無法偽裝、HTTP 區網位址與同名的 HTTPS 位址分得出來）；採用時會被拒絕的 `@host` 顯示警告而不是那句令人安心的說明。警告不分 variant；採用的端點已通過同一套驗證，所以 `verify`／`onboarding` 的呼叫端實際上到不了警告分支。兩端所有文字都 import 自 `shared/src/hostNote/messages.ts`——讓兩端逐字相同的是這個模組，不是註解。

#### API client 的回應處理

`pwa/src/api/client.ts`（`unwrap`／`unwrapVoid`／`sanitizeEnvelope`／`throwOnError` 在 `pwa/src/api/envelopeHelpers.ts`）：

- **沒有 body 的成功**：`DELETE /api/user/:id/public-shelf/:shelfId` 是這個 API 唯一不帶 body 的回應（204，RFC 9110 §15.3.5）。`response.json()` 遇到空 body 會拋 SyntaxError，呼叫端分不出它和真正的網路失敗——被拒的撤銷曾經因此被讀成「已刪除」。所以 `readEnvelope` 把 204 解析成空信封（它只有一份，在 `shared/src/api/readEnvelope.ts`，兩端 client 都 import 它），其他回應照舊解析（格式錯誤的仍會拋錯）。只放行這一個狀態碼：API 從不回 205，放寬只會讓惡意後端可以把空 body 讀成確認成功；304 屬於 `!response.ok`，本來就走錯誤路徑。`unwrapVoid` 不要求 `data`，否則每個成功的 204 都會變成假的 `EMPTY_RESPONSE`。
- **`throwOnError` 是所有 `ApiError` 的唯一出口**，錯誤文字在這裡統一處理，而不是在每個呼叫處各做一次。`code`／`message` 宣告為 `string`，實際上來自 `response.json()` 的直接轉型，後端又可以自架。`JSON.parse` 真的能產生 `{"toString":null,"valueOf":null}` 這種值，它會讓建構子的 ``super(`${code}: ${message}`)`` 拋出 TypeError，`ApiError` 根本建不起來：`err instanceof ApiError` 變成 false，需要 `code` 與 `retryAfter` 的在地化 429 退避分支被跳過，畫面改顯示英文的 TypeError。處理這兩個會被插入字串的欄位，保住的是錯誤的身分，而不只是措辭。`retryAfter` 原樣傳入，建構子自己會檢查。
- **`getPublicShelf`**（實作在 `pwa/src/api/publicShelfFetch.ts` 的 `fetchPublicShelf`）不經 `readEnvelope`，自己直接轉型回應：
  - 錯誤欄位同樣先處理再插入字串，否則惡意的 `{"toString":null}` 會讓 `new Error(...)` 在掛上 `status` 之前就拋錯；`PublicShelfPage` 依 `status` 分流，404 就會失去「此公開書櫃不存在或已過期」畫面，落到一般的載入錯誤。
  - 成功的 `data` 只靠文字層這一道防護：`PublicShelfPage` 把 `title`／`book.title`／`book.author` 直接放進 JSX，搜尋時還會對它們呼叫 `.toLowerCase()`。
- **成員清單、家庭書櫃、個人書單、驗證方式、借閱清單先以 `unknown` 讀入**：結構檢查之前，線上的形狀只是後端的聲稱。成員清單、家庭書櫃、個人書單與驗證方式整個信封一起檢查（呼叫端自己讀 `{ data, error }`，`error` 必須原樣送到），兩層的順序與理由見〈伺服器回傳資料的檢查〉。驗證方式（兩端的 `getVerifyMethod`）檢查不過時回傳 `INVALID_RESPONSE` 錯誤信封，不拋錯：五個呼叫端（Extension 兩個、PWA 三個）都只讀信封的 `data`，讀到缺少就走各自既有的「沒有方法」分支。借閱清單先跑 `unwrap`——它負責信封契約（`error` 拋 `ApiError`、缺 `data` 拋 `EMPTY_RESPONSE`）——再交給 `sanitizeBorrowRequests`。
- **`createFamily`／`joinFamily`**（兩端）：回應裡格式不對的 `authToken`／`expiresAt` 在 client 就拿掉，呼叫端讀到的是「伺服器沒發 token」，見〈伺服器回傳資料的檢查〉的「token 與到期時間」。
- **`lookupUser`**：PWA 目前沒有使用（登入走同步碼），保留是為了與 Extension client 的契約一致，兩者才不會分歧。帶不帶 `verifySecret` 的回應差異見〈PWA 登入驗證機制〉。
- **Extension 的 `extension/src/api/client.ts`**：`readEnvelope`（只放行 204，與 PWA 共用 `shared/src/api/readEnvelope.ts` 這一份）、`unwrapVoid`、`throwOnError` 與上面的規則相同。差別在 `throwOnError` 另外把 `isClientSynthesized` 套在**原始**的錯誤物件上，而不是處理過的文字：symbol 標記本身就是來源證明，不能從處理過的文字推斷（見〈伺服器回傳資料的檢查〉的「錯誤物件」）。
- **`updateMemberSettings`**（Extension 與 PWA 相同）：回應先以 `unknown` 讀入，`unwrap` 先跑（負責信封契約），再交給 `sanitizeFamilyMember` 做結構檢查，最後是文字層（與 `getFamilyMembers` 同順序）。結構檢查不過時拋出 `INVALID_RESPONSE`，這對每個呼叫端都安全：Extension 的三個呼叫處（`extension/src/dialog/BorrowTab.tsx` 的借出對象寫回、`extension/src/dialog/MemberList.tsx` 的 canLend 開關與刪除 readmooName）都會接住，交給 `memberSettingsErrorMessage`，格式錯誤的回應因此顯示成可重試的錯誤，而不會汙染 `members` 狀態。PWA 唯一的呼叫處（`pwa/src/components/MemberList.tsx` 的 canLend 開關）同樣接住並交給 `memberSettingsErrorMessage`；它不使用回傳的成員，成功後重新讀取成員清單。

#### 公開書櫃設定的寫入

`pwa/src/hooks/usePublicShelfActions.ts`（對應 `extension/src/dialog/usePublicShelfActions.ts`）：

- **排隊與傳送中是兩個獨立狀態**（`titleQueued`、`inFlight`）：一個布林無法同時表示兩者。過去在到期設定寫入結束時清掉那個布林，會把仍在排隊的標題修改標成「未儲存」（還會引來一次經「重試儲存」的重複 PUT）。
- **`activeShelfIdRef` 在 commit 時才更新**（passive effect），所以它的意思是「畫面目前綁定的 shelfId」。代價：在 commit 與 effect 執行之間送出的寫入會被無聲丟棄——不到一個 frame，真實操作碰不到，因此接受而不修。不要在 render 期間寫這個 ref：被捨棄的 concurrent render 會留下沒有 commit 的 shelfId。
- **書櫃已撤銷的寫入**：寫入還在 debounce 佇列裡時書櫃就被撤銷，那個 shelfId 已經不存在，送出只會在使用者剛確認撤銷後立刻顯示紅色的 `SHELF_NOT_FOUND`，所以直接放棄。重設網址會保留 shelfId，合法排隊中的標題寫入仍會送出。寫入途中書櫃被撤銷的，失敗也不回報（已經沒有欄位需要對齊，使用者剛確認了撤銷）；只是被後來的寫入取代的，失敗仍會回報，因為它自己的欄位可能仍不一致。

#### 移除成員與離開家庭的重試

兩者都把特定的 404 當成「已經完成」，Extension 對應的處理必須保持相同（`.claude/rules/frontend.md` → Extension ↔ PWA twins）：

- **自己離開**（`pwa/src/hooks/useLeaveFamily.ts` 的 `settleLeave`）：`MEMBER_NOT_FOUND` 只可能代表「已經不是成員」——先前一次離開在伺服器端只完成一半（名單已更新、撤銷 token 失敗），這次重試把它做完了。所以當作成功：顯示錯誤並保留工作階段，會讓下一個請求的自動復原把使用者加回他剛離開的家庭。`FAMILY_NOT_FOUND` 是同一個結果：家庭紀錄已經不在，沒有東西可以離開——唯一 Owner 解散時在刪掉紀錄之後失敗（之後的重試都會回這個 404），或家庭在這段期間被解散——保留工作階段只會把使用者困在一個不存在的家庭裡。
- **Owner 移除他人**（`pwa/src/components/MemberList.tsx` 的移除分支）：`MEMBER_NOT_FOUND` 只可能代表「已經不在名單上」——先前一次移除在伺服器端只完成一半（名單已更新、撤銷 token 失敗），或對方自己離開了；Worker 的 404 分支這時已重新嘗試寫入重新加入限制，並清掉殘留的歸屬紀錄與 token。所以當作移除完成：顯示錯誤並略過重新整理，會讓被移除的成員一直留在畫面上，直到下次載入名單。

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

- Build script 是 `extension/scripts/sync-version.ts`，`pnpm build` 與 `pnpm build:dev` 的第一步都會執行：把 `package.json` 的 `version` 寫進 `extension/public/manifest.json`，版本已相同時不改檔。
- Firefox 版的 manifest（`build-firefox-manifest.ts`）與自行散布版的更新檔 `updates.json`（`build-updates-json.ts`）也直接讀 `extension/package.json` 的版本，不經過 Chrome 的 manifest，所以 Firefox 版號不會跟著分歧（見〈十三、建置與驗證腳本（extension/scripts）〉）。
- 發版時 CD 的 `release-extension-firefox` job 會先確認 git tag 與 `extension/package.json` 的版本一致，不一致就在任何 AMO 簽署之前失敗。

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
│  publicshelves:{id}          │
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
// publicshelves:{userId} — 公開書櫃清單（現行連結的唯一來源）
interface PublicShelvesRecord {
  shelves: PublicShelf[]; // v1.2.0 強制 length <= 1
}

// user:{userId} 的 publicSharing 為舊版位置，僅供尚未搬遷者讀取時 fallback
interface UserBooksRecord {
  // ... 既有欄位
  publicSharing?: {
    shelves: PublicShelf[];
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
- **清單來源獨立**：公開書櫃清單存放於 `publicshelves:{userId}`，只有公開書櫃的四個寫入端點（建立／更新／重設網址／刪除）會寫入；書單儲存（`PUT`/`PATCH /books`）與家庭偏好設定只讀不寫。原因：`user:{userId}` 是整份覆寫且無 CAS 的記錄，而 KV 跨節點讀取最多可能延遲約 60 秒，清單若放在其中，另一台裝置的書單同步就可能把已撤銷的連結寫回、並重新產生剛被刪除的快照。搬遷採懶惰式：`publicshelves:{userId}` 不存在時讀取端 fallback 到舊欄位 `user:{userId}.publicSharing`，並由下一次公開書櫃寫入動作建立新 key（非空與空清單皆以新 key 為準）；搬遷後舊欄位在下次書單儲存時自然消失
- **過期管理**：7 / 30 / 60 / 90 天 / 永久（預設 30 天），透過 KV TTL 自動清理。建立時 `expiresAt = createdAt + expiresDays`；更新 `expiresDays` 時重算為 `更新時間 + expiresDays`（從更新時起算）。讀取端另有兩道保險：設有到期日的快照即使因異常未被 TTL 清除，逾期讀取一律回 404；接著**所有快照**（不分是否永久）都會比對 `publicshelves:{userId}` 中該書櫃的現行 token 與到期時間：token 不符（已輪換、書櫃已刪、帳號已刪、或被延遲的書單同步「復活」）即回 404；到期時間則採單向比對——快照比書櫃現行設定**更晚**到期（含書櫃已改為有到期日、快照卻仍為永久）視為失效回 404，**更早**到期則仍可讀，並於快照自身的到期時間失效（使用者剛延長期限、而快照是以尚未更新的清單寫成時，延長不會反而讓連結先斷）—— 孤兒與被復活的快照因此皆不可讀。此檢查不會刪除或改寫任何書櫃資料（每次有效讀取多一次 `publicshelves:{userId}` 讀取；尚未搬遷者才會再多讀一次完整的 `user:{userId}` 書單記錄；請求管線的 per-IP 限流計數器本就每請求固定寫一筆，不因此改變）。KV 為最終一致，重設網址後尚未取得新清單的節點，最多約 60 秒內可能仍對新連結回 404（fail-closed，自癒；此窗口現在也適用於有到期日的書櫃）
- **重設網址**：產生新 UUID token，舊 token 立即失效；shelfId 維持不變（區隔內部識別與對外連結）。即使最後清理舊快照的刪除步驟異常失敗，舊 token 也會因讀取端比對不符而讀不到
- **關閉公開分享**：刪除 `public:{token}` + 從 `publicshelves:{userId}` 移除該 shelf 元素
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

## 十二、共用套件（shared/）的設計理由

`shared/src/` 的程式碼註解最多兩行，較長的設計理由集中在本節，註解以「`docs/architecture.md → <小節名稱>`」指回這裡。

### 伺服器回傳資料的檢查

**威脅模型**：兩端的 API client 都以 `(await response.json()) as ApiResponse<T>` 直接轉型讀取回應，而 API 位址可由使用者設定——同步碼的 `@host` 會把整個 App 指向自架（BYO）伺服器。因此 `shared/src/api/types.ts` 與 `shared/src/borrow/types.ts` 只有宣告：宣告成 `string` 的欄位只是後端「聲稱」的內容，執行時其實是 `unknown`。Extension 對話框與 PWA 都沒有 ErrorBoundary，下列兩種情況都會造成**永久白屏**，直到使用者重新載入；而且錯誤是在 render／`useMemo` 中拋出，任何呼叫端的 `try/catch` 都接不到：

1. 物件被當成 JSX child 渲染：React 19 拋出 "Objects are not valid as a React child" 並卸載整棵樹（例如兩端 `MemberList.tsx` 渲染物件型別的 `displayName`）。
2. 對非字串呼叫字串方法：`useSearch` 的 `title.toLowerCase()`、借閱分組 `sortNewestFirst` 的 `createdAt.localeCompare()`、公開分享對話框與 `publicShelf/diff.ts` 的 `title.trim()`、成員名稱查表的 `userId.slice(0, 8)`（Extension `BorrowTab.tsx` 的 `buildOwnerNameLookup`、PWA `BorrowPage.tsx` 的 `buildMemberNameMap`，都在父層 `useMemo` 裡、任何卡片掛載之前執行）。

防護分兩層，都在兩端 API client 的邊界套用；規則放在 `shared/`，兩端就不可能對同一份資料套用不同規則。成員清單、家庭書櫃與個人書單是**結構層先跑，文字層後跑**（見兩端 client 的 `getFamilyMembers`／`getFamilyBookshelf`／`getPersonalBooks`）；借閱清單只走結構層，因為它本身就把 12 個欄位全部重建並轉型。

**文字層**（`shared/src/api/safeText.ts` 的基本函式，加上 client 實際呼叫的 `entityText.ts` 逐實體函式）：

- 只轉型別：真正的字串（包括 `""`）一字不改通過，不 trim、不正規化、不改寫內容。非字串降為 `""`，而且刻意不提供 fallback 參數——備用文案屬於本來就帶著它的呼叫端（`displayName || userId.slice(0, 8)`、`{book.author && …}`），`""` 是 falsy，既有的 `||` 與條件渲染會照常補上。
- `null` 有意義的欄位（`apiEndpoint: null` 表示「這個家庭使用預設端點」）改用 `safeNullableText`，保留 `null`。
- 容器：缺少的資料（`null`／`undefined`）維持缺少；其他不是物件的值（原始值、陣列）降為空實體；非陣列的清單降為 `[]`，無法承載欄位的元素直接丟棄——能渲染的空狀態勝過一次拋錯。壞掉的容器或元素會在下一次 render 才爆開（`.map` 或讀欄位時），例如 `members: [null]` 經 `setMembers` 存入後在 `members.map` 加 `member.displayName` 爆開，`data: []` 則在 `members.length` 爆開。陣列一律不展開：`{ ...arr }` 會帶上數字鍵，把壞資料偽裝成合法實體。
- 「能承載欄位的紀錄」只有一個定義：排除陣列的 plain object，與 `shared/src/borrow/validation.ts` 的 `isRecord` 相同。
- 清單丟棄元素時**不出聲**（不 `console.warn`），與結構層不同：它跑在家庭書櫃聚合等熱路徑上，每次回應一行警告只是雜訊。這是政策選擇，不是疏漏。
- 選填欄位以條件展開重建（`...(field !== undefined && { field: safeText(field) })`），後端省略的欄位維持省略，而不是變成值為 `undefined` 的屬性：下游「缺少就當作 X」的備援是針對「不存在」寫的，結構層刻意省略的鍵也不能在這裡被加回來。條件是 `!== undefined` 而不是 truthiness，因為 `null` 是存在的值。
- 刻意不處理的欄位：
  - `authToken`：憑證，不渲染、也不呼叫字串方法；降為 `""` 只會把壞掉的後端藏在無聲的重新驗證迴圈後面，而不是請求本來就會得到的 401。它的格式由結構層的 `issuedCredentials.ts` 檢查（見下方「token 與到期時間」那一條）。
  - `error.message`／`error.code`：由錯誤文字的防護負責。
  - 封面網址（`coverUrl`、`bookCoverUrl`）：它們會到的兩個地方都不會因非字串而當掉——`<img src>` 屬性由 DOM 轉成字串；而且先經過讀墨網址白名單（兩端共用的 `safeCoverUrl` → `shared/src/config/readmoo.ts` 的 `isAllowedCoverUrl`），白名單快速路徑的 `typeof` 防護讓非字串得到 `false`，而不是從 render 拋出 `TypeError`。白名單若拿掉這道防護，這個排除就不再安全，這兩個欄位必須改在文字層轉型；`extension/tests/unit/readmooConfig.test.ts` 的 describe「isAllowedCoverUrl / isAllowedBookUrl on non-string input」會先變紅。
    - `safeCoverUrl`／`safeBookUrl` 只有一份，位於 `shared/src/safeUrl/`，Extension 與 PWA 都直接 import；兩者回傳 `String(url)` 而不是 `url`，這不是多餘的：白名單判斷的是 `new URL` 轉成字串**之後**的值，所以 `["https://cdn.readmoo.com/x.jpg"]` 這種陣列會被接受；若原樣回傳 `url`，等於把陣列掛著 `string` 型別交出去，第一個對它呼叫字串方法的消費端就會在 render 中拋出 `TypeError`（`useSearch` 正是這樣對待 `title`）。`coverUrl` 沒經過文字層，執行時其實是 `unknown`；`readmooUrl` 目前有經過文字層轉型，但那是另一個模組的決定，改了也不會有人回頭檢查這一行。目前的消費端只把它放進 `src`／`href` 屬性，或拿來判斷是否為空，所以這是地雷而不是現行的 bug；對真正的字串 `String()` 是恆等函式，判定與回傳值都不變。
  - 數字、`BoolFlag` 與字串字面值聯集（`status`、`selectionMode`、`method`）：轉成 `string` 會破壞型別，它們的渲染處以 `ReadonlyMap` 查表防護。

**結構層**（`shared/src/api/memberValidation.ts` → `GET /api/family/:id/members`，以及兩端 `updateMemberSettings` 收到的 `PATCH /api/family/:id/member/:uid` 回應；`bookshelfValidation.ts` → `GET /api/family/:id/bookshelf`；`personalBooksValidation.ts` → `GET /api/user/:id/books`；`verifyValidation.ts` → `GET /api/user/:id/verify`；`issuedCredentials.ts` → `POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/refresh` 的 token／`expiresAt`；`shared/src/borrow/validation.ts` → `GET /api/family/:id/borrow`）：

- **無法定位就丟棄**（成員清單、家庭書櫃、借閱清單；個人書單相反，見下方「個人書單只轉換 `BoolFlag`，絕不丟書」）：元素不是 plain object，或身分欄位（成員 `userId`、書 `bookId`、借閱 `requestId`）不是非空字串，就整筆丟棄——它當不了 React key、名稱查表的鍵或家庭書櫃偏好 ref 的擁有者那一半，也當不了 `updateMemberSettings`／`removeMember` 的 `:uid` 或 `PATCH /api/borrow/:id` 的目標。
- **其餘欄位正規化**：非字串降為 `""`（消費端都有 `||` 備援，`""` 對 `localeCompare` 與 `.slice` 都安全）。成員的兩個選填欄位不符宣告型別時直接省略：`canLend` 只接受 `BoolFlag` 的兩個值（`true`、`2`、`"1"` 都當作缺少），缺少照舊讀成 TRUE（兩端 `MemberList.tsx` 的 `canLend !== BoolFlag.FALSE`，相容還沒有這個欄位的舊版 Worker）；`readmooName` 缺少時，「尚未記錄」提示照舊顯示。
- **家庭書櫃的身分欄位為什麼丟棄而不是正規化**：降為 `""` 仍保留元素，兩筆這樣的元素就會在空字串上相撞，造成四種看得到的後果（都不會當掉）：
  1. React key 重複：兩端的成員篩選選單以 `m.userId` 當 key（`memberFilterOptions.tsx`），書卡以 `` `${memberName}-${bookId}` `` 當 key（Extension `FamilyShelfBookList.tsx`、PWA `FamilyBookList.tsx`）。
  2. 成員標籤空白：`displayName || userId.slice(0, 8)` 兩半都是 `""`。
  3. 檢視者私人的家庭書櫃偏好塌縮：`familyPrefRef` 組成 `` `${ownerId}:${bookId}` ``（`shared/src/familyShelf/prefRefs.ts`），隱藏或收藏一張壞卡會作用到所有壞卡，塌縮後的 ref 還會經 `updateFamilyPrefs` 存到伺服器。
  4. 更新追蹤基準損壞：`baseline[member.userId]`（`shared/src/familyShelf/updateTracking.ts`）把所有壞成員塌縮到同一個 `""` 鍵，並存進 `chrome.storage.local`／`localStorage`。
- **已知殘餘，刻意不處理**：規則是「可用」而不是「唯一」。兩名成員共用同一個非空 `userId` 會直接重現 1 與 4，若再共用 `bookId` 也會重現 3；同一名成員有兩本 `bookId` 相同的書會重現 1 與 3。只有 2 被完全排除（空白標籤需要 `userId === ""`，存活的成員不可能再有）。成員清單有相同的殘餘；官方 Worker 也不對 `bookId` 去重（`worker/src/routes/user.ts` 的 `parseBooks`），去重會是兩端的政策變更而不是邊界檢查，而且這些碰撞都不會讓畫面當掉。
- **重建或保留**：成員清單與借閱清單的元素以全新物件字面值重建（成員最多 4 個欄位、借閱剛好 12 個），絕不展開原始元素，惡意的多餘屬性（包括 `JSON.parse` 產生的自有 `__proto__` 鍵）因此進不了畫面狀態。家庭書櫃刻意不同：存活的**成員**以 `{ ...element, books }` 保留——固定的欄位清單可能悄悄丟掉日後新增的欄位（例如對更新追蹤有意義的三態 `lastUpdated`），而重建要防的多餘屬性風險在這裡不存在，因為兩個消費端在進入畫面狀態前都會重建成 3 個欄位的新物件（Extension `useFamilyDataBookshelf.ts` 的 `parsedMembers`、PWA `useFamilyData.tsx` 的 `memberBooks`）。存活的**書**完全不動：`isShared`、`isArchived`、`coverUrl` 不在文字層處理的欄位裡，卻缺一不可——`isShared === BoolFlag.TRUE` 就是家庭書櫃的篩選本身，重建會把它們刪掉。欄位的型別轉換一律留給後跑的文字層。
- **個人書單只轉換 `BoolFlag`，絕不丟書**（`personalBooksValidation.ts`）：自架 Worker 若回傳 `isShared: true`，`true === BoolFlag.TRUE` 不成立，這個值卻會經合併原樣 PUT 回伺服器，正是 `BoolFlag` 慣例要防的跨平台錯誤。所以每個 plain object 元素的 `isShared` 只有剛好是 `1` 才是 `BoolFlag.TRUE`，其他值（`true`、`"1"`、`2`、缺少）都當作 `BoolFlag.FALSE`——與 Worker 自己的 `toBoolFlag`（`worker/src/routes/user.ts`）相同，也符合預設不開放，不開放的書不可能因此變成開放；`isArchived` 只保留 `BoolFlag` 的兩個值，其他值直接省略鍵（缺少讀成未封存，`mergeBooks` 的 `?? existing?.isArchived ?? BoolFlag.FALSE`）。這一層絕不丟棄、不重排元素，也不碰 `bookId`：下一次整份 PUT 會以用戶端的書單取代伺服器上的，在這裡丟掉的書會從伺服器被刪掉。不是 plain object 的元素原樣通過（文字層的 `sanitizeList` 照舊處理）；`data` 不是物件或 `books` 不是陣列時整份原樣通過，交給文字層與 `loadSavedBooks`。元素以展開保留其餘欄位，與成員清單的重建相反，因為整份 PUT 會把不認得的書欄位送回伺服器，固定的欄位清單會把它們刪掉。`data` 的其他欄位（`removedUnsharedBookIds`、`familyShelfPrefs`、`newBookDefaultShared` 等）原樣通過。
- **驗證方式只認四個值，其他一律變成錯誤信封**（`verifyValidation.ts`）：`data` 必須是 plain object，`method` 必須剛好是 `"pin"`、`"pattern"`、`"code"`、`"none"` 其中之一（以 `Set` 查詢，不用物件字面值，`"__proto__"` 不會被當成方法）。通過時重建成只有 `{ method }` 的新物件，其他欄位（例如舊版伺服器還帶著的 `prompted`）到不了呼叫端。其他情況不像清單那樣降為空值，而是換成一個全新的 `INVALID_RESPONSE` 錯誤信封（沒有 `data`），呼叫端的 `res.data?.method` 因此讀到缺少：PWA 登入在加入前的查詢（`useLandingSubmit.ts`、`useQrJoin.ts`）把它當作 `"none"`，直接送出加入、由伺服器決定，而不是進入一個沒有輸入框也沒有取消鍵的驗證畫面；QR 加入被拒後的重查（`useLandingCompleteJoin.ts`）同樣不開驗證畫面，回到登入表單（目前不顯示錯誤文字）。Extension 的 `useVerificationPrompt.ts` 把缺少的方法當成既有的 `methodError`，`VerificationSettings.tsx` 的方法流程（`extension/src/dialog/useVerifyMethodFlow.ts`）讀成 `"none"`，顯示「不設定驗證」；兩端的目前密鑰確認（`extension/src/dialog/stepUp.ts`、`pwa/src/hooks/stepUp.ts`）只讀 `data?.method`，錯誤信封讀成 `null`。帶 `error` 的信封只保留原本的 `error` 物件，旁邊的 `data` 一律丟掉：這個端點的七個呼叫端都先讀 `data`、不先看 `error`，伺服器若在錯誤旁邊附上 `data`，放行就等於讓沒檢查過的方法進到呼叫端。`data` 為 `undefined`／`null` 的信封照舊原樣通過（`data: null` 下游本來就讀成 `"none"`）。每次回應最多一行警告，不記錄值。這一層之後不再跑文字層：唯一的欄位是字串字面值聯集。
- **token 與到期時間只認一種形狀，不對就當作沒收到**（`issuedCredentials.ts`）：token（建立／加入家庭回應的 `authToken`、`/api/auth/refresh` 回應的 `token`）必須是 64 字元的小寫十六進位字串，官方 Worker 從第一版起只發這種（`worker/src/services/authTokens.ts` 的 `mintAuthToken`）；`expiresAt` 必須是大於 0 的有限數字。只檢查真假值時，`"soon"` 這種到期時間會讓 `proactiveRefresh` 的比較變成 `NaN`、永遠不提前更新，非字串的 token 也會被存起來。不符的鍵直接拿掉，不新增錯誤信封、不拋錯，下游走的都是「伺服器沒發 token」的既有路徑：
  - 建立／加入家庭（兩端 client 的 `createFamily` 與 Extension 的 `joinFamily` 先跑家庭資料的文字層再檢查，即 `sanitizeIssuedFamilyGroup`，兩者處理的欄位不重疊；PWA 的 `joinFamily` 宣告的回應只有 `ok`／`authToken`／`expiresAt`，只跑 `sanitizeIssuedCredentials`）：Extension 的 `onboardingFlow.ts` 與 `useReauth.ts` 不存 token、不設進 client；PWA 的背景復原（`useRecoveryJoin.ts`，即 `App.tsx` 的 `acquireNewToken`）回傳 `null` 並保留工作階段（Invariant 2）；登入頁的加入（`useLandingCompleteJoin.ts`）存下沒有 token 的工作階段，再由 `App.tsx` 的自動補 token 流程重新取得。
  - Extension 的 refresh 與背景復原加入（`auth-refresh.ts`，不經 client 的 `joinFamily`，直接用 `isAuthToken`／`isExpiresAt`）：壞 token 等同 refresh 失敗，走既有的分段復原；復原加入也拿到壞 token 時視為暫時失敗，家庭資料保留。
  - PWA 的 refresh（`pwa/src/api/client.ts` 的 `refreshAuthToken`，直接用 `isAuthToken`／`isExpiresAt`）：壞 token 不同於上面「拿掉鍵」的做法，換成一個全新的 `INVALID_RESPONSE` 錯誤信封（沒有 `data`），主動續期把它當成一般失敗，工作階段原樣保留（見〈PWA 主動續期〉）；`expiresAt` 不合格時從 `data` 拿掉，等同沒給，下次檢查會再續一次。帶 `error` 的信封只保留原本的 `error` 物件傳回。
  - 到期時間不合格時與缺少相同，`TOKEN_EXPIRES_AT_KEY` 不寫入（既有行為：舊的值也不會被清掉）；`proactiveRefresh` 把缺少讀成「沒有到期資訊，在收到 401 前都當作有效」。
  - 每次回應最多一行 `[issuedCredentials]` 警告，只在鍵「有送但格式不對」時輸出（缺少不算），不記錄值。
- 借閱的 `status` 不驗證：未知狀態由兩端的渲染處處理（Extension `BorrowRequestCard.tsx` 的 `STATUS_META.get(...) ?? UNKNOWN_STATUS`、PWA `BorrowCard.tsx` 中 `getStatusStyle` 的 `default:`），對它做的比較（`Set.has`、`===`）對任意值都安全。
- 成員清單回應的 `apiEndpoint` 是唯一會進到 React child 的穿透欄位：Extension 的移轉管理權確認畫面原樣印出它（`MemberList.tsx` 的 `.moo-member-list__endpoint`），PWA 則經 `hooks/useFamilyData.tsx` 提供給任何畫面。因此字串原樣保留，其他值一律變成 `null`（`apiEndpoint ?? undefined` 本來就把它讀成「沒有自訂端點」）。
- 容器壞掉時降為「沒有成員／沒有書／沒有申請」（個人書單除外：壞掉的容器原樣通過，交給文字層與 `loadSavedBooks`），不拋錯、也不新增錯誤代碼：使用者對它無能為力，空清單本來就能渲染。不是物件的 `data` 沒有可穿透的欄位，降為只有成員清單的資料，缺少的 `members` 再由陣列檢查回報。
- **檢查在 `{ data, error }` 信封內進行**（呼叫端自己讀信封）。帶 `error` 或沒有 `data` 的信封原樣通過（驗證方式例外：`error` 單獨轉交、旁邊的 `data` 丟掉，見上面「驗證方式」那一條）——驗證失敗絕不能被洗成空清單（`.claude/rules/security-ux-invariants.md` 的 Invariant 2）。`error` 以 truthiness 判斷而不是 `!== undefined`：BYO 後端可以送 `error: null`，兩端的 `if (response.error)` 都會把它當成功並讀取 `data`，放行就等於整份資料沒經過檢查。`data` 以 nullish 判斷，理由方向相反：下游根本不讀它。
- **只輸出彙總警告，絕不逐元素輸出**，惡意資料不能變成洗版。成員清單、借閱清單、個人書單與驗證方式每次回應最多一行（個人書單只計算被轉換的旗標個數，不記錄值；缺少 `isArchived` 是正常情況，不計入，缺少 `isShared` 則計入）；家庭書櫃最多兩行（成員一行、書一行）。家庭書櫃把書的損失跨成員累計後輸出一行（「丟棄的書」與「書單整個不可用的成員」分開計數，因為不可用的容器藏著不知多少本書）；成員的容器警告與丟棄警告互斥，所以成員那一半最多一行。log 前綴（`[memberValidation]`、`[bookshelfValidation]`、`[personalBooksValidation]`、`[borrowValidation]`、`[verifyValidation]`、`[issuedCredentials]`）指的是檢查而不是檔名，兩端的測試都會比對它，搬檔時要保留。

**錯誤物件**（`shared/src/api/types.ts` 的 `ApiError`）：

- `synthesized` 只在用戶端自己組出信封、而不是從回應解析時為真；Extension 以 `JSON.parse` 產生不出來的 symbol 標記證明這一點（`extension/src/api/client.ts`）。任何原樣渲染 `rawMessage` 的畫面都必須要求它為真，否則自架或惡意後端可以回傳只有用戶端才會用的錯誤代碼，把任意文字畫進對話框。PWA 目前恆為 `false`：它沒有自行合成信封的路徑（Extension 的驗證復原節流是唯一一處），未來的 PWA 合成點直接沿用這道檢查。它刻意是一般的 `boolean` 而不是 `BoolFlag`：這是記憶體中的來源標記，從來不是 API payload 或 KV 欄位，讓它留在可序列化的詞彙之外正是重點。
- `retryAfter` 在建構時檢查：自架後端可以送任何值，`NaN`、負數或小數會讓退避文案出現「NaN 秒」之類的內容。不是有限非負數的值直接丟棄（UI 改用固定文案），小數則無條件捨去。

### 借閱失敗文案只接受錯誤代碼

`shared/src/borrow/messages.ts` 把 `POST /api/family/:id/borrow` 的失敗轉成文案。Extension 對話框與 PWA 頁面從同一個「申請借閱」按鈕打同一個端點，失敗訊息兩邊必須一致，所以對照表只有這一份。

- **只進代碼、只出本機字串**：只接受機器可讀的 `code`，回傳固定的繁體中文句子；絕不接受、插入或回傳伺服器提供的訊息文字。API 位址可由使用者設定（BYO，以及同步碼的 `@host` 讓寫邀請的人決定位址），信封的 `message` 等於攻擊者可控的文字，原樣渲染會讓惡意後端把任意內容畫進對話框。只有用戶端自己合成的 `ApiError` 可以原樣顯示（見上一節的 `synthesized`）。不要「改良」成多收一個 `message`／`rawMessage` 參數當備援。
- **Extension 的合成例外**：Extension 的 `borrowFailureText`（`extension/src/dialog/useBorrowAction.ts`）、`memberSettingsErrorMessage`（`memberSettingsMessages.ts`）與 `publicShelfErrorMessage`（`publicShareMessages.ts`）對用戶端合成的驗證復原節流（`AUTH_REFRESH_RATE_LIMITED`）原樣顯示 `rawMessage`：它本來就是給使用者看的繁體中文，寫著只看代碼的對照表重建不出來的冷卻時間與該做的動作。放行的依據是 `synthesized` 而不是代碼——只有這個用戶端自己的 symbol 標記會設它，自架或惡意後端回傳這個代碼也畫不出任意文字。PWA 刻意沒有這條（`.claude/rules/frontend.md` → Extension ↔ PWA twins）。
- **對照表收錄的代碼**：使用者能採取行動的失敗——`DUPLICATE_REQUEST`、`TOO_MANY_PENDING_REQUESTS`、`RATE_LIMITED`、`LENDING_DISABLED`、`NOT_FAMILY_MEMBER`、`INVALID_OWNER`、`INVALID_OWNER_SELF`、`FAMILY_NOT_FOUND`、`UNAUTHORIZED`、`INVALID_COVER_URL`——加上 API client 自己的 `NETWORK_ERROR`（fetch 失敗、沒有信封）。只有格式錯誤的用戶端請求才會觸發的代碼（`INVALID_FAMILY_ID`／`INVALID_JSON`／`MISSING_FIELDS`／`INVALID_FIELDS`／`INVALID_USER_ID`）與 `INTERNAL_ERROR` 刻意不收：它們沒有使用者能照做的建議，落到通用句即可。
- **用 `Map` 而不是物件字面值**：`code` 由後端控制，物件查表會經原型鏈解析到 `"__proto__"`／`"toString"`。
- **`RATE_LIMITED` 刻意不寫秒數**：信封的 `retryAfter` 由兩端刻意分開的函式格式化（兩者對 `retryAfter === 0` 的處理不同，見 `extension/src/dialog/verificationMessages.ts` 的 `rateLimitedEnvelopeMessage`），在這裡插入秒數會把這個模組要防的兩端分歧帶回來。

### 共用文案的產品語意

- **自訂伺服器提示**（`shared/src/hostNote/messages.ts`）：這行字在使用者交出同步碼、驗證密碼或書單之前，說出自架伺服器的位址。Extension（`extension/src/dialog/SyncCodeHostNote.tsx`）與 PWA（`pwa/src/components/SyncCodeHostNote.tsx`）用兩套樣式系統呈現同一則提示，文案過去兩邊各一份、只靠註解承諾逐字相同，沒有任何東西強制；集中成一份讓分歧不可能發生。這裡比一般文案更要緊：兩個用戶端對同一台伺服器的描述不同，正是偽造位址可以利用的模糊。三個 variant 只差在 valid 分支的引導語，差別完全取決於「畫面上有沒有那組同步碼」：
  - `join`：同步碼就在畫面上 → 直接指名「此同步碼」。
  - `verify`：驗證挑戰畫面上沒有同步碼（可能是建立家庭，或加入很久之後的重新驗證）→ 不提同步碼。
  - `onboarding`：還沒有任何動作發生，只是陳述目前採用的伺服器 → 用現在式。

  警告文案刻意不分 variant：它講的是「帶著壞位址的那組同步碼」，與畫面無關。

- **移除成員**（`shared/src/unkick/messages.ts`）：「解除限制」解除的是後端的 kicked tombstone（6 小時內擋住同步碼重新加入），**不會**把對方加回家庭（`.claude/rules/security-ux-invariants.md` 的 Invariant 4），對方仍須自己輸入同步碼，文案必須維持這個區別。解除成功文案括號內「可能需要約一分鐘生效」不是保守說法：tombstone 刪除後，仍持有舊 key 的 colo 最長約一分鐘才看得到，這段期間對方重新加入可能仍被拒（重試即可）。

- **忘記驗證方式的提示**（`shared/src/recovery/messages.ts`）：登入驗證畫面（PWA 登入頁、擴充功能的重新驗證視窗與初次設定的驗證步驟）和驗證方式的設定提示（擴充功能的登入驗證設定、PWA 登入後的驗證設定提示）下方各有一行。三段文案：`FORGOT_SECRET_QUESTION`（「沒辦法完成驗證？」）、`FORGOT_SECRET_LINK_LABEL`（「填寫救援申請」，連到回報表單並預填救援主題，網址由 `shared/src/config/links.ts` 的 `getVerifyRecoveryLink` 產生）、`FORGOT_SECRET_SELF_HOSTED`（「忘記的話，請找伺服器管理者協助。」）。分流只看採用中的伺服器位址，不看輸入框文字：官方預設位址顯示問句加連結，其他位址（包括無效的 `@host`）只顯示自架文案、不給連結——官方表單只處理官方伺服器的帳號，自架伺服器的帳號要由該伺服器的管理者處理。問句與驗證方式無關，`code` 帳號沒有已登入的電腦時同樣需要救援。判定來源兩端不同：擴充功能用 `classifyAdoptedEndpoint(apiClient)`，PWA 登入頁用 `pendingAuth.apiHost`、設定提示用 `apiClient.getEndpoint()`。擴充功能端這行字放在 Dialog 裡（`ReauthModal`、`Onboarding`、`VerificationSettings` 渲染），不放進密鑰輸入的 secure frame。

---

## 十三、建置與驗證腳本（extension/scripts）

`extension/scripts/` 是在 Node（`tsx`）下執行的建置與驗證腳本，由 `extension/tsconfig.scripts.json` 納入 `pnpm typecheck`。腳本的程式碼註解最多兩行，較長的設計理由集中在本節，註解以「`docs/architecture.md → <小節名稱>`」指回這裡。E2E 專用的腳本（`build-e2e.ts`，以及 `verify-selectors.ts` 和它拆出的 `verify-selectors-specs.ts`、`verify-selectors-page.ts`、`verify-selectors-flows.ts`）的規則寫在 `.claude/rules/test.md` → E2E tooling (extension/scripts)。版本號的同步見〈九、版本管理〉的「版本同步機制」。

### Chrome 建置檢查（verify-build.ts）

`pnpm build` 的最後一步（`pnpm build:dev` 不執行）。任何一項失敗就以 exit code 1 結束：

- `dist/` 必須有 `content.js`、`background.js`、`popup.js`、`fiber-bridge.js`、`manifest.json`。
- `dist/content.js` 必須是 IIFE 而不是 ESM：去掉開頭空白後不能以 `import ` 或 `import{` 開頭。
- `dist/manifest.json` 的 `host_permissions`、**每一筆** `content_scripts[i].matches`、**每一筆** `web_accessible_resources[i].matches`，都必須**剛好等於** `READMOO_MATCH_PATTERNS`（`shared/src/config/readmoo.ts`，支援的讀墨網域的唯一來源），不能少也不能多：
  - 少了：在 `READMOO_MATCH_PATTERNS` 加了網域卻沒更新 `extension/public/manifest.json`，出貨的擴充功能在那個網域上永遠不會執行，也沒有任何提示。
  - 多了：過寬的 pattern（`<all_urls>`、遺留的 `http://localhost` 開發用 pattern、打錯的網域）會在出貨的 manifest 裡無聲擴大安裝時的權限提示與 content script 的範圍。
  - 陣列欄位逐筆檢查而不是只看 `[0]`：否則第二筆 content script／web-accessible resource 可以帶著錯誤或過寬的清單出貨而沒人發現。陣列不存在或為空也算失敗。
  - 腳本只宣告它要檢查的欄位，而且全部是 optional：欄位格式錯誤或被改名時回報 FAIL，而不是讓腳本當掉。
- E2E 建置刻意加入的 `http://localhost:*/*` 不會讓這項檢查失敗：`build-e2e.ts` 是在 `pnpm build`（也就是執行本檢查的指令）**結束之後**才修改 `dist/manifest.json`，檢查當下 manifest 裡還沒有 localhost。

### Firefox 建置（build-firefox.ts、build-firefox-manifest.ts）

- **流程**：`pnpm build:firefox` = `pnpm build` → `build-firefox.ts` → `verify-firefox-build.ts`；`pnpm build:firefox:dev` 改用 `pnpm build:dev`，而且只建置、驗證 `direct`（`--target direct`）。
- **`build-firefox.ts`**：從已經建好的 Chrome 版產生 Firefox 版。`dist/` 不存在時直接失敗，提示先跑 `pnpm build`。對每個目標先刪掉舊的 `dist-firefox-<target>/`，再整份複製 `dist/`（不留舊檔），然後交給 `buildFirefoxManifest` 改寫 manifest。`--target amo|direct` 只建一種，不帶參數時依序建兩種。只用 Node 的 `fs` API、不用 shell 的 `cp`：開發在 Windows、CI 在 Linux。
- **兩種目標，各自有自己的 gecko id**：
  - `amo`：上架 AMO 的版本，使用 `GECKO_ID_AMO`，**不能**帶 `update_url`（AMO 會拒絕；上架的附加元件由 AMO 自己提供更新）。
  - `direct`：自行散布的已簽署 `.xpi`，使用 `GECKO_ID_DIRECT`，帶 `update_url`（`UPDATE_URL`，指向最新 GitHub Release 附的 `updates.json`），安裝後會自動更新。
  - 兩個 id 刻意不同：上架版與自行散布版若共用一個 id，就不能用同一個版本號在兩個管道都發布（AMO 的 same-version dual-channel 衝突）。
- **manifest 轉換**（`toFirefoxManifest`，兩種目標都套用）：
  - `version`：從 `extension/package.json` 重新讀取（與 Chrome 的 `sync-version.ts` 同一個來源），Firefox 版不會跟著分歧。
  - `browser_specific_settings.gecko`：該目標的 id、`strict_min_version`、`data_collection_permissions`（只有 `direct` 再加上 `update_url`）；另加 `gecko_android.strict_min_version`，給 Firefox for Android 用。
  - `background`：Firefox for Android（Fenix）無法可靠支援 MV3 的 background `service_worker`，event page（`background.scripts`）在桌面與 Android 都能用，所以整個 `background` 換成 `scripts: [<原本的 service_worker 檔名，缺省為 background.js>]` 加上 `type: "module"`。`service_worker` 不保留，但 `type: "module"` 必須保留：`background.js` 是帶頂層 `import` 的 ES module，少了它 Firefox 會當成傳統 script 載入，遇到語法錯誤，背景從未執行（#345）。
  - 其他欄位（permissions、content_scripts、host_permissions、web_accessible_resources、action、icons）與 Chrome 版完全相同。
  - 最低版本與資料同意宣告的理由寫在 `build-firefox-manifest.ts` 匯出常數 `STRICT_MIN_VERSION`、`DATA_COLLECTION_PERMISSIONS` 的 JSDoc。

### Firefox 建置檢查（verify-firefox-build.ts）

`pnpm build:firefox` 的最後一步。對每個目標的 `dist-firefox-<target>/` 檢查下列各項，任何目標有一項失敗就以 exit code 1 結束；`--target amo|direct` 只驗證一種，不帶參數時兩種都驗證：

- bundle 檔案都存在：`content.js`、`background.js`、`popup.js`、`fiber-bridge.js`、`manifest.json`。
- `browser_specific_settings.gecko.id` 存在，而且符合目標（`amo` → `GECKO_ID_AMO`，`direct` → `GECKO_ID_DIRECT`）。
- `gecko.strict_min_version` 與 `gecko_android.strict_min_version` 都存在。
- `gecko.data_collection_permissions.required` 包含 `"websiteContent"`。
- 使用 event page：有非空的 `background.scripts`，而且沒有 `background.service_worker`（Firefox for Android 無法可靠支援）；`background.type` 必須是 `"module"`。
- `update_url` 依目標而定：`amo` 的 gecko **不能**有 `update_url`；`direct` 的 `gecko.update_url` 必須等於 `UPDATE_URL`。

### 自行散布版的更新檔（build-updates-json.ts）

- Firefox 會定期讀取 direct 版 manifest 的 `browser_specific_settings.gecko.update_url`（`UPDATE_URL`）所指的 `updates.json`；裡面提供較新的版本時，就從 `update_link` 下載已簽署的 `.xpi`。
- `updates.json` 只服務自行散布版，所以 `addons` 只以 `GECKO_ID_DIRECT` 為 key，不含 AMO 上架版的 id。
- 版本從 `extension/package.json` 讀取（與 `sync-version.ts` 同一個來源）。`update_link` 是 `https://github.com/reginna-chao/moo-family-bookshelf/releases/download/v<version>/moo-family-bookshelf-firefox-v<version>-direct-install.xpi`，檔名必須和 CD 上傳到 GitHub Release 的 `.xpi` 相同，否則 Firefox 自動更新會 404；CD 的 `release-extension-firefox` job 在上傳前會比對兩者，不一致就失敗。
- 結構是純函式 `buildUpdatesManifest(version)` 加上一層薄的 CLI：`--out <path>` 指定輸出位置，缺省為 `extension/dist-firefox-updates.json`（已列入 `.gitignore`）。CD 以 `--out "$GITHUB_WORKSPACE/updates.json"` 產生後上傳到 Release。

---

## 十四、Extension 用戶端的設計理由

`extension/src/` 的程式碼註解最多兩行，較長的設計理由集中在本節（或本文件其他已有的小節），註解以「`docs/architecture.md → <小節名稱>`」指回這裡。Extension 與 PWA 必須保持一致的成對檔案，以及刻意不一致之處，列在 `.claude/rules/frontend.md` → Extension ↔ PWA twins。

### Extension Dialog 的設計理由

#### 揭露採用中的伺服器位址

`extension/src/dialog/adoptedEndpoint.ts` 的 `classifyAdoptedEndpoint` 是「告訴使用者用戶端正在連哪台伺服器」這條規則唯一的來源。三個呼叫端：收集驗證密鑰的兩個畫面（引導畫面的驗證挑戰、重新驗證視窗），以及引導畫面容器的伺服器提示——它不收密鑰，只告訴自架者下方的建立／加入／復原按鈕會連到哪台伺服器，但問的是同一個問題、受同樣兩條不變量約束，所以也呼叫這裡，而不自己讀端點。三者都不自行推導，答案就不會對同一個問題分歧。

- **判定取自用戶端「實際採用」的端點，絕不取自輸入文字**（PR #116 立下的規則）：同步碼的 `@host` 是攻擊者可控的文字，要等使用者確認後才會採用；若對輸入文字分類，畫面就會替使用者還沒接受的位址背書——正是偽造位址想要的那份安心。採用的端點在進入 `ApiClient` 時已通過 `validateEndpointUrl`，不可能與密鑰實際要送去的地方不一致。
- **官方預設端點什麼都不揭露**（`kind: "none"`）：每一次驗證挑戰都掛一條提示，會讓使用者習慣跳過真正有意義的那一次；只有目的地不是本專案自己的 Worker 時才值得注意。
- 參數刻意是 `ApiClient` 而不是 `string`：呼叫端在結構上不可能把使用者輸入傳進來還通過型別檢查，第一條不變量由編譯器把關，而不是靠審查者注意到。
- **引導畫面的兩則提示**（`extension/src/dialog/Onboarding.tsx`）：每次 render 只算一次判定，容器提示與驗證挑戰自己的提示共用，兩者不可能揭露不同的伺服器。刻意不以 `apiClient` 做 memo：加入時會就地採用同步碼的 `@host`，端點變了、client 的身分沒變，而過時的揭露正是這則提示要防的失敗。
  - 容器提示：自架者的建立／加入／復原動作都打向採用的端點，所以在任何動作之前先說是哪台伺服器。官方預設時 `classifyAdoptedEndpoint` 回 `none`、提示不顯示（第二條不變量），這份安靜是刻意的，不是漏掉的情況。驗證挑戰畫面不顯示容器提示，因為它自己以 `verify` 引導語顯示同一則提示。
  - 驗證挑戰取代加入畫面，連帶取代它的位址揭露——偏偏是在使用者被要求把 PIN／圖形交給伺服器的時候。此時同步碼加入已經把 `@host` 套用到 client（`performJoin` 讓它維持套用，挑戰才會打向那台伺服器），建立／查詢的挑戰則仍在官方預設端點，所以採用的端點對兩者都是正確答案。
- **重複時隱藏容器提示**（`onboardingNoteRules.ts` 的 `isAdoptedNoteRedundant`，由 `Onboarding.tsx` 呼叫）：畫面上的 view 已經顯示同一個位址時，容器提示只是重複——同一畫面兩行琥珀色文字說同一件事，正是教會使用者略過整類提示的原因；同步碼殘留的預填路徑（`useOnboardingFlowState.ts`）一定會發生，預填同步碼的 `@host` 就是採用的端點。只有兩個 view 會顯示輸入中同步碼自己的提示：`RecoveryJoinView` 與 `IdleView`（`renderContent` 最後的 fallback 分支）。`DEDICATED_VIEW_STATES` 列的是有自己 view 的狀態，刻意寫成補集而不是 fallback 狀態的清單，日後新增卻沒加分支的狀態也會落到 `IdleView`；它必須與 `renderContent` 保持一致。
  - 只在兩個**都已驗證**的正規化端點逐字相同時隱藏（`kind: "valid"` 代表兩邊的字串都出自 `validateEndpointUrl`）。這是輸入文字唯一不能替任何東西背書的方向：它只能隱藏一則內容與它完全相同的提示，不能改變提示內容，也不能讓提示出現，所以第一條不變量不受影響。`invalid` 或沒有 `@host` 時從不隱藏——偽造警告與狀態提示回答的是不同問題，必須並存；兩個不同的位址也一樣。
  - 沒有空窗：`displayedSyncCodeApiHost`（`shared/src/api/syncCodeHost.ts`）只延後 `invalid` 的判定，所以 view 對 `valid` 位址的提示與隱藏容器提示發生在同一次 commit。這點不可或缺：若共用的顯示政策日後連 `valid` 也延後，等待期間會一則提示都沒有（雖然只限同一個位址，仍是缺口）。

#### 重新驗證視窗

token 在伺服器端失效、背景自動復原又被 PWA 登入驗證擋下時，`extension/src/dialog/useReauth.ts` 就地顯示重新驗證提示（`.claude/rules/security-ux-invariants.md` 的 Invariant 2：token 過期必須提示重新驗證，不得無聲丟掉資料）。它沿用既有的驗證提示機制（`useVerificationPrompt` + `VerificationPrompt`），接上 `apiClient.onReauthRequired`；`ReauthModal.tsx` 是提示外面的遮罩與卡片，疊在仍掛著的主畫面上，使用者不會失去原本的位置。

- **重新加入**（`runReauthJoin`）：以輸入的密鑰重新加入家庭，帶 `recovery: 1`，伺服器會以 `409 RECOVERY_NOT_MEMBER` 拒絕已不在名單上的人。成功時保存新 token、設進記憶體中的 client，清除殘留的復原冷卻（`RECOVERY_COOLDOWN_UNTIL_KEY`：這次成功證明憑證可用，下一次背景 refresh 不該被它節流），再呼叫 `onSuccess`，讓 App 重新載入家庭資料、取代過時的 401 畫面，不必手動重試；失敗時回傳代碼，讓提示重試或顯示鎖定訊息。
- **初始畫面**：提示一開始就帶入實際擋下背景復原的代碼，被鎖定的使用者立刻看到倒數，而不是可輸入的欄位；其他意外的值退回 `VERIFICATION_REQUIRED`，去查詢驗證方式並顯示對應的挑戰（PIN／圖形／OTP）。
- **latch**：client 在呼叫 `onReauthRequired` 之前設好 latch，設著時之後每個 401 都跳過背景復原。所以每個不顯示提示或提示結束的出口都要以 `clearReauthPending` 釋放它，否則之後再也不會出現重新驗證提示：storage 缺少重新加入所需的身分（無法顯示提示）、使用者放棄提示（只關閉提示、留在主畫面，之後的動作可以再觸發挑戰），以及下面的拆除。
- **家庭已不存在時的拆除**（`tearDownGoneFamily`）：重新加入回的是家庭已不存在的代碼（家庭被刪、已滿、被移除或已不在名單上）時，清除本機家庭資料、Dialog 退回引導畫面。這條分支並非假設：伺服器的驗證閘門排在 kicked 墓碑檢查之前，設有驗證的被移除成員要先輸入正確的密鑰，才會知道自己被移除；沒有這道拆除，提示會一直要求同樣的輸入，使用者會在「密鑰正確 → 錯誤」之間打轉，直到墓碑過期（6 小時）。錯誤代碼轉交給 `onFamilyRemoved`，引導畫面才能說明原因（見〈家庭綁定被解除時的說明〉）。
  - `clearFamilyStorage` 裡的 `storage.local.remove` 沒有防護、可能 reject，這裡吞掉它：storage 失敗不能讓 latch 卡住，殘留的 latch 會讓這次工作階段之後每個 401 都沒有反應，畫面永遠不會切換。失敗時另外呼叫 `resetFamilyEndpointChoice()`（它自己吞掉 storage 失敗，不會 reject）：App 的處理只把**記憶體中**的 client 放回預設端點，存起來的選擇才是**下次啟動**會還原的值，到時使用者可能已經用不帶 `@host` 的同步碼加入別的家庭，而那不會覆寫它，所以它不能是唯一還指向前一個家庭伺服器的東西。
  - `finally` 的順序：先清 token（401 路徑已清過，這裡再清一次，因為這個 hook 擁有 client 的狀態，而且 `onFamilyRemoved` 是選填的）；再釋放 latch，然後才交棒；最後呼叫 `onFamilyRemoved`，Dialog 只在 storage 與 client 都已是「沒有家庭」時才切到引導畫面。
- **位址揭露**：重新驗證視窗與引導畫面的驗證挑戰遵守同一條規則（見〈揭露採用中的伺服器位址〉）：輸入 PIN／圖形之前，先說出它會送往哪台伺服器。這裡的端點已經證實過——只有加入成功或使用者在確認面板接受，它才會成為 client 的端點——所以這不是在防攻擊，而是補完規則中「挑戰」的那一半；畫面上也沒有任何輸入欄位能提供另一個來源，端點早在 token 失效前就採用了。
- **範圍**：這條規則只涵蓋**挑戰**畫面，也就是還沒登入的使用者交出**既有**密鑰換取存取權的畫面。已登入之後收密鑰的畫面刻意不在範圍內：設定新密鑰的 `VerificationSettings` 與 PWA 的 `VerifySetupPrompt`，以及 #396 的目前密鑰確認（`CurrentSecretStep`：Extension 的驗證設定、兩端的刪除帳號確認、PWA 的 `VerifySetupPrompt`）。目前密鑰確認雖然也是交出既有密鑰換取寫入權限，但使用者此時已登入（Extension 的分頁需要已加入家庭；PWA 的這些畫面在登入後才出現），密鑰送往的就是登入所用、在設定或登入時已經收過同一組密鑰的那台伺服器，沒有新的揭露。這幾處收密鑰時不揭露位址，是決定，不是沒注意到的缺口。

#### 家庭綁定被解除時的說明

`extension/src/dialog/familyGoneNotice.ts` 是本機家庭綁定被解除、Dialog 退回引導畫面時的說明文案。兩個解除入口——`extension/src/api/auth-refresh.ts` 的 `clearFamilyAndNotify`（背景自動復原加入失敗後，不經任何提示）與 `extension/src/dialog/useReauth.ts` 的 `tearDownGoneFamily`（重新驗證時）——都把觸發的錯誤代碼交給 `onFamilyRemoved`，`extension/src/dialog/App.tsx` 再把文字顯示成引導畫面上方的橫幅。少了它，畫面只會沒頭沒尾地切換，看起來像程式錯誤，而不是家庭 Owner 造成的狀態變化。PWA 在 `pwa/src/utils/joinErrorMessages.ts` 說明同樣的拒絕。文案放在這個模組而不是元件裡，測試才能釘住正式的字串，而不是比對測試自己抄的一份。

#### 驗證碼的產生

`extension/src/dialog/useOtpCode.ts` 的 `handleGenerateOtp`（由 `VerificationSettings.tsx` 呼叫）讀 `POST /api/user/:id/verify/otp` 的回應。信封是直接轉型讀入的，`code`／`expiresAt` 只在型別上是 `string`／`number`：

- 不是字串的 `code` 會被當成 JSX child 渲染，React 19 遇到物件會拋錯，而這裡沒有 ErrorBoundary。
- 非有限值的 `expiresAt` 會以兩種方式弄壞倒數 effect：`Infinity`——或剩餘時間算成 NaN 的字串——是 truthy，effect 會掛上每秒一次的 interval，但 `remaining <= 0` 永遠不成立，interval 永遠不會自己清掉；NaN 本身是 falsy，effect 直接 return，倒數永遠不會開始。
- 兩種情況這個值都不能用，所以空字串、非字串的 `code` 或非有限值的 `expiresAt` 都讓整個回應當成產生失敗。這個分支也會接到欄位格式錯誤的成功信封，此時可能根本沒有 `error`。`generateOtp` 受伺服器的驗證設定寫入上限約束（見〈PWA 登入驗證機制〉的 KV Key 設計），真正的 429 會走到這裡，顯示共用的退避文案（含 `retryAfter`），而不是伺服器原始的訊息。

### Extension 背景程式、儲存與 Content Script 的設計理由

`extension/src/` 除了 `dialog/` 之外的部分：API client、背景程式、本機儲存、書單同步與 content script。

#### 認證更新與冷卻

`extension/src/api/auth-refresh.ts` 與 `extension/src/api/client.ts` 的 401 路徑。冷卻與「自己的離開請求進行中」兩道防護的共通規則見〈背景自動復原的防護〉（PWA 的對應實作）。

- **重新驗證的閂鎖**（`ApiClient` 的 `reauthPending`）：`doRefreshToken` 一呼叫 `onReauthRequired` 跳出重新驗證提示就設為 true（由 `ApiClient` 包住這個 callback 的那層設定；`auth-refresh.ts` 只透過 `isReauthPending` 讀它）。閂鎖期間，之後的 401 波次都跳過背景加入，所以一次開啟 Dialog 最多花掉一個次數額度，進行中的驗證提示也不會被重新初始化（那會清掉使用者輸到一半的 PIN／圖形）。設定非 null 的 token 或呼叫 `clearReauthPending` 時解除；`doRefreshToken` 失敗途中設成 null 不會解除。
- **何時不送背景加入**：重新驗證提示待處理中（理由同上：會重花 per-IP 的加入額度、清掉輸入），或使用者自己的離開家庭／刪除帳號請求仍在進行（#263，可能把他加回正在離開的家庭）。這兩種情況下前面那次 `/api/auth/refresh` 的 POST 仍照送：token 若已在別處修好並存進 storage，不需要加入就能恢復。
- **收到 429 時**：沒帶驗證密碼的背景加入只可能撞到 Worker per-IP 敏感端點的 429（驗證嘗試上限只對猜錯計次，沒有密碼時不會觸發）。所以收到 `RATE_LIMITED` 就設定冷卻，讓之後每次開啟 Dialog 不再消耗共用的額度；而且**不**提示重新驗證：同一個 IP 帶著密碼重試，仍會被同一個 per-IP 時間窗擋下。
- **冷卻上限**：後端給的任何 `retryAfter` 都截到 `MAX_RECOVERY_COOLDOWN_SECONDS`（1 小時）。官方 Worker 最多只要求 900 秒，所以這道上限只防惡意或有 bug 的自架後端把自動復原幾乎永久鎖住。它與 `extension/src/dialog/useRetryCountdown.ts` 的上限相同，但刻意各自定義：api 層不依賴 dialog 層（`VERIFICATION_ERROR_CODES` 與 `extension/src/dialog/useVerificationPrompt.ts` 的集合也是同樣的理由）。
- **限流時回給畫面的錯誤**：背景復原被限流（剛收到 429 或冷卻中）時，`ApiClient` 不回傳原本的英文 401，而是自己合成一個 `AUTH_REFRESH_RATE_LIMITED` 錯誤，附上在地化文案（`extension/src/api/rateLimitMessage.ts` 的 `buildRateLimitMessage`；知道冷卻期限時，附上無條件進位到分鐘的剩餘時間）。代碼刻意與伺服器的 `RATE_LIMITED` 不同，UI 才認得出這段專屬文案並原樣顯示，而不是換成通用的退避句子；`synthesizeError` 蓋上的 symbol 標記就是允許原樣顯示的憑據（見〈伺服器回傳資料的檢查〉的「錯誤物件」）。

#### 背景 Service Worker 與訊息

`extension/src/background/`：跨瀏覽器的背景程式（Chrome 是 service worker，Firefox 是 event page），負責 content script／Dialog 與擴充功能內部之間的訊息。

- **訊息機制**（webextension-polyfill）：`onMessage` 對已知的訊息類型回傳一個 Promise，resolve 成回應物件，polyfill 再把它交給發送端 `await` 的 `browser.runtime.sendMessage`；沒有 `sendResponse` + `return true` 那套 Chrome 專屬寫法。未知類型回傳 `undefined`。每個 handler（`messageHandlers.ts`）只負責一種訊息類型，只做那則訊息的 storage 存取與驗證；分派在 `index.ts`。
- **只處理三種訊息**（`SET_FAMILY_ID`／`CLEAR_FAMILY_ID`／`SET_API_ENDPOINT`）：listener 先排除不是物件的訊息，`type` 必須是字串、而且是 `messageHandlers` 自己的 key 才會派發，原型鏈上的名稱（`toString`、`__proto__`）碰不到任何 handler，其餘一律回傳 `undefined`。單元測試 `extension/tests/unit/background/messageSenders.test.ts` 斷言每個 handler 在 `extension/src` 都有發送端，沒人發送的 handler 不會再悄悄留下來。
- **訊息內容一律當成不可信的輸入**：`BackgroundMessage` 各欄位刻意宣告成寬鬆的輸入型別（`string`、`number`、`string | null`），而不是驗證後的字面值聯集，handler 在執行時檢查；在型別上先收窄，執行時的檢查就會變成死碼。
- **儲存位置**：familyId 同時寫入 `storage.local` 與 `storage.sync`，以 `storage.local` 為準（讀取規則見〈本機儲存與同步〉）；API 端點只存 `storage.local`（不同裝置可能用不同端點）。
- **`SET_API_ENDPOINT`** 使用與 `ApiClient`、Dialog 相同的 `validateEndpointUrl`（`shared/src/api/endpointUrl.ts`），整個擴充功能只有這一套規則，背景不得另留一份：先前背景裡的本機版本是更嚴格的「第三種意見」，擋掉了其餘用戶端都接受的私有網段／區網位址，自架者的背景副本因此沒有任何提示就與正式的 storage 寫入分歧。存的是正規化後的值，這條路徑與 Dialog 的直接寫入才不會留下同一個端點的兩種寫法。
- **沒有背景排程同步**：以 `chrome.alarms` 排程的背景同步已移除，`alarms` 權限也拿掉了；升級上來的裝置若殘留排程，沒有任何 listener 會處理，等於無效。書單同步只在 Dialog 裡進行：開啟個人書櫃時的自動同步（依 `autoSyncInterval` 節流）與手動同步按鈕（`extension/src/sync/syncBooks.ts`），以及引導畫面建立／加入家庭時（`extension/src/dialog/useAutoSetup.ts`）。

#### 本機儲存與同步

`extension/src/storage/` 與擴充功能的 `storage.local`／`storage.sync`。多裝置同步的目的與限制見〈chrome.storage.sync 多裝置同步〉。

- **Dialog 直接存取 storage，不經背景訊息**：Firefox MV3 的背景是會休眠的非常駐 event page，休眠時 `browser.runtime.sendMessage` 往返可能 reject 或 resolve 成 `undefined`，`browser.storage.*` 在 Dialog 裡則一直可靠。familyId（`familyId.ts`）、家庭書櫃檢視模式（`viewMode.ts`）、自動同步頻率（`autoSyncInterval.ts`）、同步封存書籍（`syncArchived.ts`）、家庭書櫃按鈕大小（`floatingIconSize.ts`）、兩個書櫃的排序（`bookSort.ts`）、家庭端點的選擇（`familyEndpointChoice.ts`）、自己的離開標記（`selfDeparture.ts`）都因此直接讀寫 storage，避開同一類只在 Firefox 出現的 bug。Dialog 的偏好設定沒有一個再經過背景訊息；背景只剩 familyId 與 API 端點的訊息。
- **familyId 以 `storage.local` 為準**（`familyId.ts` 的 `readFamilyId`）：每次寫入都寫到 `storage.local`，它也是 Firefox 上可靠的區域（`storage.sync` 可能是空的或無法使用）。`storage.sync` 只是跨裝置的初次設定提示，只有從未完成引導的裝置（本機沒有 `USER_ID_KEY`）才會讀它。不能改成先讀 sync：背景復原失敗會清掉本機的 familyId，但過期的 familyId 可能還留在 `storage.sync`（Android 版 Firefox 的 `storage.sync.remove` 也可能不聲不響地什麼都沒做），先讀 sync 會在每次開啟 Dialog 時讓這個「殭屍」familyId 復活，把使用者困在壞掉的主畫面、回不到引導畫面。所以裝置一旦完成引導，本機沒有 familyId 就代表「沒有家庭」，絕不從 sync 復活。殘留在 sync 的值只會由 `readSyncFamilyIdRemnant` 拿去預填引導畫面的同步碼欄位（絕不自動送出）。
- **寫入與清除都是本機優先**（背景的 `SET_FAMILY_ID`／`CLEAR_FAMILY_ID`）：先寫或先清 `storage.local`，持久化就不依賴 `storage.sync`——它在 Firefox 可能 reject（沒登入帳號、Android 的限制、或偏好設定關閉）。sync 的寫入／移除是盡力而為，而且獨立包起來，失敗也擋不住本機那一步；所以解除綁定一定會清掉本機的 familyId 與認證資訊（auth token 與到期時間）。
- **只存本機的偏好**：家庭書櫃的檢視模式只是本機的介面偏好，不該跟著使用者換裝置，所以不鏡像到 `storage.sync`。只有剛好存成 `"row"` 才讀成 `"row"`，其他值（包括沒設定、舊資料）一律讀成 `"grid"`。自動同步頻率也一樣只存 `storage.local`：每台裝置自己決定多久爬一次書櫃，Chrome 上設的值不會出現在 Firefox 或手機上；沒設定或值不認得時讀成「每天」。同步封存書籍、家庭書櫃按鈕大小和兩個書櫃的排序也只存 `storage.local`，讀到不認得的值時各自回到預設（關閉、中、預設排序；排序的舊值 `title`／`author` 會讀成 `-asc` 形式）。按鈕大小的型別與判斷只在 `floatingIconSize.ts` 定義一次，content script 的浮動按鈕也從那裡 import。這些偏好寫入失敗時畫面都不退回舊值：Dialog 直接寫 `storage.local` 幾乎不會失敗（只有擴充功能的 context 失效時才會，那時整個 Dialog 已經不能用了），真的失敗也只是這次的選擇沒存下來，比畫面在使用者眼前跳回舊值好。
- **`safeStorageGet`**（`safeStorage.ts`）：擴充功能重新載入／更新／停用後，留在頁面上的 content script 變成孤兒，`browser.storage.local` 的參照斷掉，任何 `.get(...)` 都會拋出 `Extension context invalidated`，沒被接住的 `await` 就變成 uncaught promise rejection。`safeStorageGet` 先檢查 context，再吞掉任何讀取錯誤，回傳空物件，呼叫端就落回各自的預設值。刻意吞掉錯誤，所以它只用於盡力而為的**讀取**：讀取失敗必須讓使用者知道的地方不要用它，而且呼叫端拿到 `{}` 時必須仍然正確。
- **storage key 前綴**：擴充功能的 storage key 一律以 `moo:` 開頭，與 PWA 一致。v1.4.0 起曾有一次性遷移把舊的無前綴 key（例如 `userId`、`familyId`）改名，已在 #346 移除；殘留的舊 key 與 `moo:storageMigrated` 旗標是無害的孤兒，不另外清除。email 是例外（#359）：擴充功能已不再儲存 email，背景的 `onInstalled`（安裝與每次更新都會觸發）會一併移除 `moo:userEmail` 與舊的無前綴 `userEmail`（`extension/src/background/purgeStoredEmail.ts`）。已接受的殘餘風險：2026 年 6 月前就沒再開過的 Chrome 安裝更新後讀不到舊 key，會回到引導畫面，資料都在伺服器上，按「開始使用」就重新連回原家庭（舊的自訂 API 端點也讀不到，自架家庭要先重新設定端點）；Firefox 版一開始就用 `moo:` key，不受影響。

#### 書單同步

`extension/src/sync/`：把讀墨書櫃的爬取結果上傳成個人書單。

- **觸發時機**：(A) 個人書櫃掛載時的自動完整同步，依使用者設定的 `autoSyncInterval`（每天／每週／每月／永不，`never` 等於關閉）對照 `LAST_SYNC_AT_KEY` 節流；(B) 手動同步按鈕，不節流。兩者都只做一次完整的爬取加上傳。以 `chrome.alarms` 排程的背景同步已移除（見〈背景 Service Worker 與訊息〉）。
- **爬取警告每次同步重置**：讀墨書櫃是可以開好幾天的單頁程式，綁在頁面載入的「只警告一次」狀態一輩子最多只會出現一次。所以 `syncBooks` 每次同步都呼叫 `resetScrapeWarnings`：只要還在走降級路徑（舊版 selector、被拒絕的 bookId），每次同步都要在 console 看得到，而不是只有第一次。
- **斷路器**（`syncBreaker.ts`）：爬取結果看起來像讀墨改版（新的 id、selector 壞掉），而不像使用者的書櫃時，拒絕上傳。適用於每一條上傳爬取結果的路徑——`sync/syncUpload.ts`（`syncBooks` 擷取後的讀取與 409 重讀；擷取前那次讀取只固定移除候選，不經過斷路器）與 `dialog/onboardingBooksUpload.ts`（`useAutoSetup` 使用）——不論這次爬取完不完整。伺服器上 bookId 是真正讀墨書籍 id 的書至少 50 本（`SYNC_BREAKER_MIN_SERVER_BOOKS`）才會啟用；這次爬取找回的比例低於一半（`SYNC_BREAKER_MIN_OVERLAP_RATIO` = 0.5）就暫停，顯示「讀墨可能改版了，已暫停同步書櫃」。這次爬取沒涵蓋封存書時，已封存的書不列入計算。
- **書的 id 變了**（#236，`renamedBooks.ts`）：讀墨替一本書換了新 id 時，累加式的合併會讓舊 id 永遠留在新 id 旁邊。這一步把這種舊項目換成新 id 的那一筆，條件是沒有其他原因能解釋舊 id 為什麼不在完整的爬取結果裡。完整爬取裡少了某本已存的書，也可能是封存了（而這時封存書不同步）、借出去了、或退款／刪除了；光看爬取結果分不出這幾種情況，所以換 id 只處理書名一對一對上一個全新 id 的那一筆，其他一律留給下一步。換 id 與下一步的移除共用同一道閘門（完整的爬取；有家庭時要拿到借閱清單），其餘幾種情況則靠 fiber bridge 公布的讀墨書櫃 id（見〈Content Script 的擷取與注入〉）分開。它是 `dropResolvedLegacyBooks`（短的舊 id，#234）的一般化版本；後者仍在 `mergeBooks` 裡執行，這一步在它之後、對合併後的清單執行。有家庭時，同步前先抓一次借閱清單，借出中的書不參與換 id 的判斷。
- **移除讀墨上已經沒有的書**（#241，`pruneBooks.ts`）：退款或從讀墨書櫃刪掉的書，累加式的合併會讓它永遠留在個人書櫃（分享中的話也留在家庭書櫃）。`resolveForUpload` 在換 id 之後執行 `pruneRemovedBooks`，保留集合是三者的聯集：這次爬取到的 id、fiber bridge 從讀墨書櫃元件讀到的 id（`itemList` ∪ `archivedLibraryItems` ∪ `loanedLibraryItems`，見 `data-moo-library-ids`）、MooFamily 借出中（LENT、使用者是擁有者）的書。只有**這台裝置開始擷取之前**伺服器就有的書（擷取前先讀一次伺服器書單，只用來固定候選範圍；上傳仍以擷取後的讀取為準，所以擷取期間的儲存——包括家庭書櫃偏好——不會被同步蓋掉；409 重讀也沿用這份候選範圍）、bookId 是真正讀墨 id、又不在保留集合裡的書才會被移除；擷取期間或 409 重讀時才出現在伺服器上的書（別的裝置剛新增的）絕不會被移除；但分頁開著沒重新整理時，別的裝置在擷取前那次讀取之前就同步上去的書，可能因為這個分頁的 `itemList` 還沒更新而被移除——受單次上限約束，下次同步會加回來：原本不分享的書維持不分享，原本分享中的書則回到預設值（不分享；打開「新書預設開放」時則是開放，見下一項），屬已接受的殘餘風險；重新整理讀墨頁面就不會再發生；同步封存書關閉時，伺服器上標為封存的書也一律保留（與換 id 相同）；短的舊 id 交給 #234，這裡不碰。閘門：爬取完整；有家庭時拿到借閱清單；bridge 的 id 讀得到，而且涵蓋這次爬取到的每一本（不涵蓋就代表兩份資料對不起來，不移除，只留 console 警告）；這次爬取一本都沒爬到時也不移除。上限：一次同步最多移除真正 id 書籍數的 25%（`PRUNE_MAX_RATIO`），至少允許 2 本（`PRUNE_MIN_ALLOWANCE`，避免只有幾本書的書櫃永遠移除不了），但不超過 20 本（`PRUNE_MAX_PER_SYNC`）；候選超過上限就整批不移除。頁面本身能改寫 `data-moo-library-ids`，但能在讀墨頁面執行腳本的人本來就能改寫頁面上的書櫃資料、看到傳到 `document` 的按鍵（見〈浮動按鈕與 Dialog 外殼〉）；這份 id 只當保留集合，最壞結果是每次同步最多把 20 本書連同分享設定從個人書櫃移除，屬已接受的殘餘風險。移除後個人書櫃顯示「已移除 N 本讀墨書櫃裡已經沒有的書」，有分享中的再註明其中幾本原本設為分享。引導畫面的第一次同步不執行這一步。**已驗證的前提**（#253，108 本的帳號）：讀墨在畫出書卡之前就把本機資料庫（IndexedDB `read-db`）同步完——無痕模式重新登入、第一次載入書櫃且未捲動時，`itemList` 與本機資料庫的筆數都已是全部；所以「本機資料庫只同步了一半、`itemList` 與書卡數一起偏少而彼此吻合」的情境在這個規模下不會出現。更大的書櫃沒有驗證，這個情境也只可能發生在新瀏覽器首次登入後的第一次同步，單次最多移除 20 本，列為已接受的殘餘風險。**未驗證的前提**：讀墨上借出中的書是否仍留在 `itemList`（驗證時的帳號沒有借出中的書）。保守處理：取三份清單的聯集，任一份不是陣列就當作讀不到、整步不移除；MooFamily 的借出紀錄另外保護。
- **新書預設開放**（#238，`autoShare.ts`）：使用者在設定打開「新書預設開放」後（存在伺服器獨立的 `newbookdefault:{id}`，`GET /api/user/:id/books` 回傳時合併成 `newBookDefaultShared`，見〈個人開放設定 API〉），同步會把伺服器上沒有的新書設為開放再上傳。這個開關本身就是使用者的同意，所以它是「預設不開放」與 Inv-3 唯一允許的例外（`.claude/rules/security-ux-invariants.md`）。「新書」是：這次爬取到、這次上傳所根據的讀取裡沒有、不是換 id（#236）或舊 id 解析（#234）的目標、書名不和這次沒爬到的已存書相同、還沒開放，而且沒有封存的書：打開同步封存書之後，第一次上傳的封存書不會被自動開放。書名和這次沒爬到的已存書相同的新 id，可能是讀墨換了 id、但書名不唯一而配不上的同一本書（`deferRenameCandidates` 用的是同一個判斷），所以一律不自動開放。「新書」因此不只是新買的書：同步封存書關閉時從封存移回書櫃的書、先前沒爬完而漏掉的書，也都算，設定畫面與網站的說明照這個範圍寫。這一步在 `resolveForUpload`（換 id 與移除）之後執行，絕不放進 `mergeBooks`：換 id 與舊 id 解析只會把 TRUE 帶到新 id、從不清掉，若先把新 id 設成開放，使用者刻意不分享、只是被讀墨換了 id 的書就會被分享出去。不會自動開放的情況：第一次同步（伺服器沒有紀錄，或紀錄裡一本書都沒有）；以不分享狀態從伺服器書單移除過、id 記在 `removedUnsharedBookIds` 的書（見〈個人開放設定 API〉）；一次超過 `AUTO_SHARE_MAX_NEW`（100）本新書時整批都不開放，個人書櫃提示「這次新增了 N 本書，一次超過 100 本不會自動開放」，console 只留數量的警告。有自動開放時，個人書櫃顯示「已自動開放 N 本新加入個人書櫃的書給家人，也會出現在你的公開書櫃」：公開書櫃收錄所有開放的書（`selectionMode: "all-shared"`），所以這些書也會出現在使用者現有的公開書櫃連結上。409 重讀時，設定值與新書都以重讀的紀錄重新計算。引導畫面的第一次同步不經過這一步，PWA 不能爬取書櫃，也不執行。設定畫面在開啟時讀一次 `GET /api/user/:id/books` 取得現值，切換時立刻儲存，失敗就切回原值；回 404 時停用開關並顯示「伺服器尚未支援這個設定」。伺服器上還沒有書單紀錄時（`GET` 回 `data: null`，第一次同步才會建立；`GET` 只在紀錄存在時合併這個設定），開關同樣停用，顯示「同步一次書單後就能設定」，也不送出儲存。被移除步驟移除（包括誤刪）、下次同步才加回的書（見上一項）：移除時是不分享的，Worker 把它的 id 記在 `removedUnsharedBookIds`，加回時 Extension 跳過這些 id，書維持不分享；移除時是分享中的，加回時照一般規則處理，設定打開時會再被自動開放——這是刻意的，不另開新的自動開放途徑。已接受的殘餘風險：讀墨同時改了一本書的 id 和書名時，新 id 和新買的書無從分辨，會被自動開放。
- **自動偵測已歸還的書**（`autoReturn.ts`）：讀墨的書借出後會從擁有者的書櫃頁整個消失，歸還或收回後再出現。借出的書不會從分享清單被移除：移除步驟的保留集合包含讀墨的借出清單（`loanedLibraryItems`）與 MooFamily 的 LENT 紀錄，所以「重新出現在新的爬取結果裡」是可靠的「書回來了」訊號：目前使用者擁有、而且有進行中 LENT 申請的書再次出現，就把該申請標成 RETURNED。防單頁程式殘留：剛借出的書可能還留在沒重新整理的頁面 DOM 裡，所以更新時間不到 `minLentAgeMs`（預設 30 分鐘）的 LENT 申請會略過，`updatedAt` 解析不了的也略過（保守處理）。這一步在上傳之後、盡力而為，不影響同步結果；它沿用上傳前抓的借閱清單，那次抓取失敗就略過。

#### Content Script 的擷取與注入

`extension/src/content/` 的書櫃擷取（`scraper*.ts`、`scrapeResult.ts`、`fiber-bridge.ts`、`fiber-data.ts`、`readmoo-dom.ts`）。只讀頁面上看得到的書單資訊，見〈2.1 Content Script〉。

- **fiber bridge**：content script 跑在瀏覽器的 isolated world，看不到 DOM 元素上的 React fiber 屬性（`__reactFiber*`）。`fiber-bridge.js` 以 `<script>` 標籤注入頁面的 main world，與頁面共用 JS context，才讀得到 fiber 內部。兩邊透過共用的 DOM 溝通：bridge 直接把資料蓋成 `.library-item` 上的屬性——`data-moo-book-id`（`libraryItem.book.id`）、`data-moo-cover-url`（中尺寸封面，沒有就用小尺寸）、`data-moo-author`、`data-moo-category`（`main_subject`，把讀墨的 `\\` 分隔字元換成單一 `\`，與讀墨書籍頁一致，最多 50 字）——content script 直接讀屬性，不需要用 CustomEvent 傳資料或比對快取。請求與完成只用 `moo-request-fiber-data`／`moo-fiber-data` 兩個事件通知，bridge 絕不把錯誤拋進頁面；讀不到的卡片改走 hover 路徑。bridge 也在 `<html>` 上公布 `data-moo-list-total`：書櫃在目前篩選下的項目數（書櫃元件的 `filteredItemList.length`），讀不到時就移除，過時的值不會留下；`fiber-data.ts` 的 `ATTR_LIST_TOTAL` 必須與 bridge 的值相同（兩者在不同的 bundle）。同一次請求裡，bridge 還在 `<html>` 上公布 `data-moo-library-ids`：讀墨替這個帳號保存的每一本書的 `book.id`（自有、封存、借出、借入），以逗號串接、去重複；取自書櫃元件的 `itemList`、`archivedLibraryItems`、`loanedLibraryItems` 三份清單的聯集，三份都必須是陣列，否則移除屬性（讀不到）；三份都是空陣列時是空字串（確定沒有書，與讀不到不同）。`fiber-data.ts` 的 `requestLibraryFiberData` 先清掉兩個屬性再發出一次請求、同時讀回總數與 id（只保留 `isRealBookId` 的 id），`ATTR_LIBRARY_IDS` 同樣必須與 bridge 相同。這份 id 只當保留集合用（`ScrapeResult.libraryIds`，見〈書單同步〉的「移除讀墨上已經沒有的書」），絕不用來新增書——借入的書也在裡面。注入 bridge 與請求蓋屬性的程式（`fiber-data.ts`）由書櫃擷取（同步）與借出流程的搜尋共用，蓋屬性的邏輯只有一份，不要複製。
- **書的 id 從哪裡來**（`scraper-ids.ts`）：依序試 fiber bridge 的 `data-moo-book-id`、（hover 之後的）閱讀器連結 href、`.privacy` 元素。每個來源都必須給出真正的讀墨書籍 id（`isRealBookId`，12 到 32 位數，規則在 `shared/src/api/bookId.ts`，Worker 的 PUT books 邊界也用同一份）：其他命名空間的 id 會上傳一筆永遠對不上那本書的幽靈項目。來源若拿到不是真正 id 的值，就以 null 結束搜尋、略過這本書。卡片要觸發 hover 才會出現 `.openbook-overlay` 動作層（舊主機上叫 `.openbook`）；在兩個主機之間搬過位置的 selector 經 `queryWithLegacyFallback` 處理。「借入」的卡片不是使用者自己的書，直接忽略；自己的書讀不出來時，這次擷取就算不完整。
- **擷取完整的定義**（`scrapeResult.ts`）：只有**確定**看過使用者擁有的每一本書，擷取才算完整：讀墨自己在目前檢視下的項目數讀得到，而且等於讀到的卡片數；沒有略過任何一本自己的書；分頁沒有停在硬上限；（同步封存書時）封存書的擷取也完整。「捲動不再出現新卡片」**不算**確認——下一頁載入慢的時候看起來一模一樣。只有完整的擷取才能用來斷定某本已存的書不在讀墨上了（見〈書單同步〉的「書的 id 變了」與「移除讀墨上已經沒有的書」）；不完整的擷取仍會上傳，只是以累加方式。
- **分頁**（`scraper-pagination.ts`）：讀墨用 window 層級的無限捲動，捲到頁面底部才載入下一批（約 200 本）。迴圈一直捲到不再出現新卡片為止，並回報進度，以 100 次捲動的硬上限當安全閥；等待新卡片時，`scrollHeight` 的變化（讀墨載入時的 loader 或 spacer）也算「還在載入」，會重設閒置計時。
- **只警告一次的狀態**（`readmoo-dom.ts`）：`readmoo-dom.ts` 是所有擷取讀墨頁面的程式共用的底層，本身不依賴其中任何一個：借出流程（`readmoo-lend.ts`／`readmoo-search.ts`）用它找卡片（`findBookCardInLibrary`）與等待 DOM（`waitForElement`）；擷取程式（`scraper.ts`）用它做舊 selector 的備援（`queryWithLegacyFallback`）與降級警告（`warnOnce`）；同步的入口（`sync/syncBooks.ts`、`dialog/useAutoSetup.ts`）每次擷取呼叫一次 `resetScrapeWarnings()`。它最初是為了打破 `readmoo-lend` ↔ `readmoo-search` 的模組循環而抽出來的。警告的去重狀態是模組層級的，所有使用者共用；`resetScrapeWarnings` 是唯一的重置點，而且必須由擷取的**入口**呼叫，不能放進 `scrapeBooks`——同一次擷取裡它可能執行不只一次（例如書櫃加封存書），會在中途重新啟用去重，印出重複的警告。去重以 label 為單位而不是逐元素：一頁書櫃有 25 張以上的 `.library-item` 卡片，逐張警告會在 console 洗出 25 行相同的訊息、淹沒真正的錯誤；每次同步每個 label 一行，就足以回答這些警告存在的唯一問題——「這條降級路徑是否仍在被使用」。

#### 浮動按鈕與 Dialog 外殼

`extension/src/content/index.ts`、`mobileLayout.ts`、`shellStyles.ts`、`pendingBorrowBadge.ts`：content script 在讀墨頁面上注入「家庭書櫃」浮動按鈕，點擊後掛載 Dialog。

- **兩種 bundle**：content script 本身是輕量的 IIFE；Dialog 是 code-split 的模組（`content-dialog.js`），isolated world 的 content script 無法照常解析 ES module import，所以透過 `runtime.getURL()`（web-accessible resource）動態載入。爬蟲模組刻意同時打包進 content script（經 `profileCache.ts`）與 ESM 的 content-sync 模組（經 `syncBooks.ts`）：它沒有狀態，只讀 DOM、回傳資料，沒有共用的可變狀態，所以重複打包是安全的。
- **Shadow Root 外殼**：light DOM 上的 host（`moo-family-bookshelf-host`）擁有一個 closed Shadow Root，backdrop、Dialog、手機版關閉圖示與 React 掛載點都在裡面，與讀墨的 CSS 隔離。closed 模式下 `host.shadowRoot` 是 `null`，讀墨頁面 main world 的腳本無法再經由 `.shadowRoot` 取得 Dialog 樹裡的節點，也無法對裡面的控制項呼叫 `.click()`；content script 自己保留 `attachShadow` 回傳的 root，沒有任何地方讀 `host.shadowRoot`（#362）。Chromium 實測，`.shadowRoot`、合成的 `.click()`、`document.getAnimations()`、`elementFromPoint`、selection 的 anchor、`focusin` 的 target 從頁面看都只到 host。兩張 QR Code 圖片（連結手機的 QR 含 `qrt`，邀請 QR 含同步碼，都是 data URL）從 #363 起畫在擴充功能來源的 iframe 裡（見下一項），不在這個 shadow tree 裡；iframe 裡的圖片仍設 `draggable={false}`，外框 `.moo-secure-frame__qr` 仍設 `user-select: none`，使用者自己拖曳或反白也帶不出去。殘餘的管道見「Shadow Root 外殼：已接受的殘餘風險」。E2E 的後果：Playwright 的 selector 穿不過 closed Shadow Root，所以既有 spec 跑在 `build-e2e.ts` 另外產出、改回 open 的 `dist-e2e-open/`，只有驗證頁面腳本碰不到 Dialog 的 spec 跑真正的 `dist/`（見 `.claude/rules/test.md` → E2E tooling）。host 是普通的 div，不建立 stacking context、沒有 transform，所以裡面 `position: fixed` 的 backdrop／Dialog 仍然蓋住整個 viewport。「Dialog 是否已開啟」看的是這個 host：Dialog 在它的 shadow tree 裡，`document.getElementById` 找不到。
- **擴充功能來源的 iframe**（#363，`extension/src/secureFrame/`）：帶密鑰的那一塊畫面改在 `secure-frame.html` 裡渲染——PIN／圖形輸入（重新登入驗證、設定或變更驗證方式、輸入目前的 PIN／圖形）、兩個同步碼輸入欄位（引導畫面、還原流程）、建立家庭後與設定頁的同步碼文字、OTP 驗證碼、兩個 QR Code 圖片。標題、說明與複製／顯示／切換等按鈕留在 Shadow Root；按鈕不帶資料，複製仍由 content script 寫剪貼簿。iframe 是另一個 origin 的文件：頁面讀不到它的 DOM，在裡面按的鍵與指標事件也不會 compose 到頁面的 `document`。每一塊畫面在 `frames.tsx` 有一個對應的元件，iframe 的 `title`、view 與握手前的高度只定義在那裡。
  - **握手**：宿主元件 `SecureFrame` 為每個 iframe 產生一次性的 nonce，放在 frame 網址的 hash 裡；iframe 在 closed Shadow Root 裡，頁面讀不到它的 `src`。第一次 `load` 後，宿主建立 `MessageChannel`，以擴充功能自己的 origin 為 targetOrigin（不是 `*`）送出帶 nonce 的 hello，並交出其中一個 port。iframe 只接受同時符合這些條件的 hello（`protocol.ts` 的 `acceptHello`）：`source` 是 `window.parent`；origin 屬於 manifest 的 `web_accessible_resources[].matches`，或等於擴充功能自己的 origin（Dialog 開發頁）；schema 正確；nonce 與自己網址 hash 裡的相符。之後所有往來只走這條 port，兩邊每則訊息都經 type guard 檢查；iframe 從不呼叫 `window.parent.postMessage`，`postMessage` 只出現在 `protocol.ts`。輸入的密鑰經 port 交回 content script，API 呼叫的位置不變。
  - **被干擾時**：iframe 第二次觸發 `load`（被重新載入或導走），或 iframe 掛上之後 10 秒內沒有收到 `ready`（計時從掛上就開始，不等 `load`：`load` 若在監聽器掛上前就觸發、或根本沒觸發，同樣會變成干擾提示而不是停在空白），宿主就關閉 port、拿掉 iframe，在原位置顯示「畫面被干擾，請關閉後重新開啟」。
  - **焦點**：`SecureFrame` 的 `autoFocus` 預設關閉，與被取代的欄位一樣，開啟畫面時不搶焦點；`PinInput` 換步驟後的重新 focus 與「重新設定」在 iframe 裡照常運作。
  - **測試**：jsdom 跑不了跨來源 iframe 與握手，元件測試由 `extension/tests/setup.ts` 把 `SecureFrame` 換成直接渲染對應 view 的替身。E2E 有兩種讀法：改回 open 的副本用 `frameLocator` 進 iframe；真正 closed 的 `dist/` 從 `page.frames()` 依網址找到 iframe（設定頁同時有同步碼與邀請 QR 兩個 frame，網址相同，再依內容挑）。
- **Shadow Root 外殼：已接受的殘餘風險**：closed Shadow Root 不是安全邊界。上一項移進 iframe 的畫面不受以下管道影響，留在 Shadow Root 裡的仍然受影響（Chromium 實測，Firefox 未實測）：Shadow Root 裡其他輸入框（搜尋、顯示名稱、公開書櫃設定等）的 keydown／input 事件仍會傳到 `document`；Chromium 的 `window.find()` 會搜尋 closed tree 裡的文字，頁面能逐字猜出公開書櫃連結這類仍留在 Shadow Root 的純文字；使用者自己反白的 Shadow Root 文字可經 `getSelection().toString()` 讀到；`document.execCommand("insertText")` 可以寫進 Shadow Root 裡目前有焦點的輸入框（不會送出）。iframe 也擋不住被入侵的頁面自己在 Dialog 上方畫一整片假畫面，或是在使用者點進 iframe 時（頁面的 `window` 收到 `blur`）把焦點搶回頁面上隱藏的輸入框，讓之後盲打的按鍵進到頁面——兩者都是偽裝畫面這一類，使用者看得到異狀。頁面若在 iframe 第一次載入前就把它導走，宿主的 hello 會因 targetOrigin 不符被瀏覽器丟掉，要等 10 秒沒收到 `ready` 才會換成干擾提示，這 10 秒內 iframe 裡顯示的是頁面自己的內容；Chromium 實測這條走不通——closed shadow tree 裡的 iframe 不會出現在 `window.frames`（`window.length` 是 0）、`document.querySelectorAll("iframe")` 找不到、resource timing 也沒有它的項目，頁面拿不到它的 WindowProxy，也讀不到網址 hash 裡的 nonce；Firefox 未實測，10 秒逾時就是為它留的保底。另一個已接受的取捨（#422）：同步碼輸入欄位自己持有文字，宿主會把 `value` 經 port 推回來。為了分辨這是宿主自己改的值還是舊回報遲到的回聲，`change` 訊息帶遞增的序號，宿主在 props 裡回傳最後套用的序號（`appliedSeq`），view 只在這個序號追上自己送出的最新序號、而且值與欄位目前的文字不同時，才採用宿主的值；回報的值重複（極快地打 `a`、`b`、Backspace）也不會讓欄位閃回舊文字。取捨是宿主還沒追上時自己改的值（同步碼殘留的預填）先不採用，還在途中的回報會把使用者的文字帶到宿主，兩邊一致；追上之後宿主改的值照常採用。
- **拆除順序**（`disposeDialogShell`）：先卸載 React root（effect 的 cleanup 在 DOM 還掛著時執行），再釋放 Dialog 的斷點 watcher，最後移除 host。切換關閉、點 backdrop、手機版關閉圖示都走這同一個函式，三步的順序只存在一處；浮動按鈕與它的數字標記是另一個 light DOM 元素，不受影響，按鈕自己的斷點 watcher 也必須保留，按鈕才會在之後的斷點變化時重新定位。只移除 host 會讓 React root 洩漏（它的 effect 繼續執行）；卸載失敗也絕不能擋住其餘的 DOM 拆除。開啟新的 Dialog 前會先保險地卸載殘留的 root handle；動態 import 完成前 Dialog 若已被關掉（掛載點已不在 DOM 上），就跳過掛載，否則會留下一個沒人持有的 root。擴充功能 context 失效時改走 `teardownMooFamilyUI`：先卸載 React root，再停掉所有斷點 watcher 並移除全部 UI；content script 一律用它而不是直接呼叫 `cleanupMooFamilyUI`，matchMedia listener 才不會殘留。
- **外殼的起始樣式**（`shellStyles.ts`）：一份很小、自成一體的樣式表，不是完整的 `styles.css`。Shadow Root 一建立就注入（`index.ts` 的 `toggleDialog`），早於 backdrop／Dialog 加入，外殼一出現就有樣式；完整的 scoped 樣式表要等 `mountDialog` 動態 import `styles.css` 後才注入，這些結構規則若只放在那裡，外殼會先閃一下沒有樣式的畫面。它只放四個外殼元素的**靜態**結構屬性：`applyDialogLayout`／`applyBackdropLayout` 依斷點設定的屬性（位置、尺寸、圓角、高度）與關閉圖示的 `display` 一律由 JS 以 inline style 設定，刻意不寫進這裡——inline 雖然會贏，但留著過時的靜態值只會讓人困惑。這個模組必須不 import 任何東西（不含 `styles.css`、不含共用模組），打包進 content script 的 IIFE 時才不會把 Dialog bundle 或完整樣式表一起帶進來；注入時以標記屬性保證同一個 root 不會注入兩次。元素的 id 保留給 `getElementById` 與 E2E selector 使用。
- **桌面與手機版面**（`mobileLayout.ts`）：content script 不在 React 裡，所以以 `window.matchMedia(MOBILE_MEDIA_QUERY)`（767px，`extension/src/hooks/breakpoints.ts`）而不是 `useMediaQuery` 驅動；這裡註冊的每個 listener 都有記錄，Dialog 關閉、按鈕移除或 context 失效時都能拆掉（`stopAllMobileWatchers`）。桌面維持原本的置中卡片，只有主畫面固定 `height: 80vh`（等於卡片的 max-height 上限，切換分頁時高度不跳動），引導／載入畫面依內容決定高度（上限 max-height、下限容器的 min-height），短內容下方不會留一大片空白。手機版 Dialog 全螢幕，backdrop 隱藏（它只會被不透明的 Dialog 蓋住）。
- **浮動按鈕的位置**：桌面在 viewport 右下角；手機版同樣在右下，但抬高到讀墨底部分頁列之上、間隔 12px。底部列的高度在執行時量測：先試讀墨真正的 `.main-menu`，再試同一個元素上的 `.nav.nav-justified`，最後是幾個通用的猜測，每個候選都必須寬度至少占 viewport 的 60%、底邊距 viewport 底部不超過 4px，才當成底部列；都不符合時改用依寬度決定的固定高度（寬度 ≤ 370px 的雙行列 76px，否則單行列 55px）。
- **按鈕樣式**：hover 樣式在所有環境都注入，包在 `@media (hover: hover)` 裡，觸控裝置點一下後 hover 樣式才不會卡住；`cleanupMooFamilyUI` 只移除按鈕、不移除這個 `<style>`，所以靠模組層級的旗標避免重複注入。開發環境另有環境標示樣式（`injectEnvStyle`）。浮動圖示大小的設定改變時直接更新現有按鈕，不重新注入，以免失去數字標記的狀態。
- **待處理借閱數字的請求**（`pendingBorrowBadge.ts`；何時查詢見〈讀墨帳號確認（已加入家庭時）〉）：刻意用裸的 `fetch`，因為 content script 是輕量的 IIFE bundle，不能把 `ApiClient`（認證更新、端點驗證、去重）拉進來——它在 code-split 的 Dialog 模組裡。不過儲存的伺服器位址仍會先經過與 `ApiClient` 相同的 `validateEndpointUrl`（它放在 `shared/`，不屬於 `ApiClient`）；被它拒絕的位址就不送出請求，權杖因此不會送到 Dialog 也會拒絕的位址。回應的信任因此交給 `sanitizeBorrowRequests`，與 `ApiClient.listBorrowRequests` 同一道邊界，這個端點的兩個用戶端對不可信（BYO）後端回應的處理不會分歧。信封本身也不可信：只從真正的物件上讀 `.data`，陣列與元素的驗證交給 sanitizer；任何不可用的內容都降為空清單（不顯示數字），不拋錯。

#### 讀墨借出自動化

`extension/src/content/readmoo-lend.ts`、`readmoo-search.ts`（借出流程的 Scope B）：書主核准 MooFamily 的借閱申請時，替他依序點過讀墨原生的借出流程。

- **步驟**：1. 在讀墨書櫃頁（`next.readmoo.com/read/#/library` 或 `read.readmoo.com/#/library`）找到那本書的卡片；2. 開啟書籍詳情視窗；3. 點「借出」打開借出對話框；4. 選擇與 `readmooName` 相符的家庭成員；5. 使用者**自己**按下讀墨原生 `window.confirm` 的確定；6. 等借出對話框關閉（代表借出完成）。
- **絕不攔截原生的確認視窗**：全域覆寫 `window.confirm` 會弄壞讀墨其他無關的功能，讓使用者自己按確定，整合才安全。
- **找書靠讀墨自己的搜尋**：讀墨書櫃是無限捲動，要借出的書可能根本不在目前渲染的 DOM 裡。`readmoo-search.ts` 操作讀墨內建的搜尋視窗，用書名把書櫃篩到目標書，再重新蓋上 fiber id，以 `bookId` 精確比對卡片。嚴格模式：就算搜尋只回一張卡，也要求 `data-moo-book-id` 完全相符，不以書名退而求其次（產品決定）。輸入框是 React 受控元件，所以用原生的 value setter 設值再送出 `input` 事件，直接指定 `input.value` 會被 React 忽略。
- **還原使用者原本的搜尋**：`previousQuery` 讓呼叫端在整個流程結束後把書櫃還原成使用者原本的搜尋狀態（有關鍵字就重新套用，沒有就送出空查詢清掉篩選）。**時機**：成功路徑上不能在中途還原——還原會重新渲染書櫃、讓這張卡片的節點脫離 DOM，而之後開啟詳情視窗的點擊必須打在仍掛著的卡片上；呼叫端只在整個流程結束後還原。搜尋成功之後的任何失敗則由這裡負責還原，使用者不會被留在篩選過的書櫃；**順序**：先關掉殘留的視窗再還原（`clickLendButton` 可能已經開了詳情視窗，還原會重新渲染書櫃，仍開著的視窗會疊在上面）。還原是盡力而為，絕不蓋掉原本要重新拋出的錯誤。
- **書櫃網址跟著目前的主機**：每次呼叫才解析（不是模組常數），新舊兩個主機都讓使用者留在原本的網站，兩者的路徑前綴不同（`/read/#/library` 與 `/#/library`）。
- 每個函式都沒有狀態，可以各自測試；逾時可以注入，失敗一律拋出 `ReadmooLendError`。`readmoo-dom.ts` 是兩者共用的底層，`readmoo-lend.ts` 再匯出其中的 DOM 基本函式，打破 `readmoo-lend` ↔ `readmoo-search` 的模組循環。借出對話框的成員讀取與點選、關閉對話框的函式和預設逾時（`READMOO_LEND_DEFAULTS`）放在 `readmoo-lend-dialog.ts`，由 `readmoo-lend.ts` 轉出，呼叫端一律從 `readmoo-lend.ts` 引入；`readmoo-lend-dialog.ts` 不得引入 `readmoo-lend.ts`，以免形成循環。

---

## 十五、Worker 後端的設計理由

`worker/src/` 的程式碼註解最多兩行，較長的設計理由集中在本節、本文件其他已有的小節（「2.4 Cloudflare Workers (API)」、「三、資料流程」、「已接受的殘餘風險」、「PWA 登入驗證機制」、「十一、個人公開書櫃分享」），以及 `.claude/rules/backend.md`（API Design、KV Key Patterns、Route handler invariants），註解以「`docs/architecture.md → <小節名稱>`」或「`.claude/rules/backend.md → <小節名稱>`」指回這裡。

### 路由層（routes/）的設計理由

#### 每帳號寫入上限能擋住什麼

以 userId 計數、每小時一個窗口的寫入上限共有七組，都疊在 per-IP 限制之上：`verify-write`（`worker/src/routes/verify.ts` 的 `VERIFY_WRITE_LIMIT`，每小時 30 次，OTP／prompted／qr-token 三個寫入端點共用）、`verify-set`（同檔的 `VERIFY_SET_LIMIT`，每小時 30 次，`PUT /api/user/:id/verify` 專用，#396）、`family-write`（`worker/src/routes/family.ts` 的 `FAMILY_WRITE_LIMIT`，每小時 30 次，六個家庭寫入端點共用）、`public-shelf`（`worker/src/routes/publicShelf.ts` 的 `PUBLIC_SHELF_WRITE_LIMIT`，每小時 30 次，建立／更新／重設網址／關閉四個端點共用）、`put-books`（`PUT` 與 `PATCH /api/user/:id/books` 共用，每小時 30 次）、`family-prefs`（`PUT /api/user/:id/family-prefs`，每小時 60 次），以及 `new-book-default`（`PUT /api/user/:id/new-book-default`，每小時 60 次）。

- **它們限制的是單一已驗證帳號的消耗速度，不是硬上限**。userId 由 email 推導、不是憑證，自己產生一個帳號幾乎沒有成本；這些上限把「一個帳號幾分鐘內燒光免費方案每日 1,000 次 KV 寫入額度」拉長成數小時，並逼攻擊者每用完一份額度就得再建立（加入）一個帳號，但不能單獨讓額度變得安全。真正的全域上限要靠邊緣層（Cloudflare WAF Rate Limiting，見「運維層的補強」與 `worker/DEPLOY.md` →「免費方案額度與濫用防護」）。
- **計數器本身也寫 KV**：每小時的計數器記在 KV，每放行一個請求寫一次（被 429 擋下的請求不寫）。per-IP 計數器在正常部署下由原生 Rate Limiting binding 計數、不寫 KV；只有缺少 binding、退回 KV 計數時，它才在驗證身分之前每個請求寫一次，這時無視 429 持續送出的未驗證流量仍在這些上限管不到的地方消耗額度（每分鐘最多 60 次，約 17 分鐘耗盡當日額度）。
- **量級**：`verify-write` 的三個端點各只寫一次 KV，連同計數器每小時約 60 次寫入，持續一整天約 1,440 次（退回 KV 計數 per-IP 時每小時約 90 次）。`verify-set` 的每次 PUT 連同計數器寫入 2 次（改成驗證碼或不驗證）到 4 次（設成 PIN／圖形，另外刪除 2 個 key），每小時最多約 120 次寫入。`public-shelf` 以建立／更新（清單與快照各寫一次）計，連同每帳號計數器約每小時 90 次寫入、一天約 2,160 次（退回 KV 計數 per-IP 時約每小時 120 次、一天約 2,880 次）；沒有這道上限時，單一已驗證帳號約 8 分鐘（退回 KV 計數時約 6 分鐘）就能燒光當日額度，有了它約需 11 小時（退回時約 8 小時）。
- **`family-write` 的 30 次是請求數，不是 KV 寫入數**：一次放行的 Owner 移除成員會寫墓碑、寫家庭紀錄、刪除目標的 `member:{uid}`、`auth:{uid}` 與清單上每一把 `token:{hash}`（最多 5 把，#425；#431 起另 list 一次 `tokenidx:{uid}:`，連同列到的 token 與索引本身一起刪），借閱結算再加最多一次借閱索引寫入，外加每筆移出索引的紀錄各刪一次 `borrow:{requestId}` 指標。計數器是先讀後寫、非原子操作，平行送出的一批請求會依呼叫方的並行數超出上限（見「已接受的殘餘風險」→ 速率限制不是硬上限）。
- **`verify-write`、`verify-set` 與驗證閘門的 `verify` 猜錯上限刻意分開計數**：共用一個計數器的話，攻擊者的猜錯次數會擠掉帳號本人調整驗證設定的額度，反之亦然。
- **`verify-set` 在目前密鑰確認之後才計數（#396）**：其他每小時寫入上限都在解析 body 之前扣，`PUT /api/user/:id/verify` 是唯一的例外。它排在格式檢查、token 檢查與目前密鑰確認（`enforceCurrentSecret`）之後，所以在 PIN／圖形帳號上，只有知道密鑰的人才扣得到這份額度；若照舊在解析前扣，握有 token 卻不知道密鑰的人每小時送 30 次就能把本人改設定的額度用完。代價是失敗分支（格式錯誤、不是目前的 token、沒帶或帶錯密鑰）不受每帳號寫入上限約束，每次只花 2～3 次 KV 讀取（猜錯另寫失敗紀錄與 `verify` 計數，仍受每小時 10 次約束）；免費方案讀取每日 100,000 次、寫入只有 1,000 次，而解析前扣額度本身就是一次寫入，因此接受。`DELETE /api/user/:id` 同樣要求目前密鑰，但不設每帳號寫入上限，理由相同。
- 收費位置與「以已驗證的呼叫者計數、絕不以路徑上的 `:uid` 計數」的規則，見 `.claude/rules/backend.md` → Route handler invariants 與 API Design。

#### 家庭成員的授權與移除

- **加入家庭的寫入順序**：新成員先寫 `family:{id}`，再寫 `member:{uid}`。歸屬紀錄寫入失敗時，使用者已在名單上，重試會走既有成員重連分支把歸屬紀錄補回。反過來的順序會留下一筆指向「名單上沒有他」之家庭的歸屬紀錄；這種歸屬紀錄在現行的有效歸屬規則（`worker/src/services/membership.ts` 的 `isLiveMembership`）下視為失效，不會擋住建立或其他加入，但先寫名單能讓重試直接補回，不必依賴這條規則。
- **重連補回歸屬紀錄是必要的**：家庭書櫃、成員清單與 `POST /api/auth/refresh`（請求帶 `familyId` 時）都先檢查 `member:{uid}`，名單上有他、歸屬紀錄卻不指向本家庭時若不補回，重連拿到的 token 讀不到這個家庭。能走到補回的只有三種歸屬紀錄：不存在、指向已不存在的家庭、指向名單上已沒有他的家庭；三種都該覆寫。補回只發生在這條少見的分支，多出的墓碑複查讀取也只在這裡付。補回之後為何要再查一次墓碑（與踢除對稱的寫入順序），以及補回時為何一律不寫回成員名單，見「已接受的殘餘風險」中家庭多鍵寫入那一列。
- **墓碑檢查的成本**：加入家庭在驗證閘門之後多讀一次 `kicked:{family_id}:{user_id}`；這是有速率限制的敏感端點，成本可以接受。檢查的位置與涵蓋範圍見「PWA 登入驗證機制」→ 安全措施（`MEMBER_REMOVED` 那一點）。
- **新成員加入後的墓碑複查只撤回歸屬紀錄**：寫入歸屬紀錄後若查到墓碑，撤回剛寫的歸屬紀錄、回 `403 MEMBER_REMOVED`、不發 token，但名單上新加的那一項保留：進行中的移除會自己寫入名單把他拿掉；若 Owner 是在他加入之前就經 `404 MEMBER_NOT_FOUND` 分支預先補寫了墓碑，Owner 會在成員清單上看到他，再移除一次即可。成本是每次新成員加入多一次小讀取。
- **Owner 可以預先寫墓碑**：`404 MEMBER_NOT_FOUND` 分支在 Owner 指定他人時會等冪補寫墓碑，因此 Owner 也能替從未加入的 userId 預先寫入墓碑。影響只限他自己的 familyId，也本來就在他的權限內（他可以隨時移除任何成員），所以無害。
- **成員上限沒有原子檢查**：KV 沒有 compare-and-swap，同時送出的兩個加入請求可能一起超過 `maxMembers`；以 2 人家庭、低並行的實際使用情境而言可以接受。

#### 家庭 API 位址的驗證

`PUT /api/family/:id/endpoint` 由 `validateApiEndpoint`（`worker/src/routes/family.ts`）檢查 `apiEndpoint`。Worker 自己從不連線到這個位址；它會分送給所有成員，所以要防的是 Owner 把其他成員的用戶端指向他們自己網路內的位址。Worker 擋掉的是最廉價的字面位址形式：

- 超過 2,048 字元；`null` 以外的非字串；無法解析的 URL。
- 非 HTTPS 的位址，只有 `localhost` 與 `127.0.0.1` 可以用 HTTP。
- 所有 IPv6 字面位址：WHATWG URL 解析器會保留主機的方括號（`[::1]`），所以以開頭的 `[` 判斷；整類拒絕而不分網段，也一併擋下 `[::ffff:10.0.0.1]` 這種 IPv4-mapped 寫法，否則它會繞過下面的 IPv4 檢查。
- IPv4 字面位址落在 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16（link-local）、127.0.0.0/8（`127.0.0.1` 本身除外）或 0.0.0.0/8。

這刻意不是完整的防護：解析到內網的網域名稱在 Worker 這裡與正常網域無從區分，上列以外的 IPv4 字面位址（例如 100.64.0.0/10 的 CGNAT／Tailscale、224.0.0.0/4）也不分類，兩者都放行，缺口由用戶端補上（見「端點切換確認」）。通過檢查的位址會去掉路徑結尾的斜線再儲存。

#### 借閱請求的狀態與結算

- **列表只回傳呼叫者是當事人的紀錄**（理由見「已接受的殘餘風險」中 borrow 紀錄無 TTL 那一列）。兩端用戶端都不需要第三方的紀錄：借閱分頁以 `ownerId === userId`／`borrowerId === userId` 分組（`extension/src/dialog/BorrowTab.tsx`、`pwa/src/pages/BorrowPage.tsx`），標示「已申請」的 `pendingBookIds` 只收集呼叫者自己 PENDING 的申請（`extension/src/dialog/useBorrowAction.ts`、`pwa/src/hooks/useBorrowAction.ts`）；建立借閱的 `DUPLICATE_REQUEST` 檢查直接讀借閱索引，不依賴列表的回應。
- **PATCH 只寫一次**：紀錄就在索引裡，`borrow:{requestId}` 指標只存 `familyId`，狀態變更改不到它。改寫索引可能淘汰同一借方較舊的終態紀錄，但剛更新的那筆 `updatedAt` 最新，不會是被淘汰的那一筆。
- **PATCH 找不到紀錄一律回 `404 REQUEST_NOT_FOUND`**：紀錄可能已超出借方的歷史上限被修剪，也可能是孤兒指標（修剪的 fail-open 刪除沒有成功，或建立時寫了指標卻沒寫成索引）。回應與未知的 requestId 完全相同，不多揭露任何事。
- **家庭紀錄不存在時跳過成員檢查**：這是孤兒路徑，來自任何一次解散（`worker/src/services/familyDissolve.ts` 的 `dissolveFamily`：單人管理者解散、名單上最後一人離開家庭，或最後一人刪除帳號）中 fail-open 的借閱索引刪除沒有成功（`BORROW_INDEX_DELETE_FAILED`）。沒有名單可比對，交易雙方仍可收尾，非當事人仍由當事人檢查擋下。家庭仍存在時為何要重驗成員資格（#159），以及剩下約 60 秒的傳播窗口，見「已接受的殘餘風險」中 borrow 當事人 PATCH 那一列。
- **索引成長的驗收標準**：`worker/tests/integration/budget/borrow-index-growth.test.ts` 釘住列表讀取維持 O(1)。修剪與離開時的清除讓索引有界，但同一家庭的並發寫入仍會互相覆蓋；要嚴格正確，得把索引改成每位借方各一把，或改用 Durable Objects。

#### 公開書櫃的寫入與撤銷

- **重設網址的順序**：先寫新 token 的快照，再寫清單，最後刪舊快照。讀者在清單寫入之後讀到新清單時，新快照必定已經在位；但讀取端會以清單驗證每一份快照，所以清單寫入也必須傳播到讀者所在的資料中心，在那之前新 token 最多約 60 秒會讀到 404（fail-closed，會自行恢復）。舊快照的刪除排在最後，失敗只會留下一份讀取端本來就拒絕提供的孤兒。
- **關閉公開書櫃的順序：先寫清單，最後刪快照**。有了讀取端的比對，寫入清單本身就是撤銷，所以它必須最先落地。兩種半途失敗都是 fail-closed：清單寫入失敗等於什麼都沒發生（書櫃仍在清單上、快照也還在，使用者看到 5xx 會重試）；快照刪除失敗只留下讀取端拒絕提供的孤兒。先刪快照的舊順序有第三種、開放的失敗：快照已刪但書櫃仍在清單上，下一次一般的書單同步會替仍帶著那個 token 的書櫃重建快照，已撤銷的連結重新可讀，永久書櫃則是無限期。寫入的空 `shelves` 陣列代表「已遷移、沒有書櫃」，優先於 `user:{userId}` 上殘留的舊欄位，之後的書單儲存因此不會把刪掉的書櫃列回來。
- **關閉不需要書單紀錄**：撤銷從不讀 `record.books`，若要求書單紀錄存在，`user:{userId}` 不見時（例如刪除帳號半途失敗、留下清單 key）書櫃就撤銷不了，已遷移的使用者也得白付一次書單讀取。因此公開讀取、列表與關閉只讀清單（`readPublicShelves`：先讀 `publicshelves:{userId}`，只有它不存在、使用者尚未遷移時才讀 `user:{userId}`）；建立、更新與重設網址要重建快照，才平行讀取清單與書單紀錄（`findShelf`），書單紀錄不存在時對它們而言就是找不到。
- **公開讀取不刪除孤兒**：`GET /api/public/:shareToken` 的 handler 不做任何 KV 寫入，陌生人因此永遠無法選擇要寫入或刪除哪一把 key。孤兒以讀不到的死資料留在 KV、不會被回收（刪除帳號只清掉清單上還認得的 token）；它的數量受「清理寫入失敗的次數」限制（每次失敗使用者都會看到 5xx），而不是受 `MAX_PUBLIC_SHELVES` 限制，後者只限制現行的書櫃。
- **公開讀取的成本與限制**：持有效 token 的每次讀取，對已遷移的使用者多讀一次小的清單 key，對尚未遷移的使用者多讀兩次（清單 key 未命中，加上一次完整的 `user:{userId}` 書單紀錄，並不小），後者在他第一次寫入公開書櫃後消失；格式正確但不存在的 token 停在快照未命中，只花一次讀取。公開端點的 per-IP 上限（每分鐘 10 次）只限制單一來源，擋不住分散的流量，那需要邊緣層（Cloudflare WAF）。其餘殘餘風險見 `.claude/rules/backend.md` → KV Key Patterns 中讀取端比對的段落。

#### 個人書單的寫入路徑

- **`PUT /api/user/:id/books` 帶 `familyShelfPrefs` 時**（Extension 同步會原樣帶回已儲存的紀錄），必須通過與 `PUT /api/user/:id/family-prefs` 相同的格式、去重與數量上限檢查；沒帶就保留 KV 上的值。兩條路徑共用 `parseFamilyPrefs`：每筆 ref 必須是 `{ownerId}:{bookId}`（ownerId 為 64 字元小寫十六進位；bookId 為 1 到 32 字元，可含 `:`，不可含換行，上限是 `MAX_FAMILY_PREF_BOOK_ID_LENGTH`，#316；讀墨的 id 是 15 位數），每份清單去重後最多 3000 筆（`MAX_FAMILY_PREF_ENTRIES`），任一項不符就回 `400 INVALID_PAYLOAD`。bookId 要限長度，是因為書單與偏好在不同請求之間各自保留：只限筆數的話，一筆超長 ref 就能把 `user:{id}` 撐到接近請求本文上限，之後每次讀家庭書櫃都得讀取並解析它。書單能存的新書 id 最長 32 字元（`shared/src/api/bookId.ts` 的 `MAX_BOOK_ID_LENGTH`），與 ref 的 bookId 上限相同，所以存得進書單的書一定做得成合法的 ref。部署前已存在的超長 ref（只在有人刻意上傳超長 id、且家人隱藏了那本書時才可能出現）不做遷移、讀取時也不過濾，帶回它的整份寫入會回 `400`，這是接受的殘餘風險；部署前已存進書單的超長 id 也照舊保留（`dropNewMalformedBookIds` 不刪已存的 id），家人之後隱藏或收藏那本書同樣會回 `400`。這條上限是三端共用的，Extension 端也跟著改變：這種已存的超長 id 自此被 `isLegacyBookEntry` 當成舊格式項目（同書名只有一筆真正 id 的書時會被併入並移除，開放旗標搬過去），`pruneBooks`、`syncBreaker` 與 `autoShare` 也不再把它算作真正的書（不會被移除、不會被自動開放），方向偏安全，同樣接受。空物件 `{}`（`hidden` 與 `favorites` 都沒有）會讓 `parseFamilyPrefs` 回 `400 INVALID_PAYLOAD`、整個 PUT 失敗，這是刻意的：真正的 Extension 與 PWA 一律帶回完整的 `{ hidden, favorites }`。
- **`removedUnsharedBookIds` 只由 PUT 計算**：紀錄仍照固定欄位清單重建，請求帶來的同名欄位直接忽略；新值由 handler 自己讀到的紀錄與最後寫入的書單（`dropNewMalformedBookIds` 之後）算出，空的就不寫。PATCH、`family-prefs` 與家庭暱稱的寫入原樣保留它。規則見〈個人開放設定 API〉。
- **顯示名稱以家庭紀錄為準**：使用者在家庭中、且家庭紀錄的名單上有他時，PUT 一律採用家庭紀錄裡的顯示名稱（包括空字串，代表刻意清除），避免用戶端的舊快取蓋掉伺服器上的值；只有沒有歸屬紀錄、家庭紀錄不存在或名單上沒有他時，才採用用戶端送來的值，經 `sanitizeDisplayName` 檢查，不合格就存空字串。PATCH 只在 body 帶了 `displayName` 時才走同一套解析，否則沿用既有的值。
- **PATCH 的清單 key 讀取刻意與另兩個讀取平行發出**：只有通過「沒有任何變更」的短路之後才需要它，但延後讀取會讓一般路徑多一次循序往返，而無變更的 PATCH 只浪費一次平行的小讀取。沒有符合的書、也沒帶 `displayName` 的 PATCH 不寫 KV，也不刷新快照。
- **`PUT /family-prefs` 不寫快照**：它照樣重新過濾每本書的封面與書籍連結（三條書單寫入路徑共用的懶惰清除），所以 KV 上的紀錄可能暫時比既有的公開快照乾淨，下一次書單寫入時兩者就會一致。

### KV 備份與事故還原

正式 KV 的每日備份由一個獨立的 Cloudflare Worker 執行，跑在 Workers Free 方案，與服務 API Worker 分開設定與部署（`worker/wrangler.backup.toml`，程式在 `worker/src/backup/`）；服務 API Worker 的路由與 binding 不受影響。每天 03:17 UTC 的 Cron 觸發後，Worker 透過 binding 分頁列舉 KV，以 `getWithMetadata([keys], "text")` 每批 100 個 key 讀取（回應超過 25 MB 的 413 就把該批對半拆開），把原始 JSON 文字寫成 version 2 的 JSONL，分段上傳到私人 R2；再列舉一次核對 key 集合與到期時間，接著寫 manifest、以 R2 原生的 ETag 條件寫入更新 `latest.json`，清理超過 14 天且不是最後成功的備份，最後 ping Healthchecks 的「備份成功」check。內部請求數、筆數與封存大小都低於分界時，才另外 ping「容量正常」，沒收到這個訊號就是該升級 Workers Paid 的提醒。GitHub 不排程也不部署它，CI 只做 dry-run build，所以 repository 長期沒有活動也不影響備份。

Free 方案每次執行只有 10 ms CPU，因此 Worker 只做搬運與計數：不算雜湊、不解析 value，每筆的 byte 長度、總長與 R2 回報的物件大小記進 manifest。完整性核對全部移到本機還原 CLI（`scripts/kv-restore.mjs`，共用模組在 `scripts/kv-backup/`）：下載後核對總長與每筆長度、每行能否解析、每筆 value 是否符合現有儲存格式，以及 `count`／`prefixCounts`。代價是備份當天不知道檔案是否損壞，要到每月的 dry-run 或真正還原時才發現。還原只寫入與來源不同的全新空白 namespace，`member:` 寫回裸字串，其餘寫回原始 JSON 文字，寫完逐筆讀回；寫入憑證不交給備份 Worker，是否切換正式 binding 由管理者另行決定。

已接受的殘餘風險：

- **不是交易快照**：兩次列舉能發現 key 新增、消失或到期時間改變，發現不了讀取期間 value 被覆寫，跨 key 不保證是同一時點的狀態。
- **value 不是合法 JSON 只在還原時才會發現**：Worker 原樣嵌入原始文字，不解析；KV 裡若有一筆壞掉的 value，當天的備份照樣發布，要到 dry-run 或還原時才被拒絕。
- **批次讀取 413 的錯誤格式未經實測**：程式以錯誤訊息含 `413` 判斷並立即拆批；就算實際格式不同，該批也會走一般的「重試一次、仍失敗就對半拆」路徑，只是多花一次內部請求。
- **CPU 無法在程式內計數**：持續超過 10 ms 會被平台直接中止，不會有明確的錯誤訊息；這種情況靠核對 Cron 執行結果發現（GraphQL `dimensions.status` 為 `exceededResources`，或當時掛著的 `wrangler tail` 事件 `outcome` 為 `exceededCpu`）；「備份成功」逾期信只在成功 ping 之前就被中止時才會寄出，不能代替核對。實測數字、官方口徑與升級判斷見計畫第 8、9 節。

KV binding 本身不是唯讀授權，Worker 只呼叫 get／list，不代表被攻陷時沒有寫入能力；這是 binding 的平台限制。資料範圍、費用、升級分界與流程見 [KV 備份計畫](kv-backup-plan.md)，啟用、驗收、還原與告警處理步驟見 [部署指南](../worker/DEPLOY.md#kv-每日備份與還原演練)。程式合併與排程啟用是兩件事，部署指南的啟用步驟全部完成前，不宣稱正式備份已上線。

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
- `GET /api/version` 不需要 auth token（列在 `worker/src/utils/routes.ts` 的 `isPublicRoute`），客戶端未登入也能呼叫；它走公開路由的頻率限制（每個 IP 每分鐘 10 次）

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

### `API_VERSION = 3`：改驗證設定與刪除帳號要先確認目前的密鑰

- **已遞增至 3**，理由對應上表的「變更認證機制」（#396）：帳號目前是 PIN／圖形時，`PUT /api/user/:id/verify` 與 `DELETE /api/user/:id` 都要求 body 帶 `currentSecret`，沒帶或帶錯會被拒絕（規則見「PWA 登入驗證機制」→ 安全措施的「只有帳號目前的 token 能改驗證設定」）
- **舊版客戶端的行為（請更新擴充功能／PWA）**：早於本次變更的 Extension／PWA 不會送出 `currentSecret`，因此在**已設 PIN／圖形**的帳號上：
  - 改驗證設定（擴充功能的「登入驗證」設定、PWA 首次登入的設定提示）與刪除帳號都會收到 `403 VERIFICATION_REQUIRED`
  - 畫面會顯示伺服器回傳的訊息「此帳號需要驗證才能登入」（兩端以 `safeErrorText` 原樣顯示），不是一般的「儲存失敗」；設定與帳號都不會被改動
  - **解法：更新擴充功能／PWA 至最新版**。未設定驗證（`none`）或設成驗證碼（`code`）的帳號完全不受影響
- **反方向相容**：新版客戶端連到尚未更新的 Worker 時，多送的 `currentSecret` 會被忽略，照舊運作，因此兩端的 `MIN_API_VERSION` 不需要調整
- **注意訊號方向**：與 `API_VERSION = 2` 相同，`/api/version` 無法警示「客戶端過舊」，這次遞增僅如實記錄契約變更
