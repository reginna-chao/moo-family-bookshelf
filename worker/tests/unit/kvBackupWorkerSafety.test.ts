import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import type { BackupRecord } from "../../../scripts/kv-backup/types.mjs";
import { PART_BYTES } from "../../src/backup/multipart";
import {
  CAPACITY_LIMITS,
  isWithinCapacity,
  MAX_ARCHIVE_BYTES,
  MAX_EXTERNAL_REQUESTS,
  MAX_INTERNAL_REQUESTS,
  MAX_SAVED_KEYS,
  MAX_VALUE_BYTES,
  READ_BATCH_SIZE,
  RunBudget,
} from "../../src/backup/runtime";
import {
  listSavedKeys,
  readSavedRecords,
  verifySourceKeys,
} from "../../src/backup/source";
import { NOW, type RecordFixture } from "../helpers/kvBackupFixtures";
import {
  failure as rejectionOf,
  workerKv,
  type ListPage,
} from "../helpers/kvBackupWorkerFixtures";

/**
 * Unit-level guards of the backup Worker's KV side: the Free profile
 * constants, the capacity rule, KV listing, the source re-check and the
 * adaptive batch reader. The run budget, multipart writer, retention and
 * Healthchecks ping are in `kvBackupWorkerRuntime.test.ts`; the end-to-end
 * counterparts (a whole `runScheduledBackup`) are in `kvBackupCapacity.test.ts`
 * and `kvBackupWorker.test.ts`.
 *
 * Adaptive split (`readSavedRecords`): a batch whose error message contains
 * "413" is halved at once (one internal request, no sleep); any other remote
 * failure is retried once after `sleep(500)` (two internal requests) and then
 * halved. A single-key batch that still fails stops the run. The expected call
 * sizes below are derived from that split tree, e.g. with a 25-key ceiling:
 * 100 → 50 → 25, 25 → 50 → 25, 25.
 *
 * Mid-run expiry: a null batch value is skipped only for a listed key whose own
 * expiration is at or before the run clock; `verifySourceKeys` tolerates
 * exactly that key disappearing. Every acceptance row has a rejecting neighbour.
 *
 * Messages are asserted exactly: every BackupError is a repo-authored constant
 * (`kvBackupErrorMessages.test.ts`).
 */

const PAST = NOW / 1000 - 60;
const FUTURE = NOW / 1000 + 60;
const emptyEntry = { value: null, metadata: null, cacheStatus: null };

function budget() {
  const sleep = vi.fn(async (_ms: number) => undefined);
  return { b: new RunBudget({ now: () => NOW, sleep }), sleep };
}

const users = (n: number): RecordFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `user:k${String(i).padStart(4, "0")}`,
    value: `{"i":${i}}`,
  }));

/** Runs `readSavedRecords` over `records` in listing order; `error` is set when it throws. */
async function readAll(
  records: RecordFixture[],
  fail?: (names: string[]) => Error | undefined,
) {
  const kv = await workerKv(records);
  if (fail) kv.failBatch(fail);
  const { b, sleep } = budget();
  const out: BackupRecord[] = [];
  let error: Error | undefined;
  try {
    const listed = records.map((record) => ({ name: record.key }));
    for await (const record of readSavedRecords(kv.binding, listed, b))
      out.push(record);
  } catch (caught) {
    error = caught as Error;
  }
  return { kv, b, sleep, out, error };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Free profile constants", () => {
  it("pins the documented limits and the 70% capacity thresholds", () => {
    expect({
      MAX_VALUE_BYTES,
      MAX_SAVED_KEYS,
      MAX_ARCHIVE_BYTES,
      READ_BATCH_SIZE,
      MAX_INTERNAL_REQUESTS,
      MAX_EXTERNAL_REQUESTS,
      PART_BYTES,
    }).toEqual({
      MAX_VALUE_BYTES: 4 * 1024 * 1024,
      MAX_SAVED_KEYS: 5000,
      MAX_ARCHIVE_BYTES: 15_000_000,
      READ_BATCH_SIZE: 100,
      MAX_INTERNAL_REQUESTS: 1000,
      MAX_EXTERNAL_REQUESTS: 50,
      PART_BYTES: 5 * 1024 * 1024,
    });
    expect(CAPACITY_LIMITS).toEqual({
      internalRequests: 700,
      keys: 3500,
      archiveBytes: 10_000_000,
    });
  });
});

describe("isWithinCapacity", () => {
  const below = { internalRequests: 699, count: 3499, byteLength: 9_999_999 };
  it.each([
    ["everything one below its threshold", below, true],
    ["everything zero", { internalRequests: 0, count: 0, byteLength: 0 }, true],
    ["700 internal requests", { ...below, internalRequests: 700 }, false],
    ["3,500 keys", { ...below, count: 3500 }, false],
    ["a 10,000,000-byte archive", { ...below, byteLength: 10_000_000 }, false],
    [
      "everything over",
      { internalRequests: 999, count: 4999, byteLength: 14_999_999 },
      false,
    ],
  ])("answers %s with %s", (_case, measures, expected) => {
    expect(isWithinCapacity(measures)).toBe(expected);
  });
});

describe("listSavedKeys", () => {
  const page = (keys: ListPage["keys"], complete = true) =>
    ({ keys, list_complete: complete, cacheStatus: null }) as ListPage;
  it.each<[string, ListPage, string]>([
    [
      "an unknown category",
      page([{ name: "future:secret" }]),
      "發現未列入計畫的 key 類別，請先更新備份範圍。",
    ],
    [
      "nothing saved",
      page([{ name: "token:x" }]),
      "KV 備份資料為空，已停止此次作業。",
    ],
    [
      "a duplicate key",
      page([{ name: "user:a" }, { name: "user:a" }]),
      "KV 列舉含重複資料。",
    ],
    [
      "an incomplete page without cursor",
      page([{ name: "user:a" }], false),
      "KV 列舉分頁資訊不正確。",
    ],
    [
      "a malformed page",
      { keys: null } as unknown as ListPage,
      "KV 列舉回應格式錯誤。",
    ],
    [
      "an invalid expiration",
      page([{ name: "user:a", expiration: 0 }]),
      "KV 列舉含無效到期時間。",
    ],
    [
      "5,001 saved keys",
      page(Array.from({ length: 5001 }, (_, i) => ({ name: `user:${i}` }))),
      "每日備份超過 5,000 筆資料限制。",
    ],
  ])("rejects a listing with %s", async (_case, response, message) => {
    const kv = await workerKv([]);
    kv.list.mockResolvedValue(response);
    const error = await rejectionOf(listSavedKeys(kv.binding, budget().b));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(message);
  });

  it("accepts exactly 5,000 saved keys; transient keys do not count", async () => {
    const kv = await workerKv([]);
    const saved = Array.from({ length: 5000 }, (_, i) => ({
      name: `user:${i}`,
    }));
    kv.list.mockResolvedValue(page([...saved, { name: "token:x" }]));
    expect((await listSavedKeys(kv.binding, budget().b)).size).toBe(5000);
  });

  it("rejects a cursor that repeats", async () => {
    const kv = await workerKv([]);
    kv.list
      .mockResolvedValueOnce({
        ...page([{ name: "user:a" }], false),
        cursor: "c",
      })
      .mockResolvedValueOnce({
        ...page([{ name: "user:b" }], false),
        cursor: "c",
      });
    const error = await rejectionOf(listSavedKeys(kv.binding, budget().b));
    expect(error.message).toBe("KV 列舉分頁資訊不正確。");
  });

  it("follows pages with only transient keys and keeps the absolute TTL", async () => {
    const kv = await workerKv([]);
    kv.list
      .mockResolvedValueOnce({
        ...page([{ name: "token:x" }], false),
        cursor: "next",
      })
      .mockResolvedValueOnce(
        page([{ name: "kicked:a", expiration: NOW / 1000 + 600 }]),
      );
    expect([...(await listSavedKeys(kv.binding, budget().b))]).toEqual([
      ["kicked:a", { name: "kicked:a", expiration: NOW / 1000 + 600 }],
    ]);
    expect(kv.list.mock.calls.map(([options]) => options)).toEqual([
      { limit: 1000, cursor: undefined },
      { limit: 1000, cursor: "next" },
    ]);
  });
});

describe("verifySourceKeys", () => {
  type Listed = { name: string; expiration?: number };
  const initial: Listed[] = [
    { name: "user:a" },
    { name: "public:expired", expiration: PAST },
    { name: "public:live", expiration: FUTURE },
  ];
  const [user, expired, live] = initial;
  async function relist(keys: Listed[]) {
    const kv = await workerKv([]);
    kv.list.mockResolvedValue({ keys, list_complete: true, cacheStatus: null });
    const before = new Map(initial.map((key) => [key.name, key]));
    return verifySourceKeys(kv.binding, before, budget().b);
  }

  it.each([
    ["an identical re-listing", [user, expired, live]],
    ["an expired key absent from the re-listing", [user, live]],
    ["an expired key still listed with the same expiration", initial],
  ])("accepts %s", async (_case, keys) => {
    await expect(relist(keys)).resolves.toBeUndefined();
  });

  it.each([
    [
      "a key that appears only in the re-listing",
      [...initial, { name: "user:b" }],
    ],
    ["an unexpired key absent from the re-listing", [user, expired]],
    ["a key without expiration absent from the re-listing", [expired, live]],
    [
      "an expired key re-listed with a different expiration",
      [user, { ...expired, expiration: FUTURE }, live],
    ],
    [
      "a live key re-listed with a different expiration",
      [user, expired, { ...live, expiration: FUTURE + 1 }],
    ],
  ])("rejects %s", async (_case, keys) => {
    const error = await rejectionOf(relist(keys));
    expect(error.message).toBe(
      "備份期間資料清單或到期時間改變，沒有發布成功備份。",
    );
  });
});

describe("readSavedRecords", () => {
  it("reads READ_BATCH_SIZE names per batch call, one internal request each, in listing order", async () => {
    const records = users(250);
    const { kv, b, out } = await readAll(records);
    expect(kv.batchSizes()).toEqual([100, 100, 50]);
    expect(
      kv.getWithMetadata.mock.calls.every(([, type]) => type === "text"),
    ).toBe(true);
    expect(out).toEqual(records);
    expect(b.counts()).toEqual({ internal: 3, external: 0 });
  });

  it("halves a batch at once on a 413 until each half fits, counting every attempt", async () => {
    const records = users(100);
    const tooLarge = new Error("KV GET failed: 413 Payload Too Large");
    const { kv, b, sleep, out } = await readAll(records, (names) =>
      names.length > 25 ? tooLarge : undefined,
    );
    expect(kv.batchSizes()).toEqual([100, 50, 25, 25, 50, 25, 25]);
    expect(b.counts().internal).toBe(7);
    expect(sleep).not.toHaveBeenCalled();
    expect(out).toEqual(records);
  });

  it("retries any other failure once after 500 ms before halving the batch", async () => {
    const records = users(100);
    const { kv, b, sleep, out } = await readAll(records, (names) =>
      names.length > 50 ? new Error("connection reset") : undefined,
    );
    expect(kv.batchSizes()).toEqual([100, 100, 50, 50]);
    expect(b.counts().internal).toBe(4);
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(out).toEqual(records);
  });

  it.each([
    ["a 413", new Error("413"), [3, 2, 1, 1], 0],
    ["a transient error", new Error("boom"), [3, 3, 2, 2, 1, 1, 1], 3],
  ])(
    "stops the run when a single-key batch still fails with %s",
    async (_case, failure, sizes, sleeps) => {
      const { kv, b, sleep, out, error } = await readAll(users(3), (names) =>
        names.includes("user:k0001") ? failure : undefined,
      );
      expect(error).toBeInstanceOf(BackupError);
      expect(error?.message).toBe("單筆 KV 資料讀取失敗，已停止此次作業。");
      expect(kv.batchSizes()).toEqual(sizes);
      expect(b.counts().internal).toBe(sizes.length);
      expect(sleep).toHaveBeenCalledTimes(sleeps);
      expect(out).toEqual([]);
    },
  );

  it("carries the listed expiration and the batch metadata into the record", async () => {
    const record = {
      key: "public:x",
      value: '{"expiresAt":null}',
      expiration: FUTURE,
      metadata: { v: 1 },
    };
    const kv = await workerKv([record]);
    const listed = [{ name: record.key, expiration: FUTURE }];
    const out: BackupRecord[] = [];
    for await (const read of readSavedRecords(kv.binding, listed, budget().b))
      out.push(read);
    expect(out).toEqual([record]);
  });

  it("accepts a value of exactly 4 MiB of escaped Unicode JSON", async () => {
    const prefix = '{"text":"';
    const suffix = '📚"}';
    const room = MAX_VALUE_BYTES - Buffer.byteLength(prefix + suffix);
    const value =
      prefix +
      "\\t".repeat(Math.floor(room / 2)) +
      " ".repeat(room % 2) +
      suffix;
    expect(Buffer.byteLength(value)).toBe(MAX_VALUE_BYTES);
    const { out, error } = await readAll([{ key: "user:a", value }]);
    expect(error).toBeUndefined();
    expect(out[0].value).toBe(value);
  });

  it.each([
    ["4 MiB + 1 ASCII bytes", "x".repeat(MAX_VALUE_BYTES + 1)],
    [
      "fewer UTF-16 units than 4 MiB but more UTF-8 bytes",
      "é".repeat(MAX_VALUE_BYTES / 2 + 1),
    ],
  ])("rejects a value of %s", async (_case, value) => {
    const { error } = await readAll([{ key: "user:a", value }]);
    expect(error?.message).toBe("單筆 KV 資料超過 4 MiB 備份限制。");
  });

  it.each([
    ["a non-Map response", async () => ({}) as Map<string, typeof emptyEntry>],
    [
      "a non-string value",
      async () =>
        new Map([["user:a", { ...emptyEntry, value: 5 as unknown as null }]]),
    ],
  ])("rejects %s from the batch binding", async (_case, answer) => {
    const kv = await workerKv([{ key: "user:a", value: "{}" }]);
    kv.getWithMetadata.mockImplementation(answer);
    const read = readSavedRecords(kv.binding, [{ name: "user:a" }], budget().b);
    const error = await rejectionOf(read.next());
    expect(error.message).toBe("KV 批次讀取回應格式錯誤。");
  });

  async function readMissing(expiration: number | undefined) {
    const kv = await workerKv([]);
    kv.getWithMetadata.mockResolvedValue(new Map([["public:x", emptyEntry]]));
    const out: BackupRecord[] = [];
    for await (const read of readSavedRecords(
      kv.binding,
      [{ name: "public:x", expiration }],
      budget().b,
    ))
      out.push(read);
    return out;
  }

  it.each([
    ["a past expiration", PAST],
    ["an expiration equal to the run clock", NOW / 1000],
  ])(
    "skips a listed key with %s whose value has expired",
    async (_case, expiration) => {
      await expect(readMissing(expiration)).resolves.toEqual([]);
    },
  );

  it.each([
    ["a future expiration", NOW / 1000 + 1],
    ["no expiration", undefined],
  ])(
    "rejects a listed key with %s whose value vanished",
    async (_case, expiration) => {
      const error = await rejectionOf(readMissing(expiration));
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toBe("已列舉的 KV 資料不存在。");
    },
  );
});
