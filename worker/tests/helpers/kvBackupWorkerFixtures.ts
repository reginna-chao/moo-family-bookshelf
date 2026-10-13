import { createHash } from "node:crypto";
import type { BackupEnv } from "../../src/backup/runtime";
import {
  ACCOUNT,
  SOURCE,
  NOW,
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

/** The shared mock owns values; these fixed attributes model metadata and absolute expiry only. */
export async function workerKv(records: RecordFixture[]) {
  const kv = createMockKV();
  for (const record of records) await kv.put(record.key, record.value);
  const list = vi.fn(async () => ({
    keys: (await kv.list()).keys.map(({ name }) => ({
      name,
      expiration: records.find((r) => r.key === name)?.expiration,
    })),
    list_complete: true,
    cacheStatus: null,
  }));
  const getWithMetadata = vi.fn(async (key: string) => {
    const value = await kv.get(key);
    return {
      value:
        value === null ? null : byteStream(new TextEncoder().encode(value)),
      metadata: records.find((r) => r.key === key)?.metadata ?? null,
      cacheStatus: null,
    };
  });
  return {
    base: kv,
    list,
    getWithMetadata,
    binding: { ...kv, list, getWithMetadata } as unknown as KVNamespace,
  };
}

/** Minimal R2 boundary with real byte streams, multipart assembly and conditional writes. */
export function workerBucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; uploaded: Date; etag: string }
  >();
  const trace: string[] = [];
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
  function object(key: string) {
    const data = objects.get(key);
    return data
      ? {
          key,
          size: data.bytes.byteLength,
          etag: data.etag,
          uploaded: data.uploaded,
          body: byteStream(data.bytes),
          text: async () => new TextDecoder().decode(data.bytes),
        }
      : null;
  }
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
  const uploads: {
    abort: ReturnType<typeof vi.fn>;
    uploadPart: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  }[] = [];
  const createMultipartUpload = vi.fn(async (key: string) => {
    const parts = new Map<number, Uint8Array>();
    const upload = {
      key,
      uploadId: "test-upload",
      uploadPart: vi.fn(async (partNumber: number, bytes: Uint8Array) => {
        parts.set(partNumber, bytes.slice());
        return {
          partNumber,
          etag: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
      complete: vi.fn(async (order: R2UploadedPart[]) => {
        seed(key, Buffer.concat(order.map((p) => parts.get(p.partNumber)!)));
        trace.push(`complete:${key}`);
        return object(key);
      }),
      abort: vi.fn(async () => {
        trace.push(`abort:${key}`);
      }),
    };
    uploads.push(upload);
    return upload;
  });
  const list = vi.fn(async () => ({
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
    seed,
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

export async function workerFixture(
  records: RecordFixture[] = [{ key: "user:reader", value: "{}" }],
) {
  const kv = await workerKv(records);
  const bucket = workerBucket();
  const fetcher = vi.fn<typeof fetch>(async () => {
    bucket.trace.push("heartbeat");
    return new Response("OK");
  });
  const env: BackupEnv = {
    BACKUP_KV: kv.binding,
    BACKUP_BUCKET: bucket.binding,
    SOURCE_ACCOUNT_ID: ACCOUNT,
    SOURCE_NAMESPACE_ID: SOURCE,
    HEALTHCHECKS_UUID: UUID,
    BACKUP_ENABLED: "true",
  };
  const deps = {
    now: () => NOW,
    uuid: () => UUID,
    sleep: vi.fn(async () => undefined),
    fetch: fetcher,
  };
  return { kv, bucket, fetcher, env, deps };
}
