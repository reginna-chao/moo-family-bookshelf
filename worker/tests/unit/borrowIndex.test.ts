/**
 * Unit tests for `src/services/borrowIndex.ts` — the family borrow index.
 *
 * Since #160 item 2 `borrows:family:{familyId}` holds the full
 * `BorrowRequest[]` and is the SINGLE SOURCE OF TRUTH, while
 * `borrow:{requestId}` is only a `{ familyId }` pointer. This file covers that
 * module directly; the HTTP-level consequences live in
 * tests/integration/borrowIndexMigration.test.ts and the budget suites.
 *
 * `BORROW_HISTORY_KEEP` is imported, never spelled as `20`: the cap is a
 * product decision that may move, and a hard-coded 20 here would turn a
 * deliberate change into a test failure that says nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  BORROW_HISTORY_KEEP,
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
} from "../../src/kv/schema";
import {
  deleteBorrowIndex,
  isLegacyBorrowIndex,
  readBorrowIndex,
  readBorrowPointer,
  settleDepartingBorrower,
  trimBorrowIndex,
  writeBorrowIndex,
} from "../../src/services/borrowIndex";
import { isValidFamilyId } from "../../src/utils/validation";
import { USER1, USER2, USER3 } from "../helpers/ids";

const FAMILY_ID = "abcd-1234";
const OTHER_FAMILY_ID = "wxyz-9876";
const BASE_MS = Date.parse("2026-03-01T12:00:00.000Z");

/**
 * Values a corrupted `borrow:{requestId}` could carry that are non-empty
 * strings yet not well-formed familyIds. The second one is the reason the
 * check is a FORMAT check and not a truthiness check: it is what a key-shaping
 * value looks like.
 *
 * Kept honest by the `isValidFamilyId` assertion in the `readBorrowPointer`
 * block below rather than by this comment.
 */
const MALFORMED_FAMILY_IDS = ["not-a-family", "../x"];

/**
 * Two borrowers in ONE family. The history cap is per `borrowerId`, so every
 * case that claims "A's overflow does not touch B" needs both, and the family
 * total in those cases deliberately exceeds `BORROW_HISTORY_KEEP` — a
 * family-wide cap would evict there and the test would go red.
 */
const BORROWER_A = USER1;
const BORROWER_B = USER3;

let kv: KVNamespace;

/** Deterministic v4-shaped requestId (RequestIdSchema, src/schemas/common.ts). */
function requestIdAt(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`;
}

/**
 * One record whose timestamps INCREASE with `index`, so "newest" is always the
 * highest index and the recency ordering under test is readable at the call
 * site. Both stamps are ISO-8601 UTC, matching what production writes.
 */
function makeRecord(
  index: number,
  overrides: Partial<BorrowRequest> = {},
): BorrowRequest {
  const at = new Date(BASE_MS + index * 1000).toISOString();
  return {
    requestId: requestIdAt(index),
    familyId: FAMILY_ID,
    borrowerId: USER1,
    borrowerName: "Alice",
    ownerId: USER2,
    bookId: `book-${index}`,
    bookTitle: `Book ${index}`,
    bookAuthor: "Author",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** `count` records of one status, oldest first. */
function makeRecords(
  count: number,
  status: BorrowStatus,
  from = 0,
): BorrowRequest[] {
  return Array.from({ length: count }, (_, i) =>
    makeRecord(from + i, { status }),
  );
}

/**
 * `count` records of one status for ONE borrower, oldest first.
 *
 * `from` also seeds the requestId and the timestamps, so two borrowers must be
 * given disjoint ranges or their records would collide on both.
 */
function makeRecordsFor(
  borrowerId: string,
  count: number,
  status: BorrowStatus,
  from: number,
): BorrowRequest[] {
  return Array.from({ length: count }, (_, i) =>
    makeRecord(from + i, { status, borrowerId }),
  );
}

const ids = (records: BorrowRequest[]): string[] =>
  records.map((r) => r.requestId);

/** Current storage: records in the index + a `{ familyId }` pointer per record. */
async function seedIndex(records: BorrowRequest[]): Promise<void> {
  for (const record of records) {
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(pointer));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(records));
}

/** Pre-migration storage: `string[]` index + a FULL record per `borrow:{id}`. */
async function seedLegacyIndex(records: BorrowRequest[]): Promise<void> {
  for (const record of records) {
    await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(record));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(ids(records)));
}

/** The raw stored index, unparsed — so its SHAPE can be asserted. */
async function storedIndex(): Promise<unknown> {
  return await kv.get(kvKeys.borrowsByFamily(FAMILY_ID), "json");
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // watchKvOps installs vi.spyOn handlers and does not clean up after itself.
  vi.restoreAllMocks();
});

// ===========================================================================
// isLegacyBorrowIndex
// ===========================================================================

describe("isLegacyBorrowIndex", () => {
  it.each([
    { label: "an array of requestId strings", value: ["a", "b"], legacy: true },
    {
      label: "an EMPTY array (both shapes serialize an empty family alike)",
      value: [],
      legacy: false,
    },
    { label: "an array of records", value: [makeRecord(0)], legacy: false },
    {
      label: "an array whose first element is null",
      value: [null],
      legacy: false,
    },
    { label: "a bare string", value: "aaaa", legacy: false },
    { label: "an object", value: { shelves: [] }, legacy: false },
    { label: "null", value: null, legacy: false },
    { label: "undefined", value: undefined, legacy: false },
  ])("classifies $label as legacy=$legacy", ({ value, legacy }) => {
    expect(isLegacyBorrowIndex(value)).toBe(legacy);
  });
});

// ===========================================================================
// readBorrowIndex
// ===========================================================================

describe("readBorrowIndex", () => {
  it("returns an empty non-legacy read when the index key is absent", async () => {
    const ops = watchKvOps(kv);

    expect(await readBorrowIndex(kv, FAMILY_ID)).toEqual({
      requests: [],
      legacy: false,
    });
    // One get, and it is the index key — the positive companion that stops the
    // "no fan-out" claim from passing because nothing was read at all.
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
  });

  it("does not fan out over an empty stored index", async () => {
    await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify([]));

    const ops = watchKvOps(kv);
    const read = await readBorrowIndex(kv, FAMILY_ID);

    expect(read).toEqual({ requests: [], legacy: false });
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
  });

  it("degrades a corrupted non-array container to an empty list", async () => {
    // Boundary guard: a `kv.get(…, "json")` cast nothing validates must not
    // throw a TypeError into a 500.
    await kv.put(
      kvKeys.borrowsByFamily(FAMILY_ID),
      JSON.stringify({ requests: "nope" }),
    );

    expect(await readBorrowIndex(kv, FAMILY_ID)).toEqual({
      requests: [],
      legacy: false,
    });
  });

  it("returns a new-shape index as-is, with exactly one KV read", async () => {
    const records = makeRecords(3, BorrowStatus.PENDING);
    await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(records));

    const ops = watchKvOps(kv);
    const read = await readBorrowIndex(kv, FAMILY_ID);

    expect(read.legacy).toBe(false);
    expect(read.requests).toEqual(records);
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
  });

  it("fans a legacy string[] index out once, in index order", async () => {
    const records = makeRecords(3, BorrowStatus.PENDING);
    for (const record of records) {
      await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(record));
    }
    await kv.put(
      kvKeys.borrowsByFamily(FAMILY_ID),
      JSON.stringify(ids(records)),
    );

    const ops = watchKvOps(kv);
    const read = await readBorrowIndex(kv, FAMILY_ID);

    expect(read.legacy).toBe(true);
    expect(ids(read.requests)).toEqual(ids(records));
    expect(ops.getKeys()).toEqual([
      kvKeys.borrowsByFamily(FAMILY_ID),
      ...ids(records).map(kvKeys.borrow),
    ]);
    // A pure read: the fan-out must not migrate anything.
    expect(ops.writeTrail()).toEqual([]);
  });

  it("drops legacy entries whose record no longer exists", async () => {
    const records = makeRecords(3, BorrowStatus.PENDING);
    // The middle record is missing — an old index can outlive what it names.
    for (const record of [records[0], records[2]]) {
      await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(record));
    }
    await kv.put(
      kvKeys.borrowsByFamily(FAMILY_ID),
      JSON.stringify(ids(records)),
    );

    const read = await readBorrowIndex(kv, FAMILY_ID);

    expect(read.legacy).toBe(true);
    expect(ids(read.requests)).toEqual([
      records[0].requestId,
      records[2].requestId,
    ]);
  });
});

// ===========================================================================
// readBorrowPointer
// ===========================================================================

describe("readBorrowPointer", () => {
  const REQUEST_ID = requestIdAt(0);

  it("resolves a new-shape pointer to its familyId", async () => {
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify(pointer));

    expect(await readBorrowPointer(kv, REQUEST_ID)).toBe(FAMILY_ID);
  });

  it("resolves a legacy full record to its familyId", async () => {
    // The legacy value is a SUPERSET of the pointer, so it serves unchanged —
    // and nothing else on it is read, which is why it is never rewritten.
    const record = makeRecord(0, { familyId: OTHER_FAMILY_ID });
    await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify(record));

    expect(await readBorrowPointer(kv, REQUEST_ID)).toBe(OTHER_FAMILY_ID);
  });

  it.each([
    { label: "an absent key", stored: undefined },
    { label: "a stored null", stored: null },
    { label: "an object with no familyId", stored: {} },
    { label: "a non-string familyId", stored: { familyId: 123 } },
    { label: "a null familyId", stored: { familyId: null } },
    { label: "an empty-string familyId", stored: { familyId: "" } },
    { label: "a JSON string value", stored: "not-an-object" },
    { label: "an array value", stored: [] },
  ])("returns null for $label", async ({ stored }) => {
    if (stored !== undefined) {
      await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify(stored));
    }

    expect(await readBorrowPointer(kv, REQUEST_ID)).toBeNull();
  });

  // A non-empty string is NOT enough. The value read here is interpolated
  // straight into the `borrows:family:{familyId}` key that PATCH then reads AND
  // rewrites, so a corrupted pointer must not be able to aim that
  // read-modify-write at an arbitrary key.
  it("uses the production familyId format rule, so these fixtures cannot go stale", () => {
    // Derived, not asserted from memory: FAMILY_ID is the guaranteed-accepted
    // companion and MALFORMED_FAMILY_IDS the guaranteed-rejected examples. If
    // the format rule ever widens to admit one of them, this fails here rather
    // than leaving the cases below passing vacuously.
    expect(isValidFamilyId(FAMILY_ID)).toBe(true);
    for (const familyId of MALFORMED_FAMILY_IDS) {
      expect(isValidFamilyId(familyId)).toBe(false);
    }
  });

  it.each(MALFORMED_FAMILY_IDS)(
    "returns null for a pointer whose familyId is %j",
    async (familyId) => {
      await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify({ familyId }));

      expect(await readBorrowPointer(kv, REQUEST_ID)).toBeNull();
    },
  );

  it("does not read the index key it would have derived from a malformed familyId", async () => {
    await kv.put(
      kvKeys.borrow(REQUEST_ID),
      JSON.stringify({ familyId: MALFORMED_FAMILY_IDS[1] }),
    );

    const ops = watchKvOps(kv);
    expect(await readBorrowPointer(kv, REQUEST_ID)).toBeNull();

    // Only the pointer is touched, and nothing is written: the rejected value
    // never reaches a key. The positive half of the assertion (the pointer key
    // IS read) stops the negative half from passing because no KV call
    // happened at all.
    expect(ops.getKeys()).toEqual([kvKeys.borrow(REQUEST_ID)]);
    expect(ops.writeTrail()).toEqual([]);
  });
});

// ===========================================================================
// trimBorrowIndex
// ===========================================================================

describe("trimBorrowIndex", () => {
  // One record per status, repeated past the cap. Only the three TERMINAL
  // statuses may ever be evicted; PENDING / LENT stay at any count, and an
  // unrecognised status value counts as non-terminal (fail-safe: an unknown
  // state is not provably finished, so it is not silently discarded).
  it.each([
    { label: "PENDING", status: BorrowStatus.PENDING, droppable: false },
    { label: "LENT", status: BorrowStatus.LENT, droppable: false },
    { label: "RETURNED", status: BorrowStatus.RETURNED, droppable: true },
    { label: "REJECTED", status: BorrowStatus.REJECTED, droppable: true },
    { label: "CANCELLED", status: BorrowStatus.CANCELLED, droppable: true },
    {
      label: "an unrecognised status value",
      status: 99 as BorrowStatus,
      droppable: false,
    },
  ])(
    "evicts nothing beyond the cap for $label unless it is terminal",
    ({ status, droppable }) => {
      const requests = makeRecords(BORROW_HISTORY_KEEP + 1, status);

      const { kept, dropped } = trimBorrowIndex(requests);

      expect(dropped).toHaveLength(droppable ? 1 : 0);
      expect(kept).toHaveLength(requests.length - dropped.length);
    },
  );

  it("returns the input untouched when the terminal count is under the cap", () => {
    const requests = makeRecords(5, BorrowStatus.RETURNED);

    expect(trimBorrowIndex(requests)).toEqual({ kept: requests, dropped: [] });
  });

  it("keeps exactly BORROW_HISTORY_KEEP terminal records at the cap", () => {
    const requests = makeRecords(BORROW_HISTORY_KEEP, BorrowStatus.RETURNED);

    const { kept, dropped } = trimBorrowIndex(requests);

    expect(dropped).toEqual([]);
    expect(ids(kept)).toEqual(ids(requests));
  });

  it("evicts the oldest terminal record by updatedAt once the cap is exceeded", () => {
    const requests = makeRecords(
      BORROW_HISTORY_KEEP + 1,
      BorrowStatus.RETURNED,
    );

    const { kept, dropped } = trimBorrowIndex(requests);

    // makeRecord's timestamps grow with the index, so index 0 is the oldest.
    expect(ids(dropped)).toEqual([requests[0].requestId]);
    expect(ids(kept)).toEqual(ids(requests.slice(1)));
  });

  it("breaks an updatedAt tie on the older createdAt", () => {
    const sameUpdatedAt = new Date(BASE_MS + 999_000).toISOString();
    const requests = makeRecords(
      BORROW_HISTORY_KEEP + 1,
      BorrowStatus.RETURNED,
    ).map((r) => ({ ...r, updatedAt: sameUpdatedAt }));

    const { dropped } = trimBorrowIndex(requests);

    // createdAt still grows with the index, so index 0 loses the tie-break.
    expect(ids(dropped)).toEqual([requests[0].requestId]);
  });

  it("never evicts an active request even when history is far over the cap", () => {
    const active = [
      makeRecord(500, { status: BorrowStatus.PENDING }),
      makeRecord(501, { status: BorrowStatus.LENT }),
    ];
    const terminal = makeRecords(
      BORROW_HISTORY_KEEP + 10,
      BorrowStatus.RETURNED,
    );
    const requests = [...active, ...terminal];

    const { kept, dropped } = trimBorrowIndex(requests);

    expect(dropped).toHaveLength(10);
    expect(ids(dropped)).toEqual(ids(terminal.slice(0, 10)));
    expect(ids(kept)).toEqual(expect.arrayContaining(ids(active)));
  });

  // -------------------------------------------------------------------------
  // The cap is PER borrowerId, not per family
  // -------------------------------------------------------------------------
  //
  // A family-wide cap would let the most active member's finished borrows
  // evict everyone else's history — one member silently destroying another's
  // records on a shared value. Every case below therefore holds a family total
  // ABOVE BORROW_HISTORY_KEEP while each borrower's own group stays at or
  // below it, which is exactly where the two rules disagree.

  it("evicts the overflowing borrower's oldest record and leaves the other borrower alone", () => {
    // A is one over its own cap; B holds 5. Family total is
    // BORROW_HISTORY_KEEP + 6 — well over a family-wide cap, which would evict
    // 6 records here (and reach into B's).
    const aRecords = makeRecordsFor(
      BORROWER_A,
      BORROW_HISTORY_KEEP + 1,
      BorrowStatus.RETURNED,
      0,
    );
    const bRecords = makeRecordsFor(BORROWER_B, 5, BorrowStatus.RETURNED, 1000);

    const { kept, dropped } = trimBorrowIndex([...aRecords, ...bRecords]);

    expect(ids(dropped)).toEqual([aRecords[0].requestId]);
    expect(ids(kept)).toEqual([...ids(aRecords.slice(1)), ...ids(bRecords)]);
  });

  it("evicts nothing when two borrowers are each exactly at the cap", () => {
    // Family total is 2 × BORROW_HISTORY_KEEP, so a family-wide cap would drop
    // half of them.
    const aRecords = makeRecordsFor(
      BORROWER_A,
      BORROW_HISTORY_KEEP,
      BorrowStatus.RETURNED,
      0,
    );
    const bRecords = makeRecordsFor(
      BORROWER_B,
      BORROW_HISTORY_KEEP,
      BorrowStatus.RETURNED,
      1000,
    );
    const requests = [...aRecords, ...bRecords];

    expect(trimBorrowIndex(requests)).toEqual({ kept: requests, dropped: [] });
  });

  it("never reaches into another borrower's records however far one overflows", () => {
    // B's records carry the LOWEST indices, so they are the oldest in the
    // family — a recency-ordered family-wide cap would evict B's first.
    const bRecords = makeRecordsFor(BORROWER_B, 3, BorrowStatus.RETURNED, 0);
    const aRecords = makeRecordsFor(
      BORROWER_A,
      BORROW_HISTORY_KEEP + 7,
      BorrowStatus.RETURNED,
      100,
    );

    const { kept, dropped } = trimBorrowIndex([...bRecords, ...aRecords]);

    expect(dropped).toHaveLength(7);
    expect(dropped.every((r) => r.borrowerId === BORROWER_A)).toBe(true);
    expect(ids(dropped)).toEqual(ids(aRecords.slice(0, 7)));
    expect(ids(kept)).toEqual([...ids(bRecords), ...ids(aRecords.slice(7))]);
  });

  it("leaves the overflowing borrower's own PENDING and LENT records untouched", () => {
    const aPending = makeRecord(700, {
      status: BorrowStatus.PENDING,
      borrowerId: BORROWER_A,
    });
    const aLent = makeRecord(701, {
      status: BorrowStatus.LENT,
      borrowerId: BORROWER_A,
    });
    const aTerminal = makeRecordsFor(
      BORROWER_A,
      BORROW_HISTORY_KEEP + 3,
      BorrowStatus.CANCELLED,
      0,
    );
    const bRecords = makeRecordsFor(BORROWER_B, 4, BorrowStatus.LENT, 1000);

    const { kept, dropped } = trimBorrowIndex([
      aPending,
      aLent,
      ...aTerminal,
      ...bRecords,
    ]);

    // Only terminal records of the overflowing borrower are ever evicted.
    expect(ids(dropped)).toEqual(ids(aTerminal.slice(0, 3)));
    expect(ids(kept)).toEqual([
      aPending.requestId,
      aLent.requestId,
      ...ids(aTerminal.slice(3)),
      ...ids(bRecords),
    ]);
  });

  it("preserves the input order in kept", () => {
    // Terminal records interleaved with active ones, so an implementation that
    // reshuffled by recency (the order the CAP is computed in) would fail here.
    const terminal = makeRecords(
      BORROW_HISTORY_KEEP + 1,
      BorrowStatus.RETURNED,
    );
    const requests: BorrowRequest[] = [];
    terminal.forEach((record, i) => {
      requests.push(record);
      if (i % 5 === 0) {
        requests.push(makeRecord(600 + i, { status: BorrowStatus.PENDING }));
      }
    });

    const { kept, dropped } = trimBorrowIndex(requests);

    const droppedIds = new Set(ids(dropped));
    expect(ids(kept)).toEqual(
      ids(requests).filter((id) => !droppedIds.has(id)),
    );
  });
});

// ===========================================================================
// writeBorrowIndex
// ===========================================================================

describe("writeBorrowIndex", () => {
  it("stores the trimmed index and reports nothing dropped under the cap", async () => {
    const requests = makeRecords(5, BorrowStatus.RETURNED);

    const ops = watchKvOps(kv);
    const { dropped } = await writeBorrowIndex(kv, FAMILY_ID, requests);

    expect(dropped).toEqual([]);
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);
    const stored = await kv.get<BorrowRequest[]>(
      kvKeys.borrowsByFamily(FAMILY_ID),
      "json",
    );
    expect(stored).toEqual(requests);
  });

  it("writes the index BEFORE deleting an evicted record's pointer", async () => {
    const requests = makeRecords(
      BORROW_HISTORY_KEEP + 1,
      BorrowStatus.RETURNED,
    );
    for (const record of requests) {
      const pointer: BorrowPointer = { familyId: FAMILY_ID };
      await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(pointer));
    }

    const ops = watchKvOps(kv);
    const { dropped } = await writeBorrowIndex(kv, FAMILY_ID, requests);

    expect(ids(dropped)).toEqual([requests[0].requestId]);
    // Order is load-bearing: the index is the truth, so it must land first. A
    // delete that runs first and is then followed by a failed index put would
    // leave an index entry whose PATCH can never resolve its family.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
      `delete ${kvKeys.borrow(requests[0].requestId)}`,
    ]);

    // The evicted record is gone from BOTH keys; the survivors keep theirs.
    expect(await kv.get(kvKeys.borrow(requests[0].requestId))).toBeNull();
    expect(await kv.get(kvKeys.borrow(requests[1].requestId))).not.toBeNull();
    const stored = await kv.get<BorrowRequest[]>(
      kvKeys.borrowsByFamily(FAMILY_ID),
      "json",
    );
    expect(ids(stored ?? [])).toEqual(ids(requests.slice(1)));
  });

  it("deletes one pointer per evicted record", async () => {
    const requests = makeRecords(
      BORROW_HISTORY_KEEP + 5,
      BorrowStatus.RETURNED,
    );

    const ops = watchKvOps(kv);
    const { dropped } = await writeBorrowIndex(kv, FAMILY_ID, requests);

    expect(ops.deleteKeys()).toEqual(ids(dropped).map(kvKeys.borrow));
    expect(ops.deleteKeys()).toHaveLength(5);
  });

  // FAIL-OPEN cleanup. The index put has already landed by the time the
  // evicted pointers are deleted, so letting a rejected delete propagate would
  // turn a persisted, successful write into a 500 and tell the caller their
  // borrow failed when it did not. The cost of swallowing it is one orphan
  // `borrow:{id}` key whose record is out of the index either way.
  it("still resolves when an evicted pointer's delete rejects, and logs it", async () => {
    const requests = makeRecords(
      BORROW_HISTORY_KEEP + 2,
      BorrowStatus.RETURNED,
    );
    for (const record of requests) {
      const pointer: BorrowPointer = { familyId: FAMILY_ID };
      await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(pointer));
    }

    // Exactly ONE of the two evictions fails, so the other one proves the
    // remaining deletes were still attempted rather than abandoned.
    const failingKey = kvKeys.borrow(requests[0].requestId);
    const realDelete = kv.delete.bind(kv);
    const deleteSpy = vi
      .spyOn(kv, "delete")
      .mockImplementation(async (key: string) => {
        if (key === failingKey) throw new Error("KV delete rejected");
        await realDelete(key);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves rather than rejects — this line IS the assertion.
    const { dropped } = await writeBorrowIndex(kv, FAMILY_ID, requests);

    expect(ids(dropped)).toEqual(ids(requests.slice(0, 2)));

    // The index write still counts: the trimmed list is what is stored.
    const stored = await kv.get<BorrowRequest[]>(
      kvKeys.borrowsByFamily(FAMILY_ID),
      "json",
    );
    expect(ids(stored ?? [])).toEqual(ids(requests.slice(2)));

    // Both deletes were attempted, and the one that could succeed did.
    expect(deleteSpy.mock.calls.map((call) => call[0])).toEqual([
      failingKey,
      kvKeys.borrow(requests[1].requestId),
    ]);
    expect(await kv.get(failingKey)).not.toBeNull();
    expect(await kv.get(kvKeys.borrow(requests[1].requestId))).toBeNull();

    // Swallowed, but never silent: the orphan key is named so it can be found.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "BORROW_POINTER_DELETE_FAILED",
      expect.objectContaining({ requestId: requests[0].requestId }),
    );
  });

  it("migrates a legacy family: the next read is new-shape and costs one get", async () => {
    const records = makeRecords(3, BorrowStatus.PENDING);
    for (const record of records) {
      await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(record));
    }
    await kv.put(
      kvKeys.borrowsByFamily(FAMILY_ID),
      JSON.stringify(ids(records)),
    );

    const before = await readBorrowIndex(kv, FAMILY_ID);
    expect(before.legacy).toBe(true);

    await writeBorrowIndex(kv, FAMILY_ID, before.requests);

    const ops = watchKvOps(kv);
    const after = await readBorrowIndex(kv, FAMILY_ID);

    expect(after.legacy).toBe(false);
    expect(ids(after.requests)).toEqual(ids(records));
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);

    // The legacy `borrow:{id}` values are left alone — they become stale copies
    // that no reader consults, but their EXISTENCE is now the pointer.
    expect(await readBorrowPointer(kv, records[0].requestId)).toBe(FAMILY_ID);
  });
});

// ===========================================================================
// settleDepartingBorrower
// ===========================================================================
//
// Two steps in one call: CANCEL every PENDING request the departing member is
// either side of, then PURGE from the index every TERMINAL record they
// BORROWED — the just-cancelled ones included — and delete those pointers.
//
// The purge is security finding F-1's fix: the history cap is keyed on
// `borrowerId` and a borrowerId is free to mint, so a leaver's finished records
// would otherwise sit in the shared index under an id that never writes again
// and can never be trimmed. The line it must NOT cross is the OWNER side: those
// records belong to the member who stays, and purging by `ownerId` would hand a
// leaver a lever to delete someone else's history on the way out.

/** The departing member — `makeRecord` already borrows as USER1 from USER2. */
const LEAVER = USER1;
/** The counterparty who stays behind. Same id as BORROWER_B, different role. */
const STAYER = USER3;

describe("settleDepartingBorrower", () => {
  it("settles nothing and writes nothing for a family with no index", async () => {
    const ops = watchKvOps(kv);

    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 0,
      evicted: 0,
    });
    // One read, and it is the index key — the positive companion that stops
    // "wrote nothing" from passing because no KV call happened at all.
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
    expect(ops.writeTrail()).toEqual([]);
  });

  // The leaver's OWN borrow, one record, by status. PENDING is cancelled and
  // then purged in the same pass; the other terminal states were already
  // finished; LENT is the one active state that survives, because the book may
  // still physically be out on loan and the owner must be able to close it.
  it.each([
    {
      label: "PENDING",
      status: BorrowStatus.PENDING,
      cancelled: 1,
      evicted: 1,
      survives: false,
    },
    {
      label: "RETURNED",
      status: BorrowStatus.RETURNED,
      cancelled: 0,
      evicted: 1,
      survives: false,
    },
    {
      label: "REJECTED",
      status: BorrowStatus.REJECTED,
      cancelled: 0,
      evicted: 1,
      survives: false,
    },
    {
      label: "CANCELLED",
      status: BorrowStatus.CANCELLED,
      cancelled: 0,
      evicted: 1,
      survives: false,
    },
    {
      label: "LENT",
      status: BorrowStatus.LENT,
      cancelled: 0,
      evicted: 0,
      survives: true,
    },
  ])(
    "settles the leaver's own $label record as cancelled=$cancelled evicted=$evicted",
    async ({ status, cancelled, evicted, survives }) => {
      const record = makeRecord(0, { status });
      await seedIndex([record]);

      expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
        cancelled,
        evicted,
      });

      const stored = (await storedIndex()) as BorrowRequest[];
      expect(ids(stored)).toEqual(survives ? [record.requestId] : []);
      // The pointer follows the index entry, in both directions.
      expect(await kv.get(kvKeys.borrow(record.requestId))).toEqual(
        survives ? expect.any(String) : null,
      );
    },
  );

  it("cancels a PENDING request the leaver only OWNED, and keeps it", async () => {
    // The counterparty's record: cancelled, because the lender is walking out,
    // but it stays in the index as the STAYER's own history.
    const record = makeRecord(0, { borrowerId: STAYER, ownerId: LEAVER });
    await seedIndex([record]);

    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 1,
      evicted: 0,
    });

    const stored = (await storedIndex()) as BorrowRequest[];
    expect(ids(stored)).toEqual([record.requestId]);
    expect(stored[0].status).toBe(BorrowStatus.CANCELLED);
    expect(await kv.get(kvKeys.borrow(record.requestId))).not.toBeNull();
  });

  it("keeps a finished record the leaver only OWNED, and writes nothing", async () => {
    // The load-bearing negative: purging by `ownerId` too would let a departing
    // member delete a remaining member's finished history.
    const record = makeRecord(0, {
      borrowerId: STAYER,
      ownerId: LEAVER,
      status: BorrowStatus.RETURNED,
    });
    await seedIndex([record]);

    const ops = watchKvOps(kv);
    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 0,
      evicted: 0,
    });

    expect(ops.writeTrail()).toEqual([]);
    expect(ids((await storedIndex()) as BorrowRequest[])).toEqual([
      record.requestId,
    ]);
    expect(await kv.get(kvKeys.borrow(record.requestId))).not.toBeNull();
  });

  it("writes the index BEFORE deleting the evicted pointers, one delete each", async () => {
    const purged = [
      makeRecord(0, { status: BorrowStatus.RETURNED }),
      makeRecord(1, { status: BorrowStatus.PENDING }),
    ];
    const kept = makeRecord(2, {
      borrowerId: STAYER,
      ownerId: USER2,
      status: BorrowStatus.LENT,
    });
    await seedIndex([...purged, kept]);

    const ops = watchKvOps(kv);
    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 1,
      evicted: 2,
    });

    // Order is load-bearing and matches the module's standing rule: the index
    // is the truth, so it lands first. Deleting first and then failing to write
    // would leave index entries whose PATCH can never resolve their family.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
      ...ids(purged).map((id) => `delete ${kvKeys.borrow(id)}`),
    ]);
    expect(ids((await storedIndex()) as BorrowRequest[])).toEqual([
      kept.requestId,
    ]);
    expect(await kv.get(kvKeys.borrow(kept.requestId))).not.toBeNull();
  });

  it("leaves a legacy index legacy when it changes nothing", async () => {
    // Nothing here involves the leaver, so an un-migrated family must not be
    // rewritten for no reason — a write per departure would migrate families
    // that had no borrow activity at all.
    const records = [
      makeRecord(0, { borrowerId: STAYER, ownerId: USER2 }),
      makeRecord(1, {
        borrowerId: STAYER,
        ownerId: USER2,
        status: BorrowStatus.RETURNED,
      }),
    ];
    await seedLegacyIndex(records);

    const ops = watchKvOps(kv);
    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 0,
      evicted: 0,
    });

    expect(ops.writeTrail()).toEqual([]);
    expect(await storedIndex()).toEqual(ids(records));
  });

  it("migrates a legacy index on the departure that does change something", async () => {
    // Companion to the case above: flip who borrowed and the same call now has
    // work to do, so "legacy stays legacy" is about the fixture rather than
    // about a function that never writes.
    const purged = makeRecord(0, { status: BorrowStatus.RETURNED });
    const kept = makeRecord(1, {
      borrowerId: STAYER,
      ownerId: USER2,
      status: BorrowStatus.LENT,
    });
    await seedLegacyIndex([purged, kept]);

    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 0,
      evicted: 1,
    });

    const stored = await storedIndex();
    expect(isLegacyBorrowIndex(stored)).toBe(false);
    expect(ids(stored as BorrowRequest[])).toEqual([kept.requestId]);
    expect(await kv.get(kvKeys.borrow(purged.requestId))).toBeNull();
  });

  // FAIL-OPEN, same rule as the trim's evictions: the index write has already
  // landed, so letting a rejected pointer delete propagate would turn a
  // persisted, successful settlement into a 500 — and, on the member-removal
  // route, refuse a removal that in fact happened.
  it("still resolves when an evicted pointer's delete rejects, and logs it", async () => {
    const purged = [
      makeRecord(0, { status: BorrowStatus.RETURNED }),
      makeRecord(1, { status: BorrowStatus.REJECTED }),
    ];
    await seedIndex(purged);

    const failingKey = kvKeys.borrow(purged[0].requestId);
    const realDelete = kv.delete.bind(kv);
    vi.spyOn(kv, "delete").mockImplementation(async (key: string) => {
      if (key === failingKey) throw new Error("KV delete rejected");
      await realDelete(key);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves rather than rejects — this line IS the assertion.
    expect(await settleDepartingBorrower(kv, FAMILY_ID, LEAVER)).toEqual({
      cancelled: 0,
      evicted: 2,
    });

    // The index write still counts, and the delete that could succeed did.
    expect(await storedIndex()).toEqual([]);
    expect(await kv.get(failingKey)).not.toBeNull();
    expect(await kv.get(kvKeys.borrow(purged[1].requestId))).toBeNull();

    expect(errorSpy).toHaveBeenCalledWith(
      "BORROW_POINTER_DELETE_FAILED",
      expect.objectContaining({ requestId: purged[0].requestId }),
    );
  });
});

// ===========================================================================
// deleteBorrowIndex
// ===========================================================================
//
// The dissolve path (sole-owner leave, sole-member account deletion): the
// family key is going away, so the index would otherwise become an orphan no
// write path ever visits again. Pointer deletes come FIRST here — the inverse
// of every other write in the module — because the "never leave an index entry
// without its pointer" rule protects readers of a LIVE index, and this call is
// removing the index outright.

describe("deleteBorrowIndex", () => {
  it("does nothing when the family has no index", async () => {
    const ops = watchKvOps(kv);

    await deleteBorrowIndex(kv, FAMILY_ID);

    expect(ops.writeTrail()).toEqual([]);
    // Positive companion: the index key IS looked up, so the empty trail is a
    // decision and not a missing call.
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
  });

  it("deletes every pointer, then the index key", async () => {
    const records = makeRecords(3, BorrowStatus.RETURNED);
    await seedIndex(records);

    const ops = watchKvOps(kv);
    await deleteBorrowIndex(kv, FAMILY_ID);

    expect(ops.writeTrail()).toEqual([
      ...ids(records).map((id) => `delete ${kvKeys.borrow(id)}`),
      `delete ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);
    // One read: the index value already names every requestId.
    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);

    expect(await storedIndex()).toBeNull();
    for (const record of records) {
      expect(await kv.get(kvKeys.borrow(record.requestId))).toBeNull();
    }
  });

  it("deletes a LEGACY string[] index's pointers without fanning out", async () => {
    // A legacy index ALREADY is the id list, so this must not spend a KV read
    // per record to rediscover ids it is holding — the reason it deliberately
    // does not go through `readBorrowIndex`.
    const records = makeRecords(3, BorrowStatus.RETURNED);
    await seedLegacyIndex(records);

    const ops = watchKvOps(kv);
    await deleteBorrowIndex(kv, FAMILY_ID);

    expect(ops.getKeys()).toEqual([kvKeys.borrowsByFamily(FAMILY_ID)]);
    expect(ops.writeTrail()).toEqual([
      ...ids(records).map((id) => `delete ${kvKeys.borrow(id)}`),
      `delete ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);
    expect(await storedIndex()).toBeNull();
    expect(await kv.get(kvKeys.borrow(records[0].requestId))).toBeNull();
  });

  it.each([
    { label: "an empty index", stored: [] },
    { label: "a corrupted non-array container", stored: { requests: "nope" } },
  ])("deletes only the index key for $label", async ({ stored }) => {
    await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(stored));

    const ops = watchKvOps(kv);
    await deleteBorrowIndex(kv, FAMILY_ID);

    // No ids to enumerate — the key is dropped and nothing else is touched.
    expect(ops.writeTrail()).toEqual([
      `delete ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);
    expect(await storedIndex()).toBeNull();
  });

  it("still deletes the index key when a pointer delete rejects, and logs it", async () => {
    const records = makeRecords(2, BorrowStatus.RETURNED);
    await seedIndex(records);

    const failingKey = kvKeys.borrow(records[0].requestId);
    const realDelete = kv.delete.bind(kv);
    vi.spyOn(kv, "delete").mockImplementation(async (key: string) => {
      if (key === failingKey) throw new Error("KV delete rejected");
      await realDelete(key);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await deleteBorrowIndex(kv, FAMILY_ID);

    // The orphan pointer is the whole cost: the index key still goes, and the
    // other pointer was still attempted.
    expect(await storedIndex()).toBeNull();
    expect(await kv.get(failingKey)).not.toBeNull();
    expect(await kv.get(kvKeys.borrow(records[1].requestId))).toBeNull();

    expect(errorSpy).toHaveBeenCalledWith(
      "BORROW_POINTER_DELETE_FAILED",
      expect.objectContaining({ requestId: records[0].requestId }),
    );
  });
});
