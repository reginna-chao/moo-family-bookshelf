/**
 * A "hollow" member is inert on every family-scoped path (#222, Inv-4).
 *
 * `family:{id}` is a read-modify-write with no CAS. A full-record write that
 * read the member list before an owner's kick (a displayName write-back, the
 * displayName / member-settings endpoints) can land AFTER the kick's list put
 * and re-list the kicked member, whose `member:{uid}` pointer the kick has
 * already deleted: listed, pointerless, possibly holding a fresh token. The
 * same stale write can also roll `ownerId` back to a kicked ex-owner.
 *
 * KV cannot stop that write, so family-scoped authorization is BIDIRECTIONAL:
 * a user is a member only when the record LISTS them AND their pointer names
 * this family (`isActiveMember` / `filterActiveMembers` in
 * services/membership.ts). This file pins what that buys, one describe per
 * rule:
 *
 * - (A) Member-level paths: a hollow member's books leave the aggregation, and
 *   they can neither list / create / settle borrows, nor be borrowed from, nor
 *   write the family record, nor receive ownership. The members GET still
 *   lists them and the owner's re-kick converges.
 * - (B) Owner-only paths: a hollow ex-owner (restored `ownerId`, no pointer)
 *   gets the non-owner answer on kick / un-kick / transfer. Their self-DELETE
 *   in a multi-member family is refused `403 OWNER_CANNOT_LEAVE` exactly like
 *   any recorded owner's — that refusal is decided by `ownerId` + the list,
 *   never the pointer (INFO-2) — so it writes nothing and never dissolves.
 * - (C) The race itself, reproduced end to end: a displayName PUT that read
 *   the record before the owner's kick re-lists the kicked member after it,
 *   and the resulting hollow member reads nothing.
 * - (D) A departure never writes an empty member list: the LAST listed
 *   member's self-leave (a hollow ex-owner skips the sole-owner dissolve) and
 *   their account deletion (C1', `ownerId` naming an unlisted user) both
 *   dissolve the family instead, so later reads answer 404 rather than 500.
 * - (E) Owner rules need `ownerId` AND a listing: OWNER_CANNOT_LEAVE ignores
 *   the pointer, while an UNLISTED caller named by `ownerId` is no owner —
 *   their self-DELETE takes the MEMBER_NOT_FOUND stray-pointer cleanup, their
 *   account deletion writes no family record, and the endpoint PUT answers
 *   them 404 NOT_FOUND.
 *
 * (A) and (B) seed the hollow state DIRECTLY (a real family built through the
 * API, then `member:{uid}` deleted while the user stays listed and keeps a
 * valid token) and run every case twice: hollow, and the POSITIVE companion
 * with the pointer intact, so a refusal can never pass because the call was
 * broken for everyone. Refusals additionally pin "no KV write" via
 * `writeTrail()`, and the companion pins the key a successful call writes, so
 * the negative assertion cannot pass on a drifted key.
 *
 * Fixtures:
 * - `seedTwoMemberFamily`: USER1 creates the family, USER2 joins, both have a
 *   shared book, and USER2 holds a PENDING request for USER1's book — all
 *   through the real API.
 * - `applyMembership`: hollow = the state a kick leaves behind when a stale
 *   full-record write re-lists the target: still listed, pointer gone, token
 *   still valid.
 * - A case's `writes` is the key a successful call writes (asserted as
 *   `put {key}` in the active companion), omitted for read-only calls; when the
 *   hollow call is a refusal (`hollow.code` set) it must write NOTHING.
 * - `makeUser2Owner` restores `ownerId` to USER2 — what a stale full-record
 *   write that read the record before an ownership transfer does when it lands
 *   after the new owner kicked the ex-owner. USER1 stays an active non-owner.
 * - `makeUser2LastListed` rewrites `family:{id}` so USER2 is the ONLY listed
 *   member and `ownerId` is the given `ownerId` — the state a stale
 *   full-record write can leave behind. USER1 is unlisted but keeps its
 *   `member:{uid}` pointer and token, so it can still reach the family-record
 *   read on the members GET afterwards.
 * - `makeUser1UnlistedOwnerOfThree` rewrites `family:{id}` without USER1 while
 *   `ownerId` still names USER1, after USER3 joined: a MULTI-member family
 *   (USER2, USER3) whose recorded owner is unlisted but keeps a pointer naming
 *   this family and a valid token.
 *
 * INFO-2: a hollow ex-owner's self-DELETE is decided by `ownerId` + the list
 * alone: the missing pointer does not turn the recorded owner's leave into a
 * plain self-leave that would drop them off the list while `ownerId` still
 * names them.
 *
 * Race interleaving (`kickRacingDisplayNamePut`): kick USER2 while USER2's
 * displayName PUT runs against the pre-kick record, driven deterministically
 * through a Proxy over `kv`:
 * 1. The owner's kick reaches its tombstone put and is held there.
 * 2. USER2's displayName PUT runs: it reads the record (USER2 still listed)
 *    and the pointer (still naming the family — the revoke has not run), so it
 *    passes its active-member check, and reaches its own `family:{id}` put,
 *    which is held.
 * 3. The owner's kick resumes: tombstone, list put (USER2 removed), revoke
 *    (pointer + token deleted).
 * 4. The held displayName put lands AFTER the owner's list put — the stale
 *    record, USER2 still in it: the hollow member.
 * Every wait inside the hook is a `Promise.race` against "the PUT reached its
 * family put", so a request that returns early can never deadlock the kick.
 *
 * Fresh token: the kick's revoke deleted USER2's token. A reconnect that read
 * the pointer before the revoke can mint a fresh one (the documented
 * residual); the race case stands in for it so its reads are made by an
 * AUTHENTICATED hollow member rather than answered 401 by the auth middleware.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps, type KvOpLog } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  BorrowStatus,
  kvKeys,
  type BookEntry,
  type BorrowRequest,
  type FamilyRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { USER1, USER2, USER3 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The store every assertion reads. */
let kv: KVNamespace;
/** What the app is handed as `env.KV`: `kv`, or an interleaving Proxy over it. */
let envKv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
  envKv = kv;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ----- Helpers -----

type Membership = "hollow" | "active";

/** Everything a case needs after seeding. */
interface Ctx {
  familyId: string;
  /** USER1's token. */
  ownerToken: string;
  /** USER2's token — still valid in the hollow state. */
  memberToken: string;
  /** A PENDING borrow: USER2 borrows USER1's `book-u1`. */
  requestId: string;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: envKv, DEV_MODE: "1" });
}

function sharedBook(bookId: string): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

async function seedBooks(userId: string, bookId: string) {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: userId === USER1 ? "Alice" : "Bob",
    books: [sharedBook(bookId)],
    lastUpdated: new Date().toISOString(),
  };
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

async function createBorrow(
  familyId: string,
  token: string,
  ownerId: string,
  bookId: string,
) {
  return request(
    "POST",
    `/api/family/${familyId}/borrow`,
    { bookId, bookTitle: `Title ${bookId}`, bookAuthor: "Author", ownerId },
    token,
  );
}

async function readFamily(familyId: string): Promise<FamilyRecord | null> {
  return kv.get<FamilyRecord>(kvKeys.family(familyId), "json");
}

async function listedMemberIds(familyId: string): Promise<string[]> {
  const record = await readFamily(familyId);
  expect(record).not.toBeNull();
  return record!.members.map((m) => m.userId);
}

async function readBorrowStatus(
  familyId: string,
  requestId: string,
): Promise<BorrowStatus | undefined> {
  const index = await kv.get<BorrowRequest[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );
  return index?.find((r) => r.requestId === requestId)?.status;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

/** USER1's family + USER2, shared books both sides, USER2's PENDING request — via
 *  the real API. See the header → "Fixtures". */
async function seedTwoMemberFamily(): Promise<Ctx> {
  const created = await request("POST", "/api/family", {
    userId: USER1,
    displayName: "Alice",
  });
  expect(created.status).toBe(201);
  const createdData = ((await created.json()) as Json).data;
  const familyId = createdData.familyId as string;

  const joined = await request("POST", `/api/family/${familyId}/join`, {
    userId: USER2,
    displayName: "Bob",
  });
  expect(joined.status).toBe(200);
  const memberToken = ((await joined.json()) as Json).data.authToken as string;

  await seedBooks(USER1, "book-u1");
  await seedBooks(USER2, "book-u2");

  const borrow = await createBorrow(familyId, memberToken, USER1, "book-u1");
  expect(borrow.status).toBe(201);
  const requestId = ((await borrow.json()) as Json).data.requestId as string;

  return {
    familyId,
    ownerToken: createdData.authToken as string,
    memberToken,
    requestId,
  };
}

/** Put USER2 into `membership`; hollow = still listed, pointer gone, token valid.
 *  See the header → "Fixtures". */
async function applyMembership(ctx: Ctx, membership: Membership) {
  expect(await listedMemberIds(ctx.familyId)).toContain(USER2);
  expect(await kv.get(kvKeys.member(USER2))).toBe(ctx.familyId);
  if (membership === "hollow") {
    await kv.delete(kvKeys.member(USER2));
  }
}

/** Seed + membership, then start recording: only the call under test counts. */
async function arrange(
  membership: Membership,
  prepare?: (ctx: Ctx) => Promise<void>,
): Promise<{ ctx: Ctx; ops: KvOpLog }> {
  const ctx = await seedTwoMemberFamily();
  await prepare?.(ctx);
  await applyMembership(ctx, membership);
  return { ctx, ops: watchKvOps(kv) };
}

// ----- (A) Member-level paths -----

interface MemberCase {
  name: string;
  run: (ctx: Ctx) => Promise<Response>;
  hollow: { status: number; code?: string };
  active: { status: number };
  /** Key a successful call writes; omitted for reads. A hollow refusal writes
   *  NOTHING. See the header → "Fixtures". */
  writes?: (ctx: Ctx) => string;
  check?: (ctx: Ctx, membership: Membership, res: Response) => Promise<void>;
}

const MEMBER_CASES: MemberCase[] = [
  {
    name: "family bookshelf aggregation (as the owner)",
    run: (ctx) =>
      request(
        "GET",
        `/api/family/${ctx.familyId}/bookshelf`,
        undefined,
        ctx.ownerToken,
      ),
    hollow: { status: 200 },
    active: { status: 200 },
    check: async (_ctx, membership, res) => {
      const members = ((await res.json()) as Json).data.members as {
        userId: string;
        books: { bookId: string }[];
      }[];
      const bookIds = members.flatMap((m) => m.books.map((b) => b.bookId));
      if (membership === "hollow") {
        expect(members.map((m) => m.userId)).toEqual([USER1]);
        expect(bookIds).toEqual(["book-u1"]);
      } else {
        expect(members.map((m) => m.userId)).toEqual([USER1, USER2]);
        expect(bookIds).toEqual(["book-u1", "book-u2"]);
      }
    },
  },
  {
    name: "borrow list (as the hollow member)",
    run: (ctx) =>
      request(
        "GET",
        `/api/family/${ctx.familyId}/borrow`,
        undefined,
        ctx.memberToken,
      ),
    hollow: { status: 403, code: "NOT_FAMILY_MEMBER" },
    active: { status: 200 },
  },
  {
    name: "borrow create (hollow member as borrower)",
    run: (ctx) =>
      createBorrow(ctx.familyId, ctx.memberToken, USER1, "book-u1-second"),
    hollow: { status: 403, code: "NOT_FAMILY_MEMBER" },
    active: { status: 201 },
    writes: (ctx) => kvKeys.borrowsByFamily(ctx.familyId),
  },
  {
    name: "borrow create (hollow member as lender)",
    run: (ctx) => createBorrow(ctx.familyId, ctx.ownerToken, USER2, "book-u2"),
    hollow: { status: 403, code: "INVALID_OWNER" },
    active: { status: 201 },
    writes: (ctx) => kvKeys.borrowsByFamily(ctx.familyId),
  },
  {
    name: "borrow PATCH (hollow member as a party)",
    run: (ctx) =>
      request(
        "PATCH",
        `/api/borrow/${ctx.requestId}`,
        { status: BorrowStatus.CANCELLED },
        ctx.memberToken,
      ),
    hollow: { status: 403, code: "NOT_FAMILY_MEMBER" },
    active: { status: 200 },
    writes: (ctx) => kvKeys.borrowsByFamily(ctx.familyId),
    check: async (ctx, membership) => {
      expect(await readBorrowStatus(ctx.familyId, ctx.requestId)).toBe(
        membership === "hollow" ? BorrowStatus.PENDING : BorrowStatus.CANCELLED,
      );
    },
  },
  {
    name: "displayName PUT (as the hollow member)",
    run: (ctx) =>
      request(
        "PUT",
        `/api/family/${ctx.familyId}/member/${USER2}/displayName`,
        { displayName: "Renamed" },
        ctx.memberToken,
      ),
    hollow: { status: 404, code: "MEMBER_NOT_FOUND" },
    active: { status: 200 },
    writes: (ctx) => kvKeys.family(ctx.familyId),
    check: async (ctx, membership) => {
      const record = await readFamily(ctx.familyId);
      const name = record?.members.find((m) => m.userId === USER2)?.displayName;
      expect(name).toBe(membership === "hollow" ? "Bob" : "Renamed");
    },
  },
  {
    name: "member-settings PATCH (as the hollow member)",
    run: (ctx) =>
      request(
        "PATCH",
        `/api/family/${ctx.familyId}/member/${USER2}`,
        { readmooName: "bob-on-readmoo" },
        ctx.memberToken,
      ),
    hollow: { status: 403, code: "NOT_FAMILY_MEMBER" },
    active: { status: 200 },
    writes: (ctx) => kvKeys.family(ctx.familyId),
  },
  {
    name: "ownership transfer TO the hollow member",
    run: (ctx) =>
      request(
        "PUT",
        `/api/family/${ctx.familyId}/transfer`,
        { newOwnerId: USER2 },
        ctx.ownerToken,
      ),
    hollow: { status: 400, code: "INVALID_MEMBER" },
    active: { status: 200 },
    writes: (ctx) => kvKeys.family(ctx.familyId),
    check: async (ctx, membership) => {
      expect((await readFamily(ctx.familyId))?.ownerId).toBe(
        membership === "hollow" ? USER1 : USER2,
      );
    },
  },
  {
    // Deliberately unfiltered: the owner must SEE a hollow member to re-kick
    // it, or it would occupy a maxMembers slot invisibly.
    name: "members GET (as the owner) still lists the member",
    run: (ctx) =>
      request(
        "GET",
        `/api/family/${ctx.familyId}/members`,
        undefined,
        ctx.ownerToken,
      ),
    hollow: { status: 200 },
    active: { status: 200 },
    check: async (_ctx, _membership, res) => {
      const members = ((await res.json()) as Json).data.members as {
        userId: string;
      }[];
      expect(members.map((m) => m.userId)).toEqual([USER1, USER2]);
    },
  },
  {
    name: "owner re-kick of the member converges",
    run: (ctx) =>
      request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER2}`,
        undefined,
        ctx.ownerToken,
      ),
    hollow: { status: 200 },
    active: { status: 200 },
    writes: (ctx) => kvKeys.family(ctx.familyId),
    check: async (ctx) => {
      expect(await listedMemberIds(ctx.familyId)).toEqual([USER1]);
      expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    },
  },
];

describe("hollow member — member-level family-scoped paths (#222)", () => {
  describe.each(MEMBER_CASES)("$name", (c) => {
    it(`hollow member → ${c.hollow.status}${c.hollow.code ? ` ${c.hollow.code}` : ""}`, async () => {
      const { ctx, ops } = await arrange("hollow");
      const res = await c.run(ctx);

      if (c.hollow.code) {
        await expectError(res.clone(), c.hollow.status, c.hollow.code);
        // A refusal leaves KV byte-identical, not merely answers 4xx.
        expect(ops.writeTrail()).toEqual([]);
      } else {
        expect(res.status).toBe(c.hollow.status);
      }
      await c.check?.(ctx, "hollow", res);
    });

    it(`positive companion: pointer intact → ${c.active.status}`, async () => {
      const { ctx, ops } = await arrange("active");
      const res = await c.run(ctx);

      expect(res.status).toBe(c.active.status);
      if (c.writes) {
        expect(ops.writeTrail()).toContain(`put ${c.writes(ctx)}`);
      } else {
        expect(ops.writeTrail()).toEqual([]);
      }
      await c.check?.(ctx, "active", res);
    });
  });
});

// ----- (B) Owner-only paths — a hollow ex-owner holds no owner power -----

/** Restore `ownerId` to USER2 as a stale post-transfer write would; USER1 stays an
 *  active non-owner. See the header → "Fixtures". */
async function makeUser2Owner(ctx: Ctx) {
  const record = await readFamily(ctx.familyId);
  expect(record).not.toBeNull();
  await kv.put(
    kvKeys.family(ctx.familyId),
    JSON.stringify({ ...record!, ownerId: USER2 }),
  );
}

interface OwnerCase {
  name: string;
  run: (ctx: Ctx) => Promise<Response>;
  active: { status: number };
  check?: (ctx: Ctx, membership: Membership) => Promise<void>;
}

const OWNER_CASES: OwnerCase[] = [
  {
    name: "kick another member",
    run: (ctx) =>
      request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER1}`,
        undefined,
        ctx.memberToken,
      ),
    active: { status: 200 },
    check: async (ctx, membership) => {
      expect(await listedMemberIds(ctx.familyId)).toEqual(
        membership === "hollow" ? [USER1, USER2] : [USER2],
      );
    },
  },
  {
    name: "un-kick (lift a removal ban)",
    run: (ctx) =>
      request(
        "DELETE",
        `/api/family/${ctx.familyId}/kicked/${USER1}`,
        undefined,
        ctx.memberToken,
      ),
    active: { status: 200 },
  },
  {
    name: "transfer ownership",
    run: (ctx) =>
      request(
        "PUT",
        `/api/family/${ctx.familyId}/transfer`,
        { newOwnerId: USER1 },
        ctx.memberToken,
      ),
    active: { status: 200 },
    check: async (ctx, membership) => {
      expect((await readFamily(ctx.familyId))?.ownerId).toBe(
        membership === "hollow" ? USER2 : USER1,
      );
    },
  },
];

describe("hollow ex-owner — owner-only paths (#222)", () => {
  describe.each(OWNER_CASES)("$name", (c) => {
    it("hollow ex-owner → 403 NOT_OWNER, nothing written", async () => {
      const { ctx, ops } = await arrange("hollow", makeUser2Owner);
      const res = await c.run(ctx);

      await expectError(res, 403, "NOT_OWNER");
      expect(ops.writeTrail()).toEqual([]);
      await c.check?.(ctx, "hollow");
    });

    it(`positive companion: active owner → ${c.active.status}`, async () => {
      const { ctx } = await arrange("active", makeUser2Owner);
      const res = await c.run(ctx);

      expect(res.status).toBe(c.active.status);
      await c.check?.(ctx, "active");
    });
  });

  describe("self-DELETE", () => {
    it("a hollow ex-owner's self-DELETE in a 2-member family is refused 403 OWNER_CANNOT_LEAVE, writes nothing, and never dissolves", async () => {
      const { ctx, ops } = await arrange("hollow", makeUser2Owner);
      const res = await request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER2}`,
        undefined,
        ctx.memberToken,
      );

      // Decided by `ownerId` + the list alone, never the pointer.
      // See the header → "INFO-2".
      await expectError(res, 403, "OWNER_CANNOT_LEAVE");
      expect(ops.writeTrail()).toEqual([]);
      // The family survives untouched; USER1 keeps their seat.
      expect(await listedMemberIds(ctx.familyId)).toEqual([USER1, USER2]);
      expect((await readFamily(ctx.familyId))?.ownerId).toBe(USER2);
      expect(await kv.get(kvKeys.member(USER1))).toBe(ctx.familyId);
    });

    it("positive companion: an ACTIVE owner of a 2-member family takes the owner branch (403 OWNER_CANNOT_LEAVE)", async () => {
      const { ctx, ops } = await arrange("active", makeUser2Owner);
      const res = await request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER2}`,
        undefined,
        ctx.memberToken,
      );

      await expectError(res, 403, "OWNER_CANNOT_LEAVE");
      expect(ops.writeTrail()).toEqual([]);
    });

    it("positive companion: an ACTIVE sole owner's self-DELETE still dissolves the family", async () => {
      const created = await request("POST", "/api/family", { userId: USER1 });
      expect(created.status).toBe(201);
      const data = ((await created.json()) as Json).data;
      const familyId = data.familyId as string;

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/family/${familyId}/member/${USER1}`,
        undefined,
        data.authToken as string,
      );

      expect(res.status).toBe(200);
      expect(await readFamily(familyId)).toBeNull();
      expect(ops.writeTrail()).toContain(`delete ${kvKeys.family(familyId)}`);
    });
  });
});

// ----- (C) The race end to end -----

/** Kick USER2 while USER2's displayName PUT runs against the pre-kick record.
 *  See the header → "Race interleaving". */
async function kickRacingDisplayNamePut(ctx: Ctx) {
  const tombstoneKey = kvKeys.kicked(ctx.familyId, USER2);
  const familyKey = kvKeys.family(ctx.familyId);
  let tombstoneArmed = true;
  let dnPutSeen = false;
  let dnRes: Promise<Response> | undefined;
  let signalDnReachedPut!: () => void;
  const dnReachedPut = new Promise<void>((r) => (signalDnReachedPut = r));
  let signalOwnerPutLanded!: () => void;
  const ownerPutLanded = new Promise<void>((r) => (signalOwnerPutLanded = r));

  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "put") {
        const real = Reflect.get(target, "put") as (
          k: string,
          ...r: unknown[]
        ) => Promise<unknown>;
        return async (k: string, ...rest: unknown[]): Promise<unknown> => {
          if (k === tombstoneKey && tombstoneArmed) {
            tombstoneArmed = false;
            dnRes = request(
              "PUT",
              `/api/family/${ctx.familyId}/member/${USER2}/displayName`,
              { displayName: "Renamed" },
              ctx.memberToken,
            );
            await Promise.race([dnRes, dnReachedPut]);
            return real(k, ...rest);
          }
          if (k === familyKey && dnRes && !dnPutSeen) {
            // The displayName PUT's stale write-back: land it after the kick's.
            dnPutSeen = true;
            signalDnReachedPut();
            await ownerPutLanded;
            return real(k, ...rest);
          }
          if (k === familyKey && dnPutSeen) {
            const result = await real(k, ...rest);
            signalOwnerPutLanded();
            return result;
          }
          return real(k, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const kick = await request(
    "DELETE",
    `/api/family/${ctx.familyId}/member/${USER2}`,
    undefined,
    ctx.ownerToken,
  );
  expect(dnRes).toBeDefined();
  const dn = await dnRes!;
  envKv = kv;
  // The interleaving really happened — without this, every assertion below
  // could pass on a displayName PUT that never raced the kick.
  expect(dnPutSeen).toBe(true);
  return { kick, dn };
}

describe("hollow member — the stale-write race end to end (#222)", () => {
  it("a displayName PUT racing a kick re-lists the target hollow, and the hollow member reads nothing", async () => {
    const ctx = await seedTwoMemberFamily();

    const { kick, dn } = await kickRacingDisplayNamePut(ctx);
    expect(kick.status).toBe(200);
    expect(dn.status).toBe(200);

    // The residual #222 cannot prevent: listed again, pointerless.
    expect(await listedMemberIds(ctx.familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();

    // Stand in for a residual reconnect's fresh token so the reads are AUTHENTICATED.
    // See the header → "Fresh token".
    const freshToken = await seedAuthToken(kv, USER2);

    await expectError(
      await request(
        "GET",
        `/api/family/${ctx.familyId}/borrow`,
        undefined,
        freshToken,
      ),
      403,
      "NOT_FAMILY_MEMBER",
    );

    const shelf = await request(
      "GET",
      `/api/family/${ctx.familyId}/bookshelf`,
      undefined,
      ctx.ownerToken,
    );
    expect(shelf.status).toBe(200);
    const members = ((await shelf.json()) as Json).data.members as {
      userId: string;
      books: { bookId: string }[];
    }[];
    expect(members.map((m) => m.userId)).toEqual([USER1]);
    expect(members.flatMap((m) => m.books.map((b) => b.bookId))).toEqual([
      "book-u1",
    ]);
  });
});

// ----- (D) The last listed member leaving dissolves the family -----

/** USER2 the ONLY listed member, `ownerId` as given; USER1 unlisted but keeps pointer
 *  and token. See the header → "Fixtures". */
async function makeUser2LastListed(ctx: Ctx, ownerId: string) {
  const record = await readFamily(ctx.familyId);
  expect(record).not.toBeNull();
  await kv.put(
    kvKeys.family(ctx.familyId),
    JSON.stringify({
      ...record!,
      ownerId,
      members: record!.members.filter((m) => m.userId === USER2),
    }),
  );
  expect(await listedMemberIds(ctx.familyId)).toEqual([USER2]);
}

/** The family's storage is gone: record, borrow index, and its borrow pointer. */
async function expectDissolved(ctx: Ctx) {
  expect(await readFamily(ctx.familyId)).toBeNull();
  expect(await kv.get(kvKeys.borrowsByFamily(ctx.familyId))).toBeNull();
  expect(await kv.get(kvKeys.borrow(ctx.requestId))).toBeNull();
}

describe("last listed member leaving — dissolve, never an empty list (#222)", () => {
  it("a hollow ex-owner whose pointer names another family dissolves the old family and keeps their other session", async () => {
    const ctx = await seedTwoMemberFamily();
    // Seed: USER2 has moved on — pointer gone, then they create family G,
    // which gives them a pointer to G and a fresh token.
    await kv.delete(kvKeys.member(USER2));
    const created = await request("POST", "/api/family", {
      userId: USER2,
      displayName: "Bob",
    });
    expect(created.status).toBe(201);
    const g = ((await created.json()) as Json).data;
    const otherFamilyId = g.familyId as string;
    const otherToken = g.authToken as string;
    expect(otherFamilyId).not.toBe(ctx.familyId);
    // A stale write then restores USER2 as owner and sole listed member of F.
    await makeUser2LastListed(ctx, USER2);
    // Preconditions the assertions below depend on.
    expect(await kv.get(kvKeys.borrowsByFamily(ctx.familyId))).not.toBeNull();
    expect(await kv.get(kvKeys.member(USER2))).toBe(otherFamilyId);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${ctx.familyId}/member/${USER2}`,
      undefined,
      otherToken,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({ ok: true });
    await expectDissolved(ctx);
    const familyKey = kvKeys.family(ctx.familyId);
    expect(ops.writeTrail()).toContain(`delete ${familyKey}`);
    // Never the empty-list write that bricks every later read.
    expect(ops.writeTrail()).not.toContain(`put ${familyKey}`);

    // The pointer names G, not this family: USER2's G session survives intact.
    expect(await kv.get(kvKeys.member(USER2))).toBe(otherFamilyId);
    expect(await kv.get(kvKeys.authToken(otherToken))).toBe(USER2);
    expect(await kv.get(kvKeys.auth(USER2))).not.toBeNull();
    expect(ops.writeTrail()).not.toContain(`delete ${kvKeys.member(USER2)}`);
    expect(ops.writeTrail()).not.toContain(`delete ${kvKeys.auth(USER2)}`);
    expect(await readFamily(otherFamilyId)).not.toBeNull();

    // Later reads of the old family answer 404, not 500: USER1's leftover
    // pointer still names it, so the members GET reaches the record read.
    await expectError(
      await request(
        "GET",
        `/api/family/${ctx.familyId}/members`,
        undefined,
        ctx.ownerToken,
      ),
      404,
      "FAMILY_NOT_FOUND",
    );
    // So does a join with the old sync code.
    await expectError(
      await request("POST", `/api/family/${ctx.familyId}/join`, {
        userId: USER3,
        displayName: "Carol",
      }),
      404,
      "FAMILY_NOT_FOUND",
    );
  });

  it("positive companion: an active non-owner who is the last listed member dissolves the family and loses their pointer and token", async () => {
    const ctx = await seedTwoMemberFamily();
    // `ownerId` points at USER1, who is no longer listed.
    await makeUser2LastListed(ctx, USER1);
    expect(await kv.get(kvKeys.member(USER2))).toBe(ctx.familyId);
    expect(await kv.get(kvKeys.authToken(ctx.memberToken))).toBe(USER2);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${ctx.familyId}/member/${USER2}`,
      undefined,
      ctx.memberToken,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({ ok: true });
    await expectDissolved(ctx);
    const familyKey = kvKeys.family(ctx.familyId);
    expect(ops.writeTrail()).toContain(`delete ${familyKey}`);
    expect(ops.writeTrail()).not.toContain(`put ${familyKey}`);

    // The pointer named THIS family, so the leaver's session is revoked.
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.authToken(ctx.memberToken))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();
    expect(ops.writeTrail()).toContain(`delete ${kvKeys.member(USER2)}`);
    // Family record first, then the pointer (orphan pointer over orphan family).
    const trail = ops.writeTrail();
    expect(trail.indexOf(`delete ${familyKey}`)).toBeLessThan(
      trail.indexOf(`delete ${kvKeys.member(USER2)}`),
    );
  });

  it("the last listed member's ACCOUNT deletion dissolves the family when ownerId names an unlisted user (C1')", async () => {
    const ctx = await seedTwoMemberFamily();
    // `ownerId` points at USER1, who is no longer listed; USER2 is active.
    await makeUser2LastListed(ctx, USER1);
    expect(await kv.get(kvKeys.member(USER2))).toBe(ctx.familyId);
    expect(await kv.get(kvKeys.borrowsByFamily(ctx.familyId))).not.toBeNull();

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/user/${USER2}`,
      undefined,
      ctx.memberToken,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({ ok: true });
    await expectDissolved(ctx);
    const familyKey = kvKeys.family(ctx.familyId);
    expect(ops.writeTrail()).toContain(`delete ${familyKey}`);
    // Never the `members: []` write that bricks every later read.
    expect(ops.writeTrail()).not.toContain(`put ${familyKey}`);

    // The account teardown still ran.
    expect(await kv.get(kvKeys.user(USER2))).toBeNull();
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.authToken(ctx.memberToken))).toBeNull();

    // The old sync code answers 404, not 500.
    await expectError(
      await request("POST", `/api/family/${ctx.familyId}/join`, {
        userId: USER3,
        displayName: "Carol",
      }),
      404,
      "FAMILY_NOT_FOUND",
    );
    // So does a family read by USER1, whose leftover pointer still names it.
    await expectError(
      await request(
        "GET",
        `/api/family/${ctx.familyId}/members`,
        undefined,
        ctx.ownerToken,
      ),
      404,
      "FAMILY_NOT_FOUND",
    );
  });
});

// ----- (E) Owner rules need `ownerId` AND a listing -----

/** Multi-member family (USER2, USER3) whose recorded owner USER1 is unlisted but
 *  keeps pointer and token. See the header → "Fixtures". */
async function makeUser1UnlistedOwnerOfThree(ctx: Ctx) {
  // Room for a third member (the default family holds 2), so USER3 joins
  // through the real API.
  const seeded = await readFamily(ctx.familyId);
  expect(seeded).not.toBeNull();
  await kv.put(
    kvKeys.family(ctx.familyId),
    JSON.stringify({ ...seeded!, maxMembers: 3 }),
  );
  const joined = await request("POST", `/api/family/${ctx.familyId}/join`, {
    userId: USER3,
    displayName: "Carol",
  });
  expect(joined.status).toBe(200);
  const record = await readFamily(ctx.familyId);
  expect(record).not.toBeNull();
  await kv.put(
    kvKeys.family(ctx.familyId),
    JSON.stringify({
      ...record!,
      members: record!.members.filter((m) => m.userId !== USER1),
    }),
  );
  expect(await listedMemberIds(ctx.familyId)).toEqual([USER2, USER3]);
  expect((await readFamily(ctx.familyId))?.ownerId).toBe(USER1);
  expect(await kv.get(kvKeys.member(USER1))).toBe(ctx.familyId);
}

describe("owner rules need ownerId AND a listing (#222 INFO-2 / INFO-4)", () => {
  describe("DELETE /api/family/:id/member/:uid (self)", () => {
    // The pointer-intact companion of the first case is (B) › self-DELETE ›
    // "positive companion: an ACTIVE owner of a 2-member family …".
    it("the real owner whose member:{uid} read misses still gets 403 OWNER_CANNOT_LEAVE — no pointer read, no writes", async () => {
      const ctx = await seedTwoMemberFamily();
      // A cross-colo lag / cached miss: USER1 is listed and `ownerId`, but
      // their pointer is not visible.
      await kv.delete(kvKeys.member(USER1));

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER1}`,
        undefined,
        ctx.ownerToken,
      );

      await expectError(res, 403, "OWNER_CANNOT_LEAVE");
      expect(ops.writeTrail()).toEqual([]);
      expect(ops.getKeys()).not.toContain(kvKeys.member(USER1));
      // Not dropped off the list while `ownerId` still names them.
      expect(await listedMemberIds(ctx.familyId)).toEqual([USER1, USER2]);
      expect((await readFamily(ctx.familyId))?.ownerId).toBe(USER1);
    });

    it("positive companion: the sole-owner dissolve DOES read that pointer (the key the case above negates)", async () => {
      const created = await request("POST", "/api/family", { userId: USER1 });
      expect(created.status).toBe(201);
      const data = ((await created.json()) as Json).data;

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/family/${data.familyId as string}/member/${USER1}`,
        undefined,
        data.authToken as string,
      );

      expect(res.status).toBe(200);
      expect(ops.getKeys()).toContain(kvKeys.member(USER1));
    });

    it("an UNLISTED caller named by ownerId in a multi-member family → 404 MEMBER_NOT_FOUND, stray pointer + token deleted, no tombstone", async () => {
      const ctx = await seedTwoMemberFamily();
      await makeUser1UnlistedOwnerOfThree(ctx);

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/family/${ctx.familyId}/member/${USER1}`,
        undefined,
        ctx.ownerToken,
      );

      await expectError(res, 404, "MEMBER_NOT_FOUND");
      // Exactly the stray-pointer cleanup (#213 convergence): no tombstone
      // (a self-leave is never a kick), no family write, no dissolve.
      expect(ops.writeTrail()).toEqual([
        `delete ${kvKeys.member(USER1)}`,
        `delete ${kvKeys.auth(USER1)}`,
        `delete ${kvKeys.authToken(ctx.ownerToken)}`,
      ]);
      expect(await kv.get(kvKeys.member(USER1))).toBeNull();
      expect(await kv.get(kvKeys.authToken(ctx.ownerToken))).toBeNull();
      expect(await kv.get(kvKeys.kicked(ctx.familyId, USER1))).toBeNull();
      expect(await listedMemberIds(ctx.familyId)).toEqual([USER2, USER3]);
    });
  });

  describe("DELETE /api/user/:id", () => {
    it("an UNLISTED caller named by ownerId deletes their account: no OWNER_CANNOT_DELETE, no dissolve, no family write", async () => {
      const ctx = await seedTwoMemberFamily();
      // `ownerId` = USER1 (unlisted, pointer + token intact); USER2 listed.
      await makeUser2LastListed(ctx, USER1);
      const before = await readFamily(ctx.familyId);

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/user/${USER1}`,
        undefined,
        ctx.ownerToken,
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data).toEqual({ ok: true });
      const familyKey = kvKeys.family(ctx.familyId);
      expect(ops.writeTrail()).not.toContain(`put ${familyKey}`);
      expect(ops.writeTrail()).not.toContain(`delete ${familyKey}`);
      expect(await readFamily(ctx.familyId)).toEqual(before);
      expect(await kv.get(kvKeys.borrowsByFamily(ctx.familyId))).not.toBeNull();

      // The listed member is untouched.
      expect(await kv.get(kvKeys.member(USER2))).toBe(ctx.familyId);
      expect(await kv.get(kvKeys.authToken(ctx.memberToken))).toBe(USER2);

      // The caller's account data is deleted as usual.
      expect(await kv.get(kvKeys.user(USER1))).toBeNull();
      expect(await kv.get(kvKeys.member(USER1))).toBeNull();
      expect(await kv.get(kvKeys.authToken(ctx.ownerToken))).toBeNull();
    });

    it("positive companion: a LISTED non-owner's account deletion writes the shrunken list", async () => {
      const ctx = await seedTwoMemberFamily();

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/user/${USER2}`,
        undefined,
        ctx.memberToken,
      );

      expect(res.status).toBe(200);
      expect(ops.writeTrail()).toContain(`put ${kvKeys.family(ctx.familyId)}`);
      expect(await listedMemberIds(ctx.familyId)).toEqual([USER1]);
    });
  });

  describe("PUT /api/family/:id/endpoint", () => {
    const body = { apiEndpoint: "https://api.example.com" };

    it("an UNLISTED caller named by ownerId whose pointer names the family → 404 NOT_FOUND, nothing written", async () => {
      const ctx = await seedTwoMemberFamily();
      await makeUser2LastListed(ctx, USER1);
      expect(await kv.get(kvKeys.member(USER1))).toBe(ctx.familyId);
      const before = await readFamily(ctx.familyId);

      const ops = watchKvOps(kv);
      const res = await request(
        "PUT",
        `/api/family/${ctx.familyId}/endpoint`,
        body,
        ctx.ownerToken,
      );

      await expectError(res, 404, "NOT_FOUND");
      expect(ops.writeTrail()).toEqual([]);
      expect(await readFamily(ctx.familyId)).toEqual(before);
    });

    it("positive companion: the listed active owner → 200 and the family record is written", async () => {
      const ctx = await seedTwoMemberFamily();

      const ops = watchKvOps(kv);
      const res = await request(
        "PUT",
        `/api/family/${ctx.familyId}/endpoint`,
        body,
        ctx.ownerToken,
      );

      expect(res.status).toBe(200);
      expect(ops.writeTrail()).toEqual([`put ${kvKeys.family(ctx.familyId)}`]);
      expect((await readFamily(ctx.familyId))?.apiEndpoint).toContain(
        "api.example.com",
      );
    });
  });
});
