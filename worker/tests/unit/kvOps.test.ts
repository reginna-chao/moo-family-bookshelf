/**
 * Unit tests for the KV op recorder itself (`tests/helpers/kvOps.ts`).
 *
 * Like the KV mock, this is test INFRASTRUCTURE that other suites lean on to
 * catch a real regression — and `writeTrail()` is the one accessor that can
 * fail SILENTLY. It builds its result by concatenating the `put` calls and then
 * the `delete` calls before sorting them by Vitest's global
 * `invocationCallOrder`, so if that ordering ever stopped working the sort
 * would be a no-op and every trail would come back as "all puts, then all
 * deletes" — which is exactly the shape the public-shelf revocation assertions
 * expect. They would keep passing while pinning nothing.
 *
 * The delete-BEFORE-put cases below are the anti-vacuity guard: that order can
 * only be reported if the sequencing is genuinely being read, since it is the
 * opposite of the concatenation order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";

const FIRST = "public:aaaa";
const SECOND = "publicshelves:alice";
const THIRD = "user:alice";

let kv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // The recorder installs `vi.spyOn` handlers and does not clean up after
  // itself — see its docblock.
  vi.restoreAllMocks();
});

describe("watchKvOps writeTrail", () => {
  it("reports a delete that ran BEFORE a put in that order", async () => {
    const ops = watchKvOps(kv);

    await kv.delete(FIRST);
    await kv.put(SECOND, "v");

    expect(ops.writeTrail()).toEqual([`delete ${FIRST}`, `put ${SECOND}`]);
  });

  it("reports a put that ran BEFORE a delete in that order", async () => {
    const ops = watchKvOps(kv);

    await kv.put(SECOND, "v");
    await kv.delete(FIRST);

    expect(ops.writeTrail()).toEqual([`put ${SECOND}`, `delete ${FIRST}`]);
  });

  it("preserves the sequence of interleaved writes", async () => {
    const ops = watchKvOps(kv);

    await kv.put(FIRST, "v");
    await kv.delete(SECOND);
    await kv.put(THIRD, "v");
    await kv.delete(FIRST);

    expect(ops.writeTrail()).toEqual([
      `put ${FIRST}`,
      `delete ${SECOND}`,
      `put ${THIRD}`,
      `delete ${FIRST}`,
    ]);
  });

  it("excludes reads, which the per-op getKeys list still records", async () => {
    // A write-order rule must not break because a read moved or was added.
    const ops = watchKvOps(kv);

    await kv.get(THIRD);
    await kv.put(SECOND, "v");
    await kv.get(FIRST);
    await kv.delete(FIRST);

    expect(ops.writeTrail()).toEqual([`put ${SECOND}`, `delete ${FIRST}`]);
    expect(ops.getKeys()).toEqual([THIRD, FIRST]);
  });

  it("is empty when nothing was written", async () => {
    const ops = watchKvOps(kv);

    await kv.get(THIRD);

    expect(ops.writeTrail()).toEqual([]);
  });

  it("counts only what happened AFTER the recorder was installed", async () => {
    // Seeding runs before `watchKvOps` on purpose across the suites, so a
    // fixture write must never show up in the trail under test.
    await kv.put(FIRST, "seeded");
    const ops = watchKvOps(kv);

    await kv.delete(FIRST);

    expect(ops.writeTrail()).toEqual([`delete ${FIRST}`]);
  });

  it("records every write straight through to the underlying namespace", async () => {
    // The recorder observes, it never substitutes — so the mock's TTL floor is
    // still live while a handler is being watched.
    const ops = watchKvOps(kv);

    await kv.put(SECOND, "v");
    await expect(kv.put(THIRD, "v", { expirationTtl: 30 })).rejects.toThrow(
      "must be at least 60",
    );

    expect(await kv.get(SECOND)).toBe("v");
    expect(await kv.get(THIRD)).toBeNull();
    // The refused put still ran, so it is still part of the trail.
    expect(ops.writeTrail()).toEqual([`put ${SECOND}`, `put ${THIRD}`]);
  });
});
