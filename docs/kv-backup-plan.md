# KV 自動備份計畫

> **狀態**：改為 Cloudflare 排程、獨立逾期告警與最後成功備份保護；正式環境尚未設定、驗收或啟用。
> **建立日期**：2026-04-14
> **更新日期**：2026-10-13

## 1. 目的與規模

服務進入維護期後，即使 repository 長期沒有更新，備份仍須持續運作；正常時不要求維護者定期登入查看，有異常才以 Email 通知。備份涵蓋誤刪、程式寫壞資料與遷移失敗，必須能下載核對並還原至隔離 namespace。

維護者回報正式版目前兩人、約 100 與 500 本書，KV 用量 **196.71 kB**，推出後預估 **100～500 人**。這些不是工具量測結果。每人的書單存在一個 `user:{userId}`，書籍數不等於 key 數；家庭、借閱與驗證等紀錄另佔 key。

## 2. 架構與啟用方式

```text
Cloudflare Cron（每日 03:17 UTC／台灣 11:17）
  → 獨立備份 Worker 透過 binding 讀取正式 KV
  → 分段上傳私人 R2，讀回核對
  → 發布 manifest 與 latest.json，清理舊備份
  → 向 Healthchecks.io 發出無內容的成功訊號

Healthchecks.io 獨立計時
  → 36 小時沒有成功訊號：Email 告警
```

備份 Worker 使用 **Workers Paid**，與服務 API Worker 分開部署；沒有公開 HTTP 管理入口、`workers.dev` 網址或 preview URL。正式 API 的路由、binding 與部署流程不變。GitHub Actions 只做 CI 檢查，已移除每日備份 workflow；備份不依賴 repository 活動，也不以 GitHub 排程維持另一個排程。

`worker/wrangler.backup.toml` 是停用範本：`BACKUP_ENABLED="false"`、`crons=[]`。維護者複製成 gitignored 的 `wrangler.backup.local.toml`，明確填入正式來源後部署。合併、發版與 API Worker 部署都不會自動啟用備份。完整命令見 [部署指南](../worker/DEPLOY.md#kv-每日備份與還原演練)。

| 設定                                       | 用途                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `BACKUP_KV`                                | 正式來源 KV binding；程式只呼叫讀取／列舉                        |
| `BACKUP_BUCKET`                            | 私人 R2 Standard bucket binding                                  |
| `SOURCE_ACCOUNT_ID`、`SOURCE_NAMESPACE_ID` | manifest 的來源識別，須與實際 binding 一致                       |
| `BACKUP_ENABLED`                           | 只有字串 `true` 才執行                                           |
| `HEALTHCHECKS_UUID`                        | Worker secret；只接受 UUID，固定向 `https://hc-ping.com/` 發訊號 |

每日執行不需要 Cloudflare REST token。**KV binding 本身並非唯讀權限**；只讀是程式行為，不能當成平台授權隔離。來源 ID 是操作者核對的設定，binding 無法自行證明其 namespace ID。部署帳號需正確配置資源並保護 Cloudflare 管理權限。

## 3. 保存與排除範圍

| 保存 prefix                  | 內容                                 |
| ---------------------------- | ------------------------------------ |
| `user:`                      | 書單、分享設定、顯示名稱、個人偏好   |
| `family:`、`member:`         | 家庭紀錄與成員反向指標               |
| `verify:`                    | 驗證方法、雜湊與 salt                |
| `publicshelves:`、`public:`  | 公開書櫃設定與分享內容、原始到期時間 |
| `borrow:`、`borrows:family:` | 借閱指標及家庭借閱紀錄，兼容舊格式   |
| `newbookdefault:`            | 新書預設開放設定                     |
| `kicked:`                    | 尚未到期的成員移除限制，不重設期限   |

排除 `auth:`、`token:`、`otp:`、`qr:`、`verifyfail:`、`ratelimit:`；不恢復舊登入憑證、一次性驗證碼或過時的流量／驗證失敗計數。未知 prefix、空備份、重複 key 或列舉後讀不到值，均使本次失敗，不發布部分成功結果。key 定義以 `worker/src/kv/schema.ts` 為準。

每筆 JSONL 保存原始 value 字串、存在時的 metadata 與絕對 expiration。不因匯出／還原重新序列化應用資料或延長到期時間。備份包含敏感的家庭、書籍與驗證資料，不能視為公開資料。

## 4. 匯出、核對與資源上限

1. 驗證設定、分頁列舉全部 key；拒絕異常 cursor、重複 key 與未知 prefix。
2. 依序讀取保存範圍，保留原始字串與 metadata，以列舉取得的 expiration 保存期限；列舉後因自身到期而消失的 key 直接略過，不寫入備份。讀取後再次列舉：不得出現新 key、未到期 key 不得消失、仍在的 key expiration 必須一致；違反便失敗。manifest 的 `count`／`prefixCounts` 只計入實際寫入 JSONL 的筆數。
3. 邊產生 JSONL 邊計算 SHA-256，以 5 MiB 分段上傳 R2，避免把整份備份放入記憶體。最後一段可較小。
4. 下載 R2 資料，以串流重新核對 bytes 與 SHA-256；只有驗證成功才發布 manifest，再更新 `latest.json`。
5. 清理舊備份並回報成功 heartbeat。任何失敗不得用舊備份發成功訊號；保留已提交的有效備份供復原。

首版保守上限：單筆原始 value **4 MiB**、保存 **5,000 個 key**、全部列舉 **100,000 個 key**、檔案 **256 MiB**、9,000 次 I/O 呼叫預算。程式在操作及串流處理間檢查 **12 分鐘**預算，並非能中斷所有進行中的 binding 呼叫；這些仍受平台期限約束。暫時性操作失敗有限重試，整次最多 100 次額外嘗試；沒有無限重試。超限會失敗並由逾期監看通知，需調整實作或容量規劃，不能宣稱支援任意成長規模。Workers Paid 並未取消 128 MB 記憶體限制；串流與單筆上限是必要設計。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

Manifest 保留 `version: 1`，含 `sourceAccountId`、`sourceNamespaceId`、`startedAt`、`completedAt`、`count`、`prefixCounts`、`sha256`、`byteLength`、`dataObjectPath`。資料與 manifest 位於 `snapshots/YYYY-MM-DD/<timestamp>_<uuid>.jsonl` 及同名 `.manifest.json`，每次執行名稱不同。

**這仍不是交易快照。** 兩次列舉能發現 key／expiration 的變化，不能發現 key 未變但 value 被覆寫，且 KV 最終一致仍可能回傳舊資料。檔案完整性不能證明跨 key 關聯是同一時點；正式切換前須另行核對家庭、借閱及分享狀態。

## 5. 最後成功備份保護

`snapshots/` 與 `latest.json` **不得套用依年齡刪除物件的 R2 lifecycle**，也不能有涵蓋整個 bucket 的刪除規則。`latest.json` 指向最後成功發布的 manifest；更新採 R2 ETag 條件寫入，並行發布衝突視為失敗，不任意覆蓋別人的指標。

清理只在新備份成功發布後執行，刪除超過 14 天且不是受保護最新世代的物件。清理失敗可能暫時增加儲存量，但不能犧牲目前最後成功備份。新備份失敗、Cron 停止或整個 Worker 不執行時，沒有 lifecycle 繼續倒數刪除最後一份。

保護代表「不因一般保留政策失去最後一份」，不是防止人工刪除、帳號入侵或錯誤修改 bucket 規則。也不代表最後一份一定夠新；新鮮度由獨立告警監看。舊版 `daily/` 檔案仍可用原本 manifest 路徑還原；遷移前必須檢查舊 lifecycle 沒有涵蓋新版 `snapshots/` 或 `latest.json`。

## 6. 獨立逾期告警

採 Healthchecks.io **Simple schedule：Period 24 小時、Grace Time 12 小時**。只有本次備份及保護流程完成才發成功 POST，沒有 request body；不發 `/start` 或 `/fail`，也不傳任何書單、識別碼、檔案或錯誤內容。約 36 小時未收到成功訊號時，由 Cloudflare 之外的平台通知 Email。可啟用每日 down reminder，直到恢復。[排程設定](https://healthchecks.io/docs/configuring_checks/)、[Email 通知](https://healthchecks.io/docs/configuring_notifications/)

Secret 只存 UUID，程式固定 HTTPS host、禁止 redirect、使用有限逾時與重試，且不記錄 UUID、完整 URL 或原始 fetch exception。Ping 失敗不回滾已提交的備份，仍讓執行結果反映通知失敗。Healthchecks 會看見送達時間與出口 IP；它不會取得備份內容。

**HTTP 200 不能單獨證明監看設定正確。** Healthchecks UUID API 對不存在 check 或 rate limit 也可能回 200，因此啟用驗收須看到實際成功事件，並做真正的漏 ping Email 演練。不得手工對正式 check 持續 ping 偽裝備份正常。[Pinging API](https://healthchecks.io/docs/http_api/)

這個機制能發現備份程式未啟動或未成功；Healthchecks 自身中斷、Email 投遞失敗、check 被誤停用或 UUID 外洩仍是剩餘風險。收到異常後仍需處理，但正常運作不以人工定期查看為前提。

## 7. 還原與正式切換

本機 `scripts/kv-restore.mjs` 保留，支援新版 `snapshots/` 及舊版 `daily/` manifest。預設 dry-run；真正寫入需 `--apply`、不同於來源的新空白 namespace，以及兩次互動確認。還原 token 只存在可信任的本機環境，不提供備份 Worker。

寫入前完整核對版本、來源、path、hash、bytes、count、重複 key、prefix、value 型別與 expiration。Metadata 保留原 JSON 值，不驗證應用層 schema。`--max-writes` 預設 1,000，是本次上限，不是 Cloudflare 剩餘額度查詢。KV expiration 或 `public:` 的 `expiresAt` 已到期／距到期不超過 60 秒便略過，寫入前再檢查；不重設 TTL。

寫入後核對成功數、失敗清單，並逐筆回讀 value、metadata、expiration 與 key 集合。KV 傳播延遲採有限重試；超時或部分寫入失敗不能宣稱完成，不自動清空或切換正式 binding。重試改用另一個全新空白 namespace。

事故復原前需核對備份後的家庭成員、借閱、PIN／驗證方法、分享設定與已撤銷連結，避免回復舊資料重新開放存取。含真實資料的隔離 Worker 必須有存取保護且保持正式驗證設定，不得放到公開 `DEV_MODE=1` 服務。CLI 不執行正式切換。

## 8. 費用與容量

Workers Paid **每月 US$5 起**，是帳號層級方案，不是只對備份 Worker 計費；帳號其他 Worker／KV 用量合併計算，超額可能另計。R2 另需開通 subscription。[Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)、[KV 定價](https://developers.cloudflare.com/kv/platform/pricing/)

以每家庭兩人、200 kB、每日一份估算：

| 使用者 | 家庭 | 原始資料一份 | 14 份原始資料 |
| -----: | ---: | -----------: | ------------: |
|    100 |   50 |        10 MB |        140 MB |
|    300 |  150 |        30 MB |        420 MB |
|    500 |  250 |        50 MB |        700 MB |

這是十進位單位，未含 JSONL 編碼、metadata、額外執行、multipart／失敗殘留、清理延遲與帳號其他用量。不是剛好最多 14 份；最後成功備份即使超過 14 天仍保留。已驗證的舊 Node 格式工具樣本中，50.079 MB raw value 產生 60.633 MB JSONL，此比例不是所有資料的固定值，也不能拿 Node 的記憶體測量證明 Worker 可用。

R2 Standard 每月免費額度目前為 10 GB-month、100 萬 Class A 與 1,000 萬 Class B 操作；KV 備份的讀取／列舉與還原寫入也照用量計算。US$5 是方案起價，不是總費用硬上限。Healthchecks 免費 Hobbyist 方案目前有 20 個 check，本次只需要一個。[R2 定價](https://developers.cloudflare.com/r2/pricing/)、[Healthchecks 定價](https://healthchecks.io/pricing/)

## 9. 驗收紀錄與推出條件

### 本機檢查範圍

2026-10-13 本次驗證結果：

- Worker 全套 `pnpm test:coverage`：89 個測試檔、2,492 個測試通過；整體 lines／statements 98.03%、branches 97.10%、functions 99.01%。包含既有備份／還原 CLI，以及新增分段、損毀、發布順序、CAS 衝突、超限、到期、保護與清理失敗、heartbeat 測試。
- Worker 型別、lint、備份 Worker dry-run build、變更檔案格式檢查通過。移除最後成功備份保護或 heartbeat 回應核對的記憶體副本，均由對應斷言攔截。
- `node scripts/test-kv-backup-runtime.mjs` 在真實本機 workerd 觸發正式 `scheduled` handler，使用合成 KV／R2 與攔截的通知外連。501 筆原始 value 共 **54,218,804 bytes**，輸出 **56,354,301 bytes** JSONL，約 **10.2 秒**完成；含一筆需跳脫編碼的 **4 MiB** value。逐筆 value SHA-256、metadata、整份 hash／bytes／筆數均相符，完成後僅送一次成功訊號。
- Runtime 演練曾抓到 Cloudflare 不支援 `fetch` 的 `redirect: "error"`；已改為 `manual` 並保留 HTTP 200 與精確 `OK` 檢查，修正後演練通過。程式與變更範圍安全審查通過。

本機 workerd 驗證了執行環境相容性與資料往返，**不能證明正式 Cloudflare CPU／記憶體配額、遠端 binding 權限或 Email 投遞已驗收**。本次未變更依賴，也未重跑既有依賴 audit；未執行前端 E2E。

### 正式啟用驗收（尚未完成）

- [ ] Workers Paid、私人 R2、正式來源 binding 已配置並交叉核對。
- [ ] `snapshots/` 與 `latest.json` 沒有被任何物件刪除 lifecycle 涵蓋。
- [ ] Email 已驗證並連接 check，24h／12h 設定正確。
- [ ] 真實資料完成備份、R2 下載核對、manifest 與 `latest.json` 發布。
- [ ] 同一備份還原至隔離 namespace，逐筆回讀及受保護的服務讀取成功。
- [ ] 故意失敗後，最後成功備份仍可下載與還原。
- [ ] 短時間窗漏 ping 演練收到真正逾期 Email；恢復 24h／12h，成功後收到復原通知。
- [ ] 至少一次正式每日 Cron 成功；記錄時間、筆數、bytes、digest 與結果，不記錄資料／憑證。

每日執行備份及 R2 核對，不每日向 KV 做還原寫入。還原演練在首次啟用及格式／工具重要變更後重做；新鮮度告警不要求人工每日查看。尚無正式 R2 往返、還原或通知演練紀錄，不能宣稱正式備份已啟用。

## 10. 已接受的限制

- 約 24 小時資料復原窗口是目標，不是 SLA；告警發現異常不代表資料已自動補回。
- 跨 key 非交易一致，checksum 不能證明應用邏輯正確。
- KV 與 R2 同帳號，無法涵蓋整個 Cloudflare 帳號失去存取權或遭入侵。
- 自動保留與告警不能取代事故處理、帳號／付款維護或對容量成長的回應。
- 首版不加額外應用層加密；R2 讀取權限視同資料庫讀取權限，備份不進 Git、GitHub artifact 或公開日誌。
