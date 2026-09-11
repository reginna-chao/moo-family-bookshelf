/**
 * `src/kv/{families,users,publicShelves,verify}.ts` — the KV data access layer
 * (#163 Wave 3), plus the `borrow:{requestId}` pointer writer that joined it in
 * `services/borrowIndex.ts`.
 *
 * WHY THIS FILE EXISTS. The refactor moved 83 inline KV calls out of
 * `src/routes/**` and behind these accessors. The route-level suites still
 * cover the HANDLERS, but they can no longer see what the accessors do — a
 * dropped `"json"` read type, a `JSON.stringify` turned into a raw object, a
 * TTL forgotten on `kicked:` / `otp:` / `qr:`, or a second KV round-trip added
 * inside an accessor would change the stored bytes, the key's lifetime or the
 * per-request `kv_ops` bill for EVERY caller at once. This file pins each
 * accessor's three observable facts — the key, the stored value, the TTL — and
 * that each one costs exactly ONE KV operation.
 *
 * ANTI-DRIFT. Every expected key is built with the production `kvKeys` builder
 * and every TTL is the production constant, both imported from
 * `src/kv/schema.ts`. A renamed key prefix or a retuned TTL therefore moves the
 * expectation with the code — which is the point: this file guards the ACCESSOR
 * layer, not the key spellings (`kvSchema.test.ts` pins those literals).
 *
 * The mock is `createMockKV()`, so the KV TTL floor stays enforced: an accessor
 * that computed a sub-60s `expirationTtl` would throw here rather than only
 * against real KV.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  kvKeys,
  KICKED_TOMBSTONE_TTL_SECONDS,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  BoolFlag,
  type FamilyRecord,
  type KickedRecord,
  type UserBooksRecord,
  type PublicShelvesRecord,
  type PublicShelfSnapshot,
  type VerifyRecord,
  type OtpRecord,
  type QrTokenRecord,
} from "../../src/kv/schema";
import {
  getFamilyRecord,
  putFamilyRecord,
  deleteFamilyRecord,
  getMemberFamilyId,
  putMemberFamilyId,
  deleteMemberFamilyId,
  hasKickedTombstone,
  putKickedTombstone,
  deleteKickedTombstone,
} from "../../src/kv/families";
import {
  getUserBooksRecord,
  putUserBooksRecord,
  deleteUserBooksRecord,
} from "../../src/kv/users";
import {
  getPublicShelves,
  putPublicShelves,
  deletePublicShelves,
  getPublicSnapshot,
  deletePublicSnapshot,
} from "../../src/kv/publicShelves";
import {
  getVerifyRecord,
  putVerifyRecord,
  putOtpRecord,
  getQrTokenRecord,
  putQrTokenRecord,
  deleteQrToken,
} from "../../src/kv/verify";
import {
  writeBorrowPointer,
  readBorrowPointer,
} from "../../src/services/borrowIndex";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps, type KvOpLog } from "../helpers/kvOps";
import { USER1, OWNER1 } from "../helpers/ids";

const FAMILY_ID = "abcd-1234";
const OTHER_FAMILY_ID = "wxyz-9876";
const SHARE_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const QR_TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

// ---------------------------------------------------------------------------
// Fixtures — minimal but SHAPE-VALID records, one per key family.
// ---------------------------------------------------------------------------

const FAMILY_RECORD: FamilyRecord = {
  familyId: FAMILY_ID,
  ownerId: OWNER1,
  members: [
    { userId: OWNER1, displayName: "Owner", canLend: BoolFlag.TRUE },
    { userId: USER1, displayName: "Member", canLend: BoolFlag.FALSE },
  ],
  maxMembers: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const USER_BOOKS_RECORD: UserBooksRecord = {
  schemaVersion: 1,
  userId: USER1,
  displayName: "Member",
  books: [],
  lastUpdated: "2026-01-01T00:00:00.000Z",
};

const PUBLIC_SHELVES_RECORD: PublicShelvesRecord = {
  shelves: [
    {
      shelfId: "shelf-1",
      shareToken: SHARE_TOKEN,
      title: "Shared shelf",
      expiresDays: 30,
      createdAt: 1767225600000,
      expiresAt: 1769817600000,
      selectionMode: "all-shared",
    },
  ],
};

const PUBLIC_SNAPSHOT: PublicShelfSnapshot = {
  userId: USER1,
  shelfId: "shelf-1",
  title: "Shared shelf",
  books: [],
  createdAt: 1767225600000,
  expiresAt: 1769817600000,
};

const VERIFY_RECORD: VerifyRecord = {
  method: "pin",
  hash: "deadbeef",
  salt: "cafe",
  prompted: BoolFlag.TRUE,
  secretUpdatedAt: 1767225600000,
};

const OTP_RECORD: OtpRecord = {
  code: "123456",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const QR_RECORD: QrTokenRecord = { userId: USER1 };

const KICKED_RECORD: KickedRecord = {
  removedAt: "2026-01-01T00:00:00.000Z",
  removedBy: OWNER1,
};

/**
 * Total KV operations observed. The accessor layer's whole justification is
 * that it is THIN — one function, one operation — so an accessor that grew a
 * read-before-write (or a second read for validation) fails here, where the
 * cost is attributable, instead of showing up as a diffuse `kv_ops` rise
 * spread across every route budget test.
 */
function opCount(log: KvOpLog): number {
  return log.getKeys().length + log.putKeys().length + log.deleteKeys().length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Reads that parse JSON
// ===========================================================================

interface JsonReadCase {
  /** Accessor name, for the test title. */
  label: string;
  /** The key it must read, built by the production key builder. */
  key: string;
  /** A stored record of that key's own shape. */
  stored: object;
  read: (kv: KVNamespace) => Promise<unknown>;
}

const JSON_READ_CASES: JsonReadCase[] = [
  {
    label: "getFamilyRecord",
    key: kvKeys.family(FAMILY_ID),
    stored: FAMILY_RECORD,
    read: (kv) => getFamilyRecord(kv, FAMILY_ID),
  },
  {
    label: "getUserBooksRecord",
    key: kvKeys.user(USER1),
    stored: USER_BOOKS_RECORD,
    read: (kv) => getUserBooksRecord(kv, USER1),
  },
  {
    label: "getPublicShelves",
    key: kvKeys.publicShelves(USER1),
    stored: PUBLIC_SHELVES_RECORD,
    read: (kv) => getPublicShelves(kv, USER1),
  },
  {
    label: "getPublicSnapshot",
    key: kvKeys.publicShelf(SHARE_TOKEN),
    stored: PUBLIC_SNAPSHOT,
    read: (kv) => getPublicSnapshot(kv, SHARE_TOKEN),
  },
  {
    label: "getVerifyRecord",
    key: kvKeys.verify(USER1),
    stored: VERIFY_RECORD,
    read: (kv) => getVerifyRecord(kv, USER1),
  },
  {
    label: "getQrTokenRecord",
    key: kvKeys.qrToken(QR_TOKEN),
    stored: QR_RECORD,
    read: (kv) => getQrTokenRecord(kv, QR_TOKEN),
  },
];

describe("KV data access — JSON reads", () => {
  it.each(JSON_READ_CASES)(
    "$label reads its own key once and returns the parsed record",
    async ({ key, stored, read }) => {
      const kv = createMockKV();
      await kv.put(key, JSON.stringify(stored));

      const log = watchKvOps(kv);
      const result = await read(kv);

      // Deep equality (not a string) is what proves the `"json"` read type
      // survived: without it the mock hands back the raw serialized string.
      expect(result).toEqual(stored);
      expect(log.getKeys()).toEqual([key]);
      expect(opCount(log)).toBe(1);
    },
  );

  it.each(JSON_READ_CASES)(
    "$label returns null when the key is absent",
    async ({ read }) => {
      const kv = createMockKV();

      const log = watchKvOps(kv);
      expect(await read(kv)).toBeNull();
      expect(opCount(log)).toBe(1);
    },
  );
});

// ===========================================================================
// The reads that are deliberately NOT JSON
// ===========================================================================

describe("getMemberFamilyId", () => {
  it("reads member:{userId} once and returns the plain familyId string", async () => {
    const kv = createMockKV();
    await kv.put(kvKeys.member(USER1), FAMILY_ID);

    const log = watchKvOps(kv);
    const result = await getMemberFamilyId(kv, USER1);

    expect(result).toBe(FAMILY_ID);
    expect(log.getKeys()).toEqual([kvKeys.member(USER1)]);
    expect(opCount(log)).toBe(1);
  });

  it("returns null when the user is in no family", async () => {
    const kv = createMockKV();

    const log = watchKvOps(kv);
    expect(await getMemberFamilyId(kv, USER1)).toBeNull();
    expect(opCount(log)).toBe(1);
  });
});

describe("hasKickedTombstone", () => {
  it("reports true from the key's PRESENCE alone, in one read", async () => {
    const kv = createMockKV();
    await kv.put(
      kvKeys.kicked(FAMILY_ID, USER1),
      JSON.stringify(KICKED_RECORD),
    );

    const log = watchKvOps(kv);
    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(true);
    expect(log.getKeys()).toEqual([kvKeys.kicked(FAMILY_ID, USER1)]);
    expect(opCount(log)).toBe(1);
  });

  it("still reports true for a corrupted (unparseable) tombstone value", async () => {
    // The join gate never parses this value, so corruption must NOT reopen the
    // door — a `"json"` read here would throw or yield null and let the removed
    // member back in.
    const kv = createMockKV();
    await kv.put(kvKeys.kicked(FAMILY_ID, USER1), "{not json");

    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(true);
  });

  it("reports false when no tombstone exists", async () => {
    const kv = createMockKV();

    const log = watchKvOps(kv);
    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(false);
    expect(opCount(log)).toBe(1);
  });

  it("is scoped to one family — another family's tombstone does not match", async () => {
    const kv = createMockKV();
    await kv.put(
      kvKeys.kicked(OTHER_FAMILY_ID, USER1),
      JSON.stringify(KICKED_RECORD),
    );

    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(false);
  });
});

// ===========================================================================
// Writes — exact key, exact bytes, exact TTL
// ===========================================================================

interface PutCase {
  label: string;
  key: string;
  /** The exact string the accessor must store. */
  expected: string;
  /** Expected `expirationTtl`; `undefined` = persistent key, no TTL. */
  ttl: number | undefined;
  write: (kv: KVNamespace) => Promise<void>;
}

const PUT_CASES: PutCase[] = [
  {
    label: "putFamilyRecord",
    key: kvKeys.family(FAMILY_ID),
    expected: JSON.stringify(FAMILY_RECORD),
    ttl: undefined,
    write: (kv) => putFamilyRecord(kv, FAMILY_ID, FAMILY_RECORD),
  },
  {
    label: "putMemberFamilyId",
    key: kvKeys.member(USER1),
    // PLAIN STRING, not JSON: the value is read back with a bare `get` and
    // compared to a familyId directly. A stray JSON.stringify would store
    // `"abcd-1234"` (quotes included) and every membership comparison would
    // silently stop matching.
    expected: FAMILY_ID,
    ttl: undefined,
    write: (kv) => putMemberFamilyId(kv, USER1, FAMILY_ID),
  },
  {
    label: "putKickedTombstone",
    key: kvKeys.kicked(FAMILY_ID, USER1),
    expected: JSON.stringify(KICKED_RECORD),
    ttl: KICKED_TOMBSTONE_TTL_SECONDS,
    write: (kv) => putKickedTombstone(kv, FAMILY_ID, USER1, KICKED_RECORD),
  },
  {
    label: "putUserBooksRecord",
    key: kvKeys.user(USER1),
    expected: JSON.stringify(USER_BOOKS_RECORD),
    ttl: undefined,
    write: (kv) => putUserBooksRecord(kv, USER1, USER_BOOKS_RECORD),
  },
  {
    label: "putPublicShelves",
    key: kvKeys.publicShelves(USER1),
    expected: JSON.stringify(PUBLIC_SHELVES_RECORD),
    ttl: undefined,
    write: (kv) => putPublicShelves(kv, USER1, PUBLIC_SHELVES_RECORD),
  },
  {
    label: "putVerifyRecord",
    key: kvKeys.verify(USER1),
    expected: JSON.stringify(VERIFY_RECORD),
    ttl: undefined,
    write: (kv) => putVerifyRecord(kv, USER1, VERIFY_RECORD),
  },
  {
    label: "putOtpRecord",
    key: kvKeys.otp(USER1),
    expected: JSON.stringify(OTP_RECORD),
    ttl: OTP_TTL_SECONDS,
    write: (kv) => putOtpRecord(kv, USER1, OTP_RECORD),
  },
  {
    label: "putQrTokenRecord",
    key: kvKeys.qrToken(QR_TOKEN),
    expected: JSON.stringify(QR_RECORD),
    ttl: QR_TOKEN_TTL_SECONDS,
    write: (kv) => putQrTokenRecord(kv, QR_TOKEN, QR_RECORD),
  },
  {
    label: "writeBorrowPointer",
    key: kvKeys.borrow(REQUEST_ID),
    // A POINTER, not the whole request: the family index owns the record.
    // Storing a full BorrowRequest here would resurrect the per-entry read
    // cost #162 removed.
    expected: JSON.stringify({ familyId: FAMILY_ID }),
    ttl: undefined,
    write: (kv) => writeBorrowPointer(kv, REQUEST_ID, FAMILY_ID),
  },
];

describe("KV data access — writes", () => {
  it.each(PUT_CASES)(
    "$label writes its own key once, with the expected bytes",
    async ({ key, expected, write }) => {
      const kv = createMockKV();

      const log = watchKvOps(kv);
      await write(kv);

      expect(log.putKeys()).toEqual([key]);
      expect(opCount(log)).toBe(1);
      expect(await kv.get(key)).toBe(expected);
    },
  );

  it.each(PUT_CASES)(
    "$label passes expirationTtl $ttl",
    async ({ key, ttl, write }) => {
      const kv = createMockKV();
      await write(kv);

      // `undefined` = the accessor passed no TTL at all. Persistent keys must
      // stay persistent (Invariant 5 for `user:`), and self-expiring keys must
      // keep the TTL that is their ONLY expiry mechanism — nothing sweeps them.
      expect(getPutTtl(kv, key)).toBe(ttl);
    },
  );
});

// ===========================================================================
// Deletes
// ===========================================================================

interface DeleteCase {
  label: string;
  key: string;
  remove: (kv: KVNamespace) => Promise<void>;
}

const DELETE_CASES: DeleteCase[] = [
  {
    label: "deleteFamilyRecord",
    key: kvKeys.family(FAMILY_ID),
    remove: (kv) => deleteFamilyRecord(kv, FAMILY_ID),
  },
  {
    label: "deleteMemberFamilyId",
    key: kvKeys.member(USER1),
    remove: (kv) => deleteMemberFamilyId(kv, USER1),
  },
  {
    label: "deleteKickedTombstone",
    key: kvKeys.kicked(FAMILY_ID, USER1),
    remove: (kv) => deleteKickedTombstone(kv, FAMILY_ID, USER1),
  },
  {
    label: "deleteUserBooksRecord",
    key: kvKeys.user(USER1),
    remove: (kv) => deleteUserBooksRecord(kv, USER1),
  },
  {
    label: "deletePublicShelves",
    key: kvKeys.publicShelves(USER1),
    remove: (kv) => deletePublicShelves(kv, USER1),
  },
  {
    label: "deletePublicSnapshot",
    key: kvKeys.publicShelf(SHARE_TOKEN),
    remove: (kv) => deletePublicSnapshot(kv, SHARE_TOKEN),
  },
  {
    label: "deleteQrToken",
    key: kvKeys.qrToken(QR_TOKEN),
    remove: (kv) => deleteQrToken(kv, QR_TOKEN),
  },
];

describe("KV data access — deletes", () => {
  it.each(DELETE_CASES)(
    "$label removes its own key in one operation",
    async ({ key, remove }) => {
      const kv = createMockKV();
      await kv.put(key, "seeded");
      await kv.put("untouched:key", "kept");

      const log = watchKvOps(kv);
      await remove(kv);

      expect(log.deleteKeys()).toEqual([key]);
      expect(opCount(log)).toBe(1);
      expect(await kv.get(key)).toBeNull();
      // A delete must never behave like a prefix sweep.
      expect(await kv.get("untouched:key")).toBe("kept");
    },
  );

  it.each(DELETE_CASES)(
    "$label is idempotent on an absent key",
    async ({ remove }) => {
      const kv = createMockKV();

      const log = watchKvOps(kv);
      await expect(remove(kv)).resolves.toBeUndefined();
      expect(opCount(log)).toBe(1);
    },
  );
});

// ===========================================================================
// Round trips across an accessor pair
// ===========================================================================

describe("borrow pointer round trip", () => {
  it("writeBorrowPointer stores a pointer readBorrowPointer resolves", async () => {
    const kv = createMockKV();
    await writeBorrowPointer(kv, REQUEST_ID, FAMILY_ID);

    const log = watchKvOps(kv);
    expect(await readBorrowPointer(kv, REQUEST_ID)).toBe(FAMILY_ID);
    expect(log.getKeys()).toEqual([kvKeys.borrow(REQUEST_ID)]);
    expect(opCount(log)).toBe(1);
  });

  it("stores only familyId — never the whole borrow request", async () => {
    const kv = createMockKV();
    await writeBorrowPointer(kv, REQUEST_ID, FAMILY_ID);

    expect(JSON.parse((await kv.get(kvKeys.borrow(REQUEST_ID)))!)).toEqual({
      familyId: FAMILY_ID,
    });
  });
});

describe("family record round trip", () => {
  it("putFamilyRecord then getFamilyRecord returns an equal record", async () => {
    const kv = createMockKV();
    await putFamilyRecord(kv, FAMILY_ID, FAMILY_RECORD);
    expect(await getFamilyRecord(kv, FAMILY_ID)).toEqual(FAMILY_RECORD);
  });

  it("deleteFamilyRecord makes the subsequent read null", async () => {
    const kv = createMockKV();
    await putFamilyRecord(kv, FAMILY_ID, FAMILY_RECORD);
    await deleteFamilyRecord(kv, FAMILY_ID);
    expect(await getFamilyRecord(kv, FAMILY_ID)).toBeNull();
  });
});

describe("kicked tombstone round trip", () => {
  it("putKickedTombstone blocks, deleteKickedTombstone lifts", async () => {
    const kv = createMockKV();

    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(false);
    await putKickedTombstone(kv, FAMILY_ID, USER1, KICKED_RECORD);
    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(true);
    await deleteKickedTombstone(kv, FAMILY_ID, USER1);
    expect(await hasKickedTombstone(kv, FAMILY_ID, USER1)).toBe(false);
  });
});
