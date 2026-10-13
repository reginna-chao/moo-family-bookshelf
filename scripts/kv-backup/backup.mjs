import { randomUUID } from "node:crypto";
import {
  BackupError,
  MAX_ARCHIVE_BYTES,
  classifyKey,
  createArchive,
  validateArchive,
  validateRecord,
} from "./format.mjs";

export async function runBackup({
  client,
  store,
  accountId,
  namespaceId,
  now = Date.now,
  uuid = randomUUID,
}) {
  const startedAt = new Date(now()).toISOString();
  const listed = await client.listKeys();
  const selected = listed.filter((entry) => classifyKey(entry.name) !== null);
  const records = [];
  let size = 0;
  for (let offset = 0; offset < selected.length; offset += 100) {
    const batch = selected.slice(offset, offset + 100);
    const values = await client.readKeys(batch.map((entry) => entry.name));
    for (const entry of batch) {
      const result = Object.hasOwn(values, entry.name)
        ? values[entry.name]
        : undefined;
      if (!result || typeof result.value !== "string")
        throw new BackupError(
          "列舉後有資料消失或讀取失敗，這次備份已中止，請重跑。",
        );
      const record = { key: entry.name, value: result.value };
      if (result.expiration !== undefined)
        record.expiration = result.expiration;
      if (result.metadata !== undefined && result.metadata !== null)
        record.metadata = result.metadata;
      if (entry.expiration !== record.expiration)
        throw new BackupError("資料到期設定在備份期間改變，請重跑。");
      validateRecord(record);
      size += Buffer.byteLength(JSON.stringify(record)) + 1;
      if (size > MAX_ARCHIVE_BYTES)
        throw new BackupError("備份超過 256 MiB，請調整方案後再執行。");
      records.push(record);
    }
  }
  const stamp = startedAt.replace(/[:.]/g, "-");
  const objectKey = `daily/${startedAt.slice(0, 10)}/${stamp}_${uuid()}.jsonl`;
  const { manifest, data } = createArchive(records, {
    accountId,
    namespaceId,
    startedAt,
    completedAt: new Date(now()).toISOString(),
    objectKey,
  });
  const manifestKey = objectKey.replace(/\.jsonl$/, ".manifest.json");
  await store.put(objectKey, data);
  const downloaded = await store.get(objectKey);
  validateArchive(manifest, downloaded, {
    accountId,
    namespaceId,
    manifestKey,
  });
  // Only a verified data object receives a success marker.
  await store.put(manifestKey, Buffer.from(JSON.stringify(manifest) + "\n"));
  return { manifest, manifestKey };
}
