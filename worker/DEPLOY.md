# 自建後端部署指南

將 Worker 部署到你自己的 Cloudflare 帳號，完全掌控資料。

## 前置需求

- [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)（免費方案即可）
- Node.js 20+
- pnpm 9+

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

### 5. 部署

```bash
pnpm deploy
```

部署完成後會顯示你的 Worker URL，例如：

```
https://moo-family-bookshelf.YOUR_SUBDOMAIN.workers.dev
```

### 6. 設定 Extension / PWA 使用自訂端點

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
> - **per-userId 速率限制**（例如加入家庭每小時 10 次）
>
> 這代表 PWA 登入驗證（PIN／圖形／驗證碼）少了暴力破解的煞車；再加上 dev 模式下 CORS 放寬、`/api/_docs` 對外開放，**開啟 `DEV_MODE=1` 的 Worker 絕對不能存放真實家庭資料**，請只用在測試用的 KV Namespace。

## 更新

```bash
git pull origin main
cd worker
pnpm install
pnpm deploy
```
