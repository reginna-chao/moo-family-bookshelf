import {
  BackupError,
  checksum,
  decodeLine,
  encodeLine,
  validateArchive,
} from "../../../scripts/kv-backup/format.mjs";
import {
  runRestore,
  verifyRestored,
} from "../../../scripts/kv-backup/restore.mjs";
import type {
  ManifestV1,
  ManifestV2,
} from "../../../scripts/kv-backup/types.mjs";
import {
  ACCOUNT,
  FORMATTED_USER,
  NOW,
  SOURCE,
  MANIFEST_KEY,
  DATA_KEY,
  recordsFixture,
  fixtureClient,
  seededArchive,
  restoreOptions,
  v1Archive,
} from "../helpers/kvBackupFixtures";

/**
 * Restore-side safety: `runRestore` / `verifyRestored` and the archive reader
 * `validateArchive` / `decodeLine` in `scripts/kv-backup/format.mjs`.
 *
 * Negative restore cases always inspect the shared KV mock as well as calls.
 * Canned read responses model propagation and metadata, not a second store.
 *
 * Archive versions: version 2 (written by the backup Worker, built here with
 * the production `createArchive`) is checked by per-line lengths, total length,
 * the R2-reported `objectSize` and the request counts; version 1 (legacy,
 * read-only, built by the `v1Archive` fixture) by its whole-archive SHA-256.
 * A tampered v2 archive is re-measured by `rewrite()` so that only the one
 * property under test is wrong. Messages are asserted exactly.
 */

const LENGTHS = "備份大小或每筆長度驗證失敗，沒有寫入任何資料。";
const COUNTS = "備份筆數或分類筆數驗證失敗。";
const VERSION = "備份版本、來源或時間資訊不符合設定。";
const LINE = "備份資料行格式不正確。";
const reader = { accountId: ACCOUNT, namespaceId: SOURCE };
const read = (manifest: unknown, data: Buffer) =>
  validateArchive(manifest, data, { ...reader, manifestKey: MANIFEST_KEY });

/** Replaces the archive's lines and re-measures the manifest to match them. */
function rewrite(manifest: ManifestV2, lines: string[]) {
  const buffers = lines.map((line) => Buffer.from(line));
  const data = Buffer.concat(buffers);
  manifest.count = lines.length;
  manifest.lineLengths = buffers.map((buffer) => buffer.length);
  manifest.byteLength = manifest.objectSize = data.length;
  return data;
}

function rejection(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("KV restore safety", () => {
  it("defaults to a dry run and leaves the target empty", async () => {
    const { store } = seededArchive();
    const target = fixtureClient();
    const result = await runRestore(restoreOptions(store, target.client));
    expect(result).toMatchObject({ applied: false, count: 10, skipped: 0 });
    expect((await target.kv.list()).keys).toEqual([]);
    expect(target.client.writeRecords).not.toHaveBeenCalled();
  });

  it.each(["source", "account", "nonempty", "confirmation", "race", "budget"])(
    "rejects %s before any write",
    async (failure) => {
      const { store } = seededArchive();
      const target = fixtureClient();
      const options = restoreOptions(store, target.client);
      if (failure === "source") options.targetNamespaceId = SOURCE;
      if (failure === "account") options.accountId = "d".repeat(32);
      if (failure === "nonempty") await target.kv.put("user:existing", "{}");
      const confirm = async () => {
        if (failure === "race") await target.kv.put("user:concurrent", "{}");
        return failure !== "confirmation";
      };
      await expect(
        runRestore({
          ...options,
          apply: true,
          maxWrites: failure === "budget" ? 9 : 1000,
          confirm,
        }),
      ).rejects.toThrow();
      expect(target.client.writeRecords).not.toHaveBeenCalled();
      expect(await target.kv.get("user:reader")).toBeNull();
    },
  );

  it("requires a confirmation callback even when apply is true", async () => {
    const { store } = seededArchive();
    const target = fixtureClient();
    await expect(
      runRestore({ ...restoreOptions(store, target.client), apply: true }),
    ).rejects.toThrow();
    expect(target.client.writeRecords).not.toHaveBeenCalled();
  });

  const fixtureLines = () => recordsFixture().map((r) => encodeLine(r));
  it.each<[string, (m: ManifestV2, data: Buffer) => Buffer, string]>([
    ["count", (m, d) => (m.count++, d), LENGTHS],
    ["prefix-count", (m, d) => (m.prefixCounts["user:"]++, d), COUNTS],
    [
      "duplicate",
      (m) => rewrite(m, [...fixtureLines(), fixtureLines()[0]]),
      "備份包含重複 key。",
    ],
    [
      "unknown",
      (m) => rewrite(m, [encodeLine({ key: "future:secret", value: "{}" })]),
      "發現未列入計畫的 key 類別，請先更新備份範圍。",
    ],
    [
      "credential",
      (m) => rewrite(m, [encodeLine({ key: "token:secret", value: "{}" })]),
      "備份含不應還原的短期憑證或計數資料。",
    ],
    ["version", (m, d) => (Object.assign(m, { version: 999 }), d), VERSION],
    ["truncated", (_m, d) => d.subarray(0, -1), LENGTHS],
  ])("rejects %s archives before any write", async (_case, tamper, message) => {
    const { store, manifest, data } = seededArchive();
    store.objects.set(DATA_KEY, tamper(manifest, data));
    store.objects.set(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)));
    const target = fixtureClient();
    const error = await runRestore({
      ...restoreOptions(store, target.client),
      apply: true,
      confirm: async () => true,
    }).then(
      () => new Error("expected a rejection"),
      (rejection: Error) => rejection,
    );
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(message);
    expect(target.client.writeRecords).not.toHaveBeenCalled();
    expect((await target.kv.list()).keys).toHaveLength(0);
  });

  it("skips expired and near-expiry records without extending either public deadline", async () => {
    const records = [
      { key: "user:live", value: "{}" },
      { key: "kicked:old", value: "{}", expiration: NOW / 1000 - 1 },
      { key: "kicked:near", value: "{}", expiration: NOW / 1000 + 59 },
      {
        key: "public:app",
        value: JSON.stringify({ expiresAt: NOW + 30_000 }),
        expiration: NOW / 1000 + 3600,
      },
      {
        key: "public:kv",
        value: JSON.stringify({ expiresAt: NOW + 3_600_000 }),
        expiration: NOW / 1000 + 60,
      },
      { key: "kicked:live", value: "{}", expiration: NOW / 1000 + 61 },
    ];
    const { store } = seededArchive(records);
    const target = fixtureClient(records);
    const result = await runRestore({
      ...restoreOptions(store, target.client),
      apply: true,
      confirm: async () => true,
    });
    expect(result).toMatchObject({ count: 2, skipped: 4 });
    expect(
      target.client.writeRecords.mock.calls.flatMap(([batch]) => batch),
    ).toEqual([records[0], records[5]]);
    expect((await target.kv.list()).keys.map(({ name }) => name)).toEqual([
      "user:live",
      "kicked:live",
    ]);
  });

  it("rechecks expiration after user confirmation", async () => {
    const records = [
      { key: "kicked:near", value: "{}", expiration: NOW / 1000 + 70 },
    ];
    const { store } = seededArchive(records);
    const target = fixtureClient(records);
    let clock = NOW;
    const result = await runRestore({
      ...restoreOptions(store, target.client),
      now: () => clock,
      apply: true,
      confirm: async () => {
        clock += 15_000;
        return true;
      },
    });
    expect(result).toMatchObject({ count: 0, skipped: 1 });
    expect(target.client.writeRecords).not.toHaveBeenCalled();
  });
});

describe("KV restore read-back verification", () => {
  it.each(["missing", "value", "expiration", "metadata"])(
    "does not accept %s mismatches after bounded retries",
    async (failure) => {
      const record = recordsFixture()[0];
      const target = fixtureClient();
      const actual = {
        value: record.value,
        expiration: record.expiration,
        metadata: record.metadata,
      };
      if (failure === "value") actual.value = "{}";
      if (failure === "expiration") actual.expiration = NOW / 1000 + 3600;
      if (failure === "metadata") actual.metadata = { revision: 99 };
      target.client.readKeys.mockResolvedValue(
        failure === "missing" ? {} : { [record.key]: actual },
      );
      let clock = NOW;
      const sleep = vi.fn(async (ms: number) => {
        clock += ms;
      });
      await expect(
        verifyRestored(target.client, [record], { now: () => clock, sleep }),
      ).rejects.toThrow();
      expect(target.client.readKeys).toHaveBeenCalledTimes(7);
      expect(clock).toBe(NOW + 60_000);
    },
  );

  it("waits for the expected bytes and metadata to become visible", async () => {
    const record = recordsFixture()[0];
    const target = fixtureClient();
    target.client.readKeys.mockResolvedValueOnce({}).mockResolvedValueOnce({
      [record.key]: {
        value: record.value,
        metadata: record.metadata,
        expiration: record.expiration,
      },
    });
    const sleep = vi.fn(async () => undefined);
    await verifyRestored(target.client, [record], { now: () => NOW, sleep });
    expect(target.client.readKeys).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("retains partially written data and reports failure without deleting", async () => {
    const { store } = seededArchive();
    const target = fixtureClient();
    target.client.writeRecords.mockImplementation(async (entries) => {
      await target.kv.put(entries[0].key, entries[0].value);
      throw new Error("partial");
    });
    await expect(
      runRestore({
        ...restoreOptions(store, target.client),
        apply: true,
        confirm: async () => true,
      }),
    ).rejects.toThrow("保留隔離目標");
    expect(await target.kv.get("user:reader")).toBe(recordsFixture()[0].value);
    expect(target.client.writeRecords).toHaveBeenCalledOnce();
  });
});

describe("validateArchive", () => {
  const records = [...recordsFixture(), FORMATTED_USER];

  it("reads a legacy v1 and a v2 archive of the same records into equal record lists", () => {
    const v1 = v1Archive(records);
    const v2 = seededArchive(records);
    expect(v1.manifest.version).toBe(1);
    expect(v2.manifest.version).toBe(2);
    const fromV1 = read(v1.manifest, v1.data);
    expect(fromV1).toEqual(records);
    expect(read(v2.manifest, v2.data)).toEqual(fromV1);
  });

  it.each<[string, (m: ManifestV2) => void, string]>([
    [
      "a lineLengths sum that differs from byteLength",
      (m) => m.lineLengths[0]++,
      LENGTHS,
    ],
    [
      "fewer lineLengths entries than count",
      (m) => m.lineLengths.pop(),
      LENGTHS,
    ],
    [
      "an objectSize that differs from byteLength",
      (m) => m.objectSize++,
      LENGTHS,
    ],
    [
      "a missing requests object",
      (m) => delete (m as Partial<ManifestV2>).requests,
      LENGTHS,
    ],
    [
      "a negative internal request count",
      (m) => (m.requests.internal = -1),
      LENGTHS,
    ],
    [
      "a line boundary shifted by one byte (sum unchanged)",
      (m) => (m.lineLengths[0]++, m.lineLengths[1]--),
      LINE,
    ],
  ])("rejects a v2 archive with %s", (_case, tamper, message) => {
    const { manifest, data } = seededArchive(records);
    expect(read(manifest, data)).toHaveLength(records.length);
    tamper(manifest);
    const error = rejection(() => read(manifest, data));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(message);
  });

  it("rejects a v1 archive whose sha256 does not match its bytes", () => {
    const { manifest, data } = v1Archive(records);
    const tampered: ManifestV1 = {
      ...manifest,
      sha256: checksum(Buffer.from("x")),
    };
    expect(rejection(() => read(tampered, data)).message).toBe(
      "備份大小或 SHA-256 驗證失敗，沒有寫入任何資料。",
    );
  });
});

describe("decodeLine (version 2)", () => {
  it.each(recordsFixture().map((record) => [record.key, record] as const))(
    "decodes the line encodeLine wrote for %s back to the record",
    (_key, record) => {
      expect(decodeLine(encodeLine(record), 2)).toEqual(record);
    },
  );

  const valid = '{"key":"user:a","value":{}}\n';
  it.each([
    [
      "an inserted null metadata field",
      '{"key":"user:a","metadata":null,"value":{}}\n',
    ],
    ["value written before key", '{"value":{},"key":"user:a"}\n'],
    ["a space after a colon", '{"key": "user:a","value":{}}\n'],
    ["an undeclared field", '{"key":"user:a","value":{},"extra":1}\n'],
    ["no trailing newline", valid.slice(0, -1)],
  ])("rejects a line with %s", (_case, line) => {
    expect(decodeLine(valid, 2)).toEqual({ key: "user:a", value: "{}" });
    const error = rejection(() => decodeLine(line, 2));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(LINE);
  });

  it("rejects a member: line whose value is not a JSON string", () => {
    expect(
      rejection(() => decodeLine('{"key":"member:a","value":5}\n', 2)).message,
    ).toBe("家庭指向資料格式不正確。");
  });
});
