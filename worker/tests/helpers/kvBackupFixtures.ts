import {
  checksum,
  classifyKey,
  createArchive,
  PREFIXES,
} from "../../../scripts/kv-backup/format.mjs";
import type {
  ManifestV1,
  ManifestV2,
} from "../../../scripts/kv-backup/types.mjs";
import { createMockKV } from "./mockKv";

export const ACCOUNT = "a".repeat(32);
export const SOURCE = "b".repeat(32);
export const TARGET = "c".repeat(32);
export const NOW = Date.parse("2026-10-13T03:17:00.000Z");
export const UUID = "12345678-1234-1234-1234-123456789abc";
export const CAPACITY_UUID = "87654321-4321-4321-4321-cba987654321";
export const DATA_KEY = `daily/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.jsonl`;
export const MANIFEST_KEY = DATA_KEY.replace(/\.jsonl$/, ".manifest.json");

export interface RecordFixture {
  key: string;
  value: string;
  expiration?: number;
  metadata?: unknown;
}

/** One record per saved prefix, with non-canonical JSON spacing, an emoji and a `member:` bare string. */
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

/** A `user:` value pretty-printed with literal newlines, so a `\n` split would cut it apart. */
export const FORMATTED_USER: RecordFixture = {
  key: "user:formatted",
  value: JSON.stringify(
    { displayName: "家人 🐮", books: [{ bookId: "1", isShared: 1 }] },
    null,
    2,
  ),
};

/** R2 store fake for the restore CLI: holds object bytes only and exposes `get`, like `withR2Store`. */
export function archiveStore() {
  const objects = new Map<string, Buffer>();
  const trace: string[] = [];
  return {
    objects,
    trace,
    get: vi.fn(async (key: string) => {
      trace.push(`get:${key}`);
      const data = objects.get(key);
      if (!data) throw new Error("missing fixture object");
      return Buffer.from(data);
    }),
  };
}

/** Puts a manifest + data pair at {@link MANIFEST_KEY} / {@link DATA_KEY} of a fresh {@link archiveStore}. */
export function storeArchive(manifest: unknown, data: Buffer) {
  const store = archiveStore();
  store.objects.set(DATA_KEY, data);
  store.objects.set(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)));
  return store;
}

/** A version-2 archive built by the production `createArchive`, already stored. */
export function seededArchive(records: RecordFixture[] = recordsFixture()): {
  manifest: ManifestV2;
  data: Buffer;
  store: ReturnType<typeof archiveStore>;
} {
  const archive = createArchive(records, {
    accountId: ACCOUNT,
    namespaceId: SOURCE,
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    objectKey: DATA_KEY,
  });
  return { ...archive, store: storeArchive(archive.manifest, archive.data) };
}

/**
 * A legacy version-1 archive, built here because production can no longer
 * write one: one `JSON.stringify(record)` line per record (string values) and
 * a manifest carrying the whole-archive `sha256` from the still-exported `checksum`.
 */
export function v1Archive(records: RecordFixture[] = recordsFixture()): {
  manifest: ManifestV1;
  data: Buffer;
  store: ReturnType<typeof archiveStore>;
} {
  const data = Buffer.from(
    records.map((record) => JSON.stringify(record) + "\n").join(""),
  );
  const prefixCounts: Record<string, number> = Object.fromEntries(
    PREFIXES.map((prefix) => [prefix, 0]),
  );
  for (const record of records) prefixCounts[classifyKey(record.key)!]++;
  const manifest: ManifestV1 = {
    version: 1,
    sourceAccountId: ACCOUNT,
    sourceNamespaceId: SOURCE,
    startedAt: new Date(NOW).toISOString(),
    completedAt: new Date(NOW).toISOString(),
    count: records.length,
    prefixCounts,
    byteLength: data.length,
    sha256: checksum(data),
    dataObjectPath: DATA_KEY,
  };
  return { manifest, data, store: storeArchive(manifest, data) };
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
