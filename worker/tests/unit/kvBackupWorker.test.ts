import backupWorker, { runScheduledBackup } from "../../src/backup/index";
import { encodeLine } from "../../../scripts/kv-backup/format.mjs";
import { runRestore } from "../../../scripts/kv-backup/restore.mjs";
import {
  ACCOUNT,
  CAPACITY_UUID,
  FORMATTED_USER,
  NOW,
  SOURCE,
  UUID,
  archiveStore,
  fixtureClient,
  recordsFixture,
  restoreOptions,
  type RecordFixture,
} from "../helpers/kvBackupFixtures";
import {
  CAPACITY_PING,
  RUN_DATA_KEY as DATA_KEY,
  RUN_MANIFEST_KEY as MANIFEST_KEY,
  SUCCESS_PING,
  expectNothingPublished,
  failure,
  pingedUrls,
  publishedArchive,
  workerFixture,
} from "../helpers/kvBackupWorkerFixtures";

/**
 * Drives the real `runScheduledBackup` / `scheduled()` orchestration against
 * the shared `createMockKV()` store (through `workerKv`) and a byte-faithful R2
 * fake, then reads the result back with the independent Node restore parser.
 *
 * Round trip: the archive is version 2 — raw KV text embedded verbatim, so a
 * pretty-printed `user:` value keeps its literal newlines (lines are sliced by
 * `lineLengths`, not by `\n`), while a `member:` value is wrapped as a JSON
 * string on the way out and unwrapped to the bare `abcd-1234` on restore.
 *
 * Mid-run TTL expiry: the shared mock never expires keys, so `expireOnRead`
 * models Cloudflare dropping a listed key — the batch read answers a null value
 * and, with `vanish`, the key is deleted so the re-listing no longer carries
 * it. A key whose listed `expiration` is at or before the run clock expired
 * benignly and is skipped; any other null value is data that vanished.
 *
 * Failure messages are asserted exactly: each BackupError is a repo-authored
 * constant, and `scheduled()` logs nothing else (see
 * `kvBackupErrorMessages.test.ts`).
 */

const PAST = NOW / 1000 - 60;
const CLOUDFLARE = "Cloudflare 備份操作失敗，已停止此次作業。";
const CHANGED = "備份期間資料清單或到期時間改變，沒有發布成功備份。";
const MISSING = "已列舉的 KV 資料不存在。";
const SIZE = "R2 回報的備份大小不符，沒有發布成功備份。";
const RUN_FAILED = "每日 KV 備份作業失敗。";
const UNFINISHED = "每日 KV 備份作業未完成；請檢查設定、執行限制與獨立告警。";

type Fixture = Awaited<ReturnType<typeof workerFixture>>;

async function backupThenRestore(records: RecordFixture[]) {
  const f = await workerFixture(records);
  const result = await runScheduledBackup(f.env, f.deps);
  const archive = publishedArchive(f.bucket);
  const store = archiveStore();
  store.objects.set(MANIFEST_KEY, Buffer.from(f.bucket.text(MANIFEST_KEY)));
  store.objects.set(DATA_KEY, archive.data);
  const target = fixtureClient(records);
  await runRestore({
    ...restoreOptions(store, target.client),
    manifestKey: MANIFEST_KEY,
    apply: true,
    confirm: async () => true,
  });
  return { f, result, archive, target };
}

function relistWith(f: Fixture, keys: { name: string; expiration?: number }[]) {
  const original = f.kv.list.getMockImplementation()!;
  f.kv.list.mockImplementationOnce(original).mockImplementation(async () => ({
    keys,
    list_complete: true,
    cacheStatus: null,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runScheduledBackup", () => {
  it("round-trips every saved category through a v2 archive, then publishes and pings in order", async () => {
    const records = [...recordsFixture(), FORMATTED_USER];
    const f = await workerFixture(records);
    await f.kv.base.put("token:private", "never exported");
    const result = await runScheduledBackup(f.env, f.deps);
    expect(result.manifestKey).toBe(MANIFEST_KEY);
    expect(result.capacityOk).toBe(true);
    expect(result.manifest).toMatchObject({
      version: 2,
      sourceAccountId: ACCOUNT,
      sourceNamespaceId: SOURCE,
      count: records.length,
      dataObjectPath: DATA_KEY,
    });
    const archive = publishedArchive(f.bucket);
    expect(archive.manifest).toEqual(result.manifest);
    expect(archive.records).toEqual(records);
    expect(archive.data.toString("utf8")).not.toContain("token:private");
    expect(f.bucket.trace).toEqual([
      "get:latest.json",
      `complete:${DATA_KEY}`,
      `put:${MANIFEST_KEY}`,
      "put:latest.json",
      "get:latest.json",
      `ping:${SUCCESS_PING}`,
      `ping:${CAPACITY_PING}`,
    ]);
    expect(f.bucket.put).toHaveBeenCalledWith(
      MANIFEST_KEY,
      expect.any(String),
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
    );
    expect(f.bucket.put).toHaveBeenCalledWith(
      "latest.json",
      expect.any(String),
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
    );
    expect(JSON.parse(f.bucket.text("latest.json"))).toEqual({
      manifestKey: MANIFEST_KEY,
      completedAt: new Date(NOW).toISOString(),
      sourceAccountId: ACCOUNT,
      sourceNamespaceId: SOURCE,
    });
  });

  it("restores a member: pointer as exactly abcd-1234, wrapped as a JSON string only inside the archive", async () => {
    const member = { key: "member:reader", value: "abcd-1234" };
    const { archive, target } = await backupThenRestore([
      { key: "user:reader", value: "{}" },
      member,
    ]);
    expect(archive.data.toString("utf8")).toContain(
      '{"key":"member:reader","value":"abcd-1234"}\n',
    );
    expect(archive.records.find((r) => r.key === member.key)?.value).toBe(
      "abcd-1234",
    );
    const restored = await target.kv.get(member.key);
    expect(restored).toBe("abcd-1234");
    expect(restored).not.toBe('"abcd-1234"');
  });

  it("keeps a pretty-printed user: value with literal newlines byte-identical through backup and restore", async () => {
    const spaced = { key: "user:spaced", value: '{ "a" :1 ,  "b":[ ] }' };
    const { result, archive, target } = await backupThenRestore([
      FORMATTED_USER,
      spaced,
    ]);
    const text = archive.data.toString("utf8");
    expect(FORMATTED_USER.value).toContain("\n");
    expect(text).toContain(`"value":${FORMATTED_USER.value}}\n`);
    expect(text.split("\n").length - 1).toBeGreaterThan(result.manifest.count);
    expect(result.manifest.lineLengths).toEqual([
      Buffer.byteLength(encodeLine(FORMATTED_USER)),
      Buffer.byteLength(encodeLine(spaced)),
    ]);
    for (const record of [FORMATTED_USER, spaced])
      expect(await target.kv.get(record.key)).toBe(record.value);
  });

  it.each([
    ["disabled", "每日備份尚未啟用。"],
    ["account", "帳號及 namespace 必須明確指定為 32 位小寫十六進位 ID。"],
    ["namespace", "帳號及 namespace 必須明確指定為 32 位小寫十六進位 ID。"],
    ["success-monitor", "獨立備份監看尚未設定完成。"],
    ["capacity-monitor", "獨立備份監看尚未設定完成。"],
    ["same-monitor", "兩個獨立備份監看必須使用不同的 UUID。"],
  ])("rejects %s configuration before any I/O", async (kind, message) => {
    const f = await workerFixture();
    if (kind === "disabled") f.env.BACKUP_ENABLED = "false";
    if (kind === "account") f.env.SOURCE_ACCOUNT_ID = "bad";
    if (kind === "namespace") f.env.SOURCE_NAMESPACE_ID = "bad";
    if (kind === "success-monitor")
      f.env.HEALTHCHECKS_UUID = "https://attacker.invalid/secret";
    if (kind === "capacity-monitor")
      f.env.HEALTHCHECKS_CAPACITY_UUID = "not-a-uuid";
    if (kind === "same-monitor") f.env.HEALTHCHECKS_CAPACITY_UUID = UUID;
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(message);
    expect(f.bucket.get).not.toHaveBeenCalled();
    expect(f.kv.list).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("accepts two different valid monitor UUIDs (positive companion of the preflight)", async () => {
    const f = await workerFixture();
    expect(f.env.HEALTHCHECKS_CAPACITY_UUID).toBe(CAPACITY_UUID);
    await expect(runScheduledBackup(f.env, f.deps)).resolves.toBeDefined();
  });

  it.each([
    ["a key appearing in the re-listing", "new-key", CHANGED],
    ["an expiration changing in the re-listing", "ttl", CHANGED],
    ["a listed key reading back empty", "missing", MISSING],
    ["R2 reporting a different object size", "size", SIZE],
    ["the multipart upload failing to start", "upload", CLOUDFLARE],
    [
      "the manifest name already being taken",
      "manifest",
      "此次備份名稱已存在，沒有發布成功備份。",
    ],
    ["the old-snapshot cleanup failing", "cleanup", CLOUDFLARE],
  ])("withholds both pings after %s", async (_case, kind, message) => {
    const f = await workerFixture();
    if (kind === "new-key")
      relistWith(f, [{ name: "user:reader" }, { name: "user:new" }]);
    if (kind === "ttl")
      relistWith(f, [{ name: "user:reader", expiration: NOW / 1000 + 1000 }]);
    if (kind === "missing") f.kv.expireOnRead("user:reader", false);
    if (kind === "size") f.bucket.faults.sizeSkew = 1;
    if (kind === "upload")
      f.bucket.createMultipartUpload.mockRejectedValue(
        new Error("private details"),
      );
    if (kind === "manifest") f.bucket.put.mockResolvedValueOnce(null);
    if (kind === "cleanup")
      f.bucket.list.mockRejectedValue(new Error("private details"));
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(message);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.bucket.objects.has("latest.json")).toBe(kind === "cleanup");
    if (kind === "size") {
      expect(f.bucket.remove.mock.calls).toEqual([[DATA_KEY]]);
      expect(f.bucket.uploads[0].abort).not.toHaveBeenCalled();
    } else expect(f.bucket.remove).not.toHaveBeenCalled();
    if (["new-key", "ttl", "missing"].includes(kind))
      expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
  });

  it("rejects an existing unique object without overwriting it", async () => {
    const f = await workerFixture();
    f.bucket.seed(DATA_KEY, "original");
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("此次備份名稱已存在，沒有覆寫資料。");
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(f.bucket.text(DATA_KEY)).toBe("original");
  });

  it("refuses an empty backup before any upload when nothing saved is listed", async () => {
    const f = await workerFixture([]);
    await f.kv.base.put("token:private", "transient");
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("KV 備份資料為空，已停止此次作業。");
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });
});

describe("latest.json compare-and-swap during a run", () => {
  const oldManifest = `snapshots/2026-09-01/2026-09-01T03-17-00-000Z_${UUID}.manifest.json`;
  const oldData = oldManifest.replace(".manifest.json", ".jsonl");
  const pointer = (overrides: Record<string, string> = {}) =>
    JSON.stringify({
      manifestKey: oldManifest,
      completedAt: "2026-09-01T03:18:00.000Z",
      sourceAccountId: ACCOUNT,
      sourceNamespaceId: SOURCE,
      ...overrides,
    });

  it("replaces an older latest.json of the same source by ETag and prunes the now-unprotected old pair", async () => {
    const f = await workerFixture();
    f.bucket.seed("latest.json", pointer());
    const etag = f.bucket.objects.get("latest.json")!.etag;
    for (const key of [oldManifest, oldData])
      f.bucket.seed(key, "x", new Date("2026-09-01"));
    await runScheduledBackup(f.env, f.deps);
    expect(f.bucket.put).toHaveBeenCalledWith(
      "latest.json",
      expect.any(String),
      expect.objectContaining({ onlyIf: { etagMatches: etag } }),
    );
    expect(JSON.parse(f.bucket.text("latest.json")).manifestKey).toBe(
      MANIFEST_KEY,
    );
    expect(f.bucket.remove.mock.calls).toEqual([[[oldManifest, oldData]]]);
    expect(f.bucket.objects.has(DATA_KEY)).toBe(true);
    expect(pingedUrls(f.fetcher)).toEqual([SUCCESS_PING, CAPACITY_PING]);
  });

  it.each([
    ["a newer", { completedAt: new Date(NOW).toISOString() }],
    ["another account's", { sourceAccountId: "d".repeat(32) }],
    ["another namespace's", { sourceNamespaceId: "d".repeat(32) }],
  ])(
    "does not overwrite %s latest.json and sends no ping",
    async (_case, overrides) => {
      const f = await workerFixture();
      f.bucket.seed("latest.json", pointer(overrides));
      const before = f.bucket.text("latest.json");
      const error = await failure(runScheduledBackup(f.env, f.deps));
      expect(error.message).toBe("最後成功備份較新或來源不同，沒有覆寫。");
      expect(f.bucket.text("latest.json")).toBe(before);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("keeps a concurrent winner's latest.json when the conditional put loses", async () => {
    const f = await workerFixture();
    const winner = pointer({ completedAt: "2026-10-13T03:17:30.000Z" });
    f.bucket.faults.onComplete = () => f.bucket.seed("latest.json", winner);
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("另一個備份已完成，沒有覆寫最後成功備份。");
    expect(f.bucket.text("latest.json")).toBe(winner);
    expect(f.bucket.remove).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("Healthchecks reporting after a published backup", () => {
  it("keeps the backup but fails the run when the success ping never answers OK", async () => {
    const f = await workerFixture();
    f.fetcher.mockImplementation(
      async () => new Response("no", { status: 500 }),
    );
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("備份已保留，但獨立監看回報失敗。");
    expect(pingedUrls(f.fetcher)).toEqual([
      SUCCESS_PING,
      SUCCESS_PING,
      SUCCESS_PING,
    ]);
    expect(JSON.parse(f.bucket.text("latest.json")).manifestKey).toBe(
      MANIFEST_KEY,
    );
  });

  it("fails the run with its own message when only the capacity ping never answers OK", async () => {
    const f = await workerFixture();
    f.fetcher.mockImplementation(async (url) =>
      String(url) === SUCCESS_PING
        ? new Response("OK")
        : new Response("no", { status: 500 }),
    );
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("備份已保留，但容量正常回報失敗。");
    expect(pingedUrls(f.fetcher)).toEqual([
      SUCCESS_PING,
      CAPACITY_PING,
      CAPACITY_PING,
      CAPACITY_PING,
    ]);
    expect(f.bucket.objects.has("latest.json")).toBe(true);
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
      f.kv.expireOnRead("public:gone", vanish);
      const { manifest } = await runScheduledBackup(f.env, f.deps);
      expect(f.kv.list).toHaveBeenCalledTimes(2);
      expect(manifest.count).toBe(2);
      expect(manifest.lineLengths).toHaveLength(2);
      expect(manifest.prefixCounts).toMatchObject({
        "user:": 1,
        "family:": 1,
        "public:": 0,
      });
      expect(publishedArchive(f.bucket).records).toEqual(kept);
      expect(pingedUrls(f.fetcher)).toEqual([SUCCESS_PING, CAPACITY_PING]);
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
      f.kv.expireOnRead("public:gone", true);
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
    relistWith(f, [{ name: "user:reader" }, { name: "family:abcd-1234" }]);
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
    f.kv.expireOnRead("public:gone", true);
    f.kv.expireOnRead("kicked:abcd-1234:former", false);
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
  it("deletes only this run's completed object, never aborting, when R2 misreports its size", async () => {
    const f = await workerFixture();
    f.bucket.faults.sizeSkew = -1;
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(SIZE);
    expect(f.bucket.uploads[0].complete).toHaveBeenCalledOnce();
    expect(f.bucket.remove.mock.calls).toEqual([[DATA_KEY]]);
    expect(f.bucket.objects.has(DATA_KEY)).toBe(false);
    expect(f.bucket.uploads[0].abort).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });

  it("surfaces the original error when the delete rejects, without retrying it", async () => {
    const f = await workerFixture();
    f.bucket.faults.sizeSkew = 1;
    f.bucket.remove.mockRejectedValue(new Error("delete secret detail"));
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(SIZE);
    expect(f.bucket.remove.mock.calls).toEqual([[DATA_KEY]]);
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });

  it("surfaces the original error when the run budget is already spent before the delete", async () => {
    let now = NOW;
    const f = await workerFixture();
    f.deps.now = () => now;
    f.bucket.faults.sizeSkew = 1;
    f.bucket.faults.onComplete = () => {
      now = NOW + 13 * 60_000;
    };
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(SIZE);
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

  it("surfaces the original error when the abort itself rejects", async () => {
    const f = await workerFixture([{ key: "user:reader", value: "{}" }]);
    relistWith(f, [{ name: "user:reader" }, { name: "user:late" }]);
    const create = f.bucket.createMultipartUpload.getMockImplementation()!;
    f.bucket.createMultipartUpload.mockImplementation(async (key: string) => {
      const upload = await create(key);
      upload.abort.mockRejectedValue(new Error("abort secret detail"));
      return upload;
    });
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe(CHANGED);
    expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
    expectNothingPublished(f);
  });
});

describe("scheduled()", () => {
  it("serves no public administrative route", () => {
    expect(backupWorker.fetch().status).toBe(404);
  });

  it("awaits the run and logs only the fixed aggregate success JSON", async () => {
    const f = await workerFixture();
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(f.fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await backupWorker.scheduled({} as ScheduledController, f.env);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: "kv_backup_success",
      count: 1,
      byteLength: Buffer.byteLength(
        encodeLine({ key: "user:reader", value: "{}" }),
      ),
      internalRequests: 12,
      externalRequests: 2,
      manifestKey: expect.stringMatching(
        /^snapshots\/\d{4}-\d{2}-\d{2}\/[^/]+\.manifest\.json$/,
      ),
      capacityOk: true,
    });
  });

  it("logs a BackupError by its own message and nothing else", async () => {
    const f = await workerFixture();
    f.env.BACKUP_ENABLED = "false";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const thrown = await failure(
      backupWorker.scheduled({} as ScheduledController, f.env),
    );
    expect(thrown.message).toBe(RUN_FAILED);
    expect(error.mock.calls).toEqual([["每日備份尚未啟用。"]]);
    expect(log).not.toHaveBeenCalled();
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
    expect(log.mock.calls).toEqual([[CLOUDFLARE]]);
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
    expect(log.mock.calls).toEqual([[UNFINISHED]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
