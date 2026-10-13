import { checksum } from "../../../scripts/kv-backup/format.mjs";
import {
  runRestore,
  verifyRestored,
} from "../../../scripts/kv-backup/restore.mjs";
import {
  NOW,
  SOURCE,
  MANIFEST_KEY,
  DATA_KEY,
  recordsFixture,
  fixtureClient,
  seededArchive,
  restoreOptions,
} from "../helpers/kvBackupFixtures";

/** Negative restore cases always inspect the shared KV mock as well as calls.
 * Canned read responses model propagation and metadata, not a second store. */
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

  it.each([
    "sha",
    "count",
    "prefix-count",
    "duplicate",
    "unknown",
    "version",
    "truncated",
    "credential",
  ])("rejects %s archives before any write", async (failure) => {
    const { store, manifest, data } = seededArchive();
    let changed = data;
    if (failure === "sha") manifest.sha256 = "0".repeat(64);
    if (failure === "count") manifest.count++;
    if (failure === "prefix-count") manifest.prefixCounts["user:"]++;
    if (failure === "version") Object.assign(manifest, { version: 999 });
    if (failure === "duplicate")
      changed = Buffer.concat([
        data,
        Buffer.from(JSON.stringify(recordsFixture()[0]) + "\n"),
      ]);
    if (failure === "unknown" || failure === "credential")
      changed = Buffer.from(
        JSON.stringify({
          key: failure === "unknown" ? "future:secret" : "token:secret",
          value: "{}",
        }) + "\n",
      );
    if (failure === "truncated") changed = data.subarray(0, -1);
    if (changed !== data) {
      manifest.byteLength = changed.length;
      manifest.sha256 = checksum(changed);
    }
    store.objects.set(DATA_KEY, changed);
    store.objects.set(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)));
    const target = fixtureClient();
    await expect(
      runRestore({
        ...restoreOptions(store, target.client),
        apply: true,
        confirm: async () => true,
      }),
    ).rejects.toThrow();
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
