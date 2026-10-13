import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_KEYS = 100_000;
export const PREFIXES = [
  "user:",
  "family:",
  "member:",
  "verify:",
  "publicshelves:",
  "public:",
  "borrow:",
  "borrows:family:",
  "newbookdefault:",
  "kicked:",
];
const IGNORED = ["auth:", "token:", "otp:", "qr:", "verifyfail:", "ratelimit:"];
const OBJECT_PATH =
  /^(?:daily|snapshots)\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.(jsonl|manifest\.json)$/;

export class BackupError extends Error {}

export function requireId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new BackupError(
      "帳號及 namespace 必須明確指定為 32 位小寫十六進位 ID。",
    );
  }
  return value;
}

export function requireObjectPath(value, suffix) {
  if (
    typeof value !== "string" ||
    !OBJECT_PATH.test(value) ||
    !value.endsWith(suffix)
  ) {
    throw new BackupError("備份物件路徑格式不正確。");
  }
  return value;
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupError("備份或伺服器資料不是有效的 JSON。");
  }
}

export function classifyKey(key) {
  if (typeof key !== "string" || !key || Buffer.byteLength(key) > 512) {
    throw new BackupError("資料含無效的 key，已停止處理。");
  }
  const prefix = PREFIXES.find((candidate) => key.startsWith(candidate));
  if (prefix && key.length > prefix.length) return prefix;
  if (
    IGNORED.some(
      (candidate) => key.startsWith(candidate) && key.length > candidate.length,
    )
  )
    return null;
  throw new BackupError("發現未列入計畫的 key 類別，請先更新備份範圍。");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRecord(record) {
  if (
    !isObject(record) ||
    typeof record.value !== "string" ||
    Buffer.byteLength(record.value) > 25 * 1024 * 1024 ||
    Object.keys(record).some(
      (key) => !["key", "value", "expiration", "metadata"].includes(key),
    )
  ) {
    throw new BackupError("備份紀錄格式不正確或超過容量限制。");
  }
  const prefix = classifyKey(record.key);
  if (!prefix) throw new BackupError("備份含不應還原的短期憑證或計數資料。");
  if (
    record.expiration !== undefined &&
    (!Number.isSafeInteger(record.expiration) || record.expiration <= 0)
  ) {
    throw new BackupError("備份紀錄的到期時間不正確。");
  }
  if (prefix === "kicked:" && record.expiration === undefined) {
    throw new BackupError("移除成員紀錄缺少原始到期時間。");
  }
  if (prefix === "member:") {
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(record.value))
      throw new BackupError("家庭指向資料格式不正確。");
    return prefix;
  }
  const value = parseJson(record.value);
  if (prefix === "borrows:family:" ? !Array.isArray(value) : !isObject(value)) {
    throw new BackupError("備份紀錄的 JSON 類型不符合現有儲存格式。");
  }
  if (
    prefix === "public:" &&
    value.expiresAt !== null &&
    (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0)
  ) {
    throw new BackupError("公開書櫃缺少有效的原始到期設定。");
  }
  return prefix;
}

function summarize(records) {
  if (!records.length || records.length > MAX_KEYS)
    throw new BackupError("備份為空或 key 數量超過工具上限。");
  const seen = new Set();
  const counts = Object.fromEntries(PREFIXES.map((prefix) => [prefix, 0]));
  for (const record of records) {
    const prefix = validateRecord(record);
    if (seen.has(record.key)) throw new BackupError("備份包含重複 key。");
    seen.add(record.key);
    counts[prefix]++;
  }
  return counts;
}

export function checksum(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function createArchive(
  records,
  { accountId, namespaceId, startedAt, completedAt, objectKey },
) {
  const prefixCounts = summarize(records);
  const data = Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  if (data.length > MAX_ARCHIVE_BYTES)
    throw new BackupError("備份超過 256 MiB，請調整方案後再執行。");
  const manifest = {
    version: 1,
    sourceAccountId: requireId(accountId),
    sourceNamespaceId: requireId(namespaceId),
    startedAt,
    completedAt,
    count: records.length,
    prefixCounts,
    sha256: checksum(data),
    byteLength: data.length,
    dataObjectPath: requireObjectPath(objectKey, ".jsonl"),
  };
  return { manifest, data };
}

export function validateArchive(
  manifest,
  data,
  { accountId, namespaceId, manifestKey },
) {
  requireId(accountId);
  requireId(namespaceId);
  requireObjectPath(manifestKey, ".manifest.json");
  if (
    !isObject(manifest) ||
    manifest.version !== 1 ||
    manifest.sourceAccountId !== accountId ||
    manifest.sourceNamespaceId !== namespaceId ||
    manifest.dataObjectPath !==
      manifestKey.replace(/\.manifest\.json$/, ".jsonl") ||
    !Number.isFinite(Date.parse(manifest.startedAt)) ||
    !Number.isFinite(Date.parse(manifest.completedAt)) ||
    Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)
  ) {
    throw new BackupError("備份版本、來源或時間資訊不符合設定。");
  }
  if (
    !Buffer.isBuffer(data) ||
    data.length > MAX_ARCHIVE_BYTES ||
    manifest.byteLength !== data.length ||
    manifest.sha256 !== checksum(data)
  ) {
    throw new BackupError("備份大小或 SHA-256 驗證失敗，沒有寫入任何資料。");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new BackupError("備份不是有效的 UTF-8。");
  }
  if (!text.endsWith("\n")) throw new BackupError("JSONL 備份缺少完整結尾。");
  const records = text.slice(0, -1).split("\n").map(parseJson);
  const counts = summarize(records);
  if (
    manifest.count !== records.length ||
    !isDeepStrictEqual(counts, manifest.prefixCounts)
  ) {
    throw new BackupError("備份筆數或分類筆數驗證失敗。");
  }
  return records;
}

export function selectRestorable(records, nowMs) {
  return records.filter((record) => {
    if (
      record.expiration !== undefined &&
      record.expiration * 1000 <= nowMs + 60_000
    )
      return false;
    if (record.key.startsWith("public:")) {
      const { expiresAt } = parseJson(record.value);
      if (expiresAt !== null && expiresAt <= nowMs + 60_000) return false;
    }
    return true;
  });
}
