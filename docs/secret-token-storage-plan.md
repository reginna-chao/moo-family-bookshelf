# 密鑰與 token 的儲存模型：設計計畫

狀態：#344 定案。A 段（PIN／圖形雜湊加 pepper）隨本文件同一個 PR 實作；B 段（token 雜湊與每裝置一把 token）已實作（#425），實作時修正了三處，見第 4 節「實作時的修正」。本文件寫的是決定與理由；現行行為以 `docs/architecture.md` → PWA 登入驗證機制 為準。

## 1. 背景：三件互相牽制的事

2026-10-21 的架構與安全審查（#337–#369）把下面三項列為 P2 設計題，因為它們共用「憑證生命週期與遷移」的考量，單獨改其中一項會把另一項改壞：

1. **PIN／圖形的雜湊**是一次 SHA-256(salt + secret)，salt 與雜湊同在 `verify:{userId}`，而 `verify:` 進每日的明文 R2 備份（`scripts/kv-backup/format.mjs`）。PIN 只有 10^6 到 10^12 種、圖形約 98.6 萬種，拿到備份的人可以離線猜。
2. **auth token 明文**存在 `token:{token}` 與 `auth:{userId}`。有 KV 讀取權的人（Cloudflare 後台、外洩的 API token）可以冒充所有使用者 90 天（滑動）。
3. **每人一把 token、重連共用**：`getOrGenerateAuthToken` 把既有的 token 交給第二台裝置；偷走的 token 只要任何裝置還在續期就不會過期；沒有「登出其他裝置」。只存雜湊之後拿不回原文，所以 (2) 一定連動 (3)。

**誰拿得到這些東西。** 三件事都要先有「內部憑證外洩」的前提：R2 備份或其讀取 token、KV 的讀取權。今天沒有任何外部使用者能利用它們，這也是審查把它們放在 P2、留給產品決定的原因（`docs/architecture.md` → 威脅模型與已接受的風險姿態）。有 Cloudflare 帳號完整權限的人本來就讀得到 Worker secret、寫得了 KV，本文件的任何設計都不針對這種人。

## 2. 實測：Free 方案跑不跑得動 PBKDF2

審查原本的假設「免費方案 10 ms CPU 跑不動 PBKDF2」未實測。2026-10-28 用 repo 內的 workerd（wrangler 4.132 內附的 miniflare）在一台桌機上量，每種作法跑 9 次取中位數，數字是單次 `fetch` 的**牆鐘**時間，含約 2.5 ms 的固定派發開銷（以 SHA-256 一次為基準），不是 Cloudflare 邊緣節點的 CPU 計時：

| 作法                                   | 牆鐘中位數 | 扣除派發開銷約 |
| -------------------------------------- | ---------- | -------------- |
| SHA-256 一次（現行）                   | 2.7 ms     | ~0             |
| HMAC-SHA256 一次                       | 2.5 ms     | ~0             |
| PBKDF2-SHA256 10,000 次                | 8.0 ms     | ~5.5 ms        |
| PBKDF2-SHA256 20,000 次                | 12.7 ms    | ~10 ms         |
| PBKDF2-SHA256 100,000 次               | 52.6 ms    | ~50 ms         |
| PBKDF2-SHA256 600,000 次（OWASP 建議） | 315 ms     | ~312 ms        |

結論：

- 每 1,000 次迭代約 0.5 ms。Workers Free 的 10 ms CPU 上限最多塞得下約 1 萬次，還要留空間給 handler 本身的 KV 讀寫。
- 1 萬倍的拉伸對 10^6 的 PIN 空間沒有意義：10^6 × 10^4 = 10^10 次 SHA-256，一張消費級 GPU 約一秒。對低熵密鑰有效的不是拉伸，是攻擊者拿不到的祕密。
- pepper（HMAC）的 CPU 成本等於現行，所以是 A 段的選擇。PBKDF2／scrypt／Argon2 不採用，Workers Paid 也不改這個決定。

## 3. A 段：PIN／圖形雜湊加 pepper（本 PR 實作）

### 決定

| 項目        | 決定                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 雜湊        | v2 = hex HMAC-SHA256(key = `VERIFY_PEPPER`, data = salt + secret)。salt 與現行相同，仍存在紀錄裡。                                                                                                                                                                                                                                            |
| 版本欄位    | `verify:{userId}` 加可選的 `version`（缺 = 1 = 現行 SHA-256(salt + secret)；2 = pepper）與 `pepperId`（該 pepper 的指紋：SHA-256(`"pepper-id:"` + pepper) 的前 16 個 hex 字元）。                                                                                                                                                             |
| pepper 來源 | Worker secret `VERIFY_PEPPER`（`wrangler secret put`；本機 `.dev.vars`），不進 KV、不進 R2、不進 git。trim 後非空才算設定。                                                                                                                                                                                                                   |
| pepper 缺席 | **可選**。沒設定的 Worker 完全維持現行 v1 行為，自架者零成本升級；設定後下一次成功登入自動升級。官方伺服器會設定。                                                                                                                                                                                                                            |
| 升級時機    | 建立家庭、加入家庭、查詢所屬家庭三個閘門**通過**，並且 handler 讀了 `auth:{userId}`、確認紀錄不比 token 舊（`passedAgainstStaleVerifyRecord` 為 false）之後，用同一個 salt 重算 v2 寫回。閘門函式 `validateVerification` 本身不寫 `verify:`。`salt`、`secretUpdatedAt`、`prompted` 一律不動。寫回失敗只記一行不含識別碼的 log，登入照樣成功。 |
| 無法驗證    | 紀錄是 v2 而 Worker 沒有 pepper、`pepperId` 不符、或 `version` 是未知的值 → `503 VERIFY_UNAVAILABLE`，在鎖定檢查之後、要求密鑰之前判定，有沒有帶密鑰都一樣，不扣任何計數、不寫 KV，並記 `VERIFY_PEPPER_MISSING`／`VERIFY_PEPPER_MISMATCH`／`VERIFY_HASH_VERSION_UNSUPPORTED` 一行。絕不走「壞紀錄放行」那條路。                               |
| 輪替        | 不支援。換成另一把 pepper 的症狀是所有 v2 帳號 503，log 有 `VERIFY_PEPPER_MISMATCH`。                                                                                                                                                                                                                                                         |
| 客戶端      | 不改。Extension 與 PWA 用白名單比對錯誤碼，`VERIFY_UNAVAILABLE` 落到一般錯誤訊息。                                                                                                                                                                                                                                                            |

### pepper 的保管

- 必須隨機產生（`openssl rand -hex 32`），不可自選字串：`pepperId` 隨備份外流，等於留了一個離線驗證器，弱 pepper 可被字典猜。
- pepper 是備份組合的一部分：與 R2 的讀取 token 一起存進密碼管理器。還原到另一個部署時必須用同一把，否則還原後所有設了 PIN／圖形的人都是 503。
- 遺失 pepper 等於所有 v2 使用者鎖在外面。沒有自助路徑：只能循 #379 的救援申請入口，由管理者走 `worker/DEPLOY.md` → 使用者忘記登入驗證時 的臨時 PIN 流程（那筆手寫紀錄是 v1，本人登入後自動升級）。
- 正式站的 secret 要帶 `--env production`。不帶會落到 dev Worker，而且因為「缺席 = v1」這個錯誤完全無聲；設定後要用 `wrangler secret list --env production` 與一筆測試帳號的 `verify:` 紀錄（看到 `version: 2`）確認。

### 寫入量

每個 v1 帳號在升級後第一次成功登入多 1 次 KV 寫入。查詢所屬家庭與緊接的加入通常落在同一個 colo，第二次讀到的已是 v2，所以多半只寫 1 次；落在不同 colo 時會寫第二次（同 key 每秒一次的限制可能讓它失敗，fail-open 吞掉）。上限 = 帳號數 × 1 到 2，遠低於 Free 方案每日 1,000 次寫入。

### 已接受的殘餘風險

- **升級寫回與同時改 PIN 交錯**（KV 沒有 CAS）：使用者在一台裝置改了 PIN，約 60 秒的傳播視窗內在另一台裝置用**舊** PIN 登入，舊紀錄會以 v2 寫回、蓋掉新 PIN，且 `secretUpdatedAt` 留在舊值 → 之後所有閘門與改驗證設定都回 403，沒有自助路徑，管理者用臨時 PIN 流程可解。改成「不設定驗證」或「驗證碼」時同一交錯會讓舊 PIN 悄悄復活且不鎖定，再改一次即可。
- **`POST /api/user/:id/verify/prompted`** 整筆寫回讀到的紀錄，讀到升級前的 v1 會把 v2 滾回 v1：無害，下次登入再升級。
- **刪除帳號與另一台裝置登入交錯**：雜湊會在刪除後復活，同一個 Email 重建帳號會被要求舊 PIN。接受理由：要同一個人在傳播視窗內一邊登入一邊刪帳號，而那個 PIN 是他自己的。
- **未設 pepper 的自架伺服器**維持 v1，備份外洩仍可離線猜。這是自架者自己的選擇，`worker/DEPLOY.md` 寫明建議設定。
- **壞紀錄放行**（pin／pattern 但 `hash`／`salt` 為 null）的既有行為不變。

## 4. B 段：token 雜湊與每裝置一把（子 issue）

### 決定

| 項目         | 決定                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 儲存         | `token:{hashAuthToken(token)}` → `{ userId, createdAt, expiresAt }`；`auth:{userId}` → `{ tokens: [{ hash, createdAt }], secretAt? }`。原文只在回應裡出現一次，KV 裡沒有。middleware 先雜湊 Bearer 再查。                                                                                                                        |
| 每帳號上限   | 5 把，超過時先淘汰反向 `token:` key 已不存在的，再淘汰 `createdAt` 最早的（含刪掉它的 `token:` 反向 key）。                                                                                                                                                                                                                      |
| 有效期       | 滑動 TTL 維持 90 天；另加自 `createdAt` 起算的**絕對上限 180 天**，到期的 token `POST /api/auth/refresh` 一律拒絕。客戶端現有的 401 → 復原加入路徑自動接手；設了 PIN／圖形的帳號會被要求再輸入一次。驗證碼（`code`）帳號不受絕對上限，只有滑動 90 天。`auth:{userId}` 本身不設 TTL（永久；離開、被移出、解散、刪除帳號時刪除）。 |
| 重連         | 建立、加入（含重連）一律**鑄新** token，不撤銷別把；`getOrGenerateAuthToken` 退場。這是 (2) 連動 (3) 的原因：雜湊後拿不回原文給第二台裝置。既有的明文 token 不硬切：在它下一次續期、或該帳號下一次鑄造時遷移成雜湊形狀（同一個 token 字串，裝置不會被登出）。                                                                    |
| 續期         | `POST /api/auth/refresh` 只續出示的那把（#378 的規則不變），且不得超過絕對上限。                                                                                                                                                                                                                                                 |
| 全撤         | 改 PIN／圖形（`PUT /api/user/:id/verify`）、離開家庭、被移出、刪除帳號、#379 救援後本人以臨時 PIN 登入並重設（即第一項）：撤銷該帳號的全部 token。「搶先建家庭」（已接受的風險）的情境靠「受害者設定 PIN 時全撤」解決；重連本身不撤。                                                                                            |
| QR 兌換      | 發 QR 的那把 token 仍有效（`qr:{token}` 的 `tokenHash` 對得上 `auth:` 清單裡任一把）→ 為 PWA **鑄一把新的**，不再與 Extension 共用同一字串。                                                                                                                                                                                     |
| `secretAt`   | 沿用 #378：記在 `auth:{userId}`，全撤後重鑄時帶新值。                                                                                                                                                                                                                                                                            |
| 登出其他裝置 | 不在 B 段。需要新端點（列出／撤銷），前後端都動，等 B 落地後視需要另開。                                                                                                                                                                                                                                                         |

### 實作時的修正（#425）

上表已改成實作後的樣子。與原本的定案相比，有三處是實作時依計畫審查修正的：

1. **既有明文 token 改成遷移，不硬切**：硬切會讓所有裝置同時 401，而驗證碼帳號的驗證碼只能由握有 token 的裝置產生，整個帳號會被鎖死。原設計是 middleware 在雜湊查不到時再查一次 `token:{明文}`，並由 #432 在釋出 90 天後移除這條退路；實際上 #432 提前拆除了它（未等 90 天，見 CHANGELOG），以下是當時的設計，留作紀錄。遷移（續期或鑄造時）只在 `token:{明文}` 仍存在且屬於同一個 userId 時進行——否則合法登入會把已撤銷的舊 token 復活——並且新的雜湊紀錄寫入成功後才刪舊 key，寫入失敗時舊 key 保留、可重試。
2. **驗證碼（`code`）帳號不受 180 天絕對上限**：同理，兩台裝置若同一天遷移就會同一天到期，沒有裝置能再產生驗證碼；使用者隨時能改成 PIN（撤銷全部）來重設。
3. **`auth:{userId}` 不設 TTL**：驗證碼帳號的 token 能一直滑動，固定 TTL 的 `auth:` 會比 token 先到期，撤銷全部就變成什麼都沒刪。

另有兩處細節：token 雜湊用 Worker 本地的 `hashAuthToken`（`worker/src/utils/crypto.ts`），不用 `shared/` 的 `sha256Hex`（那支綁定 userId 推導，還會 trim／轉小寫輸入）；`token:` 的值多記 `expiresAt`，讓重複的續期可以跳過寫入。

### 影響範圍（實作時要先盤的）

- `worker/src/middleware/auth.ts` 全部函式、`routes/auth.ts`（refresh）、`routes/family.ts`（建立、加入、離開、移除、解散）、`routes/user.ts`（刪除）、`routes/verify.ts`（換 token、QR）、`kv/schema.ts`。
- `worker/tests` 有 34 個檔案碰 `token:`／`auth:`，其中 `getOrGenerateAuthToken.test.ts` 釘的是「重連回同一把」的相反行為。
- 客戶端：兩端都只檢查 64 hex 與 `expiresAt`、不比對跨裝置 token（`shared/src/api/issuedCredentials.ts`），所以後端改制對客戶端透明；唯一可觀察的差別是 QR 登入後 PWA 的 token 字串與 Extension 不同，沒有程式依賴它。
- 備份：`auth:`／`token:` 已在 `IGNORED`，不變。
- 寫入量：鑄 token 2 次寫入，與現行相同；續期最多 1 次寫入（只寫 `token:`，離上次寫入的到期時間不到 1 小時就不寫）；全撤是 N + 1 次刪除（N ≤ 5）。

### 有意不做的事

- 排除 `verify:` 於備份之外：`validateVerification` 沒有紀錄就放行，還原後所有人的 PIN／圖形會消失，變成 email 即可接管。
- PBKDF2 或任何記憶體硬化的 KDF：見第 2 節。
- pepper 輪替（`VERIFY_PEPPER_OLD` 雙鑰過渡）：多一個 secret 要保管，換來的只是「換 pepper 不必等所有人登入」；沒有輪替需求之前不做。
- 把 B 段與 A 段放同一個 PR：A 是純後端、客戶端透明、可獨立驗收；B 的測試衝擊大，分開審。

## 5. 待決事項

- B 段的實作時機：已排定，於 #425 實作。（原本的考量：它守的是「KV 讀取權外洩」與「裝置可各自撤銷」，今天沒有外部可利用的路徑；可以等 #379（Email 救援）之後再排。）
- 絕對上限 180 天會讓設了 PIN 的 Extension 使用者每半年重新輸入一次；若實際採用率上升後覺得太頻繁，調成 365 天只改一個常數。
- 要不要讓 `PUT /api/user/:id/verify` 改成任何方式（含 `none`／`code`）都推進 `auth:{userId}` 的 `secretAt`（只更新時間戳、不換 token）：這會把「知道舊 PIN 的第三方利用升級寫回讓舊 PIN 復活」的變體（`docs/architecture.md` → PWA 登入驗證機制 → 安全措施 的殘餘風險）也擋成 403，但會動到 #378／#396 對 `code`／`none` 紀錄「`secretAt` 等於 `secretUpdatedAt`」的等號語意，要連同那兩項一起重新推導。KV 沒有 CAS，這條只能縮小視窗，不能消除競態。

## 官方依據

- Cloudflare Workers 限制（CPU 時間、Free 方案）：<https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare Workers Secrets：<https://developers.cloudflare.com/workers/configuration/secrets/>
- Cloudflare KV 一致性與寫入限制：<https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- Web Crypto `SubtleCrypto.sign`（HMAC）與 `deriveBits`（PBKDF2）：<https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
