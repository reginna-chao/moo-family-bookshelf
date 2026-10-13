import { createArchive } from "../../../scripts/kv-backup/format.mjs";
import { createMockKV } from "./mockKv";

export const ACCOUNT = "a".repeat(32);
export const SOURCE = "b".repeat(32);
export const TARGET = "c".repeat(32);
export const NOW = Date.parse("2026-10-13T03:17:00.000Z");
export const UUID = "12345678-1234-1234-1234-123456789abc";
export const DATA_KEY = `daily/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.jsonl`;
export const MANIFEST_KEY = DATA_KEY.replace(/\.jsonl$/, ".manifest.json");

export interface RecordFixture {
  key: string;
  value: string;
  expiration?: number;
  metadata?: unknown;
}

export function recordsFixture(): RecordFixture[] {
  return [
    {
      key: "user:reader",
      value: '{ "displayName": "讀者📚", "books": [] }',
      metadata: { revision: 2 },
    },
    { key: "family:abcd-1234", value: '{"members":[]}' },
    { key: "member:reader", value: "abcd-1234" },
    { key: "verify:reader", value: '{"method":"pin","hash":"synthetic"}' },
    { key: "publicshelves:reader", value: '{"shelves":[]}' },
    {
      key: "public:share",
      value: '{"expiresAt":null}',
      expiration: NOW / 1000 + 3600,
    },
    { key: "borrow:request", value: '{"familyId":"abcd-1234"}' },
    { key: "borrows:family:abcd-1234", value: "[]" },
    { key: "newbookdefault:reader", value: '{"newBookDefaultShared":0}' },
    {
      key: "kicked:abcd-1234:former",
      value: "{}",
      expiration: NOW / 1000 + 7200,
    },
  ];
}

/** Stores R2 bytes only; KV state always delegates to the project's shared mock. */
export function archiveStore() {
  const objects = new Map<string, Buffer>();
  const trace: string[] = [];
  return {
    objects,
    trace,
    put: vi.fn(async (key: string, data: Buffer) => {
      trace.push(`put:${key}`);
      objects.set(key, Buffer.from(data));
    }),
    get: vi.fn(async (key: string) => {
      trace.push(`get:${key}`);
      const data = objects.get(key);
      if (!data) throw new Error("missing fixture object");
      return Buffer.from(data);
    }),
  };
}

export function seededArchive(records = recordsFixture()) {
  const archive = createArchive(records, {
    accountId: ACCOUNT,
    namespaceId: SOURCE,
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    objectKey: DATA_KEY,
  });
  const store = archiveStore();
  store.objects.set(DATA_KEY, archive.data);
  store.objects.set(
    MANIFEST_KEY,
    Buffer.from(JSON.stringify(archive.manifest)),
  );
  return { ...archive, store };
}

/** Expiry/metadata are canned fixture attributes, never a second KV implementation. */
export function fixtureClient(records: RecordFixture[] = []) {
  const kv = createMockKV();
  const client = {
    listKeys: vi.fn(async () =>
      (await kv.list()).keys.map(({ name }) => {
        const record = records.find((entry) => entry.key === name);
        return {
          name,
          ...(record?.expiration === undefined
            ? {}
            : { expiration: record.expiration }),
        };
      }),
    ),
    readKeys: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        await Promise.all(
          keys.map(async (key) => {
            const value = await kv.get(key);
            const record = records.find((entry) => entry.key === key);
            return [
              key,
              value === null
                ? null
                : {
                    value,
                    metadata: record?.metadata,
                    expiration: record?.expiration,
                  },
            ];
          }),
        ),
      ),
    ),
    writeRecords: vi.fn(async (entries: RecordFixture[]) => {
      for (const record of entries) await kv.put(record.key, record.value);
    }),
  };
  return { kv, client };
}

export function restoreOptions(
  store: ReturnType<typeof archiveStore>,
  client: ReturnType<typeof fixtureClient>["client"],
) {
  return {
    store,
    client,
    accountId: ACCOUNT,
    sourceNamespaceId: SOURCE,
    targetNamespaceId: TARGET,
    manifestKey: MANIFEST_KEY,
    now: () => NOW,
    sleep: async () => undefined,
  };
}
