import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  BackupError,
  parseJson,
  requireId,
  requireObjectPath,
  selectRestorable,
  validateArchive,
} from "./format.mjs";

async function requireEmpty(client) {
  if ((await client.listKeys()).length)
    throw new BackupError("目標 namespace 不是空白，沒有開始還原。");
}

function matches(record, actual, nowMs) {
  if (actual === null || actual === undefined) {
    return record.expiration !== undefined && record.expiration * 1000 <= nowMs;
  }
  return (
    actual.value === record.value &&
    actual.expiration === record.expiration &&
    isDeepStrictEqual(actual.metadata ?? null, record.metadata ?? null)
  );
}

export async function verifyRestored(
  client,
  records,
  { now = Date.now, sleep = delay } = {},
) {
  const deadline = now() + 60_000;
  let pending = records;
  for (let attempt = 0; attempt < 7; attempt++) {
    const mismatches = [];
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      const values = await client.readKeys(batch.map((record) => record.key));
      for (const record of batch) {
        if (
          !matches(
            record,
            Object.hasOwn(values, record.key) ? values[record.key] : undefined,
            now(),
          )
        )
          mismatches.push(record);
      }
    }
    if (!mismatches.length) return;
    pending = mismatches;
    if (now() >= deadline || attempt === 6) break;
    await sleep(Math.min(10_000, deadline - now()));
  }
  throw new BackupError(`還原讀回驗證失敗，仍有 ${pending.length} 筆不一致。`);
}

function writeBatches(records) {
  const batches = [];
  let batch = [];
  let size = 2;
  for (const record of records) {
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes > 90 * 1024 * 1024)
      throw new BackupError("單筆還原資料超過批次寫入容量限制。");
    if (batch.length === 100 || size + bytes > 90 * 1024 * 1024) {
      batches.push(batch);
      batch = [];
      size = 2;
    }
    batch.push(record);
    size += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function runRestore({
  client,
  store,
  manifestKey,
  accountId,
  sourceNamespaceId,
  targetNamespaceId,
  apply = false,
  maxWrites = 1000,
  confirm,
  now = Date.now,
  sleep = delay,
}) {
  requireId(accountId);
  requireId(sourceNamespaceId);
  requireId(targetNamespaceId);
  requireObjectPath(manifestKey, ".manifest.json");
  if (sourceNamespaceId === targetNamespaceId)
    throw new BackupError(
      "禁止寫入來源或正式 namespace，請建立新的隔離 namespace。",
    );
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1)
    throw new BackupError("--max-writes 必須為正整數。");
  const manifestBytes = await store.get(manifestKey);
  if (manifestBytes.length > 1024 * 1024)
    throw new BackupError("備份清單超過 1 MiB。");
  const manifest = parseJson(manifestBytes.toString("utf8"));
  const dataKey = manifestKey.replace(/\.manifest\.json$/, ".jsonl");
  const data = await store.get(dataKey);
  const records = validateArchive(manifest, data, {
    accountId,
    namespaceId: sourceNamespaceId,
    manifestKey,
  });
  let eligible = selectRestorable(records, now());
  if (eligible.length > maxWrites)
    throw new BackupError(
      `需要 ${eligible.length} 次寫入，超過 --max-writes ${maxWrites}；尚未寫入。`,
    );
  await requireEmpty(client);
  if (!apply)
    return {
      applied: false,
      count: eligible.length,
      skipped: records.length - eligible.length,
      manifest,
    };
  if (
    typeof confirm !== "function" ||
    (await confirm({
      targetNamespaceId,
      count: eligible.length,
      maxWrites,
    })) !== true
  ) {
    throw new BackupError("還原未經兩次確認，沒有寫入資料。");
  }
  await requireEmpty(client);
  eligible = selectRestorable(records, now());
  const batches = writeBatches(eligible);
  const written = [];
  let attempted = 0;
  try {
    for (const batch of batches) {
      const live = selectRestorable(batch, now());
      if (!live.length) continue;
      attempted += live.length;
      await client.writeRecords(live);
      written.push(...live);
    }
    await verifyRestored(client, written, { now, sleep });
    const expected = new Set(written.map((record) => record.key));
    if ((await client.listKeys()).some((entry) => !expected.has(entry.name))) {
      throw new BackupError("還原目標出現非本次寫入的資料，請停止使用此目標。");
    }
  } catch (error) {
    const detail =
      error instanceof BackupError ? error.message : "還原過程發生錯誤。";
    throw new BackupError(
      `${detail} 已確認寫入 ${written.length} 筆，最多可能寫入 ${attempted} 筆；保留隔離目標供檢查，不會自動刪除或切換正式環境。`,
    );
  }
  return {
    applied: true,
    count: written.length,
    skipped: records.length - written.length,
    manifest,
  };
}
