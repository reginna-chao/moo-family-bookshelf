import { encodeLine } from "../../../scripts/kv-backup/format.mjs";
import { runScheduledBackup } from "../../src/backup/index";
import {
  CAPACITY_UUID,
  UUID,
  type RecordFixture,
} from "../helpers/kvBackupFixtures";
import {
  CAPACITY_PING,
  RUN_MANIFEST_KEY,
  SUCCESS_PING,
  expectNothingPublished,
  failure,
  pingedUrls,
  publishedArchive,
  workerFixture,
} from "../helpers/kvBackupWorkerFixtures";

/**
 * End-to-end capacity and adaptive-split behaviour of `runScheduledBackup`
 * (docs/kv-backup-plan.md §5 steps 3 / 5 / 11, §9, §13), against the shared
 * `createMockKV()` store wrapped by `workerKv` and the byte-faithful R2 fake.
 *
 * Request accounting. With a fixed clock and no prior latest.json, a run makes
 * these internal requests: 1 latest.json read, one per listing page, 1 head,
 * 1 createMultipartUpload, one per batch attempt, one per re-listing page, one
 * per uploaded part, 1 complete — that is `manifest.requests`. Publishing then
 * adds 4 (manifest put, latest.json put, cleanup's latest.json read, cleanup
 * list; nothing old to delete), which the final `result.requests` includes and
 * the capacity rule measures. So tiny data in one part and one listing page is
 * `manifest = 7 + batch attempts`, `final = manifest + 4`.
 *
 * Request-count boundary: listing pages are forced down to one key each, so n
 * keys cost 2n listing requests; n = 343 gives a final count of exactly 699,
 * and one transient batch failure (one retry) turns it into exactly 700.
 *
 * Capacity rows each push ONE measure to its threshold with the other two far
 * below it. The success ping is always sent; "容量正常" only when all three are
 * strictly below (`isWithinCapacity`).
 */

const tiny = (n: number): RecordFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `user:k${String(i).padStart(4, "0")}`,
    value: "{}",
  }));
const padded = (key: string, length: number): RecordFixture => ({
  key,
  value: `{"p":"${"x".repeat(length)}"}`,
});
const lineBytes = (record: RecordFixture) =>
  Buffer.byteLength(encodeLine(record));

/** Three records whose encoded archive is exactly `total` bytes. */
function archiveOf(total: number) {
  const big = [padded("user:a", 3_300_000), padded("user:b", 3_300_000)];
  const fixed = big.reduce((sum, record) => sum + lineBytes(record), 0);
  return [
    ...big,
    padded("user:c", total - fixed - lineBytes(padded("user:c", 0))),
  ];
}

type Fixture = Awaited<ReturnType<typeof workerFixture>>;

function pageOneKeyAtATime(f: Fixture) {
  const original = f.kv.list.getMockImplementation()!;
  f.kv.list.mockImplementation((options) => original({ ...options, limit: 1 }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adaptive batch split during a scheduled backup", () => {
  it("halves on 413 down to batches that fit, keeps listing order, and counts every attempt", async () => {
    const records = tiny(100);
    const f = await workerFixture(records);
    f.kv.failBatch((names) =>
      names.length > 25
        ? new Error("KV GET failed: 413 Payload Too Large")
        : undefined,
    );
    const result = await runScheduledBackup(f.env, f.deps);
    expect(f.kv.batchSizes()).toEqual([100, 50, 25, 25, 50, 25, 25]);
    expect(publishedArchive(f.bucket).records).toEqual(records);
    expect(result.manifest.requests).toEqual({ internal: 14, external: 0 });
    expect(result.requests).toEqual({ internal: 18, external: 2 });
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expect(pingedUrls(f.fetcher)).toEqual([SUCCESS_PING, CAPACITY_PING]);
  });

  it("retries a non-413 batch failure once after 500 ms, then halves it", async () => {
    const records = tiny(100);
    const f = await workerFixture(records);
    f.kv.failBatch((names) =>
      names.length > 50 ? new Error("connection reset") : undefined,
    );
    const result = await runScheduledBackup(f.env, f.deps);
    expect(f.kv.batchSizes()).toEqual([100, 100, 50, 50]);
    expect(f.deps.sleep.mock.calls).toEqual([[500]]);
    expect(result.manifest.requests.internal).toBe(11);
    expect(result.requests.internal).toBe(15);
    expect(publishedArchive(f.bucket).records).toEqual(records);
  });

  it.each([
    ["a 413", new Error("413")],
    ["a transient error", new Error("connection reset")],
  ])(
    "aborts the upload and publishes nothing when one key keeps failing with %s",
    async (_case, error) => {
      const f = await workerFixture(tiny(3));
      f.kv.failBatch((names) =>
        names.includes("user:k0001") ? error : undefined,
      );
      const rejection = await failure(runScheduledBackup(f.env, f.deps));
      expect(rejection.message).toBe("單筆 KV 資料讀取失敗，已停止此次作業。");
      expect(f.kv.batchSizes().at(-1)).toBe(1);
      expect(f.bucket.uploads[0].abort).toHaveBeenCalledOnce();
      expect(f.bucket.uploads[0].complete).not.toHaveBeenCalled();
      expect(f.bucket.remove).not.toHaveBeenCalled();
      expectNothingPublished(f);
    },
  );
});

describe("capacity ping after a published backup", () => {
  it("pings both checks in order, empty POSTs to two different UUIDs, when every measure is below", async () => {
    const f = await workerFixture(tiny(3));
    const result = await runScheduledBackup(f.env, f.deps);
    expect(result.capacityOk).toBe(true);
    expect(UUID).not.toBe(CAPACITY_UUID);
    expect(
      f.fetcher.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        init?.body,
      ]),
    ).toEqual([
      [SUCCESS_PING, "POST", ""],
      [CAPACITY_PING, "POST", ""],
    ]);
    expect(result.requests).toEqual({ internal: 12, external: 2 });
    expect(result.manifest.requests).toEqual({ internal: 8, external: 0 });
  });

  it.each([
    [9_999_999, true],
    [10_000_000, false],
  ])(
    "treats an archive of %i bytes (3 keys, few requests) as capacityOk=%s",
    async (total, ok) => {
      const f = await workerFixture(archiveOf(total));
      const result = await runScheduledBackup(f.env, f.deps);
      expect(result.manifest.byteLength).toBe(total);
      expect(result.manifest.count).toBe(3);
      expect(result.requests.internal).toBeLessThan(50);
      expect(result.capacityOk).toBe(ok);
      expect(pingedUrls(f.fetcher)).toEqual(
        ok ? [SUCCESS_PING, CAPACITY_PING] : [SUCCESS_PING],
      );
      expect(JSON.parse(f.bucket.text("latest.json")).manifestKey).toBe(
        RUN_MANIFEST_KEY,
      );
    },
  );

  it.each([
    [false, 699, true],
    [true, 700, false],
  ])(
    "with 343 tiny keys paged one per listing request (transient retry: %s) counts %i internal requests, capacityOk=%s",
    async (retry, internal, ok) => {
      const f = await workerFixture(tiny(343));
      pageOneKeyAtATime(f);
      let failed = !retry;
      f.kv.failBatch(() =>
        failed ? undefined : ((failed = true), new Error("blip")),
      );
      const result = await runScheduledBackup(f.env, f.deps);
      expect(result.requests.internal).toBe(internal);
      expect(result.manifest.requests.internal).toBe(internal - 4);
      expect(result.manifest.count).toBe(343);
      expect(result.capacityOk).toBe(ok);
      expect(pingedUrls(f.fetcher)).toEqual(
        ok ? [SUCCESS_PING, CAPACITY_PING] : [SUCCESS_PING],
      );
      expect(f.bucket.objects.has("latest.json")).toBe(true);
    },
  );

  it.each([
    [3499, true],
    [3500, false],
  ])(
    "treats %i tiny keys (small archive, few requests) as capacityOk=%s",
    async (n, ok) => {
      const f = await workerFixture(tiny(n));
      const result = await runScheduledBackup(f.env, f.deps);
      expect(result.manifest.count).toBe(n);
      expect(result.manifest.byteLength).toBeLessThan(200_000);
      expect(result.requests.internal).toBe(52);
      expect(result.capacityOk).toBe(ok);
      expect(pingedUrls(f.fetcher)).toEqual(
        ok ? [SUCCESS_PING, CAPACITY_PING] : [SUCCESS_PING],
      );
      expect(f.bucket.objects.has("latest.json")).toBe(true);
    },
  );
});

describe("hard caps of the Free profile", () => {
  it("refuses more than 5,000 saved keys before any upload", async () => {
    const f = await workerFixture(tiny(5001));
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("每日備份超過 5,000 筆資料限制。");
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });

  it("stops at 15,000,000 archive bytes, aborts the upload and publishes nothing", async () => {
    const records = ["a", "b", "c", "d"].map((id) =>
      padded(`user:${id}`, 3_800_000),
    );
    const f = await workerFixture(records);
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("備份超過 15 MB 限制。");
    const upload = f.bucket.uploads[0];
    expect(upload.uploadPart).toHaveBeenCalledTimes(2);
    expect(upload.complete).not.toHaveBeenCalled();
    expect(upload.abort).toHaveBeenCalledOnce();
    expectNothingPublished(f);
  });

  it("stops past 1,000 internal requests and publishes nothing", async () => {
    const f = await workerFixture(tiny(500));
    pageOneKeyAtATime(f);
    const error = await failure(runScheduledBackup(f.env, f.deps));
    expect(error.message).toBe("備份超過內部請求上限，未完成此次作業。");
    expect(f.kv.list.mock.calls.length + f.kv.batchSizes().length + 3).toBe(
      1000,
    );
    expect(f.bucket.uploads[0].complete).not.toHaveBeenCalled();
    expectNothingPublished(f);
  });
});
