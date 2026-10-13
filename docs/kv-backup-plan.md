# KV 自動備份計畫

> **狀態**：工具、排程與離線驗證已完成；正式環境尚未驗收、尚未啟用。
> **建立日期**：2026-04-14
> **更新日期**：2026-10-13
> **推出服務前的條件**：完成正式 KV 備份、R2 下載核對，以及隔離 KV namespace 還原驗證。

## 1. 目的與目前規模

備份要能處理誤刪、程式寫壞資料與遷移失敗。產生檔案只是第一步，還必須證明下載後完整，而且能還原到獨立的 KV namespace。

維護者於 2026-10-13 回報：正式版目前兩位使用者，分別約 100 與 500 本書，KV 用量 **196.71 kB**；推出後預估 **100～500 位使用者**。這些是維護者提供的數據與成長估算，尚未由備份工具核對正式帳號；每日活躍人數、key 數與操作量也未知。

每人的書單以一個 `user:{userId}` 保存，600 本書不等於 600 個 KV key。資料還包括顯示名稱、家庭關係、借閱紀錄、驗證設定與分享連結，備份應按敏感資料管理。

## 2. 架構與操作介面

由 **GitHub Actions 啟動 Node 22 腳本，透過 Cloudflare REST API 讀取正式 KV，再使用專案既有 Wrangler 存入私人 R2**。備份不經過服務 Worker，不新增公開管理 API，也不修改 Worker 的 binding 或請求處理。

| 項目     | 決定                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| 排程     | 每日 **03:17 UTC（台灣時間 11:17）**，另提供 `workflow_dispatch`                                                    |
| 啟用     | 獨立 workflow，預設停用；repository variable `KV_BACKUP_ENABLED=true` 才執行，手動觸發亦同                          |
| 來源     | 只讀明確指定的正式帳號與 namespace，不依名稱猜測                                                                    |
| 儲存     | 私人 R2 Standard bucket，預定名稱 `moo-family-bookshelf-backups`                                                    |
| 保留     | `daily/` prefix 套用 14 天刪除的 lifecycle rule                                                                     |
| 物件名稱 | `daily/YYYY-MM-DD/YYYY-MM-DDTHH-mm-ss-sssZ_UUID.jsonl`，同一名稱主體搭配 `.manifest.json`；同日手動執行不覆蓋舊備份 |
| 成功條件 | 資料上傳後重新下載核對，最後才上傳 manifest；沒有 manifest 不算成功                                                 |
| 還原     | 本機 CLI，預設 dry-run，只允許新空白隔離 namespace                                                                  |
| 工具     | `scripts/kv-backup.mjs`、`scripts/kv-restore.mjs`，完整指令隨實作更新至 `worker/DEPLOY.md`                          |

免費 Worker Cron 的 CPU、記憶體與單次執行限制需要額外處理。批次讀取雖能減少請求數，仍不能僅憑資料容量證明全量匯出可在免費 Worker 內完成。Node 工具可沿用既有 CI 與 Wrangler，無需新增依賴。

### 設定與憑證

| 設定                     | 用途                                            |
| ------------------------ | ----------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | 明確的 Cloudflare 帳號                          |
| `KV_BACKUP_NAMESPACE_ID` | 正式來源 namespace                              |
| `KV_BACKUP_API_TOKEN`    | 專用 KV 唯讀憑證                                |
| `KV_BACKUP_BUCKET`       | 備份 bucket                                     |
| `KV_BACKUP_R2_API_TOKEN` | 專用 R2 讀寫憑證，必填，不回退使用部署 token    |
| `KV_RESTORE_API_TOKEN`   | 本機還原專用 KV 寫入憑證，不提供給每日 workflow |

Wrangler 使用 R2 REST API，其 token 需要 account 層級的 Workers R2 Storage Write 權限，涵蓋的權限比單一 bucket 寬。Bucket 限定的 Object Read & Write token 適用 S3，不能宣稱同樣適用這個 REST 方案。應使用專用憑證、限制其他權限，並認知這個帳號層級的剩餘風險。[R2 token 權限](https://developers.cloudflare.com/r2/api/tokens/)

Workflow 只在受信任的預設分支執行，不接受 PR／fork 程式搭配正式秘密。GitHub 只給必要的 `contents: read`，action 固定 SHA，禁止同時執行備份。

## 3. 保存與排除範圍

| 保存的 prefix     | 內容與理由                                                    |
| ----------------- | ------------------------------------------------------------- |
| `user:`           | 書單、分享設定、顯示名稱與個人偏好                            |
| `family:`         | 家庭設定與成員清單                                            |
| `member:`         | 使用者到家庭的反向指標，與家庭清單共同判斷成員身分            |
| `verify:`         | PWA 驗證方法、雜湊與 salt 等設定                              |
| `publicshelves:`  | 現行公開書櫃設定；不可只備份 `user:` 的舊欄位                 |
| `public:`         | 分享連結對應的書櫃內容，保留原始到期時間                      |
| `borrow:`         | 借閱紀錄定位指標；舊資料也可能保存完整紀錄                    |
| `borrows:family:` | 家庭借閱紀錄                                                  |
| `newbookdefault:` | 獨立於 `user:` 的「新書預設開放」設定                         |
| `kicked:`         | 尚未到期的成員移除限制，保留原始 expiration，不重新計算六小時 |

前九項是持久資料分類，`kicked:` 是需一併保存的短期安全限制。實際 key 定義以 `worker/src/kv/schema.ts` 為準。

所有紀錄保留原始 value 字串、存在時的 metadata 與絕對 expiration，不重新序列化應用層 JSON 取代原始 value。`publicshelves:` 與 `public:`、借閱定位指標與家庭借閱索引，皆不可只備其中一邊。

| 排除的 prefix     | 原因                                       |
| ----------------- | ------------------------------------------ |
| `auth:`、`token:` | 不恢復舊登入憑證；還原後使用者需重新登入   |
| `otp:`、`qr:`     | 一次性或短效驗證資料，不重播               |
| `verifyfail:`     | 不還原舊驗證失敗計數                       |
| `ratelimit:`      | 不還原舊流量計數；現行計數不全是兩分鐘 TTL |

遇到不在保存或排除清單內的 prefix，整次備份失敗，讓新增資料類型時必須同步更新備份。錯誤只報分類與數量，不輸出實際 key 或 value。**空備份一律失敗**，避免錯誤來源被標記成功。

## 4. 匯出與完整性要求

1. 驗證設定，分頁列舉全部 key。處理 cursor，拒絕重複 cursor、重複 key 或不合法回應。
2. 對保存清單中的 key 分批讀取，每批最多 100 個，使用 text 與 metadata 選項。已列舉的 key 若缺少讀取結果，包含匯出期間自然到期，整次失敗並重跑，不以部分資料冒充完整備份。
3. 分批讀取後，在 Node 記憶體中建立 JSONL，計算 bytes、SHA-256、總筆數與分類筆數；記錄匯出起訖時間。首版不是串流實作，備份檔上限 256 MiB、單筆 value 上限 25 MiB、列舉上限 100,000 個 key。
4. 本機驗證後上傳資料，再從 R2 下載核對 hash、bytes、筆數與格式。
5. 通過後才上傳 manifest 作成功標記。任何失敗回傳非零結束碼。

Manifest 採 `version: 1`，包含 `sourceAccountId`、`sourceNamespaceId`、`startedAt`、`completedAt`、`count`、`prefixCounts`、`sha256`、`byteLength`、`dataObjectPath`。獨立物件名稱識別每次執行；還原需指定完整 manifest key。

API 呼叫須同時檢查 HTTP 狀態、Cloudflare `success` 與必要回應欄位，暫時性錯誤採有上限重試。不無限重試、不吞錯、不發布部分成功的 manifest；也不直接列印可能包含 key 或資料的 API 回應。

匯出非交易快照，跨 key 可能來自不同時間。完整性核對只能證明檔案完整，不能證明家庭、借閱與公開分享資料在同一時點一致。

## 5. 還原與正式切換

### 寫入前

本機 CLI 使用 `--backup <manifest-key>` 指定備份，下載 manifest 與資料並完成全部核對。預設 dry-run 只顯示預計還原數與到期略過數，不顯示使用者資料；備份時間及來源由指定的 manifest 保存，來源必須與環境設定相符。

真正寫入需指定 `--target-namespace <32hex>`、`--apply`，完成兩次互動確認：先確認預計寫入數，再確認完整隔離目標。完整命令見 `worker/DEPLOY.md`。

- 目標必須與來源不同，且經列舉確認為空；拒絕非空目標，不自動刪除資料。
- 在第一次寫入前驗證格式版本、來源、digest、筆數、重複 key、允許的 prefix、value 型別與 expiration。Metadata 保留備份中的 JSON 值，不另驗證應用層結構。
- `member:` 保存原始 familyId 字串；其他資料驗證必要 JSON 容器，避免任意改寫或擅自禁止合法舊格式。
- `--max-writes` 預設 1,000，可由操作者指定本次預算。預計寫入數超出便在首次寫入前拒絕；這不是 Cloudflare 剩餘額度查詢，無法保證遠端不會因其他流量耗盡額度。
- 保留絕對到期時間。KV expiration 或 `public:` value 的 `expiresAt` 任一已到期或距到期不超過 60 秒，均略過並計數；不延長、不改成無期限。寫入前再次判斷時間。

### 寫入後

每批寫入須核對成功數與失敗清單。全部寫完後重新列舉、讀取目標，比對 key 集合、value、metadata 與 expiration。KV 傳播延遲採有上限重試，超時仍視為失敗；驗證期間已到期項目按原期限處理，不能重新寫入並延長。

失敗時保留隔離 namespace 供人工檢查，不自動清空、不自動綁定正式 Worker，也不宣稱完成。重試應另建空白目標，避免混入部分成功資料。

### 正式切換前

隔離還原成功不等於已可切換正式服務。維護者需安排停止寫入或維護時段，核對備份後發生的變更：

- 家庭成員清單與 `member:` 指標、借閱定位指標與家庭紀錄是否一致。
- 已撤銷的公開連結是否會因回復舊設定重新生效，已取消分享的書籍是否會重新公開。
- PIN／驗證方法、個人分享與「新書預設開放」是否在備份後改過，舊設定恢復的影響是否已處理。
- `kicked:` 僅保留原期限內限制；不能延長，也不能藉還原消除目前仍有效的限制。

首版不自動檢查上述應用層關聯。Checksum 與逐筆讀回成功不能取代這些檢查。含真實家庭資料的隔離 namespace 不得綁到開放的 `DEV_MODE=1` 服務；正式 binding 切換由維護者另行操作。

## 6. 容量與方案估算

以每家庭兩人、200 kB，每日一份並保留 14 份線性估算，使用十進位單位。尚未包含 JSONL 額外空間、metadata、額外手動備份、失敗殘留物件與帳號其他 R2 用量，也未假設所有使用者每日活躍。

| 使用者 | 家庭 | 一份備份 |  14 份 | 每家庭資料十倍時的 14 份 |
| -----: | ---: | -------: | -----: | -----------------------: |
|    100 |   50 |    10 MB | 140 MB |                   1.4 GB |
|    300 |  150 |    30 MB | 420 MB |                   4.2 GB |
|    500 |  250 |    50 MB | 700 MB |                     7 GB |

截至 2026-10-13，R2 Standard 每月免費額度為 10 GB-month 儲存、100 萬次 Class A 與 1,000 萬次 Class B 操作；不適用 Infrequent Access。GB-month 是月用量單位，不是單一檔案大小限制。此規模的儲存量仍有餘裕，但需合併帳號其他用量。[R2 定價](https://developers.cloudflare.com/r2/pricing/)

啟用 R2 需完成其 subscription／計費開通流程，與升級 Workers Paid 不同。本方案不因執行 Node 備份而要求 Workers Paid，也不保證帳號必定零費用。[R2 開通](https://developers.cloudflare.com/r2/get-started/)

KV 免費額度每天含讀取 100,000 個 key、寫入 1,000 個 key、列舉 1,000 次。每日備份消耗列舉與讀取；還原消耗寫入，與正常服務共用額度，REST／bulk 不會免計。500 人的 key 數可能因借閱等資料超過 1,000，不能從書籍數推算。演練前須確認可用額度與本次預算，必要時重新安排或調整方案。[KV 定價](https://developers.cloudflare.com/kv/platform/pricing/)

## 7. 啟用、監看與資料保護

1. 啟用 R2，建立私人 Standard bucket，確認未開公開存取。
2. `daily/` 設定 14 天刪除 lifecycle。這是依物件年齡刪除，不保證永遠留下最近 14 份成功備份。
3. 設定帳號、正式 namespace、bucket 與專用 credentials；還原寫入 token 不提供每日 workflow。
4. 開啟 Actions 失敗通知與 `KV_BACKUP_ENABLED=true`，手動執行首次備份並驗收。
5. 維護者確認最近成功紀錄與 R2 manifest 時間；超過 **36 小時**沒有成功備份即查明原因。

GitHub schedule 可能延遲或漏跑，公開 repository 60 天無活動會停用排程。因此正常運作時的 **24 小時資料損失窗口是目標，並非 SLA**。失敗通知也不能發現根本未啟動的排程，必須查看排程是否仍啟用。[GitHub 排程限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

首版不承諾獨立的新鮮度告警服務；維護者若不能持續檢查，擴大服務前需補上外部監看。長期失敗時 lifecycle 仍會刪除舊檔，不能等需要還原才確認。

備份資料不進 Git、不上傳 GitHub Actions artifact、不輸出公開 logs，且不列印實際 key、value 或 token。暫存檔位於作業系統暫存目錄，正常結束或可捕捉錯誤時清理；程序遭強制終止時可能殘留。R2 讀取權限視同資料庫讀取權限；首版不加額外應用層加密，不代表資料不敏感。

每日只做備份與 R2 下載核對；隔離 KV 還原演練安排於首次啟用、工具／格式重要修改後與維護者安排的定期演練，避免每日消耗正常服務的寫入額度。

## 8. 驗收與完成紀錄

### 程式與離線驗證

- [x] 分頁、批次讀取、分類、未知 prefix、空資料、缺漏與重複 key 有測試。
- [x] 原始 value、metadata、`public:` 與 `kicked:` 到期時間可往返保留。
- [x] 檔案損毀、hash／count 不符、API 部分成功、上傳或下載失敗，不會發布成功 manifest。
- [x] 同來源目標、非空目標、缺少確認、超出寫入預算，都在寫入前拒絕。
- [x] 到期資料、讀回不符、傳播延遲與重試耗盡有測試，不以重設 TTL 或假成功掩蓋問題。
- [x] 50 MB 合成資料完成本機封裝與驗證，記錄耗時與資源用量。
- [x] 工具、workflow 與測試通過本機專案檢查及 review，操作手冊列出可執行指令。

### 正式環境驗收

- [ ] R2、lifecycle、credentials、啟用開關與失敗通知完成設定。
- [ ] 真實正式 KV 備份存入 R2，下載後完整性核對成功。
- [ ] 同一備份還原至新空白隔離 namespace，讀回成功，並完成家庭／借閱／分享資料檢查。
- [ ] 記錄備份時間、筆數、bytes、SHA-256、還原時間、到期略過數與結果，不記錄使用者資料或憑證。
- [ ] 至少觀察一次排程成功，確認維護者知道如何處理超過 36 小時沒有成功備份。

**2026-10-13 本機檢查**：Worker 全套 86 個測試檔、2,441 個測試通過，其中 56 個為新增備份／還原測試；Worker typecheck、lint、工具語法與格式檢查通過，獨立程式與變更安全審查通過。移除 dry-run 防護或下載驗證的記憶體副本，皆確實使對應斷言失敗。既有 workspace 依賴 audit 並非全綠（5 critical、25 high、26 moderate、6 low），本次未變更依賴，未證實這些 advisory 可由本功能觸發。尚未執行遠端 CI。

**2026-10-13 本機容量驗證**：Windows、Node 22.22.2，500 個合成使用者紀錄、350,000 本合成書籍，原始 value 共 50,079,000 bytes，JSONL 共 60,632,500 bytes。建立與完整驗證共 934 ms，程序 peak RSS 385,120 KiB（約 376 MiB）；逐筆原始 value 完全一致。這只測格式工具的容量與往返，不含 API、R2 或遠端 KV。

**目前完成紀錄：尚無正式 R2 往返或隔離 namespace 還原驗證。** 本機、mock 或 CI 通過只證明各自覆蓋範圍，不能替代正式驗收，也不能宣稱正式服務已有每日備份保護。

## 9. 已接受的限制

- KV 匯出不是交易快照；跨 key 可能來自不同時間，需記錄匯出範圍與切換前資料檢查。
- 備份之後的新增、撤銷、設定變更需另行核對，不提供直接覆寫正式 KV 的捷徑。
- Checksum 可偵測損毀，無法證明資料邏輯正確，也無法抵抗同時能改資料與 manifest 的帳號入侵。
- KV 與 R2 位於同一 Cloudflare 帳號，無法涵蓋整個帳號失去存取權；異地帳號備份不在首版範圍。
- GitHub schedule 加人工監看不構成每日執行保證，14 天 lifecycle 也不是永久保存。

## 10. 官方介面參考

- [KV 列舉 API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/)：cursor 分頁，每頁最多 1,000 個 key。
- [KV 批次讀取 API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/bulk_get/)：每次最多 100 個 key，text 與 metadata 回應可保存 expiration。
- [KV 批次寫入 API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/bulk_update/)：須檢查成功數與失敗清單。
- [Wrangler R2 指令](https://developers.cloudflare.com/r2/reference/wrangler-commands/)：remote object put/get 支援檔案上傳與下載。
