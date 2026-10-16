import type { Mock } from "vitest";
import { validateArchive } from "../../../scripts/kv-backup/format.mjs";
import type { BackupEnv } from "../../src/backup/runtime";
import {
  ACCOUNT,
  CAPACITY_UUID,
  NOW,
  SOURCE,
  UUID,
  type RecordFixture,
} from "./kvBackupFixtures";
import { createMockKV } from "./mockKv";

export function byteStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export interface ListedFixtureKey {
  name: string;
  expiration?: number;
}

export interface ListPage {
  keys: ListedFixtureKey[];
  list_complete: boolean;
  cursor?: string;
  cacheStatus: null;
}

export interface BatchEntry {
  value: string | null;
  metadata: unknown;
  cacheStatus: null;
}

/**
 * The backup Worker's view of ONE shared `createMockKV()` store, which owns
 * every value; this wrapper only adds what that mock does not model:
 *
 * - `list({ limit, cursor })` pages the store's keys in insertion order,
 *   `limit` (default 1000) per page, with the next offset as the cursor, and
 *   attaches each record's canned absolute `expiration`.
 * - `getWithMetadata(names, "text")` — the binding's array overload — answers
 *   a real `Map` keyed by name in request order, value read from the store,
 *   `metadata` canned from the fixture record.
 * - `failBatch(fn)` installs failure injection: `fn` sees the requested names
 *   before any read, and a returned Error is thrown by that call (an Error
 *   whose message contains `413` models the binding's 25 MB response cap).
 * - `expireOnRead(name, vanish)` models Cloudflare dropping a listed key whose
 *   TTL passed mid-run: the batch answers a null value for it, and with
 *   `vanish` the key is also deleted so the re-listing no longer carries it.
 * - `batchSizes()` is the number of names of every batch call, in call order.
 */
export async function workerKv(records: RecordFixture[]) {
  const base = createMockKV();
  for (const record of records) await base.put(record.key, record.value);
  const attributes = new Map(records.map((record) => [record.key, record]));
  const expiring = new Map<string, boolean>();
  let failure: (names: string[]) => Error | undefined = () => undefined;

  const list: Mock<(options?: KVNamespaceListOptions) => Promise<ListPage>> =
    vi.fn(async (options?: KVNamespaceListOptions) => {
      const names = (await base.list()).keys.map((key) => key.name);
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = names.slice(start, start + (options?.limit ?? 1000));
      const next = start + page.length;
      return {
        keys: page.map((name) => ({
          name,
          expiration: attributes.get(name)?.expiration,
        })),
        list_complete: next >= names.length,
        ...(next < names.length ? { cursor: String(next) } : {}),
        cacheStatus: null,
      };
    });

  const getWithMetadata: Mock<
    (names: string[], type: "text") => Promise<Map<string, BatchEntry>>
  > = vi.fn(async (names: string[]) => {
    const error = failure(names);
    if (error) throw error;
    const entries: [string, BatchEntry][] = [];
    for (const name of names) {
      if (expiring.get(name)) await base.delete(name);
      const value = expiring.has(name) ? null : await base.get(name);
      const metadata = attributes.get(name)?.metadata ?? null;
      entries.push([name, { value, metadata, cacheStatus: null }]);
    }
    return new Map(entries);
  });

  return {
    base,
    list,
    getWithMetadata,
    failBatch(fn: (names: string[]) => Error | undefined) {
      failure = fn;
    },
    expireOnRead(name: string, vanish: boolean) {
      expiring.set(name, vanish);
    },
    batchSizes: () => getWithMetadata.mock.calls.map(([names]) => names.length),
    binding: { ...base, list, getWithMetadata } as unknown as KVNamespace,
  };
}

export interface FixtureObject {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  body: ReadableStream<Uint8Array>;
}

export interface FixtureUpload {
  key: string;
  uploadId: string;
  uploadPart: Mock<
    (partNumber: number, bytes: Uint8Array) => Promise<R2UploadedPart>
  >;
  complete: Mock<(parts: R2UploadedPart[]) => Promise<FixtureObject>>;
  abort: Mock<() => Promise<void>>;
}

/**
 * Minimal R2 boundary: real byte streams, multipart assembly, `onlyIf`
 * conditional puts (`etagDoesNotMatch: "*"` / `etagMatches`) and a `trace` of
 * object writes. `faults.sizeSkew` is added to the `size` that
 * `upload.complete()` reports (R2 disagreeing with the bytes the Worker
 * wrote); `faults.onComplete` runs right after the object is committed.
 */
export function workerBucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; uploaded: Date; etag: string }
  >();
  const trace: string[] = [];
  const faults: { sizeSkew: number; onComplete?: () => void } = {
    sizeSkew: 0,
  };
  let revision = 0;
  function seed(
    key: string,
    value: string | Uint8Array,
    uploaded = new Date(NOW),
  ) {
    objects.set(key, {
      bytes:
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value.slice(),
      uploaded,
      etag: `revision-${++revision}`,
    });
  }
  function object(key: string): FixtureObject | null {
    const data = objects.get(key);
    return data
      ? {
          key,
          size: data.bytes.byteLength,
          etag: data.etag,
          uploaded: data.uploaded,
          body: byteStream(data.bytes),
        }
      : null;
  }
  const text = (key: string) =>
    new TextDecoder().decode(objects.get(key)!.bytes);
  const get = vi.fn(async (key: string) => {
    trace.push(`get:${key}`);
    return object(key);
  });
  const head = vi.fn(async (key: string) => object(key));
  const put = vi.fn(
    async (key: string, value: string, options?: R2PutOptions) => {
      trace.push(`put:${key}`);
      const condition = options?.onlyIf as R2Conditional | undefined;
      const existing = objects.get(key);
      if (
        (condition?.etagDoesNotMatch === "*" && existing) ||
        (condition?.etagMatches && condition.etagMatches !== existing?.etag)
      )
        return null;
      seed(key, value);
      return object(key);
    },
  );
  const uploads: FixtureUpload[] = [];
  const createMultipartUpload = vi.fn(async (key: string) => {
    const parts = new Map<number, Uint8Array>();
    const upload: FixtureUpload = {
      key,
      uploadId: "test-upload",
      uploadPart: vi.fn(async (partNumber: number, bytes: Uint8Array) => {
        parts.set(partNumber, bytes.slice());
        return { partNumber, etag: `part-${partNumber}` };
      }),
      complete: vi.fn(async (order: R2UploadedPart[]) => {
        seed(key, Buffer.concat(order.map((p) => parts.get(p.partNumber)!)));
        trace.push(`complete:${key}`);
        faults.onComplete?.();
        const committed = object(key)!;
        return { ...committed, size: committed.size + faults.sizeSkew };
      }),
      abort: vi.fn(async () => {
        trace.push(`abort:${key}`);
      }),
    };
    uploads.push(upload);
    return upload;
  });
  const list: Mock<
    (options?: R2ListOptions) => Promise<{
      objects: FixtureObject[];
      truncated: boolean;
      cursor?: string;
    }>
  > = vi.fn(async () => ({
    objects: [...objects.keys()]
      .filter((key) => key.startsWith("snapshots/"))
      .map((key) => object(key)!),
    truncated: false,
  }));
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      trace.push(`delete:${key}`);
      objects.delete(key);
    }
  });
  return {
    objects,
    trace,
    faults,
    seed,
    text,
    get,
    head,
    put,
    list,
    remove,
    uploads,
    createMultipartUpload,
    binding: {
      get,
      head,
      put,
      list,
      delete: remove,
      createMultipartUpload,
    } as unknown as R2Bucket,
  };
}

/** A configured, enabled run: fixed clock and UUID, no-op sleep, and a Healthchecks fetch that answers `OK`. */
export async function workerFixture(
  records: RecordFixture[] = [{ key: "user:reader", value: "{}" }],
) {
  const kv = await workerKv(records);
  const bucket = workerBucket();
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    bucket.trace.push(`ping:${String(url)}`);
    return new Response("OK");
  });
  const env: BackupEnv = {
    BACKUP_KV: kv.binding,
    BACKUP_BUCKET: bucket.binding,
    SOURCE_ACCOUNT_ID: ACCOUNT,
    SOURCE_NAMESPACE_ID: SOURCE,
    HEALTHCHECKS_UUID: UUID,
    HEALTHCHECKS_CAPACITY_UUID: CAPACITY_UUID,
    BACKUP_ENABLED: "true",
  };
  const deps = {
    now: () => NOW,
    uuid: () => UUID,
    sleep: vi.fn(async (_ms: number) => undefined),
    fetch: fetcher,
  };
  return { kv, bucket, fetcher, env, deps };
}

export const SUCCESS_PING = `https://hc-ping.com/${UUID}`;
export const CAPACITY_PING = `https://hc-ping.com/${CAPACITY_UUID}`;
/** Object keys a {@link workerFixture} run writes (fixed clock + UUID). */
export const RUN_DATA_KEY = `snapshots/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.jsonl`;
export const RUN_MANIFEST_KEY = RUN_DATA_KEY.replace(
  /\.jsonl$/,
  ".manifest.json",
);

type Fixture = Awaited<ReturnType<typeof workerFixture>>;

/** Healthchecks URLs pinged so far, in call order. */
export function pingedUrls(fetcher: Mock<typeof fetch>) {
  return fetcher.mock.calls.map(([url]) => String(url));
}

/** Reads the run's stored manifest + data back through the restore-side `validateArchive`. */
export function publishedArchive(bucket: Fixture["bucket"]) {
  const manifest: unknown = JSON.parse(bucket.text(RUN_MANIFEST_KEY));
  const data = Buffer.from(bucket.objects.get(RUN_DATA_KEY)!.bytes);
  const records = validateArchive(manifest, data, {
    accountId: ACCOUNT,
    namespaceId: SOURCE,
    manifestKey: RUN_MANIFEST_KEY,
  });
  return { manifest, data, records };
}

/** Resolves to the rejection of `promise`; fails the test when it fulfils. */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

/** No manifest, no latest.json and no Healthchecks ping: the run published nothing. */
export function expectNothingPublished(f: Fixture) {
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.bucket.objects.has("latest.json")).toBe(false);
  expect(f.bucket.objects.has(RUN_MANIFEST_KEY)).toBe(false);
  expect(
    f.bucket.put.mock.calls.filter(([key]) => key === RUN_MANIFEST_KEY),
  ).toEqual([]);
}
