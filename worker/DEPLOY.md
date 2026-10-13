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

備份由獨立的 `.github/workflows/kv-backup.yml` 執行，每日 03:17 UTC（台灣時間 11:17），也能在 GitHub Actions 手動執行。它從 Cloudflare REST API 讀取正式 KV，以 Node.js 匯出至私人 R2 bucket；不新增 Worker API、Cron、binding，也不需要重新部署 Worker。這讓備份匯出不受 Workers Free 單次 CPU 與子請求上限限制，但 KV 與 Cloudflare API 的讀取額度仍照計。資料範圍、格式與限制見 [KV 備份計畫](../docs/kv-backup-plan.md)。

**程式合併不代表備份已啟用。** 必須完成以下設定、真實備份與隔離還原演練，才算具備上線前的復原能力；本文件沒有宣稱這些外部步驟已完成。

### 1. 建立私人 R2 bucket 與保留規則

在 Cloudflare Dashboard 啟用 [R2 subscription](https://developers.cloudflare.com/r2/get-started/) 並完成計費開通流程。R2 與 Workers Paid 分開計量，採用這個備份方式不必先升級 Workers Paid；費用仍依帳號用量與 [R2 定價](https://developers.cloudflare.com/r2/pricing/) 計算。

- 建立 Standard bucket，例如 `moo-family-bookshelf-backups`，關閉 `r2.dev` 公開存取，不連接公開自訂網域。
- 在 bucket Settings → Object Lifecycle Rules 新增規則：prefix 為 `daily/`、建立後 14 天刪除物件。先設定此規則，再啟用備份。
- [Lifecycle 刪除通常會在到期後 24 小時內執行](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)，14 天是保留政策，不是恰好 14 份的硬上限。手動備份也使用 `daily/`，受到同一規則管理。

### 2. 設定專用憑證與 GitHub 開關

在 repository Settings → Secrets and variables → Actions 設定下列項目。正式 namespace ID 必須從 Cloudflare Dashboard 核對；不要把開發用 namespace 填進去。

| 類型     | 名稱                     | 內容                                                             |
| -------- | ------------------------ | ---------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`  | 正式 KV 所在 Cloudflare 帳號 ID，可沿用既有設定。                |
| Secret   | `KV_BACKUP_NAMESPACE_ID` | 明確指定正式 KV namespace ID。                                   |
| Secret   | `KV_BACKUP_API_TOKEN`    | 專用的 `Workers KV Storage Read` token，資源限正式資料所在帳號。 |
| Secret   | `KV_BACKUP_R2_API_TOKEN` | 專用的 `Workers R2 Storage Write` token，資源限備份所在帳號。    |
| Variable | `KV_BACKUP_BUCKET`       | 上一步建立的 bucket 名稱。                                       |
| Variable | `KV_BACKUP_ENABLED`      | 設定完成前保持 `false` 或不設定；啟用時改成字串 `true`。         |

每日備份不持有 KV 寫入權限，也不共用部署用的 `CLOUDFLARE_API_TOKEN`。兩個專用 token 都不要加入 Workers 部署權限。KV 讀取 token 是帳號層級授權；namespace ID 是程式的來源限制，不代表 token 自身只能讀取該 namespace。

R2 腳本使用已鎖定版本的 Wrangler REST 路徑，因此採用帳號層級的 `Workers R2 Storage Write`。**這個權限包含 bucket 管理，範圍比單一 bucket 的物件寫入更大**。請使用獨立 token 並定期檢查、輪替；不要填 S3 的 Access Key ID／Secret Access Key，也不要填僅限 bucket 的 Object Read & Write token，後者[只支援 S3 API，不支援 Cloudflare REST API](https://developers.cloudflare.com/r2/api/tokens/)。

workflow 僅允許 `main` 且開關為 `true` 時執行；token 只在依賴安裝完成後注入備份步驟。備份資料不會上傳 GitHub artifact，log 只應保留數量、成功結果與備份物件路徑，禁止印出書單、key 清單、驗證資料或完整環境變數。

### 3. 手動執行第一份備份

1. 合併 workflow 至預設分支 `main`，確認前兩步的設定齊全，再將 `KV_BACKUP_ENABLED` 設成 `true`。
2. 開啟 Actions → KV 每日備份 → Run workflow，分支選 `main`。排程與手動執行共用 concurrency，正在執行的備份不會被新工作取消。
3. 確認工作成功，記下回傳的 `.manifest.json` 物件路徑；備份腳本必須完成 R2 上傳與回讀驗證才算成功。
4. 在 R2 私人 bucket 核對同一份備份的 JSONL 與 manifest 都存在，保留規則已啟用。接著執行下節的還原演練。

若要在可信任的本機終端執行，先在尚未注入憑證時於 **repo 根目錄**安裝依賴：

```bash
pnpm install --frozen-lockfile
```

再透過密碼管理器注入上表的五個環境變數（不需要 `KV_BACKUP_ENABLED`），於同一目錄執行：

```bash
node scripts/kv-backup.mjs
```

PowerShell 使用相同指令。不將 token 寫進命令列、git 追蹤檔、聊天紀錄或 shell history；也不啟用 shell tracing。腳本將資料暫存在作業系統的專用暫存目錄，正常結束與可捕捉的失敗都會清理。主機當機或被強制終止仍可能留下暫存檔，應在可信任的磁碟上執行並檢查殘留。

### 4. 還原至空白隔離 namespace

**不要直接覆寫正式 KV，也不要用正在服務測試帳號的開發 namespace。** 先於同一帳號建立新的空白 namespace，記下 ID，還原期間禁止其他程式寫入。來源與目標必須不同；腳本也會拒絕非空目標。

在可信任的本機終端注入 `CLOUDFLARE_ACCOUNT_ID`、`KV_BACKUP_NAMESPACE_ID`（仍是原正式來源）、`KV_BACKUP_BUCKET`、`KV_BACKUP_R2_API_TOKEN`，以及僅供此次還原的 `KV_RESTORE_API_TOKEN`。還原 token 需有目標所在帳號的 KV 讀寫權限，**不加入每日備份 workflow 或 GitHub Secrets**，完成演練後撤銷。帳號層級寫入 token 仍能寫其他 namespace，不能只靠程式的來源檢查視為憑證隔離。

先以預設 dry-run 檢查完整備份，沒有 `--apply` 不寫入 KV。以下命令可直接用於 Bash 或 PowerShell；將兩個佔位文字換成上一步記下的 manifest 物件路徑及目標 ID：

```bash
node scripts/kv-restore.mjs --backup "daily/日期/備份名稱.manifest.json" --target-namespace "空白隔離namespace的32位ID" --max-writes 1000
```

確認 dry-run 成功、來源正確、目標為空，且寫入數不超過剩餘額度，再執行：

```bash
node scripts/kv-restore.mjs --backup "daily/日期/備份名稱.manifest.json" --target-namespace "空白隔離namespace的32位ID" --max-writes 1000 --apply
```

`--apply` 要求互動式終端並進行兩次確認；依提示輸入 `yes` 與 `RESTORE <目標 namespace ID>`。不要 pipe 自動回答。`--max-writes` 是這次操作的上限，預設 1,000，**不代表帳號今天還剩 1,000 次**；還原與日常服務共用 Cloudflare KV 寫入額度。若需調高，先確認方案與當日用量。

還原必須逐筆回讀比對內容、metadata 與到期時間，全部符合才成功。KV 最終一致可能讓回讀暫時不符；等待上限後仍不符會以失敗結束。部分寫入成功後失敗不會自動回滾，請保留失敗紀錄，改用另一個全新的空白 namespace 重試，不把失敗目標接到正式服務。

### 5. 驗證服務讀取與推出前門檻

- 使用受存取保護的隔離 Worker 設定，讓 `KV` 指向還原後的 namespace，保持正式服務的 binding 不動。真實家庭資料不可放進 `DEV_MODE=1` 的公開 dev Worker；隔離環境必須維持正式環境的驗證與防護設定，且不公開給其他人存取。
- 以資料擁有者的帳號重新登入，人工檢查家庭成員、個人書單與分享設定、家庭書櫃、借閱紀錄、新書預設開放；若有使用公開書櫃，再核對其連結與到期行為。登入 token 不在備份內，需要重新取得。
- 程式通過 checksum、筆數與回讀檢查，仍不能保證備份是同一瞬間的交易快照。家庭成員、借閱等跨 key 關聯由上述服務讀取人工驗證；匯出時發生的跨 key 修改與 KV 最終一致仍可能造成不一致。
- 回復舊資料可能恢復舊 PIN／驗證設定、舊分享設定或已撤銷的公開連結。真正事故復原前，先與資料擁有者核對並處理這些狀態，再由管理者另行決定是否切換正式 binding。此腳本不切換、不部署正式 Worker。

推出前至少留下：一份成功且已回讀驗證的真實 R2 備份、一次空白隔離 namespace 的還原與服務讀取結果、保留政策設定，以及下一次每日排程的成功紀錄。演練完成後刪除不再需要的隔離資料與服務，撤銷臨時還原憑證；紀錄只留時間、筆數、版本與通過／失敗結果。

### 6. 日常檢查與失敗處理

在 [GitHub 通知設定](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications) 開啟 Actions 失敗的 email 通知，首次啟用時確認實際能收到通知。每天查看最近一份成功備份是否在 **36 小時內**；超時時先查 workflow 是否被停用、開關、token 有效期與 API 額度，再手動補跑。

[GitHub 排程可能延遲或在負載高時被略過，公開 repository 連續 60 天沒有活動也會自動停用排程](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。沒有執行的工作不一定會送出失敗通知，因此 email 不能取代備份新鮮度檢查。每日排程的目標是約 24 小時的資料復原窗口，並非保證；漏跑時可能失去更久的資料。

需要暫停時將 `KV_BACKUP_ENABLED` 改成 `false`；保留規則仍會繼續刪除過期物件，長期停用前需另行決定是否保留最後一份已驗證備份。
