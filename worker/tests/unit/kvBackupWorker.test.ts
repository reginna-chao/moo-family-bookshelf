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
 * KV values stay in createMockKV; stream metadata/expiry are fixed boundary fixtures.
 *
 * Mid-run TTL expiry: the shared mock never expires keys, so `expireOnRead` models
 * Cloudflare dropping a listed key — `getWithMetadata` answers a null value and, when
 * `vanish` is set, the key is deleted from the store so the re-listing no longer
 * carries it. A key whose listed `expiration` is at or before `now` expired benignly
 * and is skipped; any other null value is data that vanished and fails the run.
 *
 * Failure messages are asserted exactly (`failure()`): `RunBudget.call` now rethrows
 * an inner BackupError unchanged, so each failure surfaces with its own constant. */

const DATA_KEY = `snapshots/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.jsonl`;
const PAST = NOW / 1000 - 60;
const CLOUDFLARE = "Cloudflare 備份操作失敗，已停止此次作業。";
const CHANGED = "備份期間資料清單或到期時間改變，沒有發布成功備份。";
const MISSING = "已列舉的 KV 資料不存在。";
const RUN_FAILED = "每日 KV 備份作業失敗。";
const UNFINISHED = "每日 KV 備份作業未完成；請檢查設定、執行限制與獨立告警。";

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

type Fixture = Awaited<ReturnType<typeof workerFixture>>;

function expireOnRead(f: Fixture, name: string, vanish: boolean) {
  const read = f.kv.getWithMetadata.getMockImplementation()!;
  f.kv.getWithMetadata.mockImplementation(async (key: string) => {
    if (key !== name) return read(key);
    if (vanish) await f.kv.base.delete(key);
    return { value: null, metadata: null, cacheStatus: null };
  });
}

function expectNothingPublished(f: Fixture) {
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.bucket.put).not.toHaveBeenCalled();
  expect(f.bucket.objects.has("latest.json")).toBe(false);
  expect(
    [...f.bucket.objects.keys()].filter((key) =>
      key.endsWith(".manifest.json"),
    ),
  ).toEqual([]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    ["new-key", CHANGED],
    ["ttl", CHANGED],
    ["missing", MISSING],
    ["corrupt", "R2 備份不存在或大小不符。"],
    ["upload", CLOUDFLARE],
    ["manifest", "此次備份名稱已存在，沒有發布成功備份。"],
    ["cleanup", CLOUDFLARE],
  ])("withholds the heartbeat after %s failure", async (kind, message) => {
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
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(message);
    expect(error.message).not.toContain("private details");
    expect(f.fetcher).not.toHaveBeenCalled();
    if (kind !== "cleanup")
      expect(f.bucket.objects.has("latest.json")).toBe(false);
    else expect(f.bucket.objects.has("latest.json")).toBe(true);
    if (kind === "corrupt") {
      // A completed but unverified object is deleted (this run's key only), never aborted.
      expect(f.bucket.remove).toHaveBeenCalledOnce();
      expect(f.bucket.remove).toHaveBeenCalledWith(DATA_KEY);
      expect(f.bucket.objects.has(DATA_KEY)).toBe(false);
      expect(f.bucket.uploads[0].abort).not.toHaveBeenCalled();
    } else expect(f.bucket.remove).not.toHaveBeenCalled();
    if (["new-key", "ttl", "missing"].includes(kind))
      expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
  });

  it("rejects an existing unique object without overwriting it", async () => {
    const f = await workerFixture();
    f.bucket.seed(DATA_KEY, "original");
    await expect(runScheduledBackup(f.env, f.deps)).rejects.toThrow();
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(f.bucket.objects.get(DATA_KEY)!.bytes),
    ).toBe("original");
  });

  it("serves no public administrative route and logs a BackupError by its own message", async () => {
    expect(backupWorker.fetch().status).toBe(404);
    const f = await workerFixture();
    f.env.BACKUP_ENABLED = "false";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await failure(
      backupWorker.scheduled({} as ScheduledController, f.env),
    );
    expect(error.message).toBe(RUN_FAILED);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("每日備份尚未啟用。");
  });

  it("logs the Cloudflare constant, never the remote error text, when a KV call keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await workerFixture();
    f.kv.list.mockRejectedValue(new Error("kv secret detail"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = failure(
      backupWorker.scheduled({} as ScheduledController, f.env),
    );
    await vi.advanceTimersByTimeAsync(500);
    const error = await pending;
    expect(error.message).toBe(RUN_FAILED);
    expect(f.kv.list).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(CLOUDFLARE);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("logs only the fixed constant when a non-BackupError escapes the run", async () => {
    const f = await workerFixture();
    Object.defineProperty(f.env, "BACKUP_KV", {
      get() {
        throw new TypeError("binding secret detail");
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await failure(
      backupWorker.scheduled({} as ScheduledController, f.env),
    );
    expect(error.message).toBe(RUN_FAILED);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(UNFINISHED);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
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

describe("TTL expiry during a scheduled backup", () => {
  const kept = [
    { key: "user:reader", value: "{}" },
    { key: "family:abcd-1234", value: '{"members":[]}' },
  ];

  it.each([
    ["absent from the re-listing", true, PAST],
    ["still listed with the same past expiration", false, PAST],
    ["expiring exactly at the run's clock", true, NOW / 1000],
  ])(
    "skips a key %s and counts only the written records",
    async (_case, vanish, expiration) => {
      const f = await workerFixture([
        ...kept,
        { key: "public:gone", value: '{"expiresAt":null}', expiration },
      ]);
      expireOnRead(f, "public:gone", vanish);
      const manifest = await runScheduledBackup(f.env, f.deps);
      expect(f.kv.list).toHaveBeenCalledTimes(2);
      expect(manifest.count).toBe(2);
      expect(manifest.prefixCounts).toMatchObject({
        "user:": 1,
        "family:": 1,
        "public:": 0,
      });
      expect(
        Object.values(manifest.prefixCounts).reduce((a, b) => a + b, 0),
      ).toBe(2);
      const bytes = Buffer.from(f.bucket.objects.get(DATA_KEY)!.bytes);
      expect(bytes.toString("utf8").trimEnd().split("\n")).toHaveLength(2);
      const manifestKey = DATA_KEY.replace(/\.jsonl$/, ".manifest.json");
      expect(
        validateArchive(manifest, bytes, {
          accountId: ACCOUNT,
          namespaceId: SOURCE,
          manifestKey,
        }),
      ).toEqual(kept);
      expect(f.bucket.objects.has("latest.json")).toBe(true);
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["a future expiration", NOW / 1000 + 60],
    ["no expiration", undefined],
  ])(
    "fails the run when a listed key with %s reads back empty",
    async (_case, expiration) => {
      const f = await workerFixture([
        ...kept,
        { key: "public:gone", value: '{"expiresAt":null}', expiration },
      ]);
      expireOnRead(f, "public:gone", true);
      const error = await failure(runScheduledBackup(f.env, f.deps));
      expect(error.message).toBe(MISSING);
      expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
      expectNothingPublished(f);
    },
  );

  it("fails the run when an initial key vanished from the re-listing before its expiration", async () => {
    const f = await workerFixture([
      ...kept,
      {
        key: "public:gone",
        value: '{"expiresAt":null}',
        expiration: NOW / 1000 + 60,
      },
    ]);
    const original = f.kv.list.getMockImplementation()!;
    f.kv.list.mockImplementationOnce(original).mockImplementation(async () => {
      const page = await original();
      return {
        ...page,
        keys: page.keys.filter(({ name }) => name !== "public:gone"),
      };
    });
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(CHANGED);
    expectNothingPublished(f);
  });

  it("fails the run when a key appears only in the re-listing", async () => {
    const f = await workerFixture(kept);
    const original = f.kv.list.getMockImplementation()!;
    f.kv.list.mockImplementationOnce(original).mockImplementation(async () => {
      const page = await original();
      return {
        ...page,
        keys: [...page.keys, { name: "user:late", expiration: undefined }],
      };
    });
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(CHANGED);
    expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
    expectNothingPublished(f);
  });

  it("refuses an empty backup and publishes nothing when every listed key expired", async () => {
    const f = await workerFixture([
      { key: "public:gone", value: '{"expiresAt":null}', expiration: PAST },
      { key: "kicked:abcd-1234:former", value: "{}", expiration: PAST },
    ]);
    expireOnRead(f, "public:gone", true);
    const read = f.kv.getWithMetadata.getMockImplementation()!;
    f.kv.getWithMetadata.mockImplementation(async (key: string) =>
      key === "kicked:abcd-1234:former"
        ? { value: null, metadata: null, cacheStatus: null }
        : read(key),
    );
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("不能完成空白備份。");
    const upload = f.bucket.uploads[0];
    expect(upload.complete).not.toHaveBeenCalled();
    expect(upload.abort).toHaveBeenCalledOnce();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(f.bucket.objects.has(DATA_KEY)).toBe(false);
    expectNothingPublished(f);
  });
});

describe("cleanup after a failed export", () => {
  function corruptReadBack(f: Fixture, onRead: () => void = () => undefined) {
    const get = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key: string) => {
      const object = await get(key);
      if (key.endsWith(".jsonl") && object) {
        onRead();
        object.size++;
      }
      return object;
    });
  }

  it("surfaces the original error and withholds the heartbeat when the delete rejects", async () => {
    const f = await workerFixture();
    corruptReadBack(f);
    f.bucket.remove.mockRejectedValue(new Error("delete secret detail"));
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("R2 備份不存在或大小不符。");
    expect(f.bucket.remove).toHaveBeenCalledOnce();
    expect(f.bucket.remove).toHaveBeenCalledWith(DATA_KEY);
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expect(f.bucket.uploads[0].abort).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });

  it("surfaces the original error when the run budget is already spent before the delete", async () => {
    let now = NOW;
    const f = await workerFixture();
    f.deps.now = () => now;
    corruptReadBack(f, () => {
      now = NOW + 13 * 60_000;
    });
    const error = await failure(runScheduledBackup(f.env, f.deps));
    // The read-back fails first; the spent budget only refuses the cleanup delete.
    expect(error.message).toBe("R2 備份不存在或大小不符。");
    expect(f.bucket.uploads[0].complete).toHaveBeenCalledOnce();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(f.bucket.uploads[0].abort).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });

  it("aborts rather than deletes when R2 rejects the multipart completion", async () => {
    const f = await workerFixture();
    const create = f.bucket.createMultipartUpload.getMockImplementation()!;
    f.bucket.createMultipartUpload.mockImplementation(async (key: string) => {
      const upload = await create(key);
      upload.complete.mockRejectedValue(new Error("complete secret detail"));
      return upload;
    });
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(CLOUDFLARE);
    expect(f.bucket.uploads[0].complete).toHaveBeenCalledOnce();
    expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });
});
