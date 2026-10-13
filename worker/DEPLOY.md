# 自建後端部署指南

將 Worker 部署到你自己的 Cloudflare 帳號，完全掌控資料。

## 前置需求

- [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)（免費方案即可）
- Node.js 22+（wrangler 4.132 以上的硬性需求，Node.js 20 會直接失敗）
- pnpm 11+

## 步驟

### 1. Fork 並 Clone

```bash
git clone https://github.com/YOUR_USERNAME/moo-family-bookshelf.git
cd moo-family-bookshelf/worker
```

### 2. 安裝依賴

```bash
pnpm install
```

### 3. 登入 Cloudflare

```bash
npx wrangler login
```

### 4. 建立 KV Namespace

```bash
npx wrangler kv namespace create "KV"
npx wrangler kv namespace create "KV" --preview
```

將輸出的 `id` 和 `preview_id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "你的 KV ID"
preview_id = "你的 Preview ID"
```

### 5. 加上速率限制 Binding

Worker 的「每分鐘」限制——per-IP 的 60／10／3 次，以及家庭書櫃與借閱的每帳號上限——交由 Cloudflare 原生的 Rate Limiting binding 計數，不再寫入 KV。`wrangler.toml` 已內含四組設定（dev 與 production 各一份），**你只需要把 `namespace_id` 換成自己的編號**：

```toml
[[ratelimits]]
name = "RATE_LIMIT_60_PER_MIN"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
```

- `namespace_id` 是**你自己 Cloudflare 帳號內**的編號，任意正整數皆可，只要同一個帳號內不重複。本專案用 1001–1004 給 dev、2001–2004 給 production；dev 與 production 不可共用，否則兩個 Worker 會算進同一個計數。
- 四組都要保留：60、30、10、3 次/分鐘各一組（`period` 只接受 10 或 60）。少了哪一組，對應的限制就退回 KV 計數。
- **`simple` 的 `limit` 必須等於 binding 名稱裡的數字**（`RATE_LIMIT_60_PER_MIN` 就要 `limit = 60`）：Worker 只依名稱取用 binding，執行時無從察覺兩者不符，真正生效的是你填在 `limit` 的數字。本專案附的兩份設定（dev 與 production）都已對好，自行改過的副本請自己核對。
- 這是官方文件現行的 `[[ratelimits]]` 寫法，**需要 wrangler 4**：本專案的 `package.json` 已改用 wrangler 4，在 repo 內跑 `pnpm install` 就會裝好，`pnpm deploy` 也會直接用它。若你堅持用自己的 wrangler 3 部署，它只會印一行 `Unexpected fields found in top-level field: "ratelimits"` 的警告，然後照常部署，但 binding 根本不會建立，Worker 只能退回 KV 計數——這種情況請把每一段改寫成 `[[unsafe.bindings]]` 並加上一行 `type = "ratelimit"`。
- 你的方案是否支援這項功能，**以 `wrangler deploy` 的結果為準**（官方文件未載明方案限制）。部署成功時，輸出的 bindings 清單會列出這四個名稱。

**不設定也能跑**：找不到 binding 時，Worker 會自動退回原本的 KV 計數器，限制數字完全一樣，代價是每個請求多一次 KV 讀 + 一次 KV 寫（見下方「免費方案額度與濫用防護」），並且每道每分鐘的限流檢查都會輸出一行 `RATE_LIMIT_BINDING_MISSING` 錯誤 log——家庭書櫃與借閱路由同時受 per-IP 與 per-userId 兩道每分鐘檢查，因此單一請求最多兩行。

### 6. 部署

```bash
pnpm deploy
```

部署完成後會顯示你的 Worker URL，例如：

```
https://moo-family-bookshelf.YOUR_SUBDOMAIN.workers.dev
```

### 7. 設定 Extension / PWA 使用自訂端點

自訂 API 端點不會顯示在一般使用者介面中，需透過開發者工具手動設定。

#### Extension（Chrome 開發者工具）

1. 在讀墨頁面按 F12 開啟 DevTools
2. 切換到 Console 分頁
3. 執行以下指令設定端點：

```js
chrome.storage.local.set({
  apiEndpoint: "https://moo-family-bookshelf.YOUR_SUBDOMAIN.workers.dev",
});
```

查詢目前端點：

```js
chrome.storage.local.get("apiEndpoint", console.log);
```

重設為預設端點：

```js
chrome.storage.local.remove("apiEndpoint");
```

設定或重設後重新載入頁面即生效。

#### PWA（瀏覽器開發者工具）

1. 開啟 PWA 頁面，按 F12 開啟 DevTools
2. 在 Console 中，先取得你的 userId（可在 Application → Local Storage 中找到 `moo_userId` 對應的值）
3. 執行以下指令：

```js
localStorage.setItem(
  "moo_{userId}_apiHost",
  "https://moo-family-bookshelf.YOUR_SUBDOMAIN.workers.dev",
);
```

將 `{userId}` 替換為實際的使用者 ID。查詢目前端點：

```js
localStorage.getItem("moo_{userId}_apiHost");
```

重設為預設：

```js
localStorage.removeItem("moo_{userId}_apiHost");
```

設定或重設後重新載入頁面即生效。

#### 透過同步碼自動傳播

使用自訂端點建立家庭時，同步碼會自動帶入 `@host` 後綴：

```
moo-xxxx-yyyy@moo-family-bookshelf.YOUR_SUBDOMAIN.workers.dev
```

家人貼上此同步碼後會自動切換到你的伺服器，無需手動設定。

#### 管理者 API

管理者也可透過 API 更新家庭端點：

```bash
curl -X PUT https://YOUR_WORKER/api/family/{familyId}/endpoint \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"apiEndpoint": "https://new-worker.example.com"}'
```

重設為預設：

```bash
curl -X PUT https://YOUR_WORKER/api/family/{familyId}/endpoint \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"apiEndpoint": null}'
```

#### 端點格式限制

自訂端點在儲存時會經過驗證，不符合規則會回覆 `400 INVALID_ENDPOINT`：

- 必須是 `https://` 開頭的完整 URL。唯一例外：`localhost` 與 `127.0.0.1` 可用 `http://`，供本機開發使用
- 不接受私有／內部 IPv4 位址：`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`127/8`（`127.0.0.1` 除外）、`0/8`
  - 僅限上列範圍；清單以外的 IPv4 字面位址（例如 `100.64/10` CGNAT／Tailscale）不在辨識範圍內
- 不接受任何 IPv6 字面位址（例如 `https://[::1]`、`https://[2001:db8::1]`）——請改用網域名稱
- URL 長度上限 2048 字元；儲存時會移除尾端斜線

這些限制的目的：家庭端點會散布給所有成員的裝置使用，此檢查避免管理者把成員的連線導向常見的內網字面位址。指向內網的「網域名稱」無法在此辨識，不在防護範圍內。

## 本地開發

```bash
pnpm dev    # 啟動本地開發伺服器 (Miniflare)
pnpm test   # 執行測試
```

## 開發者工具（Dev Only）

Worker 內建 OpenAPI 文件與 Swagger UI，**僅在 dev 環境開啟**，production 完全關閉（回傳 404）。

| 路由                     | 說明                  |
| ------------------------ | --------------------- |
| `GET /api/_openapi.json` | OpenAPI 3.1 JSON spec |
| `GET /api/_docs`         | Swagger UI 互動式文件 |

### 開啟條件

兩個條件必須**同時**滿足：

1. 環境變數 `DEV_MODE=1`
2. Worker 名稱**不是** production 名稱（`moo-family-bookshelf`）

本機 `pnpm dev`（wrangler dev）會自動滿足條件（需在 `.dev.vars` 設定 `DEV_MODE=1`）。
部署在 `*.workers.dev` 的 dev 子環境也會自動開啟（Worker 名稱為 `moo-family-bookshelf-dev`）。

### 自建者注意

- 自建的 dev worker：在 Cloudflare Dashboard 的 Worker Settings → Environment Variables 中加入 `DEV_MODE=1`，即可從瀏覽器直接訪問 `/api/_docs`
- **不建議在 production 開啟**。若確實需要，請自行加上 IP 白名單或 Basic Auth 保護，避免 API 結構暴露

> ⚠️ **`DEV_MODE=1` 不只是開啟文件，它會一併關掉防濫用機制**
>
> `worker/src/middleware/rateLimit.ts` 會在 `isDevMode` 為真時直接短路，等同關閉：
>
> - **per-IP 速率限制**（一般 60／公開 10／敏感端點 3 次每分鐘）
> - **per-userId 速率限制**（例如家庭網域寫入合計每帳號每小時 30 次、公開書櫃寫入合計每帳號每小時 30 次）
>
> 這代表 PWA 登入驗證（PIN／圖形／驗證碼）少了暴力破解的煞車；再加上 dev 模式下 CORS 放寬、`/api/_docs` 對外開放，**開啟 `DEV_MODE=1` 的 Worker 絕對不能存放真實家庭資料**，請只用在測試用的 KV Namespace。

## 免費方案額度與濫用防護

Cloudflare 免費方案的 KV 每日寫入額度為 1,000 次。**若你略過了步驟 5 的速率限制 binding**，Worker 內建的速率限制會退回 KV 計數，而它**本身也消耗這個額度**——per-IP 計數器在驗證身分之前，每放行一個請求就寫入一次 KV。這代表：

- 未經驗證的垃圾流量即使全部被 401 拒絕，仍會以每分鐘最多 60 次的速度消耗寫入額度——**約 17 分鐘即可耗盡當日額度**，之後所有需要寫入 KV 的操作（儲存書單、建立家庭、換發 token，乃至速率限制本身）都會失敗到隔日額度重置。
- 內建的 per-userId 上限（例如公開書櫃寫入合計每帳號每小時 30 次）只能限制「單一帳號」的消耗速度，無法阻擋上述未驗證流量。

設定了 binding 之後，每分鐘的限制不再寫 KV，上述「垃圾流量燒光寫入額度」的路徑就消失了；每小時的每帳號上限（`put-books`、`family-prefs`、`family-write`、`public-shelf`、`verify-write`）仍記在 KV，而它們都需要通過身分驗證才會被計數。**唯一的例外是 PWA 登入驗證的猜錯上限**：三個公開閘門端點（`POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/lookup`）在未驗證的呼叫方每猜錯一次密鑰時，仍會寫入該帳號的嘗試計數（`ratelimit:user:verify:{userId}:{bucket}`）與該來源的失敗紀錄（`verifyfail:{userId}:{caller}`），同一組「帳號 × 來源」15 分鐘內至多 5 次（`VERIFY_MAX_FAILURES` / `VERIFY_FAIL_TTL_SECONDS`，見 `worker/src/kv/schema.ts`）。因此下方的 WAF 規則仍然值得設定。

若你的 Worker URL 可能被陌生人掃到（部署在公開網路本來就是如此），建議在 Cloudflare Dashboard 為 `/api/*` 設定 [WAF Rate Limiting 規則](https://developers.cloudflare.com/waf/rate-limiting-rules/)（免費方案含 1 條規則），在流量抵達 Worker 之前就把異常來源擋下。原生 Rate Limiting binding（步驟 5）本身不是硬上限——它在單一 Cloudflare 節點內計數且為最終一致——真正需要硬上限時仍得評估 Durable Objects。

## 更新

```bash
git pull origin main
cd worker
pnpm install
pnpm deploy
```

## KV 每日備份與還原演練

每日備份由獨立的 Cloudflare Worker 執行，正式排程是 **03:17 UTC（台灣 11:17）**。透過 KV／R2 bindings 備份與回讀，完成後向 Healthchecks.io 發成功訊號；超過 36 小時無成功，由外部服務寄 Email。GitHub Actions 不執行每日備份，repository 長期不更新不會讓此排程因 GitHub 活動限制而停用。資料範圍與限制見 [KV 備份計畫](../docs/kv-backup-plan.md)。

**合併 PR 不等於已啟用。** 以下首次設定、真實還原與通知演練尚未執行。平時無須人工定期查看，但收到告警後仍需排除問題。

### 1. 開通方案與私人 R2

在正式資料所在帳號啟用 **Workers Paid（每月 US$5 起）**，並開通 R2 subscription。Worker／KV／R2 額度與帳號其他服務合併計量，US$5 不是總費用硬上限。[Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)、[R2 開通](https://developers.cloudflare.com/r2/get-started/)

- 建立 Standard bucket，例如 `moo-family-bookshelf-backups`；關閉 `r2.dev` 與公開自訂網域。
- **不要對 `snapshots/` 或 `latest.json` 設定物件刪除 lifecycle，也不要設整個 bucket 的刪除規則。** 備份程式只在新備份成功後清理超過 14 天的非最新備份。
- 舊版 `daily/` 的 14 天規則可保留，但必須確認 prefix 限定 `daily/`。最後成功保護適用新 `snapshots/`；舊資料不會自動遷移。
- 未完成 multipart upload 的自動清理可保留；它與已完成物件的年齡刪除是不同規則。正常可捕捉失敗會嘗試 abort，程序被強制終止仍可能留下未完成 upload。

### 2. 建立外部 Email 監看

在 Healthchecks.io 建立一個 check，選 Simple schedule：**Period 24 hours、Grace Time 12 hours**。設定並驗證 Email integration，確認此 check 的通知開關為 ON；可在 Account Settings → Email Reports 開啟每日 down reminder。免費 Hobbyist 方案目前可監看 20 個工作，本次只需一個。[設定](https://healthchecks.io/docs/configuring_checks/)、[通知](https://healthchecks.io/docs/configuring_notifications/)、[方案](https://healthchecks.io/pricing/)

記下 check URL `https://hc-ping.com/<uuid>` 中的 UUID；稍後只將 UUID 存為 Worker secret。建議只接受 POST，不開 request body 關鍵字過濾。UUID 可以偽造成功訊號，視同秘密，不放在 Git、聊天、截圖或日誌。備份 Worker 只送無 body 的成功 POST，無 `/start`／`/fail`，不傳備份資料；Healthchecks 仍可觀察時間及出口 IP。

新建 check 必須收到實際第一份成功備份的訊號，並完成後續漏 ping 演練，才算監看有效；HTTP 200 本身不能證明 UUID 指向正確 check，官方 UUID API 對部分不存在／限流情境也回 200。[Pinging API](https://healthchecks.io/docs/http_api/)

### 3. 準備獨立 Worker 設定並部署停用版本

先在未注入憑證時於 repo 根目錄執行 `pnpm install --frozen-lockfile`。本機需 Node 22 以上，使用專案鎖定的 Wrangler。在 `worker/` 中複製設定：

```powershell
Copy-Item -LiteralPath wrangler.backup.toml -Destination wrangler.backup.local.toml
```

Bash 使用 `cp wrangler.backup.toml wrangler.backup.local.toml`。若目的檔已存在，先檢查再複製，不覆蓋已配置的檔案。這個檔名已被 Git 忽略，與開發 API 的 `wrangler.local.toml` 分開。

編輯 `wrangler.backup.local.toml`：

- `name` 為獨立備份 Worker 名稱，不得填服務 API Worker 的名稱。
- 加入頂層 `account_id = "正式帳號的32位ID"`，放在第一個 TOML section 前。
- `vars.SOURCE_ACCOUNT_ID` 填相同帳號；`vars.SOURCE_NAMESPACE_ID` 與 `kv_namespaces.id` 都填核對過的正式 namespace ID。
- `r2_buckets.bucket_name` 填私人 bucket。
- 維持 `BACKUP_ENABLED="false"`、`crons=[]`、`workers_dev=false`、`preview_urls=false`；不要新增 route 或 `DEV_MODE`。

來源 ID 只是供 manifest 記錄，程式不能從 binding 自行驗證實際 namespace ID；部署前需交叉核對。KV binding 在平台上也不是唯讀授權，程式只使用 get/list，不代表被攻陷的 Worker 沒有寫入能力。

以可信任的本機 Cloudflare 帳號登入；若用 API token，透過安全環境注入 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`，使用能部署指定帳號 Worker／配置所需 binding 的專用權限。不要把 token 放入命令列或設定檔。以下只部署獨立備份 Worker：

```bash
pnpm exec wrangler deploy --config wrangler.backup.local.toml
pnpm exec wrangler secret put HEALTHCHECKS_UUID --config wrangler.backup.local.toml
```

在互動提示貼上 UUID。每日 Worker 執行使用 bindings，不需要 KV／R2 REST token。不要對此 config 加 `--env production`；它是獨立設定，不是服務 Worker 的 production environment。之後的程式更新亦須以這份 config 明確部署；既有 main／tag CD 不會部署備份 Worker。

### 4. 觸發首次真實備份

備份 Worker 沒有公開觸發 API，不使用 curl 打正式 Worker。

1. 在本機設定改 `BACKUP_ENABLED="true"`，暫將 `crons=["17 * * * *"]` 設為每小時第 17 分鐘（UTC），再執行上節 deploy。
2. 等下一次 Cron，從 Cloudflare 備份 Worker 的事件／日誌檢查成功與資源用量。Cron 更新最多可能需約 15 分鐘傳播；不要因為暫未啟動就反覆部署。[Cron 說明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
3. 檢查 R2 `snapshots/` 的 JSONL、manifest，以及 `latest.json` 指向同一份已驗證 manifest；記下完整 manifest key。
4. 在 Healthchecks 確認本次成功事件。成功代表本次備份完成，不接受手動 ping 代替。
5. 隨即將 `crons=[]` 並重新部署，等待排程變更生效，再進行還原及通知驗收。短期每小時設定會多消耗 KV 讀取與 R2 操作，不要忘記結束。

每小時或更低頻率的 Cron 使用較寬的 CPU 預算，避免以每 5 分鐘測試時誤撞不同的執行限制。首版限制單筆 4 MiB、保存 5,000 key、檔案 256 MiB、9,000 次 I/O 呼叫；程式在操作間檢查 12 分鐘預算，進行中的 binding 呼叫仍受平台期限約束。超限不是靜默略過，需處理。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

### 5. 還原至空白隔離 namespace

不要覆寫正式 KV，也不要使用已有測試帳號的開發 namespace。於同一帳號建立全新空白 namespace，還原期間禁止其他程式寫入。

在可信任的本機終端注入：

| 變數                     | 內容                                 |
| ------------------------ | ------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`  | 原正式來源所在帳號                   |
| `KV_BACKUP_NAMESPACE_ID` | 原正式來源 ID，不是還原目標          |
| `KV_BACKUP_BUCKET`       | 私人備份 bucket                      |
| `KV_BACKUP_R2_API_TOKEN` | Wrangler REST 所需專用 R2 讀寫 token |
| `KV_RESTORE_API_TOKEN`   | 本次隔離還原的 KV 讀寫 token         |

還原 token 不放在備份 Worker 或 GitHub Secrets，演練後撤銷。Wrangler R2 REST token 的 `Workers R2 Storage Write` 是帳號層級權限，包含 bucket 管理；不要填 S3 Access Key／Secret 或 bucket 限定的 Object Read & Write token，後者不能當成 REST token 使用。[R2 權限](https://developers.cloudflare.com/r2/api/tokens/)

以下在 repo 根目錄執行；把 manifest 路徑和目標 ID 換成實際值。先 dry-run：

```bash
node scripts/kv-restore.mjs --backup "snapshots/日期/備份名稱.manifest.json" --target-namespace "空白隔離namespace的32位ID" --max-writes 1000
```

確認來源、寫入數與額度後才加 `--apply`：

```bash
node scripts/kv-restore.mjs --backup "snapshots/日期/備份名稱.manifest.json" --target-namespace "空白隔離namespace的32位ID" --max-writes 1000 --apply
```

CLI 需要互動輸入 `yes` 與 `RESTORE <目標ID>`，不要 pipe 自動回答。`--max-writes` 是本次操作上限，不是帳號剩餘額度。超過 1,000 個需要還原的 key 時，可在確認 Paid 方案用量後調整此數字。它仍支援舊 `daily/` manifest；不把 `latest.json` 直接傳給 `--backup`，先讀取它指向的 manifest key。

還原會核對來源、格式、hash、bytes、筆數，略過已到期或即將到期資料並保留絕對 expiration；寫入後逐筆回讀。部分失敗不自動清空或切換正式 binding，重試改用另一個全新空白 namespace。

以受存取保護的隔離 Worker 連接還原目標，維持正式驗證／安全設定；不要把真實資料放進公開 `DEV_MODE=1` 服務。由資料擁有者核對家庭、書單、分享、借閱、驗證設定與公開連結。跨 key 不是交易快照，舊 PIN 或撤銷連結可能被還原；正式切換前另行處理。演練結束清除不再需要的隔離服務／資料並撤銷臨時憑證。

### 6. 驗證最後成功保護與真正的逾期 Email

1. 已有一份真實成功備份後，於隔離演練環境故意使下一次備份失敗，確認舊 `latest.json` 與它指向的檔案仍可下載還原；不能為演練刪除正式來源或最後成功檔案。
2. 保持正式 Cron 暫停且確認變更生效，將該 Healthchecks check 暫改為 Period 1 minute、Grace Time 1 minute。**不送 ping、不手工呼叫 `/fail`**，等待真正逾期 Email；若最後成功時間已超過兩分鐘，可能很快告警。
3. 確認收件匣實際收到通知，而不只是在 dashboard 看到紅色。這證明「程式根本未執行」也能通知。
4. Healthchecks 改回 **24 hours + 12 hours**；Worker 改成 `BACKUP_ENABLED="true"`、`crons=["17 3 * * *"]`，重新部署。
5. 至少觀察一次正式每日 Cron 成功、R2 保護指標更新與 Healthchecks 恢復事件／Email，才標記正式啟用完成。

將演練時間、版本、筆數、bytes、digest、到期略過數與結果記錄於私人運維紀錄，不記錄家庭資料或秘密。日常不需人工定期查看；收到告警才調查。

### 7. 告警處理、暫停與舊工具

收到逾期 Email 時依序檢查：Cloudflare 帳號／付款、Cron 是否存在、`BACKUP_ENABLED`、執行錯誤／資源上限、KV／R2 binding、Healthchecks UUID 與網路。通知失敗可能發生在備份已成功之後，先檢查 R2；不要把告警一律當成資料遺失。修復後可短暫用每小時 Cron 補跑，再恢復每日設定。

暫停請在本機 config 設 `BACKUP_ENABLED="false"`、`crons=[]` 並部署。沒有刪除 lifecycle，最後成功備份仍保留；Healthchecks 會如期告警。只有明確決定暫停保護時才在外部 check 暫停通知，重新啟用時要一併恢復，不能以停掉通知掩蓋故障。

舊 `scripts/kv-backup.mjs` 保留作可信任本機的手動匯出工具，使用原本 Cloudflare REST 憑證，輸出 `daily/`。它**不更新新版 `latest.json`、不送 heartbeat，也不等同正式自動備份驗收**。本機工具會使用作業系統暫存目錄，強制終止可能殘留敏感檔案，需在可信任磁碟執行並清理。平時以 Cloudflare Cron 為唯一自動備份來源。
