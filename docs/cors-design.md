# CORS 與 Preflight Cache 設計決策

> **Status**：Active｜**最後更新**：2026-05-19｜**對應 Roadmap**：[project-plan.md Phase 7 Wave H](./project-plan.md#wave-h--基礎設施驗證cors--options)

---

## Context

MooFamily Bookshelf 的 Cloudflare Worker（Hono）需要同時服務多種跨來源 client：

| Client                                  | Origin                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Chrome Extension Content Script         | 寄生於 `https://next.readmoo.com`、`https://read.readmoo.com`                                   |
| Chrome Extension Service Worker / Popup | `chrome-extension://<id>`                                                                       |
| PWA on Cloudflare Pages                 | `https://moo-family-bookshelf.pages.dev`、`*.moo-family-bookshelf.pages.dev`、`*-dev.pages.dev` |
| 本機開發                                | `localhost`（任意 port、http/https）、RFC 1918 私有 IP（LAN 手機測 PWA 用）                     |

幾個關鍵特性，使得**每一筆 API 請求都會觸發 CORS preflight**：

1. 所有 API 使用 `Authorization: Bearer <token>`，屬於 [non-simple header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header) → 強制 preflight
2. POST/PUT/PATCH 多數帶 `Content-Type: application/json` → 同樣強制 preflight
3. Worker 位於 `*.workers.dev`，與所有上述 origin 都跨來源 → 無法用 same-origin 規避

→ 若每次操作都送一輪 preflight，使用者連續操作時 OPTIONS 流量會放大 1:1。

---

## Decision

[worker/src/index.ts:68-78](../worker/src/index.ts#L68-L78) 套用 Hono `cors` middleware：

```ts
app.use("*", async (c, next) => {
  const devMode = isDevMode(c.env);
  const middleware = cors({
    origin: (origin) => (isAllowedOrigin(origin, devMode) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });
  return middleware(c, next);
});
```

- **動態 origin 驗證**：[`isAllowedOrigin`](../worker/src/index.ts#L21-L52)（精確比對 + 子網域正則 + dev gate）
- **允許方法**：全部 HTTP 方法 + OPTIONS
- **允許 header**：`Content-Type` + `Authorization`（其他 header 一律不准）
- **`maxAge`**：86400 秒（24 小時）

---

## 為何 `maxAge: 86400`

| 瀏覽器   | preflight cache 上限                                                   |
| -------- | ---------------------------------------------------------------------- |
| Chromium | 7200 秒（2 小時）                                                      |
| Firefox  | 86400 秒（24 小時）                                                    |
| Safari   | 600 秒（10 分鐘）— 但會吃 server `Access-Control-Max-Age` 直到自家上限 |

設高於瀏覽器上限**不會壞** — 瀏覽器自行取較小值。設 86400 的目的：

1. **連續操作只發一次 OPTIONS**：使用者打開 Dialog 後做書櫃管理（多次 GET / PUT），同一個 (origin, method, headers, URL) 在 cache 窗口內不重發 preflight
2. **跨瀏覽器都拿到瀏覽器各自的最大值**：對 Chromium 等於 2 小時、Firefox 等於 24 小時，皆達到「短時間內連續操作只一次」的目標
3. **降低 production Workers 請求數**：CORS preflight 也是計費請求，cache 命中可實際降低 daily request count

---

## 實測證據（2026-05-19）

### 1. Production Workers Observability（過去 7 天）

撈 `$workers.event.request.method`，filter `OPTIONS` vs `GET`：

| 方法    | 次數 |
| ------- | ---- |
| GET     | 13   |
| OPTIONS | 7    |

**最有力的單一 session 觀察**（5/19 13:50）：

```
13:50:06.898  OPTIONS /api/family/er23-htuo/borrow
13:50:07.056  GET     ...
13:50:08.961  GET     ...
13:54:08.673  GET     ...
```

→ 一次 OPTIONS 對應後續 3 次 GET，期間瀏覽器沒有重發 preflight，符合 `maxAge` cache 行為。5/15、5/16、5/17 亦觀察到相同 pattern。

### 2. 直接 curl 驗證 Response Header

```powershell
curl.exe -i -X OPTIONS https://moo-family-bookshelf.rcwork.workers.dev/api/family/x/borrow `
  -H "Origin: https://read.readmoo.com" `
  -H "Access-Control-Request-Method: GET" `
  -H "Access-Control-Request-Headers: authorization,content-type"
```

回應（節錄）：

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://read.readmoo.com
Access-Control-Allow-Headers: Content-Type,Authorization
Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
Access-Control-Max-Age: 86400
Vary: Origin, Access-Control-Request-Headers
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

> 以上實測使用舊站 `https://read.readmoo.com` 作為 Origin。讀墨書櫃已搬到新站 `https://next.readmoo.com`（路徑前綴 `/read`），兩個網域都在 allowlist 內，把上面的 `Origin` 換成 `https://next.readmoo.com` 會得到相同結構的回應（`Access-Control-Allow-Origin` 回填該 Origin）。

關鍵點：

- `Access-Control-Max-Age: 86400` ✅
- `Vary: Origin, Access-Control-Request-Headers` ✅ — cache key 正確分流，不同 origin/header 不會互相污染
- Security header（HSTS / X-Content-Type-Options / X-Frame-Options）也都掛上

---

## 拒絕的替代方案

### 1. 改用 cookie / form-encoded body 規避 preflight

**不採用**。「Simple request」要求：

- Method 限 GET / HEAD / POST
- 無 custom header（特別是 `Authorization`）
- Content-Type 限 `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain`

要符合就得：

- 把 token 從 `Authorization` 改塞 cookie → Chrome Extension 跨 origin 帶 cookie 限制多、Content Script 環境 cookie 行為與 PWA 不同 → 整套 auth 設計要重做
- JSON body 改 form-encoded → API client / worker 都得加 form parsing → DX 倒退

結論：API 設計受損遠大於少幾次 OPTIONS 的收益。

### 2. 反向代理（讓 worker 同源於 `next.readmoo.com` / `read.readmoo.com`）

**不採用**。Readmoo 網域不在我們控制範圍，無法掛 reverse proxy。

### 3. 改用其他 storage 機制（例如 Worker Cache API）快取 preflight

**不採用**。瀏覽器端 preflight cache 是 spec 行為，server 端額外 cache 沒有幫助；server 處理 OPTIONS 本身很便宜（Hono middleware 直接回 204，未進 KV）。

---

## 中期選項（非 v1.3 必做，優先級低）

申請自有 domain 將 worker 從 `*.workers.dev` 移至 `api.<own-domain>`：

- ✅ Worker 與 PWA 若都掛在同一個 apex domain 下，可以同源化 PWA ↔ API
- ❌ 對 Chrome Extension Content Script（寄生於 `next.readmoo.com` / `read.readmoo.com`）仍跨來源 → 仍需 preflight
- ❌ 需處理 domain 註冊、DNS、Cloudflare custom domain 設定，營運成本上升

→ 不是根本解，僅是中期收斂選項。觸發條件：當 `*.workers.dev` 出現信任問題（例如 ISP / 企業防火牆封鎖）、或需要把 PWA 與 API 同源時再考慮。

---

## ⚠️ 不要動的事項（防誤改）

修改 worker CORS 設定前先看這一節：

1. **不要降低 `maxAge`**
   - 沒有任何理由比 24h 短
   - 即使 spec 允許更高值，目前的 86400 已對齊 Firefox 上限；再高無實質效益但也無害
2. **不要新增 / 改動 `allowHeaders`**
   - 加 custom header（例如 `X-Client-Version`）會破壞既有 preflight cache key，使所有 client 重新觸發 preflight
   - 若真的需要新 header，應一次新增完所有預期的 header，避免分批改動造成 cache invalidation 漣漪
3. **不要把 `Authorization` 換成 custom header**
   - 失去 standard semantics（middleware、log、debug 工具都認 `Authorization`）
   - 仍會觸發 preflight，沒省到任何成本
4. **修改 `isAllowedOrigin` 必須跑 CORS 迴歸測試**
   - 既有測試在 [worker/tests/unit/securityHardening.test.ts](../worker/tests/unit/securityHardening.test.ts)（`describe("isAllowedOrigin")` + `describe("CORS headers on responses")`）
   - 新增允許的 origin 必須補對應的 allow / deny 測試 case
5. **不要把 CORS middleware 移出全域 `app.use("*", ...)`**
   - 目前掛在所有路由之前，確保 health check `/`、404、error handler 也都帶 CORS header
   - 若改成只掛 `/api/*`，瀏覽器看到 health check 失敗時可能誤判 CORS 而非實際 503

---

## 相關檔案

| 檔案                                                                                          | 用途                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------ |
| [worker/src/index.ts:21-52](../worker/src/index.ts#L21-L52)                                   | `isAllowedOrigin` — origin allowlist |
| [worker/src/index.ts:68-78](../worker/src/index.ts#L68-L78)                                   | CORS middleware 套用                 |
| [worker/tests/unit/securityHardening.test.ts](../worker/tests/unit/securityHardening.test.ts) | CORS 迴歸測試                        |
| [docs/project-plan.md](./project-plan.md)                                                     | Phase 7 Wave H 對應條目              |

---

## 變更紀錄

| 日期       | 變更                                                           |
| ---------- | -------------------------------------------------------------- |
| 2026-05-19 | 初版。Phase 7 Wave H production preflight 觀察 + curl 驗證完成 |
