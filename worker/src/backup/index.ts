import {
  BackupError,
  classifyKey,
  encodeLine,
  PREFIXES,
  requireId,
  requireObjectPath,
} from "../../../scripts/kv-backup/format.mjs";
import type {
  ManifestV2,
  RequestCounts,
} from "../../../scripts/kv-backup/types.mjs";
import { pingCheck, requireHealthchecksUuid } from "./heartbeat";
import { MultipartWriter } from "./multipart";
import { cleanOldSnapshots, publishLatest, readLatest } from "./retention";
import {
  type BackupDependencies,
  type BackupEnv,
  isWithinCapacity,
  RunBudget,
} from "./runtime";
import { listSavedKeys, readSavedRecords, verifySourceKeys } from "./source";

export type { BackupEnv, BackupDependencies } from "./runtime";

export interface BackupRunResult {
  manifest: ManifestV2;
  manifestKey: string;
  /** True when every capacity measure was below its threshold and "容量正常" was pinged. */
  capacityOk: boolean;
  /** Final totals for the whole run, the two Healthchecks pings included. */
  requests: RequestCounts;
}

async function exportSnapshot(
  env: BackupEnv,
  key: string,
  startedAt: string,
  budget: RunBudget,
): Promise<ManifestV2> {
  const keys = await listSavedKeys(env.BACKUP_KV, budget);
  if (await budget.call(() => env.BACKUP_BUCKET.head(key)))
    throw new BackupError("此次備份名稱已存在，沒有覆寫資料。");
  const upload = await budget.call(() =>
    env.BACKUP_BUCKET.createMultipartUpload(key),
  );
  const writer = new MultipartWriter(upload, budget);
  const encoder = new TextEncoder();
  const prefixCounts: Record<string, number> = Object.fromEntries(
    PREFIXES.map((prefix) => [prefix, 0]),
  );
  const lineLengths: number[] = [];
  try {
    for await (const record of readSavedRecords(
      env.BACKUP_KV,
      keys.values(),
      budget,
    )) {
      // Expired mid-run records are never yielded; count covers written records only.
      const prefix = classifyKey(record.key);
      if (!prefix) throw new BackupError("備份包含不允許的資料類別。");
      prefixCounts[prefix]++;
      const bytes = encoder.encode(encodeLine(record));
      lineLengths.push(bytes.byteLength);
      await writer.write(bytes);
    }
    await verifySourceKeys(env.BACKUP_KV, keys, budget);
    const { byteLength, objectSize } = await writer.complete();
    if (objectSize !== byteLength)
      throw new BackupError("R2 回報的備份大小不符，沒有發布成功備份。");
    return {
      version: 2,
      sourceAccountId: env.SOURCE_ACCOUNT_ID,
      sourceNamespaceId: env.SOURCE_NAMESPACE_ID,
      startedAt,
      completedAt: new Date(budget.now()).toISOString(),
      count: lineLengths.length,
      prefixCounts,
      lineLengths,
      byteLength,
      objectSize,
      // Counts up to here: the manifest / latest / cleanup / ping calls that
      // follow are not in it; the run's final totals go to the success log.
      requests: budget.counts(),
      dataObjectPath: key,
    };
  } catch (error) {
    // A completed but unpublished object is deleted (this run's key only); an
    // incomplete upload is aborted. Cleanup is best-effort; the original error wins.
    await cleanupQuietly(
      writer.completed
        ? () => env.BACKUP_BUCKET.delete(key)
        : () => upload.abort(),
      budget,
    );
    throw error;
  }
}

async function cleanupQuietly(
  operation: () => Promise<void>,
  budget: RunBudget,
) {
  try {
    await budget.call(operation, false);
  } catch {
    // The budget may already be spent; the unpublished object is never referenced.
  }
}

async function reportHealth(
  env: BackupEnv,
  manifest: ManifestV2,
  budget: RunBudget,
  fetcher: typeof fetch | undefined,
) {
  if (!(await pingCheck(env.HEALTHCHECKS_UUID, budget, fetcher)))
    throw new BackupError("備份已保留，但獨立監看回報失敗。");
  const capacityOk = isWithinCapacity({
    internalRequests: budget.counts().internal,
    count: manifest.count,
    byteLength: manifest.byteLength,
  });
  if (
    capacityOk &&
    !(await pingCheck(env.HEALTHCHECKS_CAPACITY_UUID, budget, fetcher))
  )
    throw new BackupError("備份已保留，但容量正常回報失敗。");
  return capacityOk;
}

export async function runScheduledBackup(
  env: BackupEnv,
  deps: BackupDependencies = {},
): Promise<BackupRunResult> {
  if (env.BACKUP_ENABLED !== "true")
    throw new BackupError("每日備份尚未啟用。");
  requireId(env.SOURCE_ACCOUNT_ID);
  requireId(env.SOURCE_NAMESPACE_ID);
  requireHealthchecksUuid(env.HEALTHCHECKS_UUID);
  requireHealthchecksUuid(env.HEALTHCHECKS_CAPACITY_UUID);
  if (env.HEALTHCHECKS_UUID === env.HEALTHCHECKS_CAPACITY_UUID)
    throw new BackupError("兩個獨立備份監看必須使用不同的 UUID。");
  const budget = new RunBudget(deps);
  const startedAt = new Date(budget.now()).toISOString();
  const id = (deps.uuid ?? (() => crypto.randomUUID()))();
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
  const capacityOk = await reportHealth(env, manifest, budget, deps.fetch);
  return { manifest, manifestKey, capacityOk, requests: budget.counts() };
}

export default {
  async scheduled(_controller: ScheduledController, env: BackupEnv) {
    try {
      const result = await runScheduledBackup(env);
      console.log(
        JSON.stringify({
          event: "kv_backup_success",
          count: result.manifest.count,
          byteLength: result.manifest.byteLength,
          internalRequests: result.requests.internal,
          externalRequests: result.requests.external,
          manifestKey: result.manifestKey,
          capacityOk: result.capacityOk,
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
