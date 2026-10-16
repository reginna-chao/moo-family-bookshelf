import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

// Restore-side download bound (old v1 archives included); the backup Worker's
// own limit is MAX_ARCHIVE_BYTES in worker/src/backup/runtime.ts.
export const MAX_RESTORE_ARCHIVE_BYTES = 256 * 1024 * 1024;
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
const RECORD_FIELDS = ["key", "value", "expiration", "metadata"];
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

/**
 * The checks the backup Worker can afford per record: shape, saved prefix,
 * expiration sanity and the `member:` format. Never parses the value.
 */
export function validateRecordShape(record) {
  if (
    !isObject(record) ||
    typeof record.value !== "string" ||
    Object.keys(record).some((key) => !RECORD_FIELDS.includes(key))
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
  if (prefix === "member:" && !/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(record.value)) {
    throw new BackupError("家庭指向資料格式不正確。");
  }
  return prefix;
}

/** Full restore-side validation: {@link validateRecordShape} plus the value's JSON type per prefix. */
export function validateRecord(record) {
  const prefix = validateRecordShape(record);
  if (Buffer.byteLength(record.value) > 25 * 1024 * 1024)
    throw new BackupError("備份紀錄格式不正確或超過容量限制。");
  if (prefix === "member:") return prefix;
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

// Everything before the raw value; the writer and the v2 reader build it identically.
function linePrefix({ key, expiration, metadata }) {
  let prefix = '{"key":' + JSON.stringify(key);
  if (expiration !== undefined)
    prefix += ',"expiration":' + JSON.stringify(expiration);
  if (metadata !== null && metadata !== undefined)
    prefix += ',"metadata":' + JSON.stringify(metadata);
  return prefix + ',"value":';
}

/**
 * One version-2 JSONL line, `\n` included. Fields in fixed order (`key`,
 * optional `expiration`, optional `metadata`, then `value` LAST). The value is
 * the raw KV text embedded verbatim — never parsed or re-serialised — except a
 * `member:` value, a bare string, which is wrapped as a JSON string literal.
 */
export function encodeLine(record) {
  const value = record.key.startsWith("member:")
    ? JSON.stringify(record.value)
    : record.value;
  return linePrefix(record) + value + "}\n";
}

/**
 * Decodes one archive line into `{ key, value, expiration?, metadata? }`.
 * Version 1: the line (no `\n`) is a JSON record whose value is a string.
 * Version 2: the line (`\n` included) must start with exactly the prefix
 * {@link encodeLine} writes; the raw value text is sliced out verbatim, and a
 * `member:` value is unwrapped back to its original bare string.
 */
export function decodeLine(line, version) {
  if (version === 1) return parseJson(line);
  if (version !== 2 || typeof line !== "string" || !line.endsWith("}\n"))
    throw new BackupError("備份資料行格式不正確。");
  const parsed = parseJson(line);
  if (
    !isObject(parsed) ||
    typeof parsed.key !== "string" ||
    !Object.hasOwn(parsed, "value") ||
    Object.keys(parsed).some((key) => !RECORD_FIELDS.includes(key))
  )
    throw new BackupError("備份資料行格式不正確。");
  const record = { key: parsed.key };
  if (Object.hasOwn(parsed, "expiration"))
    record.expiration = parsed.expiration;
  if (Object.hasOwn(parsed, "metadata")) record.metadata = parsed.metadata;
  const prefix = linePrefix(record);
  if (!line.startsWith(prefix)) throw new BackupError("備份資料行格式不正確。");
  const raw = line.slice(prefix.length, -2);
  if (!record.key.startsWith("member:")) {
    record.value = raw;
    return record;
  }
  const value = parseJson(raw);
  if (typeof value !== "string")
    throw new BackupError("家庭指向資料格式不正確。");
  record.value = value;
  return record;
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

/** SHA-256 of a version-1 archive; version 2 carries no checksum. */
export function checksum(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Builds a version-2 archive `{ manifest, data }` with {@link encodeLine}, the
 * same layout the backup Worker writes. CLI / test use only.
 */
export function createArchive(
  records,
  {
    accountId,
    namespaceId,
    startedAt,
    completedAt,
    objectKey,
    requests = { internal: 0, external: 0 },
  },
) {
  const prefixCounts = summarize(records);
  const lines = records.map((record) => Buffer.from(encodeLine(record)));
  const data = Buffer.concat(lines);
  if (data.length > MAX_RESTORE_ARCHIVE_BYTES)
    throw new BackupError("備份超過 256 MiB，請調整方案後再執行。");
  const manifest = {
    version: 2,
    sourceAccountId: requireId(accountId),
    sourceNamespaceId: requireId(namespaceId),
    startedAt,
    completedAt,
    count: records.length,
    prefixCounts,
    lineLengths: lines.map((line) => line.length),
    byteLength: data.length,
    objectSize: data.length,
    requests,
    dataObjectPath: requireObjectPath(objectKey, ".jsonl"),
  };
  return { manifest, data };
}

function isCount(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BackupError("備份不是有效的 UTF-8。");
  }
}

function readVersion1(manifest, data) {
  if (
    manifest.byteLength !== data.length ||
    manifest.sha256 !== checksum(data)
  ) {
    throw new BackupError("備份大小或 SHA-256 驗證失敗，沒有寫入任何資料。");
  }
  const text = decodeUtf8(data);
  if (!text.endsWith("\n")) throw new BackupError("JSONL 備份缺少完整結尾。");
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => decodeLine(line, 1));
}

function readVersion2(manifest, data) {
  const { lineLengths, requests } = manifest;
  if (
    !Array.isArray(lineLengths) ||
    lineLengths.length !== manifest.count ||
    !lineLengths.every((length) => isCount(length, 1)) ||
    lineLengths.reduce((sum, length) => sum + length, 0) !==
      manifest.byteLength ||
    manifest.byteLength !== data.length ||
    manifest.objectSize !== manifest.byteLength ||
    !isObject(requests) ||
    !isCount(requests.internal, 0) ||
    !isCount(requests.external, 0)
  ) {
    throw new BackupError("備份大小或每筆長度驗證失敗，沒有寫入任何資料。");
  }
  const records = [];
  let offset = 0;
  for (const length of lineLengths) {
    const line = decodeUtf8(data.subarray(offset, offset + length));
    offset += length;
    records.push(decodeLine(line, 2));
  }
  return records;
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
    (manifest.version !== 1 && manifest.version !== 2) ||
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
  if (!Buffer.isBuffer(data) || data.length > MAX_RESTORE_ARCHIVE_BYTES)
    throw new BackupError("備份大小驗證失敗，沒有寫入任何資料。");
  const records =
    manifest.version === 1
      ? readVersion1(manifest, data)
      : readVersion2(manifest, data);
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
