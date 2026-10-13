import { runBackup } from "../../../scripts/kv-backup/backup.mjs";
import { runRestore } from "../../../scripts/kv-backup/restore.mjs";
import {
  ACCOUNT,
  SOURCE,
  NOW,
  UUID,
  DATA_KEY,
  MANIFEST_KEY,
  archiveStore,
  fixtureClient,
  recordsFixture,
  restoreOptions,
} from "../helpers/kvBackupFixtures";

/** Exercises the real export/restore orchestration. The shared KV mock owns all
 * storage; canned metadata/expiry only model the REST boundary it cannot emulate. */
describe("KV backup orchestration", () => {
  it("round-trips all persistent categories without resurrecting tokens", async () => {
    const records = recordsFixture();
    const source = fixtureClient(records);
    for (const record of records) await source.kv.put(record.key, record.value);
    const ignored = [
      "auth:",
      "token:",
      "otp:",
      "qr:",
      "verifyfail:",
      "ratelimit:",
    ];
    for (const prefix of ignored)
      await source.kv.put(`${prefix}secret`, "never exported");
    const store = archiveStore();
    const result = await runBackup({
      client: source.client,
      store,
      accountId: ACCOUNT,
      namespaceId: SOURCE,
      now: () => NOW,
      uuid: () => UUID,
    });
    expect(result.manifest.count).toBe(10);
    expect(Object.values(result.manifest.prefixCounts)).toEqual(
      Array(10).fill(1),
    );
    expect(store.trace).toEqual([
      `put:${DATA_KEY}`,
      `get:${DATA_KEY}`,
      `put:${MANIFEST_KEY}`,
    ]);
    const target = fixtureClient(records);
    const restored = await runRestore({
      ...restoreOptions(store, target.client),
      apply: true,
      confirm: async () => true,
    });
    expect(restored.count).toBe(10);
    for (const record of records)
      expect(await target.kv.get(record.key)).toBe(record.value);
    for (const prefix of ignored)
      expect(await target.kv.get(`${prefix}secret`)).toBeNull();
    expect(
      target.client.writeRecords.mock.calls.flatMap(([batch]) => batch),
    ).toEqual(records);
  });

  it.each(["unknown", "empty", "missing", "null", "changed-expiry"])(
    "does not publish %s exports",
    async (failure) => {
      const source = fixtureClient();
      if (failure !== "empty")
        await source.kv.put(
          failure === "unknown" ? "newkind:private" : "user:reader",
          "{}",
        );
      if (failure === "missing") source.client.readKeys.mockResolvedValue({});
      if (failure === "null")
        source.client.readKeys.mockResolvedValue({ "user:reader": null });
      if (failure === "changed-expiry")
        source.client.listKeys.mockResolvedValue([
          { name: "user:reader", expiration: NOW / 1000 + 3600 },
        ]);
      const store = archiveStore();
      await expect(
        runBackup({
          client: source.client,
          store,
          accountId: ACCOUNT,
          namespaceId: SOURCE,
          now: () => NOW,
          uuid: () => UUID,
        }),
      ).rejects.toThrow();
      expect(store.objects.has(MANIFEST_KEY)).toBe(false);
    },
  );

  it.each(["upload", "download", "truncated"])(
    "withholds the success marker after %s failure",
    async (failure) => {
      const source = fixtureClient();
      await source.kv.put("user:reader", "{}");
      const store = archiveStore();
      if (failure === "upload")
        store.put.mockRejectedValue(new Error("upload failed"));
      if (failure === "download")
        store.get.mockRejectedValue(new Error("download failed"));
      if (failure === "truncated")
        store.get.mockResolvedValue(Buffer.from('{"key":'));
      await expect(
        runBackup({
          client: source.client,
          store,
          accountId: ACCOUNT,
          namespaceId: SOURCE,
          now: () => NOW,
          uuid: () => UUID,
        }),
      ).rejects.toThrow();
      expect(
        store.put.mock.calls.some(([key]) => key.endsWith(".manifest.json")),
      ).toBe(false);
    },
  );
});
