import backupWorker, { runScheduledBackup } from "../../src/backup/index";
import { validateArchive } from "../../../scripts/kv-backup/format.mjs";
import { runRestore } from "../../../scripts/kv-backup/restore.mjs";
import {
  ACCOUNT,
  SOURCE,
  NOW,
  UUID,
  recordsFixture,
  fixtureClient,
  restoreOptions,
  archiveStore,
} from "../helpers/kvBackupFixtures";
import { workerFixture } from "../helpers/kvBackupWorkerFixtures";

/** Exercises real scheduled orchestration and the independent Node restore parser.
 * KV values stay in createMockKV; stream metadata/expiry are fixed boundary fixtures. */
describe("Cloudflare scheduled backup", () => {
  it("round-trips v1 data and publishes success only after R2 verification and cleanup", async () => {
    const records = recordsFixture();
    const fixture = await workerFixture(records);
    await fixture.kv.base.put("token:private", "never exported");
    const manifest = await runScheduledBackup(fixture.env, fixture.deps);
    const manifestKey = manifest.dataObjectPath.replace(
      /\.jsonl$/,
      ".manifest.json",
    );
    const bytes = Buffer.from(
      fixture.bucket.objects.get(manifest.dataObjectPath)!.bytes,
    );
    const restoredRecords = validateArchive(manifest, bytes, {
      accountId: ACCOUNT,
      namespaceId: SOURCE,
      manifestKey,
    });
    expect(restoredRecords).toEqual(records);
    expect(manifest.count).toBe(10);
    const pointer = JSON.parse(
      new TextDecoder().decode(
        fixture.bucket.objects.get("latest.json")!.bytes,
      ),
    );
    expect(pointer.manifestKey).toBe(manifestKey);
    const trace = fixture.bucket.trace;
    expect(trace.indexOf(`get:${manifest.dataObjectPath}`)).toBeLessThan(
      trace.indexOf(`put:${manifestKey}`),
    );
    expect(trace.indexOf(`put:${manifestKey}`)).toBeLessThan(
      trace.indexOf("put:latest.json"),
    );
    expect(trace.at(-1)).toBe("heartbeat");
    const store = archiveStore();
    store.objects.set(manifestKey, Buffer.from(JSON.stringify(manifest)));
    store.objects.set(manifest.dataObjectPath, bytes);
    const target = fixtureClient(records);
    await runRestore({
      ...restoreOptions(store, target.client),
      manifestKey,
      apply: true,
      confirm: async () => true,
    });
    for (const record of records)
      expect(await target.kv.get(record.key)).toBe(record.value);
    expect(await target.kv.get("token:private")).toBeNull();
  });

  it.each(["disabled", "account", "namespace", "monitor"])(
    "rejects %s configuration before any I/O",
    async (kind) => {
      const f = await workerFixture();
      if (kind === "disabled") f.env.BACKUP_ENABLED = "false";
      if (kind === "account") f.env.SOURCE_ACCOUNT_ID = "bad";
      if (kind === "namespace") f.env.SOURCE_NAMESPACE_ID = "bad";
      if (kind === "monitor")
        f.env.HEALTHCHECKS_UUID = "https://attacker.invalid/secret";
      await expect(runScheduledBackup(f.env, f.deps)).rejects.toThrow();
      expect(f.bucket.get).not.toHaveBeenCalled();
      expect(f.kv.list).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "new-key",
    "ttl",
    "missing",
    "corrupt",
    "upload",
    "manifest",
    "cleanup",
  ])("withholds the heartbeat after %s failure", async (kind) => {
    const f = await workerFixture();
    const original = f.kv.list.getMockImplementation()!;
    if (kind === "new-key" || kind === "ttl")
      f.kv.list
        .mockImplementationOnce(original)
        .mockImplementation(async () => ({
          keys:
            kind === "new-key"
              ? [
                  { name: "user:reader", expiration: undefined },
                  { name: "user:new", expiration: undefined },
                ]
              : [{ name: "user:reader", expiration: NOW / 1000 + 1000 }],
          list_complete: true,
          cacheStatus: null,
        }));
    if (kind === "missing")
      f.kv.getWithMetadata.mockResolvedValue({
        value: null,
        metadata: null,
        cacheStatus: null,
      });
    if (kind === "corrupt") {
      const get = f.bucket.get.getMockImplementation()!;
      f.bucket.get.mockImplementation(async (key) => {
        const object = await get(key);
        if (key.endsWith(".jsonl") && object) object.size++;
        return object;
      });
    }
    if (kind === "upload")
      f.bucket.createMultipartUpload.mockRejectedValue(
        new Error("private details"),
      );
    if (kind === "manifest") f.bucket.put.mockResolvedValue(null);
    if (kind === "cleanup")
      f.bucket.list.mockRejectedValue(new Error("private details"));
    await expect(runScheduledBackup(f.env, f.deps)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    if (kind !== "cleanup")
      expect(f.bucket.objects.has("latest.json")).toBe(false);
    else expect(f.bucket.objects.has("latest.json")).toBe(true);
    if (["new-key", "ttl", "missing", "corrupt"].includes(kind))
      expect(f.bucket.uploads[0].abort).toHaveBeenCalled();
  });

  it("rejects an existing unique object without overwriting it", async () => {
    const f = await workerFixture();
    const key = `snapshots/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.jsonl`;
    f.bucket.seed(key, "original");
    await expect(runScheduledBackup(f.env, f.deps)).rejects.toThrow();
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(f.bucket.objects.get(key)!.bytes)).toBe(
      "original",
    );
  });

  it("serves no public administrative route and sanitizes scheduled failures", async () => {
    expect(backupWorker.fetch().status).toBe(404);
    const f = await workerFixture();
    f.env.BACKUP_ENABLED = "false";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        backupWorker.scheduled({} as ScheduledController, f.env),
      ).rejects.toThrow("每日 KV 備份作業失敗。");
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("awaits the real scheduled handler and logs only aggregate success", async () => {
    const f = await workerFixture();
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(f.fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await backupWorker.scheduled({} as ScheduledController, f.env);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
        event: "kv_backup_success",
        count: 1,
        byteLength: 35,
      });
    } finally {
      transport.mockRestore();
      log.mockRestore();
    }
  });
});
