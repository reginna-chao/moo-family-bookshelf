# KV 自動備份計畫

> **狀態**：設計階段，尚未實作
> **建立日期**：2026-04-14
> **暫緩原因**：上線前優先順序調整，待正式有用戶流量或重大 migration 前再啟動
> **下次動作**：由開發者決定重啟時機

---

## 1. 背景與動機

### 為什麼需要備份

- Cloudflare KV 沒有官方備份服務，帳號或應用層資料毀損時無法還原
- **真正的風險不是 Cloudflare 硬體故障，而是應用層 bug**（例如誤刪、寫壞 schema、遷移腳本出錯）
- 手動備份流程在單人維護的 side project 容易被遺忘，自動化比「有意識地手動跑」可靠
- 備份同時可作為免費的 cron health check（定時失敗時 Cloudflare Dashboard 會顯示）

### 為什麼之前 Gemini 上線準備報告 (`docs/launch-readiness-report.md`) 提到這一點不算緊急

- 目前沒有實際用戶流量，「失去的資料」主要是測試資料
- `user:*` 不含 PII（僅書單與分享設定），降低了備份的迫切性
- 其他 key（auth/otp/ratelimit）本身就有 TTL，備份也沒意義

→ 因此本計畫是「上線後盡快做」而非「上線前必做」。

---

## 2. 設計決策總覽

| 項目             | 決定                                                                  | 理由                                                                    |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 備份頻率         | **每日 03:00 UTC**（= 台灣時間 11:00）                                | KV 讀取量小（~1000 keys/day），free tier 綽綽有餘；daily 比 weekly 安全 |
| 保留期           | **14 天**                                                             | 兩週恢復窗口足夠應付「上週某個 bug 誤刪」                               |
| 格式             | **JSONL**（每行一個 key-value pair）                                  | 支援 streaming 序列化、容易 grep、資料變大也能處理                      |
| 環境範圍         | **只有 production**，dev 完全不備份                                   | dev 沒有值得保存的資料；簡化設定                                        |
| Bucket 名稱      | **`moo-family-bookshelf-backups`**                                    | 與 Worker / Pages 命名前綴一致                                          |
| 物件路徑         | `daily/YYYY-MM-DD.jsonl`                                              | 扁平結構，方便 list 與 lifecycle rule                                   |
| Restore 機制     | **本機 script + wrangler**，互動式雙段確認                            | 比 admin endpoint 安全，必需有 wrangler 權限才能執行                    |
| 手動觸發         | 加一個 `POST /api/admin/backup` 端點，需 `BACKUP_TRIGGER_TOKEN`       | 上線 / migration 前可一鍵 snapshot                                      |
| 失敗告警         | **v1 不做**，依賴 Cloudflare Dashboard Cron Trigger 紀錄              | YAGNI，真有需要再加 webhook                                             |
| 備份 metadata    | **不備份**（worker 全部 source 沒用到 KV metadata，已 grep 驗證）     | 無意義                                                                  |
| 備份內容額外加密 | **不加**（R2 預設 private + 資料為明文 JSON / 雜湊 / UUID，不含 PII） | 降低實作複雜度                                                          |
| 單一 region      | **OK**（不做 multi-region 備份）                                      | 初期不需要                                                              |

---

## 3. 備份範圍（要備 / 不備什麼）

### 要備份

| Key Pattern           | 內容型態                    | 備份理由                           |
| --------------------- | --------------------------- | ---------------------------------- |
| `user:{userId}`       | 明文 JSON（書櫃與分享設定） | 核心資料：書櫃與分享設定           |
| `family:{familyId}`   | 明文 JSON                   | 家庭群組（成員 UUID 列表，非 PII） |
| `member:{userId}`     | 明文字串（familyId）        | 反向查找，restore 必需             |
| `verify:{userId}`     | 明文 JSON（雜湊 + salt）    | PWA 登入驗證設定；雜湊過的非 PII   |
| `public:{shareToken}` | 明文 JSON                   | 用戶主動建立的公開書櫃             |

### 不備份

| Key Pattern         | 不備份原因                |
| ------------------- | ------------------------- |
| `auth:{userId}`     | 90 天 TTL，重新登入可重建 |
| `token:{tokenHash}` | 同上                      |
| `otp:{userId}`      | 5 分鐘 TTL，無意義        |
| `ratelimit:*`       | 2 分鐘 TTL，無意義        |

---

## 4. 架構

### 新增目錄結構

```
worker/
├── src/
│   └── backup/
│       ├── types.ts          # BackupManifest / BackupEntry 型別
│       ├── exporter.ts       # KV → JSONL 序列化（含分頁）
│       └── scheduled.ts      # Cron 入口（呼叫 exporter → 寫 R2）
├── scripts/
│   └── restore-from-r2.ts    # 本機 restore 工具
└── tests/
    ├── helpers/
    │   └── mockR2.ts         # R2 mock
    └── unit/
        └── backup.test.ts    # 序列化 + 過濾邏輯測試
```

### 修改項目

- `worker/src/index.ts`：新增 `export const scheduled: ExportedHandler<Env>["scheduled"]`
- `worker/wrangler.toml`：新增 `[[env.production.r2_buckets]]` + `[triggers] crons`
- `worker/src/routes/`：新增 `admin.ts` 路由（`POST /api/admin/backup`，需 `BACKUP_TRIGGER_TOKEN`）
- `worker/src/kv/schema.ts`：新增 `BACKUPABLE_PREFIXES` 常數列表
- `.github/workflows/cicd.yml`：可能需要新增 `BACKUP_TRIGGER_TOKEN` secret 的處理（視部署流程決定）

---

## 5. 前置準備（由開發者手動完成）

### 步驟 1：啟用 R2（一次性）

1. 登入 [https://dash.cloudflare.com](https://dash.cloudflare.com)
2. 左側選單 → **R2**
3. 點「Enable R2」按鈕
4. 同意計費條款（免費額度內不會實際收費：10 GB 儲存 + 每月 100 萬次 Class A 操作）

> ⚠️ 這個步驟必須先完成，否則 `wrangler r2 bucket create` 會失敗。

### 步驟 2：建立 bucket

```bash
cd worker
wrangler r2 bucket create moo-family-bookshelf-backups
```

驗證：

```bash
wrangler r2 bucket list
```

### 步驟 3：設定 Lifecycle Rule（14 天自動刪除）

可透過 wrangler 或 Cloudflare Dashboard 設定。Dashboard 路徑：
**R2 → moo-family-bookshelf-backups → Settings → Object Lifecycle Rules → Add Rule**

- Rule name: `delete-after-14-days`
- Prefix: `daily/`
- Action: `Delete objects` after `14 days`

### 步驟 4：設定 Worker Secret

```bash
cd worker
wrangler secret put BACKUP_TRIGGER_TOKEN --env production
# 貼上一個長 random string（建議用 `openssl rand -hex 32` 產生）
```

---

## 6. 實作步驟（待執行）

### Spike：驗證 Miniflare R2 支援（必做，不可跳過）

- 在 `worker/wrangler.toml` 加一個 `[[r2_buckets]]` binding
- 跑 `pnpm dev`（local Miniflare）確認不會炸
- 跑 `pnpm test` 確認不會炸
- 寫一個 5 行測試：往 mock R2 寫入物件、讀回來
- **如果 Miniflare R2 不可用，停下來重新評估方案**（例如改用 Scheduled Worker + wrangler secrets + HTTP API 直接打到 R2）

### 正式實作順序

1. `src/backup/types.ts` — 型別定義
2. `src/backup/exporter.ts` — KV list 分頁迴圈 + JSONL 序列化 + 過濾邏輯
3. `src/backup/scheduled.ts` — cron handler + R2 寫入
4. `src/index.ts` — 加上 `export const scheduled`
5. `src/routes/admin.ts` — 手動觸發端點
6. `wrangler.toml` — R2 binding + cron trigger
7. `tests/helpers/mockR2.ts` + `tests/unit/backup.test.ts`
8. `scripts/restore-from-r2.ts` — 互動式 restore 工具

### 委派方式

這是純後端 feature，用 `/develop A` 執行完整生命週期（會以 backend scope dispatch coder / tester / reviewer 並跑 Fix Cycle）。

---

## 7. 風險與開放問題

| #   | 議題                                                       | 嚴重度 | 處理方式                                                                                            |
| --- | ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| R1  | KV `list()` 單次回 1000 keys，需要分頁                     | 中     | exporter 必須處理 `cursor` 迴圈，否則資料量變大會漏備份                                             |
| R2  | Backup 是 eventually-consistent snapshot，不是 transaction | 低     | KV 本身的限制，無解；在 manifest 註記 backup 時間範圍                                               |
| R3  | Restore 會覆寫現有資料                                     | 高     | restore script 必須兩段確認（顯示要還原的 key 數量 + 提示輸入確認字串如 `RESTORE FROM 2026-04-14`） |
| R4  | Daily cron 失敗無人知道                                    | 中     | v1 不解，依賴 CF Dashboard Cron Trigger 紀錄；若有實際漏備份事件再加 webhook                        |
| R5  | R2 free tier 限制：10 GB 儲存、Class A 每月 100 萬次       | 低     | 估算資料量 ~5-10 MB × 14 snapshots = 140 MB，遠低於上限                                             |
| R6  | **Miniflare R2 支援未驗證**，可能影響本機開發              | 高     | 實作前必須先跑 spike 驗證                                                                           |

---

## 8. Restore 策略

### 使用情境

- 發生誤刪、寫壞資料、或 migration 失敗需要回滾
- 只在真的出事時手動執行，不是日常流程

### Restore Script 要求

1. 讀取指定日期的 `daily/YYYY-MM-DD.jsonl` from R2
2. 解析每行 JSON，顯示：
   - 總 key 數
   - 各 prefix 的 key 數量
   - backup 的原始產生時間
3. **第一段確認**：顯示「即將覆寫 production KV 的 N 個 keys，從 X 日期的 backup」，要求輸入 `yes`
4. **第二段確認**：要求輸入確認字串 `RESTORE FROM YYYY-MM-DD`（必須手打，不能複製貼上）
5. 執行 `KV.put(key, value)`，對每個 backup 項目逐一寫入
6. 寫入完成後顯示統計：成功 / 失敗數
7. 失敗的 key 列出到 `restore-errors-{timestamp}.log`

### 執行方式

```bash
cd worker
pnpm tsx scripts/restore-from-r2.ts --date=2026-04-14 --env=production
```

---

## 9. 尚未決定的事

- **Spike 結果出來前，不要開始正式實作**。如果 Miniflare R2 有嚴重 bug，可能需要整個方案重新設計。
- **Restore script 的 wrangler 權限**：是讓開發者用自己的 wrangler API token 跑，還是用 GitHub Actions 跑？目前傾向前者（更安全、不留 audit trail）。
- **是否需要備份 `docs/launch-readiness-report.md` 中提到的其他要點（如 Sentry）？** 與本計畫無關，另行處理。

---

## 10. 參考資料

- Cloudflare KV 文件：[https://developers.cloudflare.com/kv/](https://developers.cloudflare.com/kv/)
- Cloudflare R2 文件：[https://developers.cloudflare.com/r2/](https://developers.cloudflare.com/r2/)
- Cron Triggers：[https://developers.cloudflare.com/workers/configuration/cron-triggers/](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- Miniflare R2 支援：[https://miniflare.dev/storage/r2](https://miniflare.dev/storage/r2)
- 相關討論紀錄：本文件為 2026-04-14 `/team-lead`（現已整併為 `/develop`）session 設計討論的結論保存
