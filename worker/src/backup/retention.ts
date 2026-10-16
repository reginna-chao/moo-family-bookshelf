import {
  BackupError,
  requireObjectPath,
} from "../../../scripts/kv-backup/format.mjs";
import type { Manifest } from "../../../scripts/kv-backup/types.mjs";
import { readBounded, RunBudget } from "./runtime";

export interface LatestBackup {
  manifestKey: string;
  completedAt: string;
  sourceAccountId: string;
  sourceNamespaceId: string;
}

export interface LatestState {
  pointer: LatestBackup;
  etag: string;
}
const RETENTION_MS = 14 * 24 * 60 * 60_000;

export async function readLatest(
  bucket: R2Bucket,
  budget: RunBudget,
): Promise<LatestState | null> {
  return budget.call(async () => {
    const object = await bucket.get("latest.json");
    if (!object) return null;
    const bytes = await readBounded(object.body, 4096, budget);
    const pointer: LatestBackup = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    requireObjectPath(pointer.manifestKey, ".manifest.json");
    if (
      !pointer.manifestKey.startsWith("snapshots/") ||
      !Number.isFinite(Date.parse(pointer.completedAt))
    )
      throw new BackupError("最後成功備份資訊不正確，已停止處理。");
    return { pointer, etag: object.etag };
  });
}

export async function publishLatest(
  bucket: R2Bucket,
  previous: LatestState | null,
  manifestKey: string,
  manifest: Manifest,
  budget: RunBudget,
) {
  const pointer: LatestBackup = {
    manifestKey,
    completedAt: manifest.completedAt,
    sourceAccountId: manifest.sourceAccountId,
    sourceNamespaceId: manifest.sourceNamespaceId,
  };
  if (
    previous &&
    (Date.parse(previous.pointer.completedAt) >=
      Date.parse(manifest.startedAt) ||
      previous.pointer.sourceAccountId !== manifest.sourceAccountId ||
      previous.pointer.sourceNamespaceId !== manifest.sourceNamespaceId)
  )
    throw new BackupError("最後成功備份較新或來源不同，沒有覆寫。");
  const result = await budget.call(
    () =>
      bucket.put("latest.json", JSON.stringify(pointer), {
        onlyIf: previous
          ? { etagMatches: previous.etag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      }),
    false,
  );
  if (!result)
    throw new BackupError("另一個備份已完成，沒有覆寫最後成功備份。");
}

function isOldSnapshot(object: R2Object, cutoff: number) {
  if (
    !object.key.startsWith("snapshots/") ||
    object.uploaded.getTime() >= cutoff
  )
    return false;
  try {
    requireObjectPath(
      object.key,
      object.key.endsWith(".manifest.json") ? ".manifest.json" : ".jsonl",
    );
    const day = object.key.split("/")[1];
    return Date.parse(day + "T23:59:59.999Z") < cutoff;
  } catch {
    return false;
  }
}

export async function cleanOldSnapshots(bucket: R2Bucket, budget: RunBudget) {
  const cutoff = budget.now() - RETENTION_MS;
  const latest = await readLatest(bucket, budget);
  if (!latest) throw new BackupError("最後成功備份資訊遺失，沒有刪除舊備份。");
  const protectedKeys = new Set([
    latest.pointer.manifestKey,
    latest.pointer.manifestKey.replace(/\.manifest\.json$/, ".jsonl"),
  ]);
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await budget.call(() =>
      bucket.list({ prefix: "snapshots/", cursor, limit: 1000 }),
    );
    const deletions = page.objects
      .filter(
        (object) =>
          !protectedKeys.has(object.key) && isOldSnapshot(object, cutoff),
      )
      .map((object) => object.key);
    if (deletions.length) await budget.call(() => bucket.delete(deletions));
    if (!page.truncated) return;
    cursor = page.cursor;
    if (!cursor || cursors.has(cursor))
      throw new BackupError("R2 清理分頁資訊不正確。");
    cursors.add(cursor);
  }
  throw new BackupError("舊備份清理超過本次上限，請檢查儲存用量。");
}
