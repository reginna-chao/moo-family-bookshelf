# 忘記登入驗證時的 Email 救援：設計計畫

狀態：不採用（2026-10-29）：改走人工復原流程，見 `worker/DEPLOY.md` → 使用者忘記登入驗證時；本文件保留作為當時的評估。本文件描述的端點、KV key 與畫面都不存在；現行行為以 `docs/architecture.md` → PWA 登入驗證機制 → 忘記驗證方式時 為準。

## 1. 背景：會卡死的情境

設了 PIN 或圖形驗證的帳號，在三個地方都要過驗證閘門：建立家庭、加入家庭、查詢所屬家庭（`worker/src/services/verification.ts` 的 `validateVerification`，呼叫端在 `worker/src/routes/family.ts` 與 `worker/src/routes/auth.ts`）。能更改驗證方式的 `PUT /api/user/:id/verify`、能讓手機略過驗證的 `POST /api/user/:id/qr-token`、以及 `DELETE /api/user/:id` 都需要有效的 auth token（`callerId === userId`）；#396 起，帳號目前是 PIN／圖形時，`PUT /api/user/:id/verify` 與 `DELETE /api/user/:id` 還要先出示目前的密鑰（`enforceCurrentSecret`，同在 `worker/src/services/verification.ts`）。

因此還有一台裝置握有有效 token 時，忘記 PIN／圖形也無法在擴充功能設定裡自己重設，處境與「token 已經不在」相同，只差這台裝置在 token 有效期間仍能照常使用，也還能產生 QR Code 讓手機略過驗證加入。本計畫的救援對象因此包括這兩種情況；下面先說明 token 不在時為何卡死：

- 同一個帳號只有一把 token（`auth:{userId}`，`getOrGenerateAuthToken` 讓多台裝置共用），效期 90 天（`TOKEN_TTL_SECONDS`），只在重新發 token 或 `POST /api/auth/refresh` 時續期（#425 之後：每裝置一把 token，同一帳號最多 5 把；驗證碼以外的帳號另有自發出起 180 天的絕對上限）；
- 自己離開家庭、被管理者移出都會刪掉這把 token（`deleteAuthToken`，`worker/src/routes/family.ts`）（#425 之後：每裝置一把 token，離開／移出撤銷全部）；
- 這時閘門要密鑰、改密鑰要 token（PIN／圖形帳號還要目前的密鑰）、發 token 要過閘門，刪除帳號也要 token 與目前的密鑰。現行唯一的出口是 KV 管理者把 `verify:{userId}` 改寫成臨時 PIN（`worker/DEPLOY.md` → 使用者忘記登入驗證時）。
- 刪除帳號（`DELETE /api/user/:id`）不會造成卡死：它把驗證設定與 token 一起刪掉（#341，`worker/src/routes/user.ts`），之後同一個 Email 重新開始時沒有密鑰要過。

## 2. 為什麼用 Email

威脅模型的前提一（`docs/architecture.md` → 威脅模型與已接受的風險姿態）指出，Worker 能拿來認人的只有使用者自設的密鑰；讀墨的登入狀態 Extension 握有，但無法向 Worker 證明。因此沒有 token 時，任何「不另外證明身分」的自助重設，效果都等於「知道 Email 就能拿掉驗證」，而 PIN 要防的對象正是知道你 Email 與同步碼的家人。

「收得到讀墨註冊信箱的信」是家人通常沒有的東西：知道 Email 不等於能登入那個信箱。這是現行架構以外、唯一能拿來證明本人的管道，代價是伺服器第一次需要碰到明文 Email（第 3 節）。

## 3. 隱私定位的變更

現行定位是「伺服器只收雜湊後的 userId」：`deriveUserId` 在用戶端算出 `sha256("moo:" + email)`（`shared/src/crypto/hash.ts`），隱私權政策承諾「原始 Email 永遠不會離開您的瀏覽器」（`site/privacy-policy.html`）。Email 救援必須打破這個承諾，因此採用的做法要把範圍縮到最小：

- 明文 Email 只出現在「送出救援申請」這一個請求裡；
- Worker 收到後只做兩件事：用 `deriveUserId` 算出 userId（不收用戶端送來的 userId），以及交給寄信服務寄出。寄件地址用與 `deriveUserId` 相同的正規化結果（`toLowerCase().trim()`），而且只接受 ASCII 的 Email 格式：`toLowerCase()` 會把某些 Unicode 字元對應成 ASCII（例如 U+212A 變成 `k`），「雜湊相同、地址字串不同」的輸入因此存在，雖然找不到能把信導進別人信箱的路徑，直接拒絕最省事；
- 不寫入 KV、不寫進任何 log（含錯誤 log；呼應 #357 不把 userId／familyId 寫進 Worker log 的做法。寄信失敗時只記 HTTP 狀態碼或錯誤代碼，不記整個 `err` 物件，因為寄信服務回傳的錯誤可能帶著收件地址）、不放進網址（invocation log 已關閉，見 `worker/DEPLOY.md` → 不記錄請求網址，但 body 本來就不在網址裡）；
- 寄信服務（第三方）會看到收件地址，這點必須寫進隱私權政策。

上線前必須同步更新每一處「不碰 Email」的公開承諾：`site/privacy-policy.html`（「原始 Email 永遠不會離開您的瀏覽器」那一段，以及「不收集個人識別資訊（姓名、Email、電話）」兩處）、`site/index.html`（「不記錄 Email、不追蹤你是誰」）、`README.md` 與 `README.en.md` 的「不記錄 Email」一條、Chrome 線上應用程式商店與 Firefox 附加元件商店的資料使用聲明、`AGENTS.md` → Security & Privacy Rules 的 No PII collection 一條。實作時用 grep 掃這些檔案裡的 Email 承諾，當作上線檢查。

## 4. 流程

1. **申請**：使用者在 PWA 登入頁（或擴充功能的重新驗證畫面）按「忘記驗證方式」，輸入 Email。用戶端送出 `{ email }`。
2. **比對與寄信**：Worker 依第 6 節決定要不要寄。要寄時產生一把一次性的重設 token（32 bytes 隨機，與 auth token 同強度），寫入 `recover:{token}` → `{ userId }`，並寄出含連結的信。
3. **統一回應**：不論 Email 對不對應到帳號、有沒有設驗證、這次有沒有真的寄信，一律回同一個成功回應。這不是為了隱藏「有沒有設驗證」（`GET /api/user/:id/verify` 本來就是公開端點），而是讓申請端點不比它多透露任何東西，也不透露「這次有沒有寄信」（第 6 節的冷卻）。
4. **點連結**：連結開啟 PWA 的「重設登入驗證」畫面，token 放在網址的 fragment（`#` 之後），不會出現在任何伺服器的存取紀錄裡；PWA 讀到 token 後立刻用 `history.replaceState` 把它從網址移除，免得在家人共用的電腦上留在瀏覽紀錄裡。
5. **設定新的驗證方式**：使用者在畫面上直接選新的 PIN、圖形或「不設定驗證」，用戶端送出 `{ token, method, secret }`。Worker 驗證 token、刪除 `recover:{token}`，用與 `PUT /api/user/:id/verify` 相同的檢查（`isValidPin`／`isValidPattern`）寫入新的 `verify:{userId}`，並帶上 `secretUpdatedAt` 讓舊密鑰的鎖定紀錄作廢（`isFailStreakVoid`）。同一個請求裡也刪掉 `auth:{userId}` 與對應的 `token:`（`deleteAuthToken`；#425 之後：每裝置一把 token，改走撤銷全部的 `revokeAllAuthTokens`）：卡死的帳號照理沒有 token，但若有一把別人持有的 token 還活著，重設後它必須跟著失效。
6. **之後照常登入**：重設不發 auth token。使用者回到一般的建立／加入家庭流程，用剛設定的新密鑰通過閘門。

選擇「直接設定新密鑰」，而不是「先刪掉驗證設定、讓使用者自己回去設」或「發一個像 QR Token 那樣略過驗證的票」，理由：

- 先刪除會留下一段帳號沒有任何驗證的空窗，這段期間任何知道 Email 的人都能建立家庭取得 token；
- QR Token 的略過只在加入家庭時生效（`worker/src/routes/family.ts` 的 join 路徑），建立家庭不吃它，而卡死的人常常已經不在任何家庭裡；
- 不發 token 讓救援端點的權限範圍只剩「改驗證設定」，少一條發 auth token 的路徑。這不會降低重設 token 外洩的後果：能設新密鑰就能通過閘門，`POST /api/auth/lookup` 帶正確密鑰會回傳 familyId（即同步碼），接著加入家庭就拿到 auth token；不在任何家庭的人則能直接建立家庭。重設 token 外洩等同帳號接管，所以它必須只能用一次、短效、只放在網址 `#` 之後。

重設畫面不提供「隨機驗證碼」：那個方式要靠仍登入的電腦產生驗證碼，正是 token 已經不在的人沒有的東西。

## 5. 新增的 KV key 與端點（預估）

| 項目                                       | 內容                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `recover:{token}`                          | `{ userId, createdAt }`，TTL 見第 6 節；成功使用後立即刪除                                                                                      |
| `recoveractive:{userId}`                   | 目前有效的 token 與上次寄信時間，TTL 與 `recover:{token}` 相同；成功使用後一併刪除                                                              |
| `POST /api/verify-recovery`                | 公開；body `{ email }`；回應一律相同                                                                                                            |
| `POST /api/verify-recovery/complete`       | 公開；body `{ token, method, secret? }`；`method` 只接受 `pin`／`pattern`／`none`                                                               |
| 兩個端點列入 `isSensitivePublicRoute()`    | 與三個閘門入口同樣受 per-IP 每分鐘 3 次的敏感端點上限                                                                                           |
| 備份範圍（`scripts/kv-backup/format.mjs`） | 把 `recover:`、`recoveractive:` 加進 `IGNORED`（與 `otp:`、`qr:` 同類的短效一次性資料）；`classifyKey` 遇到兩個清單都沒有的前綴會讓整份備份失敗 |

## 6. 濫用控制

**只寄給真的需要救援的帳號。** Worker 用 `deriveUserId(email)` 算出 userId，再讀 `verify:{userId}`：沒有紀錄或 `method: "none"` 時不寄信、不寫 KV，但回應與有寄信時完全相同。這讓垃圾申請（隨便編的 Email）不會消耗寄信額度與 KV 寫入額度（Free 方案每天 1,000 次寫入）。「有沒有讀 `verify:` 之後的動作」在回應時間上可能有差異，但它只會透露「這個 Email 有沒有設驗證」，而這件事 `GET /api/user/:id/verify` 本來就公開，不構成新的揭露。

**每個帳號同一時間只有一個有效連結，但本人每次申請都收得到信。** 這是本設計與 `.claude/rules/security-ux-invariants.md` Invariant 6 的交會點：任何以目標帳號為 key、每次申請都計入的狀態，第三方都能替任何人觸發。單純的「已有有效信就不再寄」不成立，因為本人沒申請過的救援信多半會被當成釣魚信刪掉，而攻擊者只要在每次到期時再觸發一次，本人之後自己申請時永遠落在「已有有效信」的區間，收到統一的成功回應卻拿不到信，等於被無限期擋在門外。因此改成：

- `recoveractive:{userId}` 存在時，新的申請不換 token，而是把同一個連結再寄一次；
- 唯一的節流是短的冷卻時間（建議 15 分鐘）：冷卻中的重複申請不寄信、回應照舊。攻擊者能造成的最壞情況是讓本人多等 15 分鐘，以及每 15 分鐘替本人寄一封信（騷擾上限有界）；
- 本人完成救援時，`recover:{token}` 與 `recoveractive:{userId}` 一併刪除。

連結的 TTL 建議 1 小時：外洩等同帳號接管（第 4 節），不該存活一天。實作時要把這個冷卻登記成 Invariant 6 的第二個已核准例外（第一個是 `VERIFY_ATTEMPT_*`），寫明「本人在冷卻結束後一定拿得到可用的連結」這個成立條件，並寫一個測試：攻擊者先觸發，本人在 TTL 內再申請，斷言本人收到可用連結。殘餘風險：攻擊者必須知道受害者的明文 Email 才能觸發，不是只知道 userId 就行。

**token 不可猜。** 32 bytes 隨機 token 的猜測空間遠大於任何速率限制能讓攻擊者嘗試的次數；完成端點另受 per-IP 敏感端點上限約束。token 只能用一次，錯誤 token 不計入任何以目標帳號為 key 的計數器（這個端點收到錯誤 token 時根本不知道目標是誰）。

## 7. 寄信服務

（2026-10-22 調查，未經官方正式版公告確認，實作前要重新核對。）

- **Cloudflare Email Service**：Worker 可透過 `send_email` binding 寄信，但寄給任意收件人需要 Workers Paid 方案，且目前仍是 Beta；Free 方案只能寄給事先在 Email Routing 驗證過的地址，不適用。寄件網域要先用 `wrangler email sending enable <domain>` 開通。
- **第三方寄信服務**（例如 Resend）：有免費額度、用 REST API 呼叫，需要一把 API key（以 Worker secret 保存）與一個驗證過的寄件網域；寄信服務會看到收件地址（第 3 節）。

兩條路都需要一個專案擁有的寄件網域。從 `worker/wrangler.toml`（沒有自訂網域路由）與 `shared/src/config/links.ts`（GitHub Pages 網址）看來，官方部署目前沒有自有網域（未驗證 Cloudflare 帳號內的設定），這是實作前要先確認的前提。選型與 `docs/kv-backup-plan.md` 第 9 節「什麼時候改 Workers Paid」的分界一起評估。

## 8. 自架伺服器

- 救援功能是選用的：Worker 沒有設定寄信服務時，兩個端點回一個固定的錯誤代碼（例如 `501 RECOVERY_UNAVAILABLE`），用戶端隱藏「忘記驗證方式」的入口，與「新書預設開放」在舊伺服器上顯示「伺服器尚未支援這個設定」的做法一致；
- 沒有開啟救援的自架伺服器，維持由管理者手動處理（`worker/DEPLOY.md` → 使用者忘記登入驗證時）；
- 信裡的連結要帶上伺服器位址，讓 PWA 知道要把 token 送去哪一台 Worker。可沿用同步碼 `@host` 的格式與 `shared/src/api/` 的位址驗證；位址由 Worker 的設定提供，不信任請求內容。任何人都能偽造一條指向官方 PWA、位址卻填自己伺服器的連結，使用者在重設畫面輸入的新密鑰就會送到那裡（邀請連結本來就有同類風險），所以重設畫面要用 `classifySyncCodeApiHost` 顯示位址提示，連結帶來的位址只用於這一次請求、不寫進設定，或只接受與目前設定相同的位址。

## 9. 待決事項

1. 寄信服務選型，以及是否因此改用 Workers Paid（第 7 節）。
2. 寄件網域從哪裡來（第 7 節）。
3. 連結的 TTL（建議 1 小時）與重寄的冷卻時間（建議 15 分鐘），要和「本人最多等多久」的體驗一起確認（第 6 節）。
4. 擴充功能要不要也提供申請入口：擴充功能本來就能從讀墨頁面讀到 Email，使用者不必再輸入；但完成重設的畫面仍在 PWA。
5. 隱私權政策與兩個商店的資料使用聲明的新文案（第 3 節）。
6. Invariant 6 例外的正式條文（第 6 節），加進 `.claude/rules/security-ux-invariants.md` 與 `.claude/rules/backend.md`。

## 官方依據

- Cloudflare Email Service 文件：<https://developers.cloudflare.com/email-service/>
- Cloudflare Email Service 更新紀錄：<https://developers.cloudflare.com/changelog/product/email-service/>
