import { setTimeout as delay } from "node:timers/promises";
import { BackupError, MAX_KEYS, parseJson, requireId } from "./format.mjs";

class ApiError extends BackupError {
  constructor(status) {
    super(`Cloudflare API 請求失敗（HTTP ${status}），未輸出伺服器原始內容。`);
    this.status = status;
  }
}

async function responseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024)
      throw new BackupError("API 回應超過 100 MiB。");
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

export function createKvClient({
  accountId,
  namespaceId,
  token,
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
}) {
  requireId(accountId);
  requireId(namespaceId);
  if (typeof token !== "string" || !token.trim())
    throw new BackupError("缺少 KV API token。");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
  let lastRequestAt = -Infinity;

  async function request(path, { method = "GET", body, retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, lastRequestAt + 500 - now()));
      lastRequestAt = now();
      let response;
      try {
        response = await fetchImpl(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
      } catch {
        if (!retry || attempt >= 3)
          throw new BackupError("Cloudflare API 連線失敗或逾時。");
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (
          !retry ||
          attempt >= 3 ||
          (response.status !== 429 && response.status < 500)
        )
          throw new ApiError(response.status);
        const header = response.headers.get("retry-after");
        const parsed = header === null ? 0 : Number(header);
        const retryMs = Number.isFinite(parsed)
          ? parsed * 1000
          : Date.parse(header) - now();
        const wait = Math.max(
          1000 * 2 ** attempt,
          Number.isFinite(retryMs) ? retryMs : 0,
        );
        if (wait > 60_000)
          throw new BackupError("API 要求等候超過 60 秒，請稍後重跑。");
        await sleep(wait);
        continue;
      }
      let payload;
      try {
        payload = await responseJson(response);
      } catch {
        throw new BackupError("Cloudflare API 回應不完整或格式不正確。");
      }
      if (
        !payload ||
        payload.success !== true ||
        (Array.isArray(payload.errors) && payload.errors.length)
      ) {
        throw new BackupError("Cloudflare API 回報操作失敗。");
      }
      return payload;
    }
  }

  async function listKeys() {
    const keys = [];
    const cursors = new Set();
    const names = new Set();
    let cursor = "";
    do {
      const params = new URLSearchParams({ limit: "1000" });
      if (cursor) params.set("cursor", cursor);
      const payload = await request(`/keys?${params}`);
      if (!Array.isArray(payload.result) || payload.result.length > 1000)
        throw new BackupError("KV 列舉回應格式不正確。");
      for (const key of payload.result) {
        if (!key || typeof key.name !== "string" || names.has(key.name))
          throw new BackupError("KV 列舉出現無效或重複 key。");
        names.add(key.name);
        keys.push(key);
      }
      if (keys.length > MAX_KEYS)
        throw new BackupError("KV key 數超過工具上限。");
      cursor = payload.result_info?.cursor;
      if (typeof cursor !== "string" || (cursor && cursors.has(cursor)))
        throw new BackupError("KV 分頁游標重複或格式不正確。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return keys;
  }

  async function readKeys(keys) {
    if (!keys.length || keys.length > 100)
      throw new BackupError("每次 KV 批次讀取必須為 1 至 100 筆。");
    let payload;
    try {
      payload = await request("/bulk/get", {
        method: "POST",
        body: { keys, type: "text", withMetadata: true },
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 413 ||
        keys.length === 1
      )
        throw error;
      const middle = Math.ceil(keys.length / 2);
      return {
        ...(await readKeys(keys.slice(0, middle))),
        ...(await readKeys(keys.slice(middle))),
      };
    }
    const values = payload.result?.values;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new BackupError("KV 批次讀取回應格式不正確。");
    return values;
  }

  async function writeRecords(records) {
    if (
      !records.length ||
      records.length > 100 ||
      Buffer.byteLength(JSON.stringify(records)) > 90 * 1024 * 1024
    ) {
      throw new BackupError("KV 批次寫入超過工具限制。");
    }
    // A failed write may already have consumed quota. Never automatically retry it.
    const payload = await request("/bulk", {
      method: "PUT",
      body: records,
      retry: false,
    });
    const result = payload.result;
    if (
      !result ||
      result.successful_key_count !== records.length ||
      !Array.isArray(result.unsuccessful_keys) ||
      result.unsuccessful_keys.length
    ) {
      throw new BackupError(
        "KV 批次寫入未完整成功；目標可能已有部分資料，請勿直接重跑。",
      );
    }
  }
  return { listKeys, readKeys, writeRecords };
}
