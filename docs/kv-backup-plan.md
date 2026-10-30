# KV 自動備份計畫：Free 方案 Cron Worker 備份至 R2，超過分界改 Workers Paid

> **狀態**：程式已實作（PR #322，2026-10-16），啟用與驗收待執行，步驟見 `worker/DEPLOY.md`。
> **更新日期**：2026-10-16
> **取代**：2026-04-14 的初版設計、PR #315 的「Workers Paid 完整備份」版，以及「Cloudflare 觸發 → GitHub Actions 備份」草案。
> **目標**：小規模階段零月費、不依賴 GitHub 排程、每日自動備份、最後成功備份保護、獨立 Email 告警；完整性核對改在還原時執行。
> **規模與分界**：現況小（幾十個家庭、數 MB）。Free 方案的瓶頸是每次執行 10 ms CPU，資料量到達第 9 節的分界時，改訂 Workers Paid 並切換到每日雜湊核對版（第 14 節）。不採用跨平台（GitHub Actions）備援，避免多一個平台的憑證與失敗面。

---

## 1. 背景與動機

- Cloudflare KV 沒有官方備份服務；真正的風險不是硬體故障，而是應用層 bug（誤刪、寫壞 schema、遷移腳本出錯）。
- 單人維護的 side project，手動備份一定會被遺忘；自動化之外還要有「沒跑也會有人知道」的機制。
- 服務進入長期維護後，公開 repository 的 GitHub `schedule` workflow 會因 60 天無活動被停用，所以排程不能放在 GitHub。
- 上一版在 Worker 內做每日 SHA-256 核對，需要 Workers Paid（每月 US$5 起）。本版把計算搬到還原端，讓小規模階段留在 Free，並明訂何時升級。

## 2. 架構

```
Cloudflare Free Worker 每日 Cron（03:17 UTC，台灣 11:17）
→ 分頁列舉正式 KV（binding）
→ 批次讀取 getWithMetadata([keys], "text")，批次大小自適應
→ 原始 JSON 文字編碼後寫入 R2 multipart 分段，累計 bytes
→ 再次列舉，比對 key 集合與到期時間
→ 發布 manifest（含本次請求計數與封存大小）與 latest.json（R2 原生條件寫入）
→ 清理超過 14 天且不是最後成功的備份
→ 通知 Healthchecks「備份成功」
→ 請求數、筆數、封存大小都低於分界時，另通知 Healthchecks「容量正常」

Healthchecks 獨立監看
→ 約 36 小時沒有「備份成功」→ Email：備份停了
→ 約 36 小時沒有「容量正常」→ Email：該升級 Workers Paid 了
```

Worker 只做搬運與計數：不算雜湊、不解析 value。所有完整性與格式驗證在本機還原 CLI 執行。

備份時機是每天固定一次，不是資料更新時觸發：KV 沒有變更事件，寫入時備份只能耦合進正式 API 的每個寫入路徑，而且仍不是一致快照。代價是最多損失一天的變更；要縮短可以把 Cron 改成每 6 小時（仍在免費額度內），每小時則會超出 Free 的 KV 讀取上限。

## 3. Free 方案的平台限制與費用

官方限制頁對 subrequest 分兩列計算，本計畫分開記帳：

| 限制                                    | Free        | Paid                     | 對備份的意義                                                           |
| --------------------------------------- | ----------- | ------------------------ | ---------------------------------------------------------------------- |
| 對外 subrequest（`fetch()`）每次執行    | **50**      | 10,000                   | 只有 Healthchecks 的 2 次 ping，用不到                                 |
| 對內部服務 subrequest（KV、R2）每次執行 | **1,000**   | 預設 10,000              | 列舉、批次讀取、R2 分段、清理合計；用批次讀取後中規模也只需約 80 次    |
| 每次執行 CPU                            | **10 ms**   | 15 分鐘（Cron ≥ 1 小時） | **真正的瓶頸**：不能雜湊；JSON 文字編碼與分段複製的 CPU 隨封存大小成長 |
| 同時連線                                | 6           | 6                        | 批次讀取可平行，以 6 為上限                                            |
| Scheduled wall time                     | 15 分鐘     | 15 分鐘                  | 足夠                                                                   |
| 每日請求                                | 100,000     | 無上限                   | Cron 觸發也計入，與正式 API Worker 共用                                |
| Cron                                    | 每帳號 5 個 | 250                      | 本計畫用 1 個                                                          |

KV binding 的批次讀取：一次最多 100 個 key、算 1 次內部 subrequest、只支援 `text`／`json`（不支援 `stream`）、**單次回應上限 25 MB，超過回 413**。Free 與 Paid 都有這個上限。

| 項目         | 方案                                                            | 超限行為                                     |
| ------------ | --------------------------------------------------------------- | -------------------------------------------- |
| Workers      | Free                                                            | 請求失敗（Error 1027），不自動收費           |
| KV           | Free：每日讀 100,000、寫 1,000、刪 1,000、列舉 1,000；儲存 1 GB | 該類操作失敗，不自動收費                     |
| R2 Standard  | 免費額度：每月 10 GB、Class A 100 萬次、Class B 1,000 萬次      | **按量計費**，不是硬停；需先開通並綁付款方式 |
| Healthchecks | 免費方案（可建 20 個 check）                                    | —                                            |

小規模階段每月目標 US$0；升級後 Workers Paid 每月 US$5 起，其餘不變。

## 4. 備份範圍

要備份（實作 PR 帶入後，與 `scripts/kv-backup/format.mjs` 的 `PREFIXES` 一致，tripwire 測試 `worker/tests/unit/kvBackupKeyParity.test.ts` 釘住它與 `kvKeys` 的對應）：

`user:`、`family:`、`member:`、`verify:`、`publicshelves:`、`public:`、`borrow:`、`borrows:family:`、`newbookdefault:`、`kicked:`

不備份（短期憑證與計數）：`auth:`、`token:`、`tokenidx:`、`otp:`、`qr:`、`verifyfail:`、`ratelimit:`

出現未列入兩邊的 key 類別時，備份停止並失敗，由告警反映；新增 key 家族必須同時更新允許清單。

## 5. 每日備份流程

1. 檢查 `BACKUP_ENABLED`、來源 ID、兩個 Healthchecks UUID；讀取現有 `latest.json`。
2. 分頁列舉 KV；拒絕異常 cursor、重複 key、未知類別；超過 `MAX_SAVED_KEYS`（5,000，Free 與 Paid 相同）停止。
3. **自適應批次讀取** `getWithMetadata([keys], "text")`：起始每批 100 筆；回應超過 25 MB（413）時把該批對半拆開重試，拆到 1 筆仍失敗才視為備份失敗；重試計入請求計數。列舉時 expiration 已過且讀不到的 key 直接略過；其他遺失視為失敗。
4. 寫入 JSONL（格式 **version 2**）：`{"key":…,"expiration":…,"metadata":…,"value":<原始 JSON 文字>}`。value 本身是 JSON 的類別（除 `member:` 外全部）以原始文字直接嵌入，不解析、不重新序列化；`member:` 的短字串包成 JSON 字串。
5. 以 `TextEncoder` 編碼後填入 5 MiB 分段上傳；累加每筆與總 byte 長度。總長超過 `MAX_ARCHIVE_BYTES`（Free 設定檔 **15 MB**）即停止並失敗——這是專案自設的保守上限（由來與第 8 節實測後的定位見第 9 節），用明確錯誤取代被平台沒有提示地中止。
6. 再次列舉：不得出現新 key、未到期 key 不得消失、仍在的 key expiration 必須一致；違反便失敗。
7. 完成 multipart；manifest 記 `version: 2`、`count`、`prefixCounts`、每筆長度表、總長、R2 回報的 size、**本次內部與對外請求計數**；以 `etagDoesNotMatch: "*"` 寫入。
8. `latest.json` 以 ETag 條件寫入更新；`completedAt` 較舊或來源不同時不覆寫。
9. 清理 `snapshots/` 下超過 14 天且不是最新一對的物件。
10. 全部成功後向 Healthchecks「備份成功」check 發送空 POST。
11. 以同一組條件判定容量——**內部請求計數、筆數、封存總長三者都低於第 9 節的分界**——才向「容量正常」check 發送空 POST；任一超過就不發（這就是升級提醒）。

KV 仍不是跨 key 交易快照：兩次列舉能發現 key／expiration 變化，不能發現 value 被覆寫。

## 6. 最後成功備份保護

- 每次備份使用獨立檔名：`snapshots/YYYY-MM-DD/<timestamp>_<uuid>.jsonl` 與同名 `.manifest.json`。
- `latest.json` 只指向已完成上傳、長度一致的備份；更新用 R2 原生 `onlyIf` 條件寫入，並行發布衝突視為失敗。
- 只在新備份成功後清理；最後成功備份即使超過 14 天仍保留。
- R2 不設涵蓋 `snapshots/`、`latest.json` 或整個 bucket 的物件到期刪除規則。**保留**「未完成 multipart upload 一天後自動清除」規則：Worker 被平台中止時 catch 不會執行，殘留靠它清。
- 失敗清理只處理本次未發布的物件。

## 7. 完整性驗證（改在還原時）

每日不做 SHA-256，改為：

- Worker 端：每筆 byte 長度、總長、R2 回報的 object size 寫入 manifest。
- 還原 CLI：下載後核對總長與每筆長度、每行可解析、每筆 value 符合既有 schema、`count`／`prefixCounts` 相符；任一不符即拒絕還原。
- 接受的取捨：備份當天不會知道檔案是否損壞，最晚在下次還原演練或真正還原時才發現。緩解：每月一次對最新備份跑 dry-run 還原（只下載核對、不寫入），由管理者手動執行（repo 根目錄 `pnpm backup:drill`）。

## 8. CPU 與請求數的驗收

請求數可以在 Worker 內精確計數（每次 KV／R2 呼叫記內部、每次 `fetch()` 記對外），寫進 manifest；CPU 不行（時鐘凍結），只能從正式環境的儀表板、`wrangler tail` 或 GraphQL 讀 `cpuTime`。本機 Miniflare 兩者都不限制，而且開源 workerd 不計 CPU：本機 tail consumer 收到的 scheduled 事件 `cpuTime` 一律是 0。驗收方式：

1. 部署到 Free 帳號，暫設每小時 Cron，對真實資料跑至少 5 次。
2. 讀每次 manifest 的請求計數與封存總長：必須低於第 9 節的分界。
3. 記下 Workers 儀表板的 CPU time 數字，但判定以每次 Cron 執行的結果為準。驗收期間掛著 `wrangler tail`：事件的 `outcome` 必須是 `ok`，被中止是 `exceededCpu`。事後回查用 GraphQL `workersInvocationsAdaptive`：`dimensions.status` 必須是 `success`，被中止是 `exceededResources`（涵蓋 CPU 與記憶體超限）。兩邊的值不同，不能互相套用。出現任何一次中止，就依第 9 節進入升級流程。
4. 同時記錄 wall-clock 與 KV／R2 用量。

### 實測（2026-10-17 調查）

**開發機的量法。** 本機 Miniflare 的 KV／R2 是同一個 workerd 行程裡的 JS 模擬器，呼叫 binding 時會同步跑進模擬器，profile 會把模擬器的時間記在 binding 呼叫上，所以 Miniflare 的數字不能拿來對照正式環境。可用的量法是：在 workerd 內把 KV／R2／`fetch()` 全換成同一個 isolate 裡的 JS stub，量 wall-clock 再扣掉空請求的基準；stub 沒有 I/O，wall 就近似 isolate 的 CPU。機器 i7-13620H、Windows 11、workerd 1.20260915.1，冷 isolate 取 6 次重啟行程的中位數。量測腳本沒有入庫，以下是 2026-10-17 的一次性量測；`worker/src/backup/` 改動後要重量，得照上述方法重寫 stub 腳本：

| 資料量                                       | 冷 isolate | 暖 isolate | 只做 JSONL 編碼 |
| -------------------------------------------- | ---------- | ---------- | --------------- |
| 20 筆／238 KB（仿正式，略大於正式的 192 KB） | 5.9 ms     | 1.8 ms     | 0.3 ms          |
| 490 筆／4.96 MB                              | 22.1 ms    | 15.6 ms    | 11.6 ms         |

編碼成本隨封存大小線性成長，約 2.3 ms／MB；冷、暖之差約 4 ms 是第一次執行的延遲編譯與暖機。關掉 nodejs_compat、把 `node:*` 換成 stub 再量，冷 6.1 ms、暖 1.8 ms，沒有差別。

**正式環境（Free，2026-10-16 儀表板讀數）。** 量測條件：啟用驗收的每小時 Cron，同一天 10:17、11:17、12:17 UTC 三次成功執行，不是連續多日的每日執行；正式資料 20 筆、192,848 bytes、內部請求 12、對外 2。三次的 CPU 尖峰各約 25、27.5、28 ms，wall 各約 1.4 秒，三次都沒有被中止；故意失敗的那次（讀取任何資料前就丟錯）`cpuTime` 為 0，表示 isolate 啟動與模組載入不計入這個數字。

以下是對差距的**推論**，不是量測。25–28 ms 與開發機冷跑 5.9 ms 的差距，推測來自兩件程式改不掉的事：其一，相隔一小時且沒有 HTTP 流量的 Cron 每次都落在全新的冷 isolate（每天一次只會更冷），社群案例顯示正式機器的冷啟動首次執行是本機冷跑的 2–5 倍，套到 5.9 ms 就是 12–30 ms，涵蓋實測值；其二，14 次 binding／`fetch()` 呼叫在 runtime 端的序列化與回應解析，依間接證據反推約 2–6 ms，本機沒有等價物可量。程式層最樂觀只能省約 1.5–3 ms（少 4 次呼叫、精簡冷啟動），仍在 10 ms 上限的兩倍以上。

結論：原本「小規模 1–3 ms、中規模 20–40 ms」的估算錯了一個數量級，正式規模在 Free 下就已經 25–28 ms。資料量仍然影響 CPU（開發機冷跑從 238 KB 的 5.9 ms 增到 4.96 MB 的 22.1 ms，約 2.3 ms／MB），但它是疊在固定成本上的增量，而正式規模的固定成本已經超過 10 ms，所以不存在「資料量到哪裡 CPU 會接近 10 ms」的門檻。驗收期間的 25–28 ms 沒有被中止，官方只說偶爾超過會被容忍、容忍幅度沒有數字（口徑見第 9 節）；「每天一次算偶爾超過」是推論，要靠正式啟用後連續 7–14 次每日執行的結果驗證（排在第 13 節的啟用步驟裡），所以驗收改看每次執行的結果，不看分位數。請求數方面，正式規模實測內部 12、對外 2；中規模（5,000 筆、50 MB）推估內部約 10（列舉）+ 50（批次）+ 16（R2）= 76，距 1,000 上限很遠，請求數不是分界。

## 9. 升級分界：什麼時候改 Workers Paid

以下任一成立，就進入第 14 節的升級流程；判定來源是 manifest 計數、Cron 執行的結果與儀表板，不是人數。計數類的門檻約為上限的 70%：

| 指標                  | Free 上限                               | 分界                     | 偵測方式                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 封存總長              | 15 MB（第 5 節第 5 步的硬停，專案自設） | **≥ 10 MB**              | Worker 計數；超過時不 ping「容量正常」→ Email                                                                                                                                                                                                          |
| 保存範圍筆數          | 5,000（硬停）                           | **≥ 3,500**              | 同上                                                                                                                                                                                                                                                   |
| 單次內部請求計數      | 1,000（平台）                           | **≥ 700**                | 同上                                                                                                                                                                                                                                                   |
| 每次 Cron 的 CPU      | 10 ms（平台）                           | **執行結果出現一次中止** | 每月用 GraphQL `workersInvocationsAdaptive` 回查（可回看三個月）：`dimensions.status` 成功是 `success`、中止是 `exceededResources`。`wrangler tail`（`outcome` 成功 `ok`、中止 `exceededCpu`）只在驗收期間掛著看，不能回查。儀表板分位數只記錄，不判定 |
| KV 每日讀取（全帳號） | 100,000（平台）                         | ≥ 70,000                 | 第 10 節的用量預警                                                                                                                                                                                                                                     |

15 MB 與 5,000 筆是專案自設的保守上限，不是平台數字。15 MB 原本是推估 CPU 會接近 10 ms 的點，第 8 節實測後這個前提不成立：正式規模（20 筆、192 KB）在 Free 下就已經 25–28 ms，資料量每多 1 MB 約再加 2.3 ms 編碼，是疊在已超標的固定成本上的增量，所以資料量門檻不是 CPU 的分界。保留 15 MB 的理由改為：它讓備份在超過時明確失敗，而不是在平台沒有保證的容忍範圍裡一路變慢；Paid 下它則只是容量上限。5,000 筆與 Paid 設定檔一致，以便切換時格式與測試不變。封存總長的分界 10 MB 是 15 MB 的約 70%，與其他列相同比例。到硬停時備份會明確失敗，從收到升級提醒到完成訂閱與切換需要幾天，70% 的分界是為了留緩衝。

**CPU 一列為什麼不是數字門檻。** Free 的 10 ms 是「每次 Cron 觸發」的上限（官方 limits 頁的 Cron 一列：「CPU time per Cron Trigger | 10 ms」）。正式環境的驗收執行實測 25–28 ms（第 8 節），原本的「p99 ≥ 7 ms」在 Free 下不可能達標，分位數不能再當分界。官方對超過時的說明是：「Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit.」「If your Worker starts hitting the limit consistently, its execution will be terminated according to the limit configured.」而儀表板的分位數也不等於有沒有被中止：「In some cases, higher quantiles may appear to exceed CPU time limits without generating invocation errors because of a mechanism in the Workers runtime that allows rollover CPU time for requests below the CPU limit.」（來源見「官方依據」的 Workers 限制與 Workers 指標兩條）。被中止時 tail 事件的 `outcome` 是 `exceededCpu`，GraphQL 的 `dimensions.status` 是 `exceededResources`（官方指標頁的 Invocation statuses 表：Exceeded resources，涵蓋錯誤 1102 與 1027），錯誤是 Error 1102「Worker exceeded resource limits」，儀表板 Metrics > Errors 顯示「Exceeded CPU Time Limits」。所以判定改看每次執行的結果：連續 7–14 次每日執行都成功（GraphQL `dimensions.status` 為 `success`），就當作這個 Cron 落在容忍範圍；出現一次中止就升級。容忍的幅度與時間窗沒有任何官方數字，官方也沒有給出依頻率判定的規則；非官方案例顯示每分鐘一次的 Free Cron 落在冷 isolate 時會被截在 10.0 ms，「每分鐘一次算持續超過、每天一次算偶爾超過」是從這些案例與官方措辭得出的推論，由上述 7–14 次每日執行驗證。

**被中止時留下的狀態，取決於中止在哪一步。** `worker/src/backup/index.ts` 的順序是：寫 manifest → 更新 `latest.json` → 清理舊備份 → ping「備份成功」→ ping「容量正常」。在更新 `latest.json` 之前中止：指標不動、兩個 check 都沒收到訊號，約 36 小時後「備份成功」寄信。在清理期間中止：`latest.json` 已指向這次完整上傳的備份，但沒有任何 ping，一樣會寄信，只是這封信代表的是「清理沒做完」而不是「沒有新還原點」。在「備份成功」ping 送達之後才中止：該 check 已重設計時、不會寄信，只有「容量正常」沒收到 ping，約 36 小時後寄的是容量逾期信，看起來像升級提醒。所以沒有收到「備份成功」逾期信不等於每次執行都成功，中止必須從執行紀錄核對（GraphQL `dimensions.status`，或當時掛著的 tail），Healthchecks 只負責成功訊號完全沒送出的情況；收到容量逾期信而 manifest 三項都正常時，先查執行結果（`worker/DEPLOY.md` 第 6 節）。不論中止在哪一步，已發布的備份都是完整上傳的，沒有資料損毀風險；進行中的 multipart 由第 6 節的 R2 一天規則清除。

## 10. 獨立 Email 告警與免費額度預警

採用 Healthchecks.io，兩個 check，都是 Period 24 小時、Grace 12 小時、已驗證 Email：

- **備份成功**：只有本次備份完整流程成功才 ping。約 36 小時沒有訊號即寄信，涵蓋跑了但失敗、在成功 ping 之前被 CPU 中止、Cron 被刪、`BACKUP_ENABLED` 被關、帳號停權等情況，不需要備份程式還活著才能發出。成功 ping 之後才被中止的情況它偵測不到，要靠執行結果核對（第 9 節）。
- **容量正常**：只有第 5 節第 11 步的三項都低於分界時才 ping。沒有訊號代表該升級了，此時備份本身仍在運作。

兩個 check 的信件主旨不同，收到時就知道是「備份停了」還是「該升級了」。不傳書單、備份內容或憑證。

全帳號 KV 用量（正式 API 加備份）：先驗證 Cloudflare GraphQL Analytics API 能否在 Free 取得操作數與儲存量；可取得則日後由 Worker 在備份成功後查詢，納入「容量正常」的判定；不可取得則文件化每月手動查儀表板。本階段不自動升級。

為什麼不用全 Cloudflare 告警：Email Workers 需要網域以 zone 形式在 Cloudflare 上，本專案網域不在 Cloudflare；而且看門狗 Worker 與備份 Worker 同帳號、同額度，帳號層級故障時沒有人收到信。Cloudflare Notifications 沒有「排程未執行」的通知類型。

## 11. 憑證與資料保護

- 備份 Worker 只用 KV／R2 bindings，不持有 REST token；兩個 Healthchecks UUID 為 Worker secret。
- 沒有公開入口：`fetch` 一律 404、`workers_dev = false`、`preview_urls = false`。
- 日誌只記筆數、bytes、請求計數、manifest 路徑與 `BackupError` 的常數訊息；`worker/tests/unit/kvBackupErrorMessages.test.ts` 釘住訊息必須是字面值。
- GitHub 不持有任何備份相關 secret；CI 只做備份 Worker 的 dry-run build，不部署。
- 還原憑證只在可信任本機使用，演練後撤銷。

## 12. 還原方式

沿用本機 CLI `scripts/kv-restore.mjs`：

- 預設 dry-run；真正寫入需 `--apply`、互動輸入 `yes` 與 `RESTORE <目標ID>`，以及 `--max-writes` 寫入預算。
- 寫入目標必須是不同於正式來源的全新空白 namespace；不自動切換正式服務的 KV binding。
- 依第 7 節驗證長度、筆數、schema；略過已到期或即將到期的資料，保留原始到期時間；完成後逐筆回讀。
- **寫回規則依類別**：`member:` 寫回原始字串（例如 `abcd-1234`，不能多一層引號，否則 `member:` 指向與家庭 ID 的字串比對會失效）；其餘類別寫回備份中的原始 JSON 文字，不重新序列化。
- 還原驗收必須包含：以隔離 Worker 接上還原目標後，家庭成員判定（members GET、bookshelf GET）仍成立。

第 7 節的每月 dry-run 另有 `pnpm backup:drill`（`scripts/kv-restore-drill.mjs`）：讀本機 `wrangler.backup.local.toml`、沿用 `wrangler login` 身分，不需要 token，也從不寫入；下載後的驗證與 `--apply` 寫入前相同。

讀取器同時支援 version 1（`feat/kv-backup` 分支歷史的格式，value 為字串、manifest 含 sha256）與 version 2；version 1 僅供讀取舊演練產出，正式備份一律 version 2。

首次啟用及重要格式變更後，須完成隔離還原演練。

## 13. 實作與驗收

### 實作（程式）

- [x] 從 `feat/kv-backup` 分支歷史帶入 `scripts/kv-backup/`（format、restore、cli）、對應測試、`worker/src/backup/{retention,heartbeat,runtime,source}.ts`；移除 `multipart.ts` 的雜湊與 `verifyObject`。
- [x] `source.ts` 改為自適應批次 `getWithMetadata([keys], "text")`（100 起、413 對半拆、1 筆仍失敗才中止）；`runtime.ts` 的 `RunBudget` 分別計數內部與對外請求並寫入 manifest；`MAX_SAVED_KEYS` 5,000、Free 設定檔 `MAX_ARCHIVE_BYTES` 15 MB（第 8 節實測後維持，理由見第 9 節）。
- [x] JSONL writer 改為 version 2（原始 JSON 文字嵌入、長度累計、`TextEncoder` 編碼）。
- [x] `format.mjs` 的 `validateArchive` 改為長度／schema 驗證，接受 version 1 與 2；restore CLI 依類別寫回。
- [x] `heartbeat.ts` 支援兩個 check；第 11 步的三項容量判定。
- [x] 刪除 REST 匯出工具 `scripts/kv-backup.mjs`，或明確標為手動備援。（已刪除）
- [x] `wrangler.backup.toml` 改為 Free 設定（移除 `cpu_ms`）；CI 保留 dry-run build。
- [x] 本機 Miniflare 演練：真實 `scheduled` handler 對小規模合成資料跑通，還原 CLI 驗證通過，`member:` 寫回逐字相等。
- [x] 測試案例必含：單筆合法但 100 筆合計超過 25 MB 時自動拆批、重試計入請求數；僅封存大小超過分界時不送「容量正常」；請求計數、筆數各自超過分界時同樣不送（`worker/tests/unit/kvBackupCapacity.test.ts`）。
- [x] 更新 `worker/DEPLOY.md`（啟用章節含下方分工與升級流程）、`docs/architecture.md`。

### 啟用與驗收（分工）

要登入儀表板、輸入秘密、按互動確認、看信箱的由管理者做；能用本機已登入的 wrangler 完成的可由 agent 代勞。

| 步驟                                                                                 | 誰                           |
| ------------------------------------------------------------------------------------ | ---------------------------- |
| 開通 R2 並綁付款方式                                                                 | 管理者                       |
| Healthchecks 帳號、兩個 check（24 h + 12 h）、Email 驗證、取得兩個 UUID              | 管理者                       |
| 建 bucket、生命週期規則、`wrangler.backup.local.toml`、部署停用版                    | agent（wrangler）            |
| `wrangler secret put` 兩個 UUID                                                      | 管理者（終端機輸入）         |
| 每小時 Cron 跑 3–5 次、讀 manifest 核對請求計數、封存大小與 `latest.json`            | agent                        |
| 記錄儀表板 CPU、核對每次 Cron 的 outcome（第 8 節）                                  | 管理者                       |
| 建隔離 namespace                                                                     | agent                        |
| 建還原用 API token、設本機環境變數                                                   | 管理者                       |
| 還原 dry-run                                                                         | 任一                         |
| 還原 `--apply`、家庭成員判定核對                                                     | 管理者（程式拒絕非互動執行） |
| 故意失敗一次，確認 `latest.json` 未動、仍可 dry-run 還原                             | agent                        |
| 兩個 check 各改 1 分鐘 + 1 分鐘，不 ping，等真的收到兩封 Email，再改回               | 管理者                       |
| Cloudflare Billing 用量通知                                                          | 管理者                       |
| 正式啟用 `crons=["17 3 * * *"]`、觀察一次成功                                        | agent 部署、管理者確認       |
| 啟用後 7–14 天每天核對執行結果（GraphQL `dimensions.status`），全部 `success` 才結案 | 管理者                       |
| 維運紀錄、每月 dry-run 提醒、每月 GraphQL 執行結果與儀表板 CPU 檢查                  | 管理者                       |

合併 PR 不代表已啟用，須完成以上全部。

## 14. 升級流程：改 Workers Paid

觸發條件見第 9 節。步驟：

1. 訂閱 Workers Paid（每月 US$5 起；KV、R2 額度隨之放大）。
2. 切換到「Paid 設定檔」：`MAX_ARCHIVE_BYTES` 提高到 256 MiB、每筆上限 4 MiB、`MAX_SAVED_KEYS` 維持 5,000；啟用每日 SHA-256 核對與下載回讀（`feat/kv-backup` 分支歷史中的 `multipart.ts`／`verifyObject`），`wrangler.backup.local.toml` 加回 `cpu_ms`。批次讀取的 25 MB 回應上限在 Paid 仍然存在，自適應拆批不可移除。
3. **格式不變**：Paid 版仍寫 version 2，manifest 多一個可選的 `sha256` 欄位；還原 CLI 讀到 `sha256` 就額外核對。不能直接恢復 `feat/kv-backup` 歷史中的 version 1 工具，它會拒絕 version 2 的備份。
4. 重新部署，重跑第 13 節的驗收（首次備份、隔離還原、保護與告警演練）。
5. 「容量正常」check 的分界改為 Paid 上限的 70%：封存 180 MB、筆數 3,500、內部請求 7,000；其餘告警不變。

## 官方依據

- Workers 限制（Free：對外 subrequest 50、對內部服務 1,000、每次 Cron 觸發 10 ms CPU 與其 built-in flexibility 說明、100,000 請求／日、5 個 Cron；Scheduled 15 分鐘 wall time）：https://developers.cloudflare.com/workers/platform/limits/
- Workers 指標（CPU time 分位數採 reservoir sampling、rollover 機制說明）：https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
- KV 批次讀取（100 key、算 1 次、text／json、回應 25 MB）：https://developers.cloudflare.com/kv/api/read-key-value-pairs/
- KV 免費額度與超限失敗：https://developers.cloudflare.com/kv/platform/pricing/
- R2 免費額度與計費：https://developers.cloudflare.com/r2/pricing/
- R2 Workers API（條件寫入、multipart）：https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- GitHub `schedule` 的 60 天無活動停用規則：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- Healthchecks：https://healthchecks.io/docs/
