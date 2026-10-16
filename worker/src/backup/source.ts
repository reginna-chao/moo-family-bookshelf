import {
  BackupError,
  classifyKey,
  MAX_KEYS,
  validateRecordShape,
} from "../../../scripts/kv-backup/format.mjs";
import type {
  BackupRecord,
  ListedKey,
} from "../../../scripts/kv-backup/types.mjs";
import {
  MAX_SAVED_KEYS,
  MAX_VALUE_BYTES,
  READ_BATCH_SIZE,
  RunBudget,
} from "./runtime";

type BatchEntry = KVNamespaceGetWithMetadataResult<string, unknown>;
type BatchResult = [ListedKey, BatchEntry | undefined][];

const TOO_LARGE = Symbol("batch response too large");
const encoder = new TextEncoder();

export async function listSavedKeys(kv: KVNamespace, budget: RunBudget) {
  const saved = new Map<string, ListedKey>();
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await budget.call(() => kv.list({ limit: 1000, cursor }));
    if (!Array.isArray(page.keys) || typeof page.list_complete !== "boolean")
      throw new BackupError("KV 列舉回應格式錯誤。");
    for (const key of page.keys) {
      const prefix = classifyKey(key.name);
      if (seen.has(key.name)) throw new BackupError("KV 列舉含重複資料。");
      seen.add(key.name);
      if (seen.size > MAX_KEYS)
        throw new BackupError("KV 列舉超過資料筆數限制。");
      if (!prefix) continue;
      if (
        key.expiration !== undefined &&
        (!Number.isSafeInteger(key.expiration) || key.expiration <= 0)
      )
        throw new BackupError("KV 列舉含無效到期時間。");
      saved.set(key.name, { name: key.name, expiration: key.expiration });
      if (saved.size > MAX_SAVED_KEYS)
        throw new BackupError("每日備份超過 5,000 筆資料限制。");
    }
    if (page.list_complete) break;
    cursor = page.cursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
      throw new BackupError("KV 列舉分頁資訊不正確。");
    cursors.add(cursor);
  }
  if (!saved.size) throw new BackupError("KV 備份資料為空，已停止此次作業。");
  return saved;
}

/**
 * Reads the listed keys in listing order, READ_BATCH_SIZE names per batch
 * call, and yields one record per key still present. A listed key whose own
 * TTL has passed is skipped; any other missing value fails the run.
 */
export async function* readSavedRecords(
  kv: KVNamespace,
  keys: Iterable<ListedKey>,
  budget: RunBudget,
): AsyncGenerator<BackupRecord> {
  const listed = [...keys];
  for (let offset = 0; offset < listed.length; offset += READ_BATCH_SIZE) {
    const batch = listed.slice(offset, offset + READ_BATCH_SIZE);
    for (const [key, entry] of await readBatch(kv, batch, budget)) {
      const record = toRecord(key, entry, budget);
      if (record) yield record;
    }
  }
}

function isResponseTooLarge(error: unknown) {
  // Unverified: the binding's 413 error shape is not pinned; match the status in its message.
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.includes("413");
}

async function fetchBatch(kv: KVNamespace, batch: ListedKey[]) {
  try {
    const names = batch.map((key) => key.name);
    return await kv.getWithMetadata<unknown>(names, "text");
  } catch (error) {
    if (isResponseTooLarge(error)) return TOO_LARGE;
    throw error;
  }
}

// A 413 splits at once; any other failure splits after the budget's one retry.
async function readBatch(
  kv: KVNamespace,
  batch: ListedKey[],
  budget: RunBudget,
): Promise<BatchResult> {
  const outcome = await budget.attempt(() => fetchBatch(kv, batch));
  if (outcome.ok && outcome.value !== TOO_LARGE) {
    const values = outcome.value;
    if (!(values instanceof Map))
      throw new BackupError("KV 批次讀取回應格式錯誤。");
    return batch.map((key) => [key, values.get(key.name)]);
  }
  if (batch.length === 1)
    throw new BackupError("單筆 KV 資料讀取失敗，已停止此次作業。");
  const middle = Math.ceil(batch.length / 2);
  const first = await readBatch(kv, batch.slice(0, middle), budget);
  return [...first, ...(await readBatch(kv, batch.slice(middle), budget))];
}

function toRecord(
  key: ListedKey,
  entry: BatchEntry | undefined,
  budget: RunBudget,
): BackupRecord | null {
  const value = entry?.value ?? null;
  if (value === null) {
    // A listed key whose own TTL has passed expired benignly; anything else vanished.
    if (hasExpired(key, budget)) return null;
    throw new BackupError("已列舉的 KV 資料不存在。");
  }
  if (typeof value !== "string")
    throw new BackupError("KV 批次讀取回應格式錯誤。");
  if (exceedsValueLimit(value))
    throw new BackupError("單筆 KV 資料超過 4 MiB 備份限制。");
  const record: BackupRecord = { key: key.name, value };
  if (key.expiration !== undefined) record.expiration = key.expiration;
  if (entry?.metadata !== null && entry?.metadata !== undefined)
    record.metadata = entry.metadata;
  validateRecordShape(record);
  return record;
}

// UTF-8 needs 1-3 bytes per UTF-16 unit, so only a borderline value is encoded to measure it.
function exceedsValueLimit(value: string) {
  if (value.length > MAX_VALUE_BYTES) return true;
  if (value.length * 3 <= MAX_VALUE_BYTES) return false;
  return encoder.encode(value).byteLength > MAX_VALUE_BYTES;
}

export async function verifySourceKeys(
  kv: KVNamespace,
  initial: Map<string, ListedKey>,
  budget: RunBudget,
) {
  const current = await listSavedKeys(kv, budget);
  const appeared = [...current.keys()].some((name) => !initial.has(name));
  const changed = [...initial].some(([name, entry]) => {
    const listed = current.get(name);
    if (listed) return listed.expiration !== entry.expiration;
    return !hasExpired(entry, budget);
  });
  if (appeared || changed)
    throw new BackupError("備份期間資料清單或到期時間改變，沒有發布成功備份。");
}

function hasExpired(key: ListedKey, budget: RunBudget) {
  return key.expiration !== undefined && key.expiration * 1000 <= budget.now();
}
