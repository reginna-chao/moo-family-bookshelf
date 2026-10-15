# KV 自動備份計畫：Free 方案 Cron Worker 備份至 R2，超過分界改 Workers Paid

> **狀態**：計畫已確認，待實作與驗收。
> **更新日期**：2026-10-15
> **取代**：2026-04-14 的初版設計、PR #315 的「Workers Paid 完整備份」版，以及「Cloudflare 觸發 → GitHub Actions 備份」草案。
> **目標**：小規模階段零月費、不依賴 GitHub 排程、每日自動備份、最後成功備份保護、獨立 Email 告警；完整性核對改在還原時執行。
> **規模與分界**：現況小（幾十個家庭、數 MB）。Free 方案只能支撐小規模（第 3 節的硬限制）；用量到達第 9 節的分界時，改訂 Workers Paid 並切換到每日雜湊核對版（第 14 節）。不採用跨平台（GitHub Actions）備援，避免多一個平台的憑證與失敗面。

---

## 1. 背景與動機

- Cloudflare KV 沒有官方備份服務；真正的風險不是硬體故障，而是應用層 bug（誤刪、寫壞 schema、遷移腳本出錯）。
- 單人維護的 side project，手動備份一定會被遺忘；自動化之外還要有「沒跑也會有人知道」的機制。
- 服務進入長期維護後，公開 repository 的 GitHub `schedule` workflow 會因 60 天無活動被停用，所以排程不能放在 GitHub。
- 上一版在 Worker 內做每日 SHA-256 核對，需要 Workers Paid（每月 US$5 起）。本版把計算搬到還原端，讓小規模階段留在 Free；但 Free 另有每次執行 50 次 subrequest 的硬限制，所以本版明訂規模上限與升級分界。

## 2. 架構

```
Cloudflare Free Worker 每日 Cron（03:17 UTC，台灣 11:17）
→ 分頁列舉正式 KV（binding）
→ 每 100 筆一次批次讀取（getWithMetadata([keys], "text")）
→ 原始 JSON 文字編碼後寫入 R2 multipart 分段
→ 再次列舉，比對 key 集合與到期時間
→ 發布 manifest（含本次 subrequest 計數）與 latest.json（R2 原生條件寫入）
→ 清理超過 14 天且不是最後成功的備份
→ 通知 Healthchecks「備份成功」
→ 用量低於分界時，另通知 Healthchecks「容量正常」

Healthchecks 獨立監看
→ 約 36 小時沒有「備份成功」→ Email：備份停了
→ 約 36 小時沒有「容量正常」→ Email：該升級 Workers Paid 了
```

Worker 只做搬運與計數：不算雜湊、不解析 value。所有完整性與格式驗證在本機還原 CLI 執行。

備份時機是每天固定一次，不是資料更新時觸發：KV 沒有變更事件，寫入時備份只能耦合進正式 API 的每個寫入路徑，而且仍不是一致快照。代價是最多損失一天的變更；要縮短可以把 Cron 改成每 6 小時（仍在免費額度內），每小時則會超出 Free 的 KV 讀取上限。

## 3. Free 方案的硬限制與費用

| 限制                | Free                                         | 對備份的意義                                                  |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| 每次執行 subrequest | **50 次**（Paid 10,000）；KV、R2、fetch 都算 | 一次備份的所有 KV／R2 呼叫合計不能超過 50，這是規模上限的主因 |
| 每次執行 CPU        | 10 ms（Paid 15 分鐘）                        | 不能雜湊；JSON 文字編碼與分段複製的 CPU 隨資料量成長          |
| 同時連線            | 6                                            | 批次讀取可平行，但以 6 為上限                                 |
| 每日請求            | 100,000                                      | Cron 觸發也計入，與正式 API Worker 共用                       |
| Cron                | 每帳號 5 個                                  | 本計畫用 1 個                                                 |

KV binding 的批次讀取：一次最多 100 個 key、算 1 次 subrequest、只支援 `text`／`json`（不支援 `stream`）、單次回應上限 25 MB。

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

不備份（短期憑證與計數）：`auth:`、`token:`、`otp:`、`qr:`、`verifyfail:`、`ratelimit:`

出現未列入兩邊的 key 類別時，備份停止並失敗，由告警反映；新增 key 家族必須同時更新允許清單。

## 5. 每日備份流程

1. 檢查 `BACKUP_ENABLED`、來源 ID、兩個 Healthchecks UUID；讀取現有 `latest.json`。
2. 分頁列舉 KV；拒絕異常 cursor、重複 key、未知類別；超過 `MAX_SAVED_KEYS`（Free 設定檔為 **2,000**）停止。
3. 每 100 筆一次 `getWithMetadata([keys], "text")`。列舉時 expiration 已過且讀不到的 key 直接略過；其他遺失視為失敗。
4. 寫入 JSONL（格式 **version 2**）：`{"key":…,"expiration":…,"metadata":…,"value":<原始 JSON 文字>}`。value 本身是 JSON 的類別（除 `member:` 外全部）以原始文字直接嵌入，不解析、不重新序列化；`member:` 的短字串包成 JSON 字串。
5. 以 `TextEncoder` 編碼後填入 5 MiB 分段上傳；累加每筆與總 byte 長度。
6. 再次列舉：不得出現新 key、未到期 key 不得消失、仍在的 key expiration 必須一致；違反便失敗。
7. 完成 multipart；manifest 記 `version: 2`、`count`、`prefixCounts`、每筆長度表、總長、R2 回報的 size、**本次 subrequest 計數**；以 `etagDoesNotMatch: "*"` 寫入。
8. `latest.json` 以 ETag 條件寫入更新；`completedAt` 較舊或來源不同時不覆寫。
9. 清理 `snapshots/` 下超過 14 天且不是最新一對的物件。
10. 全部成功後向 Healthchecks「備份成功」check 發送空 POST。
11. 若本次 subrequest 計數與筆數都低於第 9 節的分界，再向「容量正常」check 發送空 POST；否則不發（這就是升級提醒）。

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
- 接受的取捨：備份當天不會知道檔案是否損壞，最晚在下次還原演練或真正還原時才發現。緩解：每月一次對最新備份跑 dry-run 還原（只下載核對、不寫入），由管理者手動執行。

## 8. 10 ms CPU 與 50 次 subrequest 的驗收

subrequest 可以在 Worker 內精確計數（每次 KV／R2／fetch 呼叫加一），寫進 manifest；CPU 不行（時鐘凍結），本機 Miniflare 兩者都不限制。驗收方式：

1. 部署到 Free 帳號，暫設每小時 Cron，對真實資料跑至少 5 次。
2. 讀每次 manifest 的 subrequest 計數：必須低於第 9 節的分界。
3. 讀 Workers 儀表板 CPU time：p99 **≤ 5 ms** 定案；5–7 ms 記錄並定期複查；> 7 ms 視為已到分界。
4. 同時記錄 wall-clock（Cron 上限 15 分鐘）與 KV／R2 用量。

小規模（500 筆、5 MB）估算：列舉 2 次、批次讀取 5 次、R2 約 6 次、心跳 2 次，合計約 15 次 subrequest；CPU 約 1–3 ms。

## 9. 升級分界：什麼時候改 Workers Paid

以下任一成立，就進入第 14 節的升級流程；判定來源是 manifest 計數與儀表板，不是人數：

| 指標                  | 分界（約 Free 上限的 70%）                                 | 偵測方式                                            |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| 單次 subrequest 計數  | **≥ 35**                                                   | Worker 計數；超過時不 ping「容量正常」check → Email |
| 保存範圍筆數          | **≥ 1,400**（Free 設定檔 `MAX_SAVED_KEYS` = 2,000 為硬停） | 同上                                                |
| 封存大小              | **≥ 10 MB**                                                | 同上                                                |
| CPU p99               | **≥ 7 ms**                                                 | 儀表板（手動，每月檢查一次）                        |
| KV 每日讀取（全帳號） | ≥ 70,000                                                   | 第 10 節的用量預警                                  |

分界取 70% 的理由：到硬上限時備份會直接失敗，從收到升級提醒到完成訂閱與切換需要幾天，要留緩衝。超過硬停（2,000 筆或 50 次 subrequest）時備份失敗、「備份成功」check 逾期，會收到第二封信，但那時已經有幾天沒有新備份。

## 10. 獨立 Email 告警與免費額度預警

採用 Healthchecks.io，兩個 check，都是 Period 24 小時、Grace 12 小時、已驗證 Email：

- **備份成功**：只有本次備份完整流程成功才 ping。約 36 小時沒有訊號即寄信，涵蓋跑了但失敗、被 CPU 砍掉、Cron 被刪、`BACKUP_ENABLED` 被關、帳號停權等所有情況，不需要備份程式還活著才能發出。
- **容量正常**：只有用量低於第 9 節分界時才 ping。沒有訊號代表該升級了，此時備份本身仍在運作。

兩個 check 的信件主旨不同，收到時就知道是「備份停了」還是「該升級了」。不傳書單、備份內容或憑證。

全帳號 KV 用量（正式 API 加備份）：先驗證 Cloudflare GraphQL Analytics API 能否在 Free 取得操作數與儲存量；可取得則日後由 Worker 在備份成功後查詢，納入「容量正常」的判定；不可取得則文件化每月手動查儀表板。本階段不自動升級。

為什麼不用全 Cloudflare 告警：Email Workers 需要網域以 zone 形式在 Cloudflare 上，本專案網域不在 Cloudflare；而且看門狗 Worker 與備份 Worker 同帳號、同額度，帳號層級故障時沒有人收到信。Cloudflare Notifications 沒有「排程未執行」的通知類型。

## 11. 憑證與資料保護

- 備份 Worker 只用 KV／R2 bindings，不持有 REST token；兩個 Healthchecks UUID 為 Worker secret。
- 沒有公開入口：`fetch` 一律 404、`workers_dev = false`、`preview_urls = false`。
- 日誌只記筆數、bytes、subrequest 計數、manifest 路徑與 `BackupError` 的常數訊息；`worker/tests/unit/kvBackupErrorMessages.test.ts` 釘住訊息必須是字面值。
- GitHub 不持有任何備份相關 secret；CI 只做備份 Worker 的 dry-run build，不部署。
- 還原憑證只在可信任本機使用，演練後撤銷。

## 12. 還原方式

沿用本機 CLI `scripts/kv-restore.mjs`：

- 預設 dry-run；真正寫入需 `--apply`、互動輸入 `yes` 與 `RESTORE <目標ID>`，以及 `--max-writes` 寫入預算。
- 寫入目標必須是不同於正式來源的全新空白 namespace；不自動切換正式服務的 KV binding。
- 依第 7 節驗證長度、筆數、schema；略過已到期或即將到期的資料，保留原始到期時間；完成後逐筆回讀。
- **寫回規則依類別**：`member:` 寫回原始字串（例如 `abcd-1234`，不能多一層引號，否則 `member:` 指向與家庭 ID 的字串比對會失效）；其餘類別寫回備份中的原始 JSON 文字，不重新序列化。
- 還原驗收必須包含：以隔離 Worker 接上還原目標後，家庭成員判定（members GET、bookshelf GET）仍成立。

讀取器同時支援 version 1（`feat/kv-backup` 分支歷史的格式，value 為字串、manifest 含 sha256）與 version 2；version 1 僅供讀取舊演練產出，正式備份一律 version 2。

首次啟用及重要格式變更後，須完成隔離還原演練。

## 13. 實作與驗收

### 實作（程式）

- [ ] 從 `feat/kv-backup` 分支歷史帶入 `scripts/kv-backup/`（format、restore、cli）、對應測試、`worker/src/backup/{retention,heartbeat,runtime,source}.ts`；移除 `multipart.ts` 的雜湊與 `verifyObject`。
- [ ] `source.ts` 改為批次 `getWithMetadata([keys], "text")`；`runtime.ts` 的 `RunBudget` 改為計數 subrequest 並寫入 manifest；Free 設定檔 `MAX_SAVED_KEYS` = 2,000。
- [ ] JSONL writer 改為 version 2（原始 JSON 文字嵌入、長度累計、`TextEncoder` 編碼）。
- [ ] `format.mjs` 的 `validateArchive` 改為長度／schema 驗證，接受 version 1 與 2；restore CLI 依類別寫回。
- [ ] `heartbeat.ts` 支援兩個 check；第 11 步的分界判定。
- [ ] 刪除 REST 匯出工具 `scripts/kv-backup.mjs`，或明確標為手動備援。
- [ ] `wrangler.backup.toml` 改為 Free 設定（移除 `cpu_ms`）；CI 保留 dry-run build。
- [ ] 本機 Miniflare 演練：真實 `scheduled` handler 對小規模合成資料跑通，還原 CLI 驗證通過，`member:` 寫回逐字相等。
- [ ] 更新 `worker/DEPLOY.md`（啟用章節含下方分工與升級流程）、`docs/architecture.md`。

### 啟用與驗收（分工）

要登入儀表板、輸入秘密、按互動確認、看信箱的由管理者做；能用本機已登入的 wrangler 完成的可由 agent 代勞。

| 步驟                                                                    | 誰                           |
| ----------------------------------------------------------------------- | ---------------------------- |
| 開通 R2 並綁付款方式                                                    | 管理者                       |
| Healthchecks 帳號、兩個 check（24 h + 12 h）、Email 驗證、取得兩個 UUID | 管理者                       |
| 建 bucket、生命週期規則、`wrangler.backup.local.toml`、部署停用版       | agent（wrangler）            |
| `wrangler secret put` 兩個 UUID                                         | 管理者（終端機輸入）         |
| 每小時 Cron 跑 3–5 次、讀 manifest 核對 subrequest 計數與 `latest.json` | agent                        |
| 讀儀表板 CPU p99（第 8 節門檻）                                         | 管理者                       |
| 建隔離 namespace                                                        | agent                        |
| 建還原用 API token、設本機環境變數                                      | 管理者                       |
| 還原 dry-run                                                            | 任一                         |
| 還原 `--apply`、家庭成員判定核對                                        | 管理者（程式拒絕非互動執行） |
| 故意失敗一次，確認 `latest.json` 未動、仍可 dry-run 還原                | agent                        |
| 兩個 check 各改 1 分鐘 + 1 分鐘，不 ping，等真的收到兩封 Email，再改回  | 管理者                       |
| Cloudflare Billing 用量通知                                             | 管理者                       |
| 正式啟用 `crons=["17 3 * * *"]`、觀察一次成功                           | agent 部署、管理者確認       |
| 維運紀錄、每月 dry-run 提醒、每月儀表板 CPU 檢查                        | 管理者                       |

合併 PR 不代表已啟用，須完成以上全部。

## 14. 升級流程：改 Workers Paid

觸發條件見第 9 節。步驟：

1. 訂閱 Workers Paid（每月 US$5 起；KV、R2 額度隨之放大）。
2. 切換到「Paid 設定檔」：`MAX_SAVED_KEYS` 提高到 5,000、每筆上限 4 MiB、封存 256 MiB；啟用每日 SHA-256 核對與下載回讀（`feat/kv-backup` 分支歷史中的 `multipart.ts`／`verifyObject`），`wrangler.backup.local.toml` 加回 `cpu_ms`。
3. **格式不變**：Paid 版仍寫 version 2，manifest 多一個可選的 `sha256` 欄位；還原 CLI 讀到 `sha256` 就額外核對。不能直接恢復 `feat/kv-backup` 歷史中的 version 1 工具，它會拒絕 version 2 的備份。
4. 重新部署，重跑第 13 節的驗收（首次備份、隔離還原、保護與告警演練）。
5. 「容量正常」check 的分界改為 Paid 上限的 70%（subrequest 7,000、筆數 3,500），其餘告警不變。

## 官方依據

- Workers 限制（Free：50 次 subrequest、10 ms CPU、100,000 請求／日、5 個 Cron；Scheduled 15 分鐘 wall time）：https://developers.cloudflare.com/workers/platform/limits/
- KV 批次讀取（100 key、算 1 次、text／json、25 MB）：https://developers.cloudflare.com/kv/api/read-key-value-pairs/
- KV 免費額度與超限失敗：https://developers.cloudflare.com/kv/platform/pricing/
- R2 免費額度與計費：https://developers.cloudflare.com/r2/pricing/
- R2 Workers API（條件寫入、multipart）：https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- GitHub `schedule` 的 60 天無活動停用規則：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- Healthchecks：https://healthchecks.io/docs/
