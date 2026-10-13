import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  BackupError,
  classifyKey,
  PREFIXES,
  requireId,
  requireObjectPath,
} from "../../../scripts/kv-backup/format.mjs";
import type { Manifest } from "../../../scripts/kv-backup/types.mjs";
import { requireHealthchecksUuid, reportSuccess } from "./heartbeat";
import { MultipartWriter, verifyObject } from "./multipart";
import { cleanOldSnapshots, publishLatest, readLatest } from "./retention";
import { type BackupDependencies, type BackupEnv, RunBudget } from "./runtime";
import { listSavedKeys, readRecord, verifySourceKeys } from "./source";

export type { BackupEnv, BackupDependencies } from "./runtime";

async function exportSnapshot(
  env: BackupEnv,
  key: string,
  startedAt: string,
  budget: RunBudget,
): Promise<Manifest> {
  const keys = await listSavedKeys(env.BACKUP_KV, budget);
  if (await budget.call(() => env.BACKUP_BUCKET.head(key)))
    throw new BackupError("此次備份名稱已存在，沒有覆寫資料。");
  const upload = await budget.call(() =>
    env.BACKUP_BUCKET.createMultipartUpload(key),
  );
  const writer = new MultipartWriter(upload, budget);
  const prefixCounts: Record<string, number> = Object.fromEntries(
    PREFIXES.map((prefix) => [prefix, 0]),
  );
  let written = 0;
  try {
    for (const entry of keys.values()) {
      const record = await readRecord(env.BACKUP_KV, entry, budget);
      // Expired mid-run: skip it; count and prefixCounts cover written records only.
      if (!record) continue;
      const prefix = classifyKey(record.key);
      if (!prefix) throw new BackupError("備份包含不允許的資料類別。");
      prefixCounts[prefix]++;
      written++;
      await writer.write(Buffer.from(JSON.stringify(record) + "\n"));
    }
    await verifySourceKeys(env.BACKUP_KV, keys, budget);
    const integrity = await writer.complete();
    await verifyObject(env.BACKUP_BUCKET, key, integrity, budget);
    return {
      version: 1,
      sourceAccountId: env.SOURCE_ACCOUNT_ID,
      sourceNamespaceId: env.SOURCE_NAMESPACE_ID,
      startedAt,
      completedAt: new Date(budget.now()).toISOString(),
      count: written,
      prefixCounts,
      ...integrity,
      dataObjectPath: key,
    };
  } catch (error) {
    // A completed but unverified object is deleted (this run's key only); an
    // incomplete upload is aborted. Cleanup is best-effort; the original error wins.
    if (writer.completed) await deleteQuietly(env.BACKUP_BUCKET, key, budget);
    else await upload.abort().catch(() => undefined);
    throw error;
  }
}

async function deleteQuietly(bucket: R2Bucket, key: string, budget: RunBudget) {
  try {
    await budget.call(() => bucket.delete(key), false);
  } catch {
    // The budget may already be spent; the unpublished object is never referenced.
  }
}

export async function runScheduledBackup(
  env: BackupEnv,
  deps: BackupDependencies = {},
): Promise<Manifest> {
  if (env.BACKUP_ENABLED !== "true")
    throw new BackupError("每日備份尚未啟用。");
  requireId(env.SOURCE_ACCOUNT_ID);
  requireId(env.SOURCE_NAMESPACE_ID);
  requireHealthchecksUuid(env.HEALTHCHECKS_UUID);
  const budget = new RunBudget(deps);
  const startedAt = new Date(budget.now()).toISOString();
  const id = (deps.uuid ?? randomUUID)();
  const key = requireObjectPath(
    `snapshots/${startedAt.slice(0, 10)}/${startedAt.replace(/[:.]/g, "-")}_${id}.jsonl`,
    ".jsonl",
  );
  const previous = await readLatest(env.BACKUP_BUCKET, budget);
  const manifest = await exportSnapshot(env, key, startedAt, budget);
  const manifestKey = key.replace(/\.jsonl$/, ".manifest.json");
  const written = await budget.call(
    () =>
      env.BACKUP_BUCKET.put(manifestKey, JSON.stringify(manifest), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      }),
    false,
  );
  if (!written) throw new BackupError("此次備份名稱已存在，沒有發布成功備份。");
  await publishLatest(
    env.BACKUP_BUCKET,
    previous,
    manifestKey,
    manifest,
    budget,
  );
  await cleanOldSnapshots(env.BACKUP_BUCKET, budget);
  await reportSuccess(env.HEALTHCHECKS_UUID, budget, deps.fetch);
  return manifest;
}

export default {
  async scheduled(_controller: ScheduledController, env: BackupEnv) {
    try {
      const manifest = await runScheduledBackup(env);
      console.log(
        JSON.stringify({
          event: "kv_backup_success",
          count: manifest.count,
          byteLength: manifest.byteLength,
        }),
      );
    } catch (error) {
      // BackupError messages are repo-authored constants; nothing else is logged.
      console.error(
        error instanceof BackupError
          ? error.message
          : "每日 KV 備份作業未完成；請檢查設定、執行限制與獨立告警。",
      );
      throw new Error("每日 KV 備份作業失敗。");
    }
  },
  fetch() {
    return new Response("找不到此資源。", { status: 404 });
  },
} satisfies ExportedHandler<BackupEnv>;
