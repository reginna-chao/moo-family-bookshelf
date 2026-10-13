import { createHash } from "node:crypto";
import {
  BackupError,
  classifyKey,
  MAX_KEYS,
  validateRecord,
} from "../../../scripts/kv-backup/format.mjs";
import type {
  BackupRecord,
  ListedKey,
} from "../../../scripts/kv-backup/types.mjs";
import {
  MAX_SAVED_KEYS,
  MAX_VALUE_BYTES,
  readBounded,
  RunBudget,
} from "./runtime";

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
      const fingerprint = createHash("sha256").update(key.name).digest("hex");
      if (seen.has(fingerprint)) throw new BackupError("KV 列舉含重複資料。");
      seen.add(fingerprint);
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

export async function readRecord(
  kv: KVNamespace,
  key: ListedKey,
  budget: RunBudget,
): Promise<BackupRecord> {
  const result = await budget.call(async () => {
    const entry = await kv.getWithMetadata(key.name, "stream");
    if (!entry.value) throw new BackupError("已列舉的 KV 資料不存在。");
    const bytes = await readBounded(entry.value, MAX_VALUE_BYTES, budget);
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const record: BackupRecord = { key: key.name, value };
    if (key.expiration !== undefined) record.expiration = key.expiration;
    if (entry.metadata !== null) record.metadata = entry.metadata;
    validateRecord(record);
    return record;
  });
  return result;
}

export async function verifySourceKeys(
  kv: KVNamespace,
  initial: Map<string, ListedKey>,
  budget: RunBudget,
) {
  const current = await listSavedKeys(kv, budget);
  if (
    current.size !== initial.size ||
    [...initial].some(
      ([name, entry]) =>
        !current.has(name) ||
        current.get(name)?.expiration !== entry.expiration,
    )
  )
    throw new BackupError("備份期間資料清單或到期時間改變，沒有發布成功備份。");
}
