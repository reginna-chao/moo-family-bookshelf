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

### 7. 設定 PIN 雜湊的 pepper（建議）

PWA 登入用的 PIN 與圖形，伺服器只存雜湊。沒有 pepper 時，雜湊只是一次 SHA-256（v1），備份檔或 KV 內容外流後，因為 PIN 的組合數少，可以離線逐一猜出來。設定 `VERIFY_PEPPER` 這個 Worker secret 之後，新設定的 PIN 或圖形改用以 pepper 為金鑰的 HMAC-SHA256（v2，紀錄裡帶 `version: 2`）；舊紀錄會在本人下一次通過驗證時（建立家庭、加入家庭，或帶 PIN 的登入查詢）自動升級，使用者不用做任何事。不設定的話，一切維持原樣。

1. 產生 pepper。**一定要隨機產生，不要自己想一串字**：每筆 v2 紀錄都帶著 pepper 的指紋（`pepperId`），會跟著 `verify:` 進入每日備份，好記的字串可以拿字典去對指紋猜出來。

   ```bash
   openssl rand -hex 32
   ```

   Windows 的 PowerShell 沒有 `openssl` 指令（它是 Git Bash 附帶的），改用 Node 產生，結果一樣是 64 個十六進位字元：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. 在 `worker/` 目錄把它寫進正式 Worker。`pnpm deploy` 部署的是 `--env production`，secret 也要帶同一個參數：

   ```bash
   pnpm exec wrangler secret put VERIFY_PEPPER --env production
   ```

   少了 `--env production`，secret 會寫到 dev Worker（`wrangler.toml` 頂層），正式站根本沒拿到；而且沒有 pepper 時伺服器照舊運作，這個錯誤不會有任何症狀。dev Worker 也要用的話，另外執行一次不帶 `--env` 的同一行指令。

3. 驗收正式站：
   - `pnpm exec wrangler secret list --env production` 的輸出要有 `VERIFY_PEPPER`。
   - 用一個測試帳號在擴充功能設定 PIN，再讀它的驗證紀錄，要看到 `"version":2` 與 `pepperId`（userId 的算法見「使用者忘記登入驗證時」第 1 步）：

     ```bash
     pnpm exec wrangler kv key get "verify:<測試帳號的 userId>" --namespace-id <正式 namespace ID> --remote
     ```

4. 本機開發：在 `worker/.dev.vars` 加一行 `VERIFY_PEPPER=<另一把隨機值>`（範例見 `.dev.vars.example`），不要用正式的那一把。不加也可以：本機 Worker 會維持舊格式（v1），`pnpm dev` 和擴充功能都照常運作。只有一種情況會出錯：本機 KV 裡已經有設了 pepper 之後寫入的 PIN 紀錄（`"version":2`），之後把那行拿掉或換成另一把，那些本機測試帳號用 PIN 登入會收到 503 `VERIFY_UNAVAILABLE`，終端機出現 `VERIFY_PEPPER_MISSING` 或 `VERIFY_PEPPER_MISMATCH`。本機資料用完即丟，刪掉那筆 `verify:` 紀錄（或整個 `worker/.wrangler/state`）重新設定 PIN 就好。

設定之後要知道的事：

- **把 pepper 存進密碼管理器**，和備份分開保存，不要放進 KV、R2 或 GitHub（見「KV 每日備份與還原演練」→ 啟用步驟）。
- **遺失的後果**：已升級（`version: 2`）的帳號在 PIN／圖形登入、改驗證設定、刪除帳號時，都會收到 503 `VERIFY_UNAVAILABLE`（「伺服器的驗證設定不完整，請聯絡管理者」），直到把同一把 pepper 設回去為止。使用者自己沒有辦法解決；真的找不回來，只能逐一照「使用者忘記登入驗證時」改寫成臨時 PIN。
- **不支援更換 pepper**：換成新的一把，等於弄丟舊的那一把。
- **啟用之前的備份還是 v1**：已經存在 R2 的封存檔裡的 `verify:` 紀錄不會回頭升級，在保留期內仍然可以離線猜；要等本人換過 PIN／圖形，舊備份裡的雜湊才會失效。
- **設錯的症狀**：已升級的帳號登入一律回 503，Workers Logs 出現 `VERIFY_PEPPER_MISMATCH`（設成了另一把）或 `VERIFY_PEPPER_MISSING`（Worker 上沒有 pepper）。這兩行是 `console.error`，關閉 invocation log 不會把它們藏起來（見「不記錄請求網址（invocation log）」），而且不含任何 userId 或同步碼。

### 8. 設定 Extension / PWA 使用自訂端點

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

設定了 binding 之後，每分鐘的限制不再寫 KV，上述「垃圾流量燒光寫入額度」的路徑就消失了；每小時的每帳號上限（`put-books`、`family-prefs`、`family-write`、`public-shelf`、`verify-write`、`verify-set`）仍記在 KV，而它們都需要通過身分驗證才會被計數。**唯一的例外是 PWA 登入驗證的猜錯上限**：三個公開閘門端點（`POST /api/family`、`POST /api/family/:id/join`、`POST /api/auth/lookup`）在未驗證的呼叫方每猜錯一次密鑰時，仍會寫入該帳號的嘗試計數（`ratelimit:user:verify:{userId}:{bucket}`）與該來源的失敗紀錄（`verifyfail:{userId}:{caller}`），同一組「帳號 × 來源」15 分鐘內至多 5 次（`VERIFY_MAX_FAILURES` / `VERIFY_FAIL_TTL_SECONDS`，見 `worker/src/kv/schema.ts`）。因此下方的 WAF 規則仍然值得設定。

若你的 Worker URL 可能被陌生人掃到（部署在公開網路本來就是如此），建議在 Cloudflare Dashboard 為 `/api/*` 設定 [WAF Rate Limiting 規則](https://developers.cloudflare.com/waf/rate-limiting-rules/)（免費方案含 1 條規則），在流量抵達 Worker 之前就把異常來源擋下。原生 Rate Limiting binding（步驟 5）本身不是硬上限——它在單一 Cloudflare 節點內計數且為最終一致——真正需要硬上限時仍得評估 Durable Objects。

## 不記錄請求網址（invocation log）

`wrangler.toml` 在頂層的 `[observability.logs]` 與 `[env.production.observability.logs]` 都設了 `invocation_logs = false`。invocation log 會記下每個請求的完整網址，而網址裡有同步碼（familyId）、userId 與公開書櫃的 share token，開著就會讓這些值留在 Workers Logs 裡保存 3 天。

- 自架者若維護自己的 wrangler 設定，請保留這兩段，並重新部署（`pnpm deploy`）。兩段都要有：production 的 `[env.production.observability]` 區塊會整段覆蓋頂層的 `[observability]`，只寫在頂層的設定對 production 不會生效。
- `console.*` 的 log（`kv_ops`、錯誤事件）仍會保存，`enabled = true` 與 `head_sampling_rate = 1` 維持不變。`wrangler tail` 走的是即時串流，不經 Workers Logs 保存，依 Cloudflare 文件判斷不受這個設定影響（未實測）。
- 這個設定只管 Workers Logs。部署前已寫入的 log 會留到保存期滿才消失（免費方案 3 天、付費方案 7 天）；若另外設定了 Logpush，或 Worker 綁了自訂網域（流量分析、WAF 事件也會記下請求路徑），請自行確認那些地方不保存完整網址。

## 使用者忘記登入驗證時

家人忘了自己設的 PIN 或圖形時，就算手邊還有一台電腦的擴充功能仍在登入狀態，也沒辦法自己重設：改驗證設定和刪除帳號都要先輸入目前的 PIN 或圖形。如果他其實還記得，只是在手機上連續打錯被鎖住，請他在擴充功能設定裡輸入目前的 PIN 或圖形後重新設定，或等 15 分鐘鎖定解除，不需要管理者介入。鎖定是依連線來源的對外 IP 計算，而且與手機版登入共用：電腦和手機若在同一個對外 IP 之後（例如同一個家用網路），手機上連續打錯 5 次造成的 15 分鐘鎖定也會擋住電腦上的這次輸入，要等鎖定解除後再重新設定。

真的忘了的話（不論還有沒有裝置在登入），就需要管理者介入：把他的驗證設定改寫成一組臨時 PIN，再把臨時 PIN 告訴他。伺服器無法替你確認對方是不是本人，這一步完全依賴你自己的判斷，確認是本人之後再做。原因與目前的政策見 `docs/architecture.md` → PWA 登入驗證機制 → 忘記驗證方式時。

官方伺服器的受理方式：申請會從回報表單進來。使用者在登入驗證畫面或設定頁點「填寫救援申請」，在表單上選問題類型「忘記登入驗證方式」，並填上讀墨註冊 Email。表單是公開的，任何知道那個 Email 的人都填得出來，所以**先確認、再寫入**：收到申請後，先回信到表單上的讀墨註冊 Email（不回到申請人另外給的任何聯絡方式），請信箱主人回信確認是他提出的申請；收到從那個信箱寄出的確認之後，才開始下面的第 1 步。沒有確認就不要動他的驗證設定，否則任何人都能替別人的帳號觸發一次改寫。處理完之後，請刪除那筆表單回覆，以及你寄出的信的備份。自架伺服器的畫面不會出現這個連結，只會請家人直接找你。

帳號被接管時也用同樣的方式處理：有人在伺服器資料還沒同步到各節點的空窗內，用舊的 token 改掉了他的驗證設定，或把換密鑰之前的驗證設定寫了回去（`docs/architecture.md` → PWA 登入驗證機制 → 安全措施，其中的已接受殘餘風險）。握有他目前 token 但不知道 PIN 的人，在只有驗證設定還沒同步的節點上改驗證設定或刪除帳號，都會被拒絕；要接管，那個節點上的 token 紀錄也得還是舊的。這時讀到的若還是 PIN 或圖形，要同時握有舊的 token 和舊的 PIN 或圖形；讀到的若是「不驗證」、驗證碼或沒有驗證設定（例如他第一次設定 PIN，就是想把握有 token 的人趕出去），只用舊的 token 就能改掉他的驗證設定或刪除帳號，這段空窗並沒有縮小。被接管之後，或換密鑰之前的驗證設定被寫回之後（不論寫回的是哪一種驗證方式），他改驗證設定會被拒絕，用自己的 PIN 或圖形也登入不了，手上的裝置救不回來。照下面的步驟改寫成臨時 PIN；接管者在每一台裝置上的登入，都要等他用臨時 PIN 登入、再改成自己的 PIN 或圖形之後才會失效（設定新的 PIN 或圖形會撤銷該帳號的全部登入，不在清單上的也一起撤銷；只有設定前約 60 秒內剛建立（通常在別的節點）而伺服器還列不到的登入可能漏掉（登入紀錄異常多時另見下一段），這種登入不能續期，最多再 90 天失效，見 `docs/architecture.md` → PWA 登入驗證機制 的已接受殘餘風險）。

不要直接刪除他的驗證設定。刪除會留下一段沒有驗證的空窗，知道他 Email 和同步碼的家人可以在這段時間搶先登入；直到他設定新的 PIN 或圖形之前，對方都能看到他的完整書單、修改他的開放設定。設定新的 PIN 或圖形會撤銷該帳號的全部登入（包括不在清單上的孤兒登入），只有做這次設定的那台會拿到新的登入（KV 傳播期間除外：設定前約 60 秒內剛建立（通常在別的節點）、還列不到的孤兒登入可能漏掉，它不能續期，最多再 90 天失效）。設定 PIN 時若日誌出現 `AUTH_TOKEN_INDEX_CAPPED`，表示該帳號有異常多的登入紀錄，這次只撤銷了前 400 個，再儲存一次驗證設定就會繼續清。若出現 `AUTH_TOKEN_INDEX_LIST_FAILED`，表示那次撤銷只刪到清單上的登入、孤兒登入沒有被找出來，在補救前它們都還能用。這個事件不分原因（KV 拒絕、額度用完、回應格式不對都記同一個名字），請先看那一行帶的錯誤內容並查 KV 用量：若是當天的 KV list 額度用完（免費方案每天 1,000 次，整個 Cloudflare 帳號共用，dev 環境和備份也會用到），等額度重置後再請他儲存一次驗證設定；若是其他原因，先排除原因，再儘快請他重存一次，不要等隔天。改寫成臨時 PIN 就沒有空窗。臨時 PIN 你自己也知道，在他改掉之前你等於能登入他的帳號，所以請他登入後立刻改掉。

1. 算出他的 userId（`sha256("moo:" + Email 轉小寫並去掉前後空白)`，與擴充功能、PWA 用的 `deriveUserId` 相同）。這行指令會把 Email 留在終端機的歷史紀錄裡，做完可自行清除：

   ```bash
   node -e "const e=process.argv[1].toLowerCase().trim();console.log(require('crypto').createHash('sha256').update('moo:'+e).digest('hex'))" "family-member@example.com"
   ```

2. 在 `worker/` 目錄先確認這個 userId 真的有驗證設定（`<正式 namespace ID>` 可用 `pnpm exec wrangler kv namespace list` 查詢）。印出的 `method` 應該是 `pin`、`pattern` 或 `code`。設成驗證碼（`code`）的帳號要在已登入的電腦上產生驗證碼，手邊沒有已登入的電腦時一樣登入不了，也用這些步驟改成臨時 PIN。回「not found」代表 Email 打錯，或這個帳號本來就沒設驗證：

   ```bash
   pnpm exec wrangler kv key get "verify:<上一步的 userId>" --namespace-id <正式 namespace ID> --remote
   ```

3. 產生臨時 PIN 的驗證紀錄。PIN 要 6 到 12 位數字，自己挑一組，不要用例子裡的；這行會把它寫進 `temp-verify.json`，其中的 `secretUpdatedAt` 取自你這台電腦的時間。先確認本機時鐘正確：它要比對方最後一次換密鑰的時間晚，否則臨時 PIN 登入會一直被要求重新驗證。臨時 PIN 和第 1 步的 Email 一樣會留在終端機的歷史紀錄裡。這行產生的是舊格式（v1）的紀錄，伺服器設了 pepper 也照樣能用，他用臨時 PIN 登入後會自動升級，你不必自己算 HMAC：

   ```bash
   node -e "const c=require('crypto');const pin=process.argv[1];const salt=c.randomBytes(16).toString('hex');const hash=c.createHash('sha256').update(salt+pin).digest('hex');require('fs').writeFileSync('temp-verify.json',JSON.stringify({method:'pin',hash,salt,prompted:0,secretUpdatedAt:Date.now()}))" "246813"
   ```

4. 把這筆紀錄寫進他的驗證設定，然後刪掉檔案：

   ```bash
   pnpm exec wrangler kv key put "verify:<上一步的 userId>" --path temp-verify.json --namespace-id <正式 namespace ID> --remote
   rm temp-verify.json
   ```

5. **只把臨時 PIN 回信到表單上那個讀墨註冊 Email**，不寄到申請人另外給的任何聯絡方式。收得到那個信箱的信，是唯一能證明本人的方式。自架伺服器沒有這個表單，可以一樣寄到他的讀墨註冊 Email，或用其他家人看不到的管道告訴他。請他用同步碼加臨時 PIN 重新登入，登入後立刻改成自己的 PIN 或圖形：電腦上在擴充功能設定裡改，改之前會先要求輸入這組臨時 PIN；只有手機的話，PWA 登入後會跳出提示，選擇更改後先輸入臨時 PIN，再設定新的 PIN 或圖形。他的個人書櫃與分享設定都還在，不受影響。

寫入時的 `secretUpdatedAt` 會讓舊 PIN 累積的鎖定紀錄（`verifyfail:`）立刻失效，不必另外清除，也不用等 15 分鐘。如果之後從備份還原 KV，備份裡舊的驗證設定會跟著回來（見「KV 每日備份與還原演練」→ 還原）。

## 更新

```bash
git pull origin main
cd worker
pnpm install
pnpm deploy
```

設了 `VERIFY_PEPPER` 之後，如果回退到不認得 pepper 的舊版 Worker，已升級（`version: 2`）的帳號輸入正確的 PIN 也會被當成打錯，要再更新回新版才會恢復。回退期間這些「打錯」照樣計數：同一來源 5 次就鎖 15 分鐘，換回新版後被鎖的人最多還要再等 15 分鐘；第三方也能在這段期間用錯誤的 PIN 把該帳號每小時 10 次的猜測上限用完，讓本人暫時進不來。

更新到含 #432 的版本後，還沒改存成雜湊的登入會失效：直接從 v1.7.2 或更早的版本升上來的伺服器，所有裝置都要重新登入一次；已經跑過含 #425 的版本一段時間的伺服器，只有那段期間沒有續期或重新登入過的裝置要重新登入。擴充功能與 PWA 會自動重新連線，帳號設了 PIN／圖形的要再輸入一次；同一個網路下同一分鐘內有超過 3 台裝置重新連線時，多出來的要等約 1 分鐘才會自動再試。

設成驗證碼（`code`）的帳號是例外：驗證碼只有登入中的裝置能產生，更新後所有裝置都登出了，就沒有人能產生驗證碼，本人登不回來。更新前先列出有驗證設定的帳號，逐筆看 `method` 是不是 `code`：

```bash
pnpm exec wrangler kv key list --prefix "verify:" --namespace-id <正式 namespace ID> --remote
pnpm exec wrangler kv key get "verify:<userId>" --namespace-id <正式 namespace ID> --remote
```

請這些帳號的本人在更新前先把登入驗證改成 PIN、圖形或不設驗證；來不及改的，更新後照「使用者忘記登入驗證時」改寫成臨時 PIN。

## KV 每日備份與還原演練

正式 KV 的每日備份由一個獨立的 Cloudflare Worker 執行（程式在 `worker/src/backup/`，設定範本是 `worker/wrangler.backup.toml`），跑在 Workers **Free** 方案。排程是每天 **03:17 UTC（台灣 11:17）**。Worker 只透過 KV／R2 bindings 讀寫，不持有任何 Cloudflare REST token；備份寫進私人 R2 bucket，完成後通知 Healthchecks.io 的兩個 check，任一個超過時限沒收到訊號，就由 Healthchecks 寄 Email。設計理由、費用與升級分界見 [KV 備份計畫](../docs/kv-backup-plan.md)。

- GitHub 不排程、也不部署這個 Worker。CI 只跑 `pnpm run build:backup`（`wrangler deploy --dry-run`）確認能建置，`main` 與 tag 的 CD 都不會碰它；程式更新後要由管理者用本機設定檔自行部署。
- 這個 Worker 沒有公開入口：`fetch` 一律回 404，`workers_dev = false`、`preview_urls = false`。

**合併 PR 不代表已啟用。** 範本預設 `BACKUP_ENABLED = "false"`、`crons = []`，要做完下方第 3 節的全部步驟才算正式上線。

### 1. Free 方案下的限制

Worker 自己計數，碰到上限就以明確的錯誤停止，不等平台把它中止。常數都在 `worker/src/backup/runtime.ts`，列舉總數的上限在 `scripts/kv-backup/format.mjs`：

| 項目                                    | 上限                      | 常數                    |
| --------------------------------------- | ------------------------- | ----------------------- |
| 保存範圍的 key 數                       | 5,000 筆                  | `MAX_SAVED_KEYS`        |
| 整個 namespace 列舉到的 key（含不備份） | 100,000 筆                | `MAX_KEYS`              |
| 封存檔（JSONL）總長                     | 15 MB（15,000,000 bytes） | `MAX_ARCHIVE_BYTES`     |
| 單筆 value                              | 4 MiB                     | `MAX_VALUE_BYTES`       |
| 每次執行的內部請求（KV、R2，含重試）    | 1,000 次                  | `MAX_INTERNAL_REQUESTS` |
| 每次執行的對外請求（`fetch()`，含重試） | 50 次                     | `MAX_EXTERNAL_REQUESTS` |
| 每次執行的時間預算                      | 12 分鐘                   | `RunBudget`             |

- **批次讀取**：`getWithMetadata([keys], "text")` 每批 100 個 key（`READ_BATCH_SIZE`），一批算 1 次內部請求。批次回應超過 25 MB 時 KV 回 413，Worker 立刻把這一批對半拆開重讀；其他錯誤先隔 500 ms 重試一次，仍失敗也對半拆。拆到只剩 1 筆還讀不到，才讓備份失敗。重試與拆批都計入內部請求，每次執行最多重試 100 次。
- **碰到上限時**：本次備份失敗。程式會嘗試中止進行中的 multipart upload（已完成但尚未發布的檔案則刪除），但這一步本身也算一次內部請求：碰到的是內部請求上限或 12 分鐘時限時，清理會被略過，殘留的未完成 upload 交給第 2 節的「一天後自動清除」規則。`latest.json` 不更新，兩個 check 都不 ping，最後成功備份保持原樣；約 36 小時後「備份成功」check 寄 Email。
- **CPU 不在程式能計數的範圍**：Free 每次 Cron 觸發 10 ms CPU，持續超過會被平台直接中止（tail 事件 `outcome` 記 `exceededCpu`，GraphQL `dimensions.status` 記 `exceededResources`），`catch` 也不會執行，殘留的未完成 upload 靠第 2 節的 R2 規則清除。CPU 只能從正式環境的儀表板、`wrangler tail` 或 GraphQL 看（第 3 節步驟 5）；本機 tail 的 `cpuTime` 一律是 0。

**「容量正常」的分界**（`CAPACITY_LIMITS`，約為上限的 70%）：三項都**低於**分界才 ping「容量正常」，任一項達到就不 ping，這就是升級提醒，備份本身照常進行。

| 項目                     | 分界                        |
| ------------------------ | --------------------------- |
| 單次執行的內部請求       | < 700 次                    |
| 寫入的筆數（`count`）    | < 3,500 筆                  |
| 封存總長（`byteLength`） | < 10 MB（10,000,000 bytes） |

這裡的內部請求數是送 ping 當下的總數，包含寫 manifest、更新 `latest.json` 與清理舊備份，會比 manifest 裡的 `requests.internal` 多幾次；完整數字在 Worker log 的 `kv_backup_success` 那一行（`internalRequests`）。CPU 不在這三項裡，也沒有數字分界（正式環境 Free 的驗收實測每次 25–28 ms，已超過 10 ms 但沒有被中止，官方不保證容忍的幅度）：判定看每次 Cron 執行的結果，出現中止就升級；數字、官方口徑與中止後留下的狀態見計畫第 8、9 節。分界的由來見計畫第 9 節，升級步驟見計畫第 14 節與本章第 7 節。

### 2. 備份格式與保存

**保存範圍**（`scripts/kv-backup/format.mjs` 的 `PREFIXES`，tripwire 測試 `worker/tests/unit/kvBackupKeyParity.test.ts` 釘住它與 `kvKeys` 的對應）：`user:`、`family:`、`member:`、`verify:`、`publicshelves:`、`public:`、`borrow:`、`borrows:family:`、`newbookdefault:`、`kicked:`。不備份：`auth:`、`token:`、`tokenidx:`、`otp:`、`qr:`、`verifyfail:`、`ratelimit:`。列舉到兩邊都沒有的類別，備份就失敗；新增 key 家族時必須同時更新清單。

**檔名**：每次備份用獨立檔名，`snapshots/YYYY-MM-DD/<開始時間>_<uuid>.jsonl` 與同名的 `.manifest.json`。日期與開始時間都是 UTC，開始時間的 `:` 與 `.` 換成 `-`，例如 `snapshots/2026-10-16/2026-10-16T03-17-00-123Z_<uuid>.manifest.json`。

**JSONL version 2**：一個 key 一行，欄位順序固定為 `key`、選填的 `expiration`（Unix 秒）、選填的 `metadata`，`value` 放最後。`value` 是 KV 裡的原始 JSON 文字，直接嵌入，不解析也不重新序列化；只有 `member:` 的值（`abcd-1234` 這種家庭 ID 字串）會包成 JSON 字串。Worker 不檢查 value 是不是合法 JSON，這件事留到還原時才驗證。

**manifest**（以 `etagDoesNotMatch: "*"` 寫入，不會覆寫既有檔案）：

| 欄位                                     | 內容                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `version`                                | 固定為 `2`                                                                |
| `sourceAccountId`／`sourceNamespaceId`   | 來源帳號與 namespace，取自 `SOURCE_ACCOUNT_ID`／`SOURCE_NAMESPACE_ID`     |
| `startedAt`／`completedAt`               | ISO 時間                                                                  |
| `count`                                  | 寫入的筆數；執行中自然到期而略過的 key 不算                               |
| `prefixCounts`                           | 各類別的筆數                                                              |
| `lineLengths`                            | 每一行的 byte 長度（含換行）                                              |
| `byteLength`                             | 封存檔總長                                                                |
| `objectSize`                             | R2 回報的物件大小，必須等於 `byteLength`，否則不發布                      |
| `requests.internal`／`requests.external` | 寫 manifest 之前的請求數，不含之後的 manifest、`latest.json`、清理與 ping |
| `dataObjectPath`                         | 對應的 `.jsonl` 路徑                                                      |

**`latest.json`**：內容是 `{ manifestKey, completedAt, sourceAccountId, sourceNamespaceId }`，只指向已上傳完成、長度相符的備份。更新用 R2 原生的 ETag 條件寫入（已存在時 `etagMatches` 上次讀到的 ETag，不存在時 `etagDoesNotMatch: "*"`），並行發布衝突就失敗。既有指標的 `completedAt` 不早於本次開始時間、或來源不同時，也不覆寫。

**一致性檢查**：讀完所有 value 後再列舉一次 KV；出現新 key、未到期的 key 消失、或仍在的 key 到期時間改變，本次就失敗。這只能發現 key 集合與到期時間的變化，發現不了 value 被覆寫，所以備份不是跨 key 的交易快照。

**保留**：新備份發布後，刪除 `snapshots/` 底下上傳時間與日期資料夾都超過 14 天的物件，但 `latest.json` 指向的那一對一律保留，就算已超過 14 天。每次最多掃 10 頁（每頁 1,000 個物件），超過就失敗並要求檢查儲存用量。使用者移除帳戶後，他的資料仍留在移除前已寫入的備份裡，要等那些備份被這條規則刪除才會消失：每日備份正常執行時約 14 天；`latest.json` 指向的那一對不論多舊都保留，備份停擺期間也不會清理任何舊備份。

**R2 生命週期規則**：

- **不要**設任何涵蓋 `snapshots/`、`latest.json` 或整個 bucket 的物件到期刪除規則。清理由 Worker 負責，它不會刪最後成功備份；到期規則會。
- **保留**「未完成 multipart upload 一天後自動清除」這條規則。Worker 被平台中止時 `catch` 不會執行，殘留的 upload 只能靠它清。

### 3. 啟用步驟

要登入儀表板、輸入秘密、按互動確認、看信箱的由管理者做；能用本機已登入的 wrangler 完成的可由 agent 代勞（計畫第 13 節）：

| 步驟                                                                                                           | 誰                           |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 開通 R2 並綁付款方式                                                                                           | 管理者                       |
| Healthchecks 帳號、兩個 check（24 h + 12 h）、Email 驗證、取得兩個 UUID；月度 dry-run 提醒 check（30 d + 7 d） | 管理者                       |
| 建 bucket、生命週期規則、`wrangler.backup.local.toml`、部署停用版                                              | agent（wrangler）            |
| `wrangler secret put` 兩個 UUID                                                                                | 管理者（終端機輸入）         |
| 每小時 Cron 跑 3–5 次、讀 manifest 核對請求計數、封存大小與 `latest.json`                                      | agent                        |
| 記錄儀表板 CPU、核對每次 Cron 的 outcome（第 8 節）                                                            | 管理者                       |
| 建隔離 namespace                                                                                               | agent                        |
| 建還原用 API token、設本機環境變數                                                                             | 管理者                       |
| 還原 dry-run（每月例行用 `pnpm backup:drill`）                                                                 | 任一                         |
| 還原 `--apply`、家庭成員判定核對                                                                               | 管理者（程式拒絕非互動執行） |
| 故意失敗一次，確認 `latest.json` 未動、仍可 dry-run 還原                                                       | agent                        |
| 兩個 check 各改 1 分鐘 + 1 分鐘，不 ping，等真的收到兩封 Email，再改回                                         | 管理者                       |
| Cloudflare Billing 用量通知                                                                                    | 管理者                       |
| 正式啟用 `crons=["17 3 * * *"]`、觀察一次成功                                                                  | agent 部署、管理者確認       |
| 啟用後 7–14 天每天核對執行結果（GraphQL `dimensions.status`），全部 `success` 才結案                           | 管理者                       |
| 維運紀錄、每月 dry-run 提醒、每月 GraphQL 執行結果與儀表板 CPU 檢查                                            | 管理者                       |

表中的「第 8 節」指計畫第 8 節，也就是下方步驟 5 的 CPU 判定。

設了 `VERIFY_PEPPER`（「步驟」第 7 步）的話，它也是備份的一部分：沒有同一把 pepper，還原回來的已升級驗證紀錄無法使用。把它存進密碼管理器，不要放進 KV、R2 或 GitHub，備份檔與 pepper 分開保存才有保護效果。

#### 步驟 1：開通 R2（管理者）

在正式資料所在的帳號開通 R2 並綁付款方式。R2 超過免費額度是按量計費，不是硬停（計畫第 3 節）；建議同時在 Cloudflare Billing 設定用量通知。

#### 步驟 2：建立 Healthchecks check（管理者）

在 Healthchecks.io 建兩個備份 check 加一個提醒 check。兩個備份 check 都選 Simple schedule：**Period 24 hours、Grace Time 12 hours**，接上已驗證的 Email integration 並確認通知開關是開的。兩個 check 用不同名稱，例如「備份成功」與「容量正常」，收到信時從主旨就分得出是「備份停了」還是「該升級了」。

- 從 check URL `https://hc-ping.com/<uuid>` 記下兩個 UUID。UUID 視同秘密：拿到的人可以偽造成功訊號，所以不放 Git、聊天、截圖或 log。
- 兩個 UUID 必須不同，Worker 遇到相同的會拒絕執行（「兩個獨立備份監看必須使用不同的 UUID。」）；格式必須是小寫 UUID。
- Worker 對每個 check 送空內容的 POST，最多 3 次、每次 10 秒逾時，只有回 200 且內容是 `OK` 才算成功；不送 `/start`、`/fail`，也不傳任何備份內容。

第三個是「月度 dry-run 提醒」check，提醒管理者每月跑一次 `pnpm backup:drill`：

- 選 Simple schedule：**Period 30 days、Grace Time 7 days**，接上同一個已驗證的 Email integration，名稱取「月度 dry-run 提醒」。
- 它的 UUID 不交給備份 Worker，也不放進 `wrangler secret put`：Worker 從不 ping 它。
- 每次 `pnpm backup:drill` 成功後，管理者到這個 check 按 **Ping Now**。37 天內沒有跑演練，Healthchecks 就會寄信提醒。

#### 步驟 3：建 bucket、本機設定，部署停用版（agent）

以下在 `worker/` 執行，使用專案鎖定的 wrangler（Node 22 以上）。先建 bucket 與生命週期規則：

```bash
pnpm exec wrangler r2 bucket create moo-family-bookshelf-backups
pnpm exec wrangler r2 bucket dev-url get moo-family-bookshelf-backups
pnpm exec wrangler r2 bucket lifecycle add moo-family-bookshelf-backups abort-multipart --abort-multipart-days 1
pnpm exec wrangler r2 bucket lifecycle list moo-family-bookshelf-backups
```

- `dev-url get` 用來確認 r2.dev 公開網址是關閉的；也不要替這個 bucket 接公開的自訂網域。
- 生命週期規則只設 `--abort-multipart-days 1`，不要加 `--expire-days` 或 `--expire-date`，prefix 留空（整個 bucket）。加完用 `lifecycle list` 確認 bucket 上只有這一條規則、而且沒有物件到期設定。

複製設定範本（這個檔名已列在 `.gitignore`）：

```bash
cp wrangler.backup.toml wrangler.backup.local.toml
```

PowerShell 用 `Copy-Item -LiteralPath wrangler.backup.toml -Destination wrangler.backup.local.toml`。目的檔已存在時先檢查內容，不要覆蓋已設定好的檔案。接著編輯 `wrangler.backup.local.toml`：

- `name`：備份 Worker 自己的名稱（範本的 `moo-family-bookshelf-backup` 即可），不得填服務 API Worker 的名稱。
- 加一行頂層 `account_id = "<正式帳號的 32 位 ID>"`，放在第一個 `[vars]` 區段之前。
- `[vars]` 的 `SOURCE_ACCOUNT_ID` 填同一個帳號 ID；`SOURCE_NAMESPACE_ID` 與 `[[kv_namespaces]]` 的 `id` 都填正式 KV namespace 的 ID（可用 `pnpm exec wrangler kv namespace list` 核對）。兩者都必須是 32 位小寫十六進位。
- `[vars]` 的 `RESTORE_DRILL_NAMESPACE_ID` 填同一帳號內一個專供演練用的隔離 namespace 的 32 位 ID。這個 namespace 只建一次：`pnpm exec wrangler kv namespace create "KV_RESTORE_DRILL"`，把指令回傳的 32 位 ID（不是 `KV_RESTORE_DRILL` 這個名稱）填進來，之後每個月都用同一個，欄位不用再改。它裡面必須一直沒有任何 key：`pnpm backup:drill` 從不寫入，所以建好後會自然維持這個狀態，但不要拿它做 `--apply`。只有 `pnpm backup:drill` 會讀這個值，備份 Worker 不使用它。
- `[[r2_buckets]]` 的 `bucket_name` 填上面建立的 bucket。
- 維持 `BACKUP_ENABLED = "false"`、`crons = []`、`workers_dev = false`、`preview_urls = false`；不要加 route、`DEV_MODE` 或 `cpu_ms`（`cpu_ms` 是 Paid 才有的設定）。
- 保留 `[observability] enabled = true`，但**不要**替這個 Worker 開 Workers traces（`[observability.traces]`）：fetch 的 trace 可能記下完整的 `https://hc-ping.com/<uuid>` URL，而 UUID 拿到就能偽造成功訊號。

`SOURCE_*` 只寫進 manifest 供還原核對，Worker 只檢查格式，無法從 binding 反查實際的 namespace ID，所以部署前要人工交叉核對兩處 ID 一致。部署停用版：

```bash
pnpm exec wrangler deploy --config wrangler.backup.local.toml
```

不要加 `--env production`：這是獨立設定檔，不是服務 Worker 的 production environment。

#### 步驟 4：輸入兩個 UUID（管理者）

```bash
pnpm exec wrangler secret put HEALTHCHECKS_UUID --config wrangler.backup.local.toml
pnpm exec wrangler secret put HEALTHCHECKS_CAPACITY_UUID --config wrangler.backup.local.toml
```

在互動提示貼上 UUID，不要寫在命令列參數裡。`HEALTHCHECKS_UUID` 對應「備份成功」，`HEALTHCHECKS_CAPACITY_UUID` 對應「容量正常」。

#### 步驟 5：每小時 Cron 驗收（agent；CPU 由管理者看）

1. 本機設定改成 `BACKUP_ENABLED = "true"`、`crons = ["17 * * * *"]`（每小時第 17 分，UTC），重新部署。
2. 讓它跑 3–5 次。每次都讀 `latest.json` 與它指向的 manifest：

   ```bash
   pnpm exec wrangler r2 object get moo-family-bookshelf-backups/latest.json --remote --pipe --config wrangler.backup.local.toml
   pnpm exec wrangler r2 object get "moo-family-bookshelf-backups/<manifestKey>" --remote --pipe --config wrangler.backup.local.toml
   ```

   核對：`latest.json` 指向最新的那份 manifest；`requests.internal` 遠低於 700、`count` 低於 3,500、`byteLength` 低於 10,000,000；兩個 Healthchecks check 都收到了這次的 ping。Worker log 的 `kv_backup_success` 一行有本次的最終請求數與 `capacityOk`。

3. 管理者記下 Workers 儀表板這個 Worker 的 CPU time（分位數與尖峰），但驗收以每次執行的結果為準：在 Cron 時間前後掛著 `pnpm exec wrangler tail --config wrangler.backup.local.toml`，事件的 `outcome` 是 `ok` 就過、`exceededCpu` 是被中止；沒掛到的那幾次，事後用 GraphQL `workersInvocationsAdaptive` 回查，`dimensions.status` 是 `success` 就過、`exceededResources` 是被中止（兩邊的值不同，不能互相套用）。**出現任何一次中止就走第 7 節的升級流程。** 不能用「沒收到逾期信」代替這個核對：中止發生在「備份成功」ping 之後時，Healthchecks 不會寄信。目前的實測（Free 下驗收每次 25–28 ms，未被中止）、官方口徑與升級判斷見計畫第 8、9 節。本機看不到 CPU，tail 的 `cpuTime` 一律是 0。同時記下 wall-clock 時間與 KV／R2 用量。
4. 驗收結束就把 `crons` 改回 `[]` 並重新部署。長期每小時跑會超出 Free 的 KV 每日讀取額度（計畫第 2、3 節），不要忘記改回。

#### 步驟 6：還原演練（見第 4 節）

由 agent 另建一個全新的空白隔離 namespace 給 `--apply` 用（例如 `pnpm exec wrangler kv namespace create "KV_RESTORE_APPLY"`；不能用步驟 3 的 `RESTORE_DRILL_NAMESPACE_ID`，那個裡面必須一直沒有任何 key），管理者建還原用的 API token 並設好本機環境變數，先跑 dry-run，再由管理者在互動終端機執行 `--apply`，最後用隔離 Worker 核對家庭成員判定。

#### 步驟 7：故意失敗一次（agent）

已經有一份成功備份之後，讓一次排程刻意失敗，例如暫時把本機設定的 `SOURCE_NAMESPACE_ID` 改成格式不符的值（Worker 會在讀取任何資料前就停止），部署並等一次每小時 Cron。確認：

- `latest.json` 的 `manifestKey` 與 `completedAt` 沒有改變；
- 對它指向的 manifest 跑還原 dry-run 仍然通過；
- 這一次沒有送出任何 ping。

做完把 `SOURCE_NAMESPACE_ID` 改回正確值。不要用刪除正式資料或最後成功備份的方式製造失敗。

#### 步驟 8：兩封 Email 演練（管理者）

1. 確認備份 Worker 目前沒有排程（`crons = []` 已生效），否則它的 ping 會讓 check 恢復正常。
2. 兩個 check 都暫時改成 **Period 1 minute、Grace Time 1 minute**。不送 ping、不手動呼叫 `/fail`。
3. 等到收件匣真的收到兩封通知信，不只是在 Healthchecks 畫面上看到紅色。這證明就算備份程式完全沒執行，也會有人收到信。
4. 兩個 check 都改回 **24 hours + 12 hours**。

#### 步驟 9：正式啟用（agent 部署、管理者確認）

本機設定改成 `BACKUP_ENABLED = "true"`、`crons = ["17 3 * * *"]` 並部署。至少觀察到一次正式的每日執行成功（R2 有新的 manifest、`latest.json` 已更新、兩個 check 都恢復正常），才算部署完成。

接著連續 7–14 天，每天用 GraphQL `workersInvocationsAdaptive` 核對前一次執行的 `dimensions.status`（或在 03:17 UTC 前後掛著 tail 看 `outcome`），全部 `success` 才算啟用結案；出現一次 `exceededResources`（tail 是 `exceededCpu`）就走第 7 節。這段觀察是計畫第 8、9 節「每天一次算偶爾超過」這個推論的驗證，結果記進維運紀錄。

把每次演練的時間、程式版本、筆數、bytes、請求數、略過的到期筆數與結果記在私人維運紀錄，不記家庭資料或秘密。之後每月一次：在 repo 根目錄執行 `pnpm backup:drill`，對最新備份跑還原 dry-run（第 4 節「每月 dry-run：`pnpm backup:drill`」），並用 GraphQL `workersInvocationsAdaptive` 回查過去一個月每日執行的 `dimensions.status`（可回看三個月；tail 只有即時串流，不能回查），順便看儀表板的 CPU。

### 4. 還原

還原由本機 CLI `scripts/kv-restore.mjs` 執行，需要 Node 22 以上。它只寫入**同一帳號內、與正式來源不同的全新空白 namespace**，不會自動切換正式服務的 KV binding。每月例行的 dry-run 改用 `pnpm backup:drill`，見本節最後的「每月 dry-run：`pnpm backup:drill`」。

下表的環境變數用於 `--apply` 還原，以及下方手動帶 `--backup` 的 dry-run；`pnpm backup:drill` 不需要它們。在可信任的本機終端機設定：

| 變數                     | 內容                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`  | 正式來源所在的帳號 ID                                                                                  |
| `KV_BACKUP_NAMESPACE_ID` | 正式來源的 namespace ID（不是還原目標）；必須與 manifest 的 `sourceNamespaceId` 相同                   |
| `KV_BACKUP_BUCKET`       | 私人備份 bucket 名稱                                                                                   |
| `KV_BACKUP_R2_API_TOKEN` | 讓 Wrangler 以 `wrangler r2 object get --remote` 下載備份的 Cloudflare API token（不是 S3 Access Key） |
| `KV_RESTORE_API_TOKEN`   | 能列舉、批次讀取與批次寫入還原目標 namespace 的 KV API token                                           |

兩個 token 都不放進備份 Worker 或 GitHub Secrets，演練結束後撤銷。封存檔是明文，含每個 userId，也含 `verify:` 的 PIN 雜湊：舊格式（v1）的紀錄外流後可以離線猜（PIN 的組合數少），已升級的 v2 紀錄要同時拿到 pepper 才猜得了。所以 `KV_BACKUP_R2_API_TOKEN` 要盡量收窄：只給讀取權限、只限這一個備份 bucket、設短期有效，用完就撤銷。建立後先跑一次 dry-run，確認 Wrangler 用這個 token 下載得到備份。`KV_RESTORE_API_TOKEN` 同樣只在演練期間存在。

以下在 repo 根目錄執行，換成實際的 manifest 路徑與目標 ID。`--backup` 要給 manifest 的 key，不能直接給 `latest.json`，先讀出它的 `manifestKey`。先 dry-run：

```bash
node scripts/kv-restore.mjs --backup "snapshots/<日期>/<備份名稱>.manifest.json" --target-namespace "<隔離 namespace 的 32 位 ID>" --max-writes 1000
```

確認輸出的預計筆數後，才加 `--apply`：

```bash
node scripts/kv-restore.mjs --backup "snapshots/<日期>/<備份名稱>.manifest.json" --target-namespace "<隔離 namespace 的 32 位 ID>" --max-writes 1000 --apply
```

CLI 的行為：

- **預設是 dry-run**：只下載、驗證，並確認目標是空的，不寫入。下載透過 Wrangler 存進權限受限的暫存目錄，結束後刪除；manifest 上限 1 MiB，資料檔上限 256 MiB。
- **驗證內容**：manifest 的來源帳號與 namespace 必須與環境變數一致、`dataObjectPath` 與時間合理。version 2 核對 `lineLengths` 的數量等於 `count`、總和等於 `byteLength`、`byteLength` 等於下載長度、`objectSize` 等於 `byteLength`；version 1（`feat/kv-backup` 分支歷史的舊演練產出）核對長度與 SHA-256。每一行都要能解析、類別在保存範圍內、沒有重複 key、到期時間合法；`kicked:` 必須帶到期時間，`member:` 必須是 `xxxx-xxxx` 格式，其他類別的 value 必須是符合現有儲存格式的 JSON（`borrows:family:` 是陣列，其餘是物件），`public:` 的 `expiresAt` 必須有效；最後 `count` 與 `prefixCounts` 要相符。任何一項不符就拒絕，什麼都不寫。
- **略過即將到期的資料**：到期時間在 60 秒內的 key，以及 `expiresAt` 在 60 秒內的 `public:`，都不還原；其餘保留原本的絕對到期時間。需要寫入的筆數超過 `--max-writes` 就拒絕。
- **`--apply`**：只能在互動終端機執行，要依序輸入 `yes` 與 `RESTORE <目標ID>`，不要用 pipe 自動回答。確認後再檢查一次目標是空的，然後每批最多 100 筆寫入，寫入失敗不自動重試。`member:` 寫回原本的裸字串（例如 `abcd-1234`，不會多一層引號），其他類別寫回備份中的原始 JSON 文字。寫完逐筆讀回比對（60 秒內最多 7 輪），再列舉一次目標，確認沒有非本次寫入的資料。
- **中途失敗**：CLI 會回報確認寫入與可能寫入的筆數，保留目標供檢查，不自動刪除也不切換正式環境。重試請改用另一個全新的空白 namespace。

`--max-writes` 是本次操作的上限，不是帳號今天剩下的寫入額度；Free 方案全帳號每天只有 1,000 次 KV 寫入，正式 API 也在用同一份額度。

**還原驗收**：用一個受存取保護的隔離 Worker 接上還原目標，維持正式的驗證與安全設定，不要把真實資料放進 `DEV_MODE=1` 的服務。正式站設了 `VERIFY_PEPPER` 的話，接上還原目標的 Worker 必須用同一把 pepper，否則已升級的帳號一律回 503 `VERIFY_UNAVAILABLE`。確認家庭成員判定仍然成立：`GET /api/family/:id/members` 與 `GET /api/family/:id/bookshelf` 都能正常回應家庭成員。這兩個請求需要 `member:` 指向與家庭紀錄一致，是 `member:` 寫回格式的實際檢驗。演練結束後清掉隔離服務與資料，撤銷臨時 token。

**切換正式 binding 前的檢查**：還原是某個時間點的複本，備份之後使用者做過的隱私操作都會被倒回去。切換是管理者另行決定的手動步驟，切換前要逐項核對：

- **離開或被移除的成員會重新出現在名單上**：`family:` 與 `member:` 都來自同一份備份，對方的 `member:` 指向也會回來。
- **關閉分享的書會變回開放**：`user:` 裡的開放設定回到備份當時的狀態。
- **已關閉或重設的公開連結會重新打開**：`public:` 與 `publicshelves:` 來自同一份備份。
- **舊的 PIN 或驗證設定會回來**：`verify:` 同樣是備份當時的內容。

把備份時間之後已知的離開、移除、關閉分享與公開連結變更重新套用一次，再把正式 binding 指向還原後的 namespace；切換後請使用者重新確認自己的分享設定。備份也不是交易快照，同一份備份裡不同 key 的狀態未必來自同一時點。

#### 每月 dry-run：`pnpm backup:drill`

Worker 每天不算雜湊，封存檔有沒有損壞要到還原時才知道（計畫第 7 節）。所以每月對最新備份跑一次 dry-run，這是提早發現損壞的唯一方式。在 repo 根目錄執行（Node 22 以上）：

```bash
pnpm backup:drill
```

- **設定來源**：只讀 `worker/wrangler.backup.local.toml` 的頂層 `account_id`、`[vars]` 的 `SOURCE_NAMESPACE_ID` 與 `RESTORE_DRILL_NAMESPACE_ID`、第一個 `[[r2_buckets]]` 的 `bucket_name`（第 3 節步驟 3）。檔案不存在或缺少欄位時，會指出缺的是哪一項。
- **憑證**：沿用本機 `wrangler login` 的登入身分，不需要任何環境變數，也不需要 API token。工具會先清掉 shell 繼承的 `CLOUDFLARE_*`、`CF_*`、`WRANGLER_*`、`KV_BACKUP_*`、`KV_RESTORE_*` 變數，所以終端機裡殘留的 token 不會被拿來用。尚未登入、或登入過期又無法自動更新時，先在 `worker/` 執行 `pnpm exec wrangler login`。
- **做的事**：下載 `latest.json`，核對它的來源帳號與 namespace 和本機設定一致；再下載它指向的 manifest 與資料檔，做與上方「驗證內容」相同的完整驗證；接著列舉演練 namespace，確認它是空的。最後印出預計還原與略過的到期筆數，以及 manifest 的完成時間、`count`、`byteLength`、`requests.internal`／`requests.external`（version 1 沒有請求數，顯示「—」）。
- **從不寫入**：工具沒有 `--apply`；演練用的 KV 用戶端只能列舉，讀取與寫入一律拒絕。筆數上限用工具上限 100,000 筆（`MAX_KEYS`），只為了回報完整筆數，不是寫入預算。
- **演練 namespace 裡面要一直沒有任何 key**：只要有一個 key，dry-run 就會失敗（「目標 namespace 不是空白，沒有開始還原。」）。`RESTORE_DRILL_NAMESPACE_ID` 欄位本身每個月都填同一個 ID，不需要改動。
- 跑完到 Healthchecks 的「月度 dry-run 提醒」check 按 **Ping Now**，並把結果記進維運紀錄（第 3 節步驟 9 列的項目）。這個提醒 check 的建法見第 3 節步驟 2，備份 Worker 不會 ping 它。
- **被強制終止時要手動清理**：按 Ctrl+C 或關掉終端機時，工具會先刪掉暫存資料夾再結束，不需要處理。只有被強制終止（`kill -9`、工作管理員「結束工作」）、電腦當機或斷電，或刪除的當下資料夾仍被 wrangler 佔用超過 2 秒（主要發生在 Windows）時，系統暫存資料夾（Windows 是 `%TEMP%`，其他系統是 `$TMPDIR` 或 `/tmp`）裡才可能留下 `moo-kv-backup-*` 暫存資料夾，裡面有下載下來的明文備份，請手動刪除。正常跑完或自己失敗結束的執行會自動刪掉它。

`--apply` 還原，或要對最新以外的某一份備份做 dry-run，仍照上方用 `scripts/kv-restore.mjs` 並設定表中的兩個 token。首次啟用與格式有重大變更後，也要完成一次隔離還原演練。

### 5. 本機演練

```bash
node scripts/test-kv-backup-runtime.mjs
```

在 repo 根目錄、`pnpm install` 之後執行，不需要任何 Cloudflare 憑證，也不連線到遠端。它用 wrangler 內附的 esbuild 打包真正的 `worker/src/backup/index.ts`，在本機 workerd（Miniflare）裡以 `wrangler.backup.toml` 的相容日期與旗標執行：

1. 寫入約 500 筆合成資料（約 5 MB，含中文與 emoji、一筆保留原始換行的 pretty-print JSON、帶 metadata 與 TTL 的資料），外加不應被備份的 `ratelimit:` 與 `otp:` key。
2. 透過 `/cdn-cgi/local/scheduled` 觸發真正的 `scheduled` handler。
3. 檢查兩個 ping 依序送到「備份成功」與「容量正常」的 URL。
4. 從本機 R2 讀出 `latest.json`、manifest 與資料檔，用還原 CLI 的同一套驗證（`validateArchive`）解析，逐筆比對 value 與原始文字完全相同（`member:` 為裸字串）、metadata 與到期時間一致，內部請求數低於 100。

成功時印出一行 `"result":"PASS"` 的 JSON。它證明 handler、JSONL 格式與還原驗證在真實的 Workers runtime 能接得起來；**不證明**正式 Cloudflare 的 CPU 用量、平台配額、真實 KV／R2 的行為或 Email 投遞，那些只能靠第 3 節的驗收。

### 6. 告警處理與暫停

**已接受的殘餘風險：上限可能被濫用撐到，不只是自然成長。** 任何人都能替一個新的 userId 建立家庭並取得 token，`PUT /api/user/:id/books` 接受最大 2MB 的請求本文。每本書的書名、作者、分類與 ISBN 雖然都有長度上限（超過就拒絕寫入），封面與書籍網址也有長度上限（超過就存成空白），但光靠 2MB 的請求本文，一個帳號仍能寫入約 3MB 的資料（伺服器會替每一筆補齊省略的欄位）。這個版本之前存入的資料不會回頭修正：文字欄位要等該帳號下一次 PUT 才會被拒絕或取代，過長的網址要等該帳號下一次寫入書單才會被清成空白，公開書櫃的快照則要等下一次 PUT 或 PATCH 才會更新。有人持續灌入這類資料時，15 MB 與 5,000 筆的硬停會被撐到，期間每天的備份都會失敗：「備份成功」寄出逾期信，`latest.json` 與最後成功的那一對備份保持原樣，但不會產生新的還原點。

因此，收到「容量正常」逾期信，或「備份成功」逾期且 log 是「備份超過 15 MB 限制。」或「每日備份超過 5,000 筆資料限制。」時，**先查是不是濫用**，再判斷要不要升級：

1. 比對最後一份成功備份的 manifest 與正式 KV 現況：`prefixCounts` 裡 `family:`、`user:` 的筆數有沒有突然跳升，`lineLengths` 裡有沒有異常大的行（行的順序就是 KV 列舉順序，要知道是哪個 key，對照同名 `.jsonl` 的同一行）。正式 KV 的 key 可以用 `pnpm exec wrangler kv key list --namespace-id <正式 namespace ID> --remote --prefix "family:"` 列出來比對數量。
2. 確認是濫用就先清掉那些資料，等下一次備份恢復成功。
3. 排除濫用、確定是真的成長，才走第 7 節的升級流程。

- **「備份成功」逾期**：備份停了或失敗了。可能原因包括碰到第 1 節的上限、CPU 超過被中止、Cron 被刪、`BACKUP_ENABLED` 被關、secret 或 binding 設錯、Cloudflare 帳號問題。先看 Worker log：失敗時只記一行專案寫死的訊息（`BackupError` 的常數訊息，或「每日 KV 備份作業未完成；請檢查設定、執行限制與獨立告警。」），接著以「每日 KV 備份作業失敗。」結束這次執行，不會出現遠端的錯誤內容。如果訊息是「備份已保留，但獨立監看回報失敗。」，表示備份已經發布、只是 ping 沒送到，先到 R2 確認 `latest.json`，不要當成資料遺失。修好後可以暫時改成每小時 Cron 補跑，再改回每日。
- **只有「容量正常」逾期**：備份仍在運作，但內部請求、筆數或封存大小已達第 1 節的分界，該升級了；讀最新的 manifest 與 `kv_backup_success` log 找出是哪一項。例外是 log 出現「備份已保留，但容量正常回報失敗。」：容量其實正常，只是第二個 ping 沒送到。三項都沒達分界、log 也沒有那句時，查最近一次執行的結果（GraphQL `dimensions.status`）：是 `exceededResources` 就表示在「備份成功」ping 之後被 CPU 中止（計畫第 9 節），走第 7 節的升級流程。
- **暫停**：本機設定改 `BACKUP_ENABLED = "false"`、`crons = []` 並部署。沒有到期刪除規則，最後成功備份會一直保留；Healthchecks 會如期寄信。只有明確決定暫停保護時，才在 Healthchecks 暫停 check，恢復時一併恢復，不要用關掉通知來掩蓋故障。
- **沒有 REST 匯出工具**：舊的 `scripts/kv-backup.mjs` 已刪除，Cron Worker 是唯一的備份來源。需要額外一份備份時，暫時改成每小時 Cron 跑一次即可。

### 7. 升級到 Workers Paid

升級的觸發條件是第 1 節的分界（收到「容量正常」逾期信，或任一次 Cron 執行被中止：GraphQL `dimensions.status` 為 `exceededResources`，tail 事件 `outcome` 為 `exceededCpu`）。完整步驟見[計畫第 14 節](../docs/kv-backup-plan.md#14-升級流程改-workers-paid)，摘要：

1. 訂閱 Workers Paid（每月 US$5 起）。
2. 切換到 Paid 設定：`MAX_ARCHIVE_BYTES` 提高到 256 MiB，每筆上限 4 MiB、`MAX_SAVED_KEYS` 5,000 不變；加回每日 SHA-256 核對與下載回讀，`wrangler.backup.local.toml` 加回 `cpu_ms`。批次讀取的 25 MB 回應上限在 Paid 仍然存在，自動拆批不可移除。
3. 格式不變，仍是 version 2，manifest 多一個選填的 `sha256` 欄位，還原 CLI 讀到就額外核對。
4. 重新部署，重跑第 3 節的驗收。
5. 「容量正常」的分界改為 Paid 上限的 70%：封存 180 MB、筆數 3,500、內部請求 7,000。
