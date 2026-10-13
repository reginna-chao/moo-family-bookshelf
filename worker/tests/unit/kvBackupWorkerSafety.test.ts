import { createHash } from "node:crypto";
import {
  listSavedKeys,
  readRecord,
  verifySourceKeys,
} from "../../src/backup/source";
import {
  MultipartWriter,
  PART_BYTES,
  verifyObject,
} from "../../src/backup/multipart";
import {
  cleanOldSnapshots,
  publishLatest,
  readLatest,
} from "../../src/backup/retention";
import {
  readBounded,
  RunBudget,
  MAX_VALUE_BYTES,
} from "../../src/backup/runtime";
import { reportSuccess } from "../../src/backup/heartbeat";
import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import {
  ACCOUNT,
  SOURCE,
  NOW,
  UUID,
  seededArchive,
} from "../helpers/kvBackupFixtures";
import {
  byteStream,
  workerBucket,
  workerKv,
} from "../helpers/kvBackupWorkerFixtures";

/** Negative guards have positive companions: real category export, successful
 * multipart bytes, valid heartbeat, CAS replacement and expired-object deletion.
 *
 * Mid-run expiry: `readRecord` answers null (skip) only for a listed key whose own
 * expiration is at or before the run clock; `verifySourceKeys` tolerates exactly
 * that key disappearing, and nothing else (a new key, a changed TTL, or an
 * unexpired key going missing). Each acceptance row has a rejecting neighbour. */

const budget = () =>
  new RunBudget({ now: () => NOW, sleep: async () => undefined });
const emptyEntry = { value: null, metadata: null, cacheStatus: null };
const PAST = NOW / 1000 - 60;
const FUTURE = NOW / 1000 + 60;
const oldKey = `snapshots/2026-09-01/2026-09-01T03-17-00-000Z_${UUID}.manifest.json`;
const newKey = `snapshots/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.manifest.json`;
const pointer = (manifestKey = oldKey) => ({
  manifestKey,
  completedAt: "2026-09-01T03:18:00.000Z",
  sourceAccountId: ACCOUNT,
  sourceNamespaceId: SOURCE,
});

describe("KV streaming and resource guards", () => {
  it.each([
    "unknown",
    "empty",
    "duplicate",
    "cursor",
    "malformed",
    "expiry",
    "cap",
  ])("rejects %s source listings", async (kind) => {
    const f = await workerKv([{ key: "user:a", value: "{}" }]);
    const keys =
      kind === "empty"
        ? []
        : kind === "unknown"
          ? [{ name: "future:secret" }]
          : kind === "duplicate"
            ? [{ name: "user:a" }, { name: "user:a" }]
            : kind === "expiry"
              ? [{ name: "user:a", expiration: 0 }]
              : kind === "cap"
                ? Array.from({ length: 5001 }, (_, i) => ({
                    name: `user:${i}`,
                  }))
                : [{ name: "user:a" }];
    f.list.mockResolvedValue({
      keys,
      list_complete: kind !== "cursor" && kind !== "malformed",
      cacheStatus: null,
    } as Awaited<ReturnType<typeof f.list>>);
    if (kind === "malformed")
      f.list.mockResolvedValue({
        keys: null,
        list_complete: true,
      } as unknown as Awaited<ReturnType<typeof f.list>>);
    await expect(listSavedKeys(f.binding, budget())).rejects.toThrow();
  });

  it("follows pages with only transient keys and retains absolute TTL", async () => {
    const f = await workerKv([]);
    f.list
      .mockResolvedValueOnce({
        keys: [{ name: "token:x", expiration: undefined }],
        list_complete: false,
        cacheStatus: null,
        cursor: "next",
      } as Awaited<ReturnType<typeof f.list>>)
      .mockResolvedValueOnce({
        keys: [{ name: "kicked:a", expiration: NOW / 1000 + 600 }],
        list_complete: true,
        cacheStatus: null,
      });
    expect([...(await listSavedKeys(f.binding, budget()))]).toEqual([
      ["kicked:a", { name: "kicked:a", expiration: NOW / 1000 + 600 }],
    ]);
  });

  type Listed = { name: string; expiration?: number };
  const initial: Listed[] = [
    { name: "user:a" },
    { name: "public:expired", expiration: PAST },
    { name: "public:live", expiration: FUTURE },
  ];
  const relist = (keys: Listed[]) => async () => {
    const f = await workerKv([]);
    f.list.mockResolvedValue({
      keys,
      list_complete: true,
      cacheStatus: null,
    } as Awaited<ReturnType<typeof f.list>>);
    return verifySourceKeys(
      f.binding,
      new Map(initial.map((key) => [key.name, key])),
      budget(),
    );
  };
  const [user, expired, live] = initial;

  it.each([
    ["an identical re-listing", [user, expired, live]],
    ["an expired key absent from the re-listing", [user, live]],
    ["an expired key still listed with the same expiration", initial],
  ])("accepts %s", async (_case, keys) => {
    await expect(relist(keys)()).resolves.toBeUndefined();
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
    await expect(relist(keys)()).rejects.toThrow(
      /^備份期間資料清單或到期時間改變，沒有發布成功備份。$/,
    );
  });

  it.each(["over-limit", "invalid-utf8", "invalid-json", "missing"])(
    "rejects %s streamed records",
    async (kind) => {
      const f = await workerKv([{ key: "user:a", value: "{}" }]);
      const bytes =
        kind === "over-limit"
          ? new Uint8Array(MAX_VALUE_BYTES + 1)
          : kind === "invalid-utf8"
            ? new Uint8Array([0xff])
            : new TextEncoder().encode("not-json");
      f.getWithMetadata.mockImplementation(async () => ({
        value: kind === "missing" ? null : byteStream(bytes),
        metadata: null,
        cacheStatus: null,
      }));
      await expect(
        readRecord(f.binding, { name: "user:a" }, budget()),
      ).rejects.toThrow();
    },
  );

  it("accepts an exactly 4 MiB escaped Unicode JSON value", async () => {
    const suffix = '📚"}';
    const prefix = '{"text":"';
    const value =
      prefix +
      "\\t".repeat(
        Math.floor((MAX_VALUE_BYTES - Buffer.byteLength(prefix + suffix)) / 2),
      ) +
      " ".repeat((MAX_VALUE_BYTES - Buffer.byteLength(prefix + suffix)) % 2) +
      suffix;
    const f = await workerKv([{ key: "user:a", value }]);
    expect(Buffer.byteLength(value)).toBe(MAX_VALUE_BYTES);
    expect(
      (await readRecord(f.binding, { name: "user:a" }, budget()))?.value,
    ).toBe(value);
  });

  it.each([
    ["a past expiration", NOW / 1000 - 60],
    ["an expiration equal to the run clock", NOW / 1000],
  ])(
    "skips a listed key with %s whose value has expired",
    async (_case, expiration) => {
      const f = await workerKv([]);
      f.getWithMetadata.mockResolvedValue(emptyEntry);
      await expect(
        readRecord(f.binding, { name: "public:x", expiration }, budget()),
      ).resolves.toBeNull();
    },
  );

  it.each([
    ["a future expiration", NOW / 1000 + 1],
    ["no expiration", undefined],
  ])(
    "rejects a listed key with %s whose value vanished",
    async (_case, expiration) => {
      const f = await workerKv([]);
      f.getWithMetadata.mockResolvedValue(emptyEntry);
      const read = readRecord(
        f.binding,
        { name: "public:x", expiration },
        budget(),
      );
      await expect(read).rejects.toBeInstanceOf(BackupError);
      await expect(read).rejects.toThrow(/^已列舉的 KV 資料不存在。$/);
    },
  );

  it("still exports a listed key past its expiration while KV keeps serving it", async () => {
    const f = await workerKv([
      { key: "public:x", value: '{"expiresAt":null}' },
    ]);
    const expiration = NOW / 1000 - 60;
    await expect(
      readRecord(f.binding, { name: "public:x", expiration }, budget()),
    ).resolves.toEqual({
      key: "public:x",
      value: '{"expiresAt":null}',
      expiration,
    });
  });

  it("bounds retries, request count and elapsed time without leaking errors", async () => {
    const b = budget();
    const cloudflare = /^Cloudflare 備份操作失敗，已停止此次作業。$/;
    const operation = vi.fn().mockRejectedValue(new Error("secret"));
    await expect(b.call(operation)).rejects.toThrow(cloudflare);
    expect(operation).toHaveBeenCalledTimes(2);
    operation.mockClear();
    const once = b.call(operation, false);
    await expect(once).rejects.toBeInstanceOf(BackupError);
    await expect(once).rejects.toThrow(cloudflare);
    await expect(once).rejects.not.toThrow("secret");
    expect(operation).toHaveBeenCalledOnce();
    const inner = new BackupError("bounded");
    const terminal = vi.fn().mockRejectedValue(inner);
    const rethrown = b.call(terminal);
    await expect(rethrown).rejects.toBe(inner);
    await expect(rethrown).rejects.toThrow(/^bounded$/);
    expect(terminal).toHaveBeenCalledOnce();
    const limited = budget();
    for (let i = 0; i < 9000; i++) await limited.call(async () => undefined);
    await expect(limited.call(async () => undefined)).rejects.toThrow(
      "請求預算",
    );
    let now = NOW;
    const timed = new RunBudget({ now: () => now });
    now += 720000;
    expect(() => timed.check()).toThrow("時間預算");
    await expect(
      readBounded(byteStream(new Uint8Array(5)), 4),
    ).rejects.toThrow();
  });
});

describe("R2 multipart and verification", () => {
  it("uploads full-size parts and the final remainder without altering bytes", async () => {
    const b = workerBucket();
    const upload = await b.createMultipartUpload("snapshot");
    const writer = new MultipartWriter(
      upload as unknown as R2MultipartUpload,
      budget(),
    );
    const bytes = Buffer.alloc(PART_BYTES + 17, 42);
    await writer.write(bytes.subarray(0, 100));
    await writer.write(bytes.subarray(100));
    const result = await writer.complete();
    expect(
      upload.uploadPart.mock.calls.map(([, part]) => part.byteLength),
    ).toEqual([PART_BYTES, 17]);
    expect(result).toEqual({
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await verifyObject(b.binding, "snapshot", result, budget());
    expect(Buffer.from(b.objects.get("snapshot")!.bytes).equals(bytes)).toBe(
      true,
    );
  });
  it("refuses empty multipart completion", async () => {
    const b = workerBucket();
    const upload = await b.createMultipartUpload("empty");
    await expect(
      new MultipartWriter(
        upload as unknown as R2MultipartUpload,
        budget(),
      ).complete(),
    ).rejects.toThrow();
    expect(upload.complete).not.toHaveBeenCalled();
  });
  it.each(["missing", "size", "digest", "truncated", "extra"])(
    "rejects %s R2 read-back",
    async (kind) => {
      const b = workerBucket();
      if (kind !== "missing") b.seed("object", "abc");
      const expected = {
        byteLength: kind === "size" ? 4 : 3,
        sha256: createHash("sha256")
          .update(kind === "digest" ? "xyz" : "abc")
          .digest("hex"),
      };
      if (kind === "truncated" || kind === "extra") {
        const original = b.get.getMockImplementation()!;
        b.get.mockImplementation(async (key) => {
          const value = await original(key);
          if (value)
            value.body = byteStream(
              new TextEncoder().encode(kind === "extra" ? "abcdef" : "ab"),
            );
          return value;
        });
      }
      await expect(
        verifyObject(b.binding, "object", expected, budget()),
      ).rejects.toThrow();
    },
  );
});

describe("last successful backup protection", () => {
  it("protects an old latest pair while deleting only eligible old snapshots", async () => {
    const b = workerBucket();
    b.seed("latest.json", JSON.stringify(pointer()));
    for (const key of [
      oldKey,
      oldKey.replace(".manifest.json", ".jsonl"),
      oldKey.replace(UUID, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      "snapshots/not-a-snapshot",
      newKey,
    ])
      b.seed(key, "x", new Date("2026-09-01"));
    await cleanOldSnapshots(b.binding, budget());
    expect(b.remove).toHaveBeenCalledWith([
      oldKey.replace(UUID, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ]);
    expect(b.objects.has(oldKey)).toBe(true);
    expect(b.objects.has(oldKey.replace(".manifest.json", ".jsonl"))).toBe(
      true,
    );
  });
  it.each(["missing", "corrupt", "oversized"])(
    "never deletes with %s latest state",
    async (kind) => {
      const b = workerBucket();
      b.seed(oldKey, "x", new Date("2026-09-01"));
      if (kind !== "missing")
        b.seed("latest.json", kind === "corrupt" ? "{}" : "x".repeat(4097));
      await expect(cleanOldSnapshots(b.binding, budget())).rejects.toThrow();
      expect(b.remove).not.toHaveBeenCalled();
    },
  );
  it("uses compare-and-swap and preserves a concurrent winner", async () => {
    const b = workerBucket();
    b.seed("latest.json", JSON.stringify(pointer()));
    const previous = await readLatest(b.binding, budget());
    const { manifest } = seededArchive();
    await publishLatest(b.binding, previous, newKey, manifest, budget());
    const winner = new TextDecoder().decode(
      b.objects.get("latest.json")!.bytes,
    );
    await expect(
      publishLatest(b.binding, previous, newKey, manifest, budget()),
    ).rejects.toThrow("另一個備份");
    expect(new TextDecoder().decode(b.objects.get("latest.json")!.bytes)).toBe(
      winner,
    );
  });
  it.each(["newer", "account", "namespace"])(
    "does not replace a %s prior backup",
    async (kind) => {
      const b = workerBucket();
      const p = pointer();
      if (kind === "newer") p.completedAt = new Date(NOW).toISOString();
      if (kind === "account") p.sourceAccountId = "d".repeat(32);
      if (kind === "namespace") p.sourceNamespaceId = "d".repeat(32);
      b.seed("latest.json", JSON.stringify(p));
      await expect(
        publishLatest(
          b.binding,
          await readLatest(b.binding, budget()),
          newKey,
          seededArchive().manifest,
          budget(),
        ),
      ).rejects.toThrow();
      expect(b.put).not.toHaveBeenCalled();
    },
  );
  it("stops cleanup when pagination repeats", async () => {
    const b = workerBucket();
    b.seed("latest.json", JSON.stringify(pointer()));
    b.list.mockResolvedValue({
      objects: [],
      truncated: true,
      cursor: "repeat",
    } as Awaited<ReturnType<typeof b.list>>);
    await expect(cleanOldSnapshots(b.binding, budget())).rejects.toThrow(
      "分頁",
    );
    expect(b.list).toHaveBeenCalledTimes(2);
  });
});

describe("independent success heartbeat", () => {
  it("sends only an empty POST to the fixed host", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));
    await reportSuccess(UUID, budget(), send);
    expect(send).toHaveBeenCalledWith(
      `https://hc-ping.com/${UUID}`,
      expect.objectContaining({
        method: "POST",
        body: "",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each(["not-OK", " OK\n", "", "x".repeat(129), "transport", "status"])(
    "does not accept %s heartbeat",
    async (kind) => {
      const send = vi.fn<typeof fetch>();
      if (kind === "transport")
        send.mockRejectedValue(new Error(`https://hc-ping.com/${UUID}`));
      else
        send.mockImplementation(
          async () =>
            new Response(kind, { status: kind === "status" ? 500 : 200 }),
        );
      await expect(reportSuccess(UUID, budget(), send)).rejects.toThrow("獨立");
      expect(send).toHaveBeenCalledTimes(3);
    },
  );
});
