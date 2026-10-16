import { BackupError } from "../../../scripts/kv-backup/format.mjs";
import { pingCheck } from "../../src/backup/heartbeat";
import { MultipartWriter, PART_BYTES } from "../../src/backup/multipart";
import {
  cleanOldSnapshots,
  publishLatest,
  readLatest,
} from "../../src/backup/retention";
import {
  MAX_ARCHIVE_BYTES,
  MAX_EXTERNAL_REQUESTS,
  MAX_INTERNAL_REQUESTS,
  readBounded,
  RunBudget,
} from "../../src/backup/runtime";
import {
  ACCOUNT,
  NOW,
  SOURCE,
  UUID,
  seededArchive,
} from "../helpers/kvBackupFixtures";
import {
  failure as rejectionOf,
  workerBucket,
} from "../helpers/kvBackupWorkerFixtures";

/**
 * Unit-level guards of the backup Worker's run machinery: `RunBudget`
 * (retry, internal / external request caps, deadline), `readBounded`, the
 * `MultipartWriter` part boundaries and 15 MB cap, latest.json retention
 * (compare-and-swap publish, cleanup sparing the latest pair) and the
 * Healthchecks `pingCheck`. The KV side is in `kvBackupWorkerSafety.test.ts`.
 *
 * Request accounting: every KV / R2 attempt (retries included) is one internal
 * request and every `fetch()` attempt one external request; the caps refuse
 * the request that would cross them BEFORE making it. Retries are capped at
 * 100 per run, after which a failure is returned without a retry.
 *
 * Messages are asserted exactly: every BackupError is a repo-authored constant
 * (`kvBackupErrorMessages.test.ts`).
 */

const oldKey = `snapshots/2026-09-01/2026-09-01T03-17-00-000Z_${UUID}.manifest.json`;
const newKey = `snapshots/2026-10-13/2026-10-13T03-17-00-000Z_${UUID}.manifest.json`;
const pointer = (manifestKey = oldKey) => ({
  manifestKey,
  completedAt: "2026-09-01T03:18:00.000Z",
  sourceAccountId: ACCOUNT,
  sourceNamespaceId: SOURCE,
});

function budget() {
  const sleep = vi.fn(async (_ms: number) => undefined);
  return { b: new RunBudget({ now: () => NOW, sleep }), sleep };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunBudget", () => {
  const CLOUDFLARE = "Cloudflare 備份操作失敗，已停止此次作業。";

  it("retries a remote failure once, then throws the constant without the remote text", async () => {
    const { b, sleep } = budget();
    const operation = vi.fn().mockRejectedValue(new Error("secret"));
    const error = await rejectionOf(b.call(operation));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(CLOUDFLARE);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(b.counts().internal).toBe(2);
    await expect(b.attempt(operation, false)).resolves.toEqual({ ok: false });
    const inner = new BackupError("bounded");
    await expect(b.call(vi.fn().mockRejectedValue(inner))).rejects.toBe(inner);
  });

  it("stops retrying after 100 retries in one run", async () => {
    const { b, sleep } = budget();
    const operation = vi.fn().mockRejectedValue(new Error("down"));
    for (let i = 0; i < 101; i++) await b.attempt(operation);
    expect(sleep).toHaveBeenCalledTimes(100);
    expect(b.counts().internal).toBe(201);
  });

  it("allows 1,000 internal requests and refuses the 1,001st before calling it", async () => {
    const { b } = budget();
    for (let i = 0; i < MAX_INTERNAL_REQUESTS; i++)
      await b.call(async () => undefined);
    const operation = vi.fn(async () => undefined);
    const error = await rejectionOf(b.call(operation));
    expect(error.message).toBe("備份超過內部請求上限，未完成此次作業。");
    expect(operation).not.toHaveBeenCalled();
  });

  it("allows 50 external requests and refuses the 51st", () => {
    const { b } = budget();
    for (let i = 0; i < MAX_EXTERNAL_REQUESTS; i++) b.countExternal();
    expect(b.counts()).toEqual({ internal: 0, external: 50 });
    expect(() => b.countExternal()).toThrow(
      /^備份超過對外請求上限，未完成此次作業。$/,
    );
  });

  it("refuses work once 12 minutes have elapsed", () => {
    let now = NOW;
    const timed = new RunBudget({ now: () => now });
    now = NOW + 12 * 60_000 - 1;
    expect(() => timed.check()).not.toThrow();
    now = NOW + 12 * 60_000;
    expect(() => timed.check()).toThrow(
      /^備份超過執行時間預算，未完成此次作業。$/,
    );
  });
});

describe("readBounded", () => {
  const chunks = (...parts: number[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((length, i) =>
          controller.enqueue(new Uint8Array(length).fill(i + 1)),
        );
        controller.close();
      },
    });
  it("joins chunks up to exactly the maximum", async () => {
    expect([...(await readBounded(chunks(2, 2), 4))]).toEqual([1, 1, 2, 2]);
  });
  it("refuses one byte over the maximum", async () => {
    const error = await rejectionOf(readBounded(chunks(3, 2), 4));
    expect(error.message).toBe("資料超過備份讀取容量限制。");
  });
});

describe("MultipartWriter", () => {
  async function writer() {
    const bucket = workerBucket();
    const upload = await bucket.createMultipartUpload("snapshot");
    const w = new MultipartWriter(
      upload as unknown as R2MultipartUpload,
      budget().b,
    );
    return { bucket, upload, w };
  }

  it("uploads full-size parts and the final remainder without altering bytes", async () => {
    const { bucket, upload, w } = await writer();
    const bytes = Buffer.alloc(PART_BYTES + 17, 42);
    await w.write(bytes.subarray(0, 100));
    await w.write(bytes.subarray(100));
    expect(await w.complete()).toEqual({
      byteLength: bytes.byteLength,
      objectSize: bytes.byteLength,
    });
    expect(
      upload.uploadPart.mock.calls.map(([n, part]) => [n, part.byteLength]),
    ).toEqual([
      [1, PART_BYTES],
      [2, 17],
    ]);
    expect(
      Buffer.from(bucket.objects.get("snapshot")!.bytes).equals(bytes),
    ).toBe(true);
    expect(w.completed).toBe(true);
  });

  it("refuses an empty completion", async () => {
    const { upload, w } = await writer();
    expect((await rejectionOf(w.complete())).message).toBe(
      "不能完成空白備份。",
    );
    expect(upload.complete).not.toHaveBeenCalled();
  });

  it("accepts exactly 15,000,000 bytes and refuses the next byte without uploading it", async () => {
    const { upload, w } = await writer();
    await w.write(new Uint8Array(MAX_ARCHIVE_BYTES));
    expect(upload.uploadPart).toHaveBeenCalledTimes(2);
    const error = await rejectionOf(w.write(new Uint8Array(1)));
    expect(error.message).toBe("備份超過 15 MB 限制。");
    expect(upload.uploadPart).toHaveBeenCalledTimes(2);
    expect(upload.complete).not.toHaveBeenCalled();
  });
});

describe("latest.json retention", () => {
  it("protects an old latest pair while deleting only eligible old snapshots", async () => {
    const b = workerBucket();
    const other = oldKey.replace(UUID, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    b.seed("latest.json", JSON.stringify(pointer()));
    for (const key of [
      oldKey,
      oldKey.replace(".manifest.json", ".jsonl"),
      other,
      "snapshots/not-a-snapshot",
      newKey,
    ])
      b.seed(key, "x", new Date("2026-09-01"));
    await cleanOldSnapshots(b.binding, budget().b);
    expect(b.remove.mock.calls).toEqual([[[other]]]);
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
      await expect(cleanOldSnapshots(b.binding, budget().b)).rejects.toThrow();
      expect(b.remove).not.toHaveBeenCalled();
    },
  );

  it("uses compare-and-swap and preserves a concurrent winner", async () => {
    const b = workerBucket();
    b.seed("latest.json", JSON.stringify(pointer()));
    const previous = await readLatest(b.binding, budget().b);
    const { manifest } = seededArchive();
    await publishLatest(b.binding, previous, newKey, manifest, budget().b);
    const winner = b.text("latest.json");
    const error = await rejectionOf(
      publishLatest(b.binding, previous, newKey, manifest, budget().b),
    );
    expect(error.message).toBe("另一個備份已完成，沒有覆寫最後成功備份。");
    expect(b.text("latest.json")).toBe(winner);
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
      const previous = await readLatest(b.binding, budget().b);
      const error = await rejectionOf(
        publishLatest(
          b.binding,
          previous,
          newKey,
          seededArchive().manifest,
          budget().b,
        ),
      );
      expect(error.message).toBe("最後成功備份較新或來源不同，沒有覆寫。");
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
    });
    const error = await rejectionOf(cleanOldSnapshots(b.binding, budget().b));
    expect(error.message).toBe("R2 清理分頁資訊不正確。");
    expect(b.list).toHaveBeenCalledTimes(2);
  });
});

describe("pingCheck", () => {
  it("sends only an empty POST to the fixed host and resolves true on 200 OK", async () => {
    const { b, sleep } = budget();
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));
    await expect(pingCheck(UUID, b, send)).resolves.toBe(true);
    expect(send.mock.calls).toEqual([
      [
        `https://hc-ping.com/${UUID}`,
        {
          method: "POST",
          body: "",
          redirect: "manual",
          signal: expect.any(AbortSignal),
        },
      ],
    ]);
    expect(b.counts()).toEqual({ internal: 0, external: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["not-OK", " OK\n", "", "x".repeat(129), "transport", "status"])(
    "resolves false on a %s answer after 3 attempts, each one external request",
    async (kind) => {
      const { b, sleep } = budget();
      const send = vi.fn<typeof fetch>();
      if (kind === "transport")
        send.mockRejectedValue(new Error(`https://hc-ping.com/${UUID}`));
      else
        send.mockImplementation(
          async () =>
            new Response(kind, { status: kind === "status" ? 500 : 200 }),
        );
      await expect(pingCheck(UUID, b, send)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(3);
      expect(b.counts().external).toBe(3);
      expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    },
  );

  it("refuses a malformed check UUID before any request", async () => {
    const { b } = budget();
    const send = vi.fn<typeof fetch>();
    const error = await rejectionOf(pingCheck("not-a-uuid", b, send));
    expect(error.message).toBe("獨立備份監看尚未設定完成。");
    expect(send).not.toHaveBeenCalled();
    expect(b.counts().external).toBe(0);
  });
});
