import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  kvKeys,
  BorrowStatus,
  BoolFlag,
  type BorrowPointer,
  type BorrowRequest,
} from "../../src/kv/schema";
import {
  BORROW_BOOK_ID_MAX_LENGTH,
  BORROW_BOOK_TITLE_MAX_LENGTH,
  BORROW_BOOK_AUTHOR_MAX_LENGTH,
  BORROW_COVER_URL_MAX_LENGTH,
} from "../../src/utils/validation";
import { NOBODY, USER1, USER2, USER3 } from "../helpers/ids";
import {
  createRateLimitBindings,
  type RateLimitBindingCall,
} from "../helpers/rateLimitBindings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamilyAndGetToken(userId = USER1) {
  const res = await request("POST", "/api/family", {
    userId,
    displayName: "User1",
  });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(
  familyId: string,
  userId: string,
  displayName = "",
) {
  const res = await request("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName,
  });
  const json = (await res.json()) as Json;
  return {
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers() {
  const { familyId, authToken: token1 } = await createFamilyAndGetToken(USER1);
  const { authToken: token2 } = await joinFamilyAndGetToken(
    familyId,
    USER2,
    "User2",
  );
  return { familyId, token1, token2 };
}

/**
 * USER1 (family owner) + USER2 + USER3, so a record can have a party set that
 * excludes one member.
 *
 * `maxMembers` defaults to 2 on create (`routes/family.ts`) and no route raises
 * it, so the capacity is bumped directly in KV — setup only, every assertion
 * below still goes through the HTTP handlers.
 */
async function createFamilyWithThreeMembers() {
  const { familyId, authToken: token1 } = await createFamilyAndGetToken(USER1);

  const raw = await kv.get<Json>(kvKeys.family(familyId), "json");
  raw.maxMembers = 3;
  await kv.put(kvKeys.family(familyId), JSON.stringify(raw));

  const { authToken: token2 } = await joinFamilyAndGetToken(
    familyId,
    USER2,
    "User2",
  );
  const { authToken: token3 } = await joinFamilyAndGetToken(
    familyId,
    USER3,
    "User3",
  );
  return { familyId, token1, token2, token3 };
}

/**
 * A cover URL that clears the `isAllowedCoverUrl` boundary check in
 * `src/routes/borrow.ts` (https + Readmoo registrable domain + default port).
 * The field itself is OPTIONAL, but any fixture that SUPPLIES a non-empty cover
 * and expects to reach the handler's business logic must carry one — an
 * off-Readmoo host short-circuits at 400 INVALID_COVER_URL.
 */
const VALID_COVER_URL = "https://cdn.readmoo.com/cover/cover.jpg";

const validBorrowBody = {
  bookId: "book-123",
  bookTitle: "Test Book",
  bookAuthor: "Test Author",
  bookCoverUrl: VALID_COVER_URL,
  ownerId: USER1,
};

/**
 * Read the family's borrow index — the SINGLE SOURCE OF TRUTH for borrow
 * records since the index was denormalised (#160 item 2,
 * `src/services/borrowIndex.ts`). It holds full `BorrowRequest` objects, NOT a
 * `string[]` of requestIds.
 */
async function readIndex(familyId: string): Promise<BorrowRequest[] | null> {
  return await kv.get<BorrowRequest[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );
}

/**
 * The stored record for `requestId`, read where production now keeps it.
 *
 * `borrow:{requestId}` is only a `{ familyId }` pointer, so a test that wants a
 * record's status or fields must look inside the family index — reading the
 * pointer would silently assert against an object that carries neither.
 */
async function readIndexEntry(
  familyId: string,
  requestId: string,
): Promise<BorrowRequest | undefined> {
  const index = await readIndex(familyId);
  return (index ?? []).find((r) => r.requestId === requestId);
}

/** The `borrow:{requestId}` value: a pointer to the owning family, nothing else. */
async function readPointer(requestId: string): Promise<BorrowPointer | null> {
  return await kv.get<BorrowPointer>(kvKeys.borrow(requestId), "json");
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// POST /api/family/:id/borrow — create borrow request
// ===========================================================================

describe("POST /api/family/:id/borrow", () => {
  it("should return 201 with correct response shape", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = {
      bookId: "book-123",
      bookTitle: "Test Book",
      bookAuthor: "Test Author",
      bookCoverUrl: VALID_COVER_URL,
      ownerId: USER1,
    };

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body,
      token2,
    );
    expect(res.status).toBe(201);

    const json = (await res.json()) as Json;
    const data = json.data;
    expect(data.requestId).toBeDefined();
    expect(data.familyId).toBe(familyId);
    expect(data.borrowerId).toBe(USER2);
    expect(data.borrowerName).toBe("User2");
    expect(data.ownerId).toBe(USER1);
    expect(data.bookId).toBe("book-123");
    expect(data.bookTitle).toBe("Test Book");
    expect(data.bookAuthor).toBe("Test Author");
    expect(data.bookCoverUrl).toBe(VALID_COVER_URL);
    expect(data.status).toBe(BorrowStatus.PENDING);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 401 if not authenticated", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      validBorrowBody,
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 if missing required fields (bookId)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookTitle: "T", bookAuthor: "A", bookCoverUrl: "U", ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (bookTitle)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookAuthor: "A", bookCoverUrl: "U", ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (bookAuthor)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookTitle: "T", bookCoverUrl: "U", ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  // Was: "should return 400 if missing required fields (bookCoverUrl)".
  // `bookCoverUrl` left the required set when it became optional, so the same
  // slot now pins the OTHER half of that contract — the required-field list
  // itself. Acceptance of a missing cover is covered by the "optional
  // bookCoverUrl" describe block below.
  it("should not name bookCoverUrl among the required fields", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookTitle: "T", bookAuthor: "A", ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
    // Pins the production literal in src/routes/borrow.ts. If the falsy guard
    // ever regains `bookCoverUrl`, this message regains it too and this
    // assertion fails — the cheapest tripwire against the regression that made
    // every cover-less book unborrowable.
    expect(json.error.message).toBe(
      "bookId, bookTitle, bookAuthor, and ownerId are required",
    );
  });

  it("should return 400 if missing required fields (ownerId)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookTitle: "T", bookAuthor: "A", bookCoverUrl: "U" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if ownerId format is invalid", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user<script>" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 404 if family not found", async () => {
    const { token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      "/api/family/zzzz-zzzz/borrow",
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return 403 NOT_FAMILY_MEMBER if caller is not in the family", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    // Create user3 with their own family, then try to borrow from familyId
    const { authToken: token3 } = await createFamilyAndGetToken(USER3);

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      validBorrowBody,
      token3,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should return 403 INVALID_OWNER_SELF if ownerId is the same as caller (can't borrow own book)", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token1, // user1 trying to borrow from user1
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_OWNER_SELF");
  });

  it("should return 403 INVALID_OWNER if ownerId is someone outside the family", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: NOBODY },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_OWNER");
  });

  it("should answer self-borrow and non-member-owner with different error codes", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Self-borrow: the caller (user1) names themselves as the owner.
    const selfRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token1,
    );
    // Non-member owner: the caller (user2) names an owner outside the family.
    const nonMemberRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: NOBODY },
      token2,
    );

    expect(selfRes.status).toBe(403);
    expect(nonMemberRes.status).toBe(403);

    const selfCode = ((await selfRes.json()) as Json).error.code as string;
    const nonMemberCode = ((await nonMemberRes.json()) as Json).error
      .code as string;

    // Positive companions first: each branch must keep its OWN literal, so the
    // inequality below cannot pass vacuously by both branches drifting to some
    // third shared code.
    expect(selfCode).toBe("INVALID_OWNER_SELF");
    expect(nonMemberCode).toBe("INVALID_OWNER");
    // Clients map each code to its own copy — re-merging them turns "you can't
    // borrow your own book" into "that person isn't in your family".
    expect(selfCode).not.toBe(nonMemberCode);
  });

  it("should return 403 LENDING_DISABLED if owner has canLend = FALSE", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Owner (user1) disables lending for user1
    await request(
      "PATCH",
      `/api/family/${familyId}/member/${USER1}`,
      { canLend: BoolFlag.FALSE },
      token1,
    );

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("LENDING_DISABLED");
  });

  it("should return 403 LENDING_DISABLED if borrower has canLend = FALSE", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Owner (user1) disables lending for user2 (borrower)
    await request(
      "PATCH",
      `/api/family/${familyId}/member/${USER2}`,
      { canLend: BoolFlag.FALSE },
      token1,
    );

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("LENDING_DISABLED");
  });

  it("should return 400 DUPLICATE_REQUEST if PENDING request exists for same borrower + bookId", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = { ...validBorrowBody, ownerId: USER1 };

    // First request should succeed
    const res1 = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body,
      token2,
    );
    expect(res1.status).toBe(201);

    // Second identical request should fail
    const res2 = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body,
      token2,
    );
    expect(res2.status).toBe(400);
    const json = (await res2.json()) as Json;
    expect(json.error.code).toBe("DUPLICATE_REQUEST");
  });

  it("should allow duplicate request for different bookId", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body1 = { ...validBorrowBody, ownerId: USER1, bookId: "book-1" };
    const body2 = { ...validBorrowBody, ownerId: USER1, bookId: "book-2" };

    const res1 = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body1,
      token2,
    );
    expect(res1.status).toBe(201);

    const res2 = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body2,
      token2,
    );
    expect(res2.status).toBe(201);
  });

  it("should store borrow request in KV", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = { ...validBorrowBody, ownerId: USER1 };
    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      body,
      token2,
    );
    expect(res.status).toBe(201);

    const json = (await res.json()) as Json;
    const requestId = json.data.requestId;

    // Verify KV storage — the RECORD lives in the family index, which since
    // #160 item 2 carries full BorrowRequest objects rather than requestIds.
    const stored = await readIndexEntry(familyId, requestId);
    expect(stored).toBeDefined();
    expect(stored?.requestId).toBe(requestId);
    expect(stored?.status).toBe(BorrowStatus.PENDING);

    // Verify the index shape itself: objects, not a string[] of ids. Asserting
    // the mapped ids (rather than `toContain(requestId)`) is what keeps this
    // from passing again if the index ever regresses to bare strings.
    const index = await readIndex(familyId);
    expect(index?.map((r) => r.requestId)).toContain(requestId);
    expect(typeof index?.[0]).toBe("object");

    // …and `borrow:{requestId}` is now ONLY the pointer PATCH resolves.
    expect(await readPointer(requestId)).toEqual({ familyId });
  });

  it("should return 400 for invalid JSON body", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = app.request(
      `/api/family/${familyId}/borrow`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token2}`,
        },
        body: "{invalid json}",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect((await res).status).toBe(400);
  });

  it("should return 400 for invalid family ID format", async () => {
    const { token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      "/api/family/INVALID/borrow",
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });
});

// ===========================================================================
// POST /api/family/:id/borrow — bookCoverUrl is OPTIONAL
// ===========================================================================
//
// Regression guard for cover-less books. The family-bookshelf aggregation
// (src/routes/bookshelf.ts) sanitizes every off-whitelist cover to "" and the
// clients forward that verbatim, so a borrow request for such a book arrives
// with an EMPTY bookCoverUrl. While the field sat in the falsy MISSING_FIELDS
// guard, that request was answered 400 MISSING_FIELDS — which the frontend
// swallowed silently, leaving the user with a dead borrow button. Absent /
// null / "" now all mean "no cover" and are stored as "".
//
// Note the whitelist cannot wave "" through instead: `isAllowedCoverUrl("")`
// is false (`new URL("")` throws), so the handler's explicit `!== ""` exemption
// is what makes these cases pass.

/** The valid body minus the cover — the shape a cover-less book produces. */
const coverlessBorrowBody = {
  bookId: validBorrowBody.bookId,
  bookTitle: validBorrowBody.bookTitle,
  bookAuthor: validBorrowBody.bookAuthor,
  ownerId: validBorrowBody.ownerId,
};

describe("POST /api/family/:id/borrow optional bookCoverUrl", () => {
  it.each([
    { label: "the field is absent", cover: {} },
    { label: "the field is null", cover: { bookCoverUrl: null } },
    {
      label:
        'the field is "" (what the bookshelf aggregation emits for a cover-less book)',
      cover: { bookCoverUrl: "" },
    },
  ])(
    'should create the borrow request and store "" when $label',
    async ({ cover }) => {
      const { familyId, token2 } = await createFamilyWithTwoMembers();

      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...coverlessBorrowBody, ...cover },
        token2,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as Json;
      expect(json.data.bookCoverUrl).toBe("");

      // The stored record must carry "" — never undefined / null, because
      // BorrowRequest.bookCoverUrl (src/kv/schema.ts) is a non-optional string
      // and the list endpoint hands the value straight to the clients. Read
      // from the family index: that is where the record now lives.
      const stored = await readIndexEntry(familyId, json.data.requestId);
      expect(stored).toBeDefined();
      expect(stored?.bookCoverUrl).toBe("");
      expect("bookCoverUrl" in (stored as BorrowRequest)).toBe(true);
    },
  );

  // A SUPPLIED value of the wrong type stays a request-format error. `0` and
  // `false` are the load-bearing rows: they are falsy, so before the fix they
  // were caught by the MISSING_FIELDS guard. A table without them would still
  // pass if that guard came back.
  it.each([
    { label: "the number 0", coverUrl: 0 },
    { label: "the boolean false", coverUrl: false },
    { label: "a number", coverUrl: 123 },
    { label: "the boolean true", coverUrl: true },
    { label: "an object", coverUrl: {} },
    { label: "an empty array", coverUrl: [] },
    {
      label: "an array wrapping an otherwise-valid URL",
      coverUrl: ["https://cdn.readmoo.com/cover/x.jpg"],
    },
  ])("should reject $label with 400 INVALID_FIELDS", async ({ coverUrl }) => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...coverlessBorrowBody, bookCoverUrl: coverUrl },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    // Never MISSING_FIELDS (the field is optional) and never
    // INVALID_COVER_URL (a wrong type is not a whitelist verdict).
    expect(json.error.code).toBe("INVALID_FIELDS");

    // Nothing was persisted on the rejected path.
    expect(await kv.get(kvKeys.borrowsByFamily(familyId), "json")).toBeNull();
  });
});

// ===========================================================================
// POST /api/family/:id/borrow — bookCoverUrl whitelist
// ===========================================================================
//
// `bookCoverUrl` is stored verbatim and later rendered into an <img src> by the
// PWA / Extension, so a family member who plants an attacker-controlled URL
// turns every viewer's render into a tracking beacon (IP + UA leak). Every
// NON-EMPTY value the handler receives must satisfy `isAllowedCoverUrl`
// (shared/src/config/readmoo.ts): https, a Readmoo registrable domain, and the
// default port. Only the empty case is exempt, and it is pinned by the
// "optional bookCoverUrl" describe block above — making the field optional did
// not widen what the whitelist accepts.

/** Prefix shared by every per-userId rate-limit counter key. */
const PER_USER_COUNTER_PREFIX = "ratelimit:user:";

/**
 * Counter scope of the create-borrow ceiling.
 *
 * Mirrors the inline `enforcePerUserRateLimit({ scope: "borrow-create", … })`
 * call in `src/routes/borrow.ts`, which does not export its options object —
 * this literal is the one unavoidable copy. The assertions below stay honest
 * even if the scope is renamed, because they first pin the count of ALL
 * per-userId counters.
 */
const BORROW_CREATE_SCOPE = "borrow-create";

// --- Rate-limit accounting (these cases run WITHOUT DEV_MODE) ---
//
// DEV_MODE short-circuits `enforcePerUserRateLimit`, so the cases that ask
// "was the caller charged?" send their borrow POST through a helper that
// omits it. Family setup deliberately keeps using the DEV_MODE `request`
// helper: it must not spend any of the caller's budget.
//
// The `borrow-create` ceiling is 10 per 60s, so since #160 item 1 it is
// counted by a Rate Limiting binding and leaves NO KV key behind. "Was the
// caller charged?" is therefore read off the binding call log, not off KV —
// and the bindings must be injected, or the request would silently fall back
// to the old counter and the assertions would stop describing production.

/**
 * Same as {@link request} but WITHOUT `DEV_MODE` (so the live limiters run)
 * and WITH the Rate Limiting bindings a production deploy carries. Returns
 * the response together with every `limit()` call it made.
 */
async function prodRequest(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<{ res: Response; calls: RateLimitBindingCall[] }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const { bindings, calls } = createRateLimitBindings();
  const res = await app.request(path, init, { KV: kv, ...bindings });
  return { res, calls };
}

/** Per-userId charges among `calls` — the per-IP tier call is not one. */
function perUserCharges(calls: RateLimitBindingCall[]): string[] {
  return calls
    .map((call) => call.key)
    .filter((key) => key.startsWith(PER_USER_COUNTER_PREFIX));
}

/** No per-userId counter may survive in KV either, whatever the scope. */
async function perUserCounterKeys(): Promise<string[]> {
  const listed = await kv.list();
  return listed.keys
    .map((k: { name: string }) => k.name)
    .filter((name: string) => name.startsWith(PER_USER_COUNTER_PREFIX));
}

describe("POST /api/family/:id/borrow bookCoverUrl validation", () => {
  it.each([
    { label: "a plain-http URL", coverUrl: "http://cdn.readmoo.com/x.jpg" },
    { label: "an unparseable value", coverUrl: "not-a-url" },
    {
      label: "a suffix look-alike host",
      coverUrl: "https://evilreadmoo.com/x.jpg",
    },
    {
      label: "a prefix look-alike host",
      coverUrl: "https://readmoo.com.evil.com/x.jpg",
    },
    {
      label: "a non-default port",
      coverUrl: "https://cdn.readmoo.com:8443/x.jpg",
    },
    {
      label: "a third-party tracking beacon",
      coverUrl: "https://attacker.example/b.png?u=victim",
    },
    // A scheme with no `//`. Standalone it parses to host `cdn.readmoo.com`,
    // which is why the pre-fix whitelist accepted it, but a browser resolves an
    // `<img src>` against the base of the RENDERING document and WHATWG then
    // switches to "relative" state, so the host becomes the VIEWER's own
    // origin. Unlike a book link this needs no click: the request fires on
    // render, which inside the Extension means a same-site GET to Readmoo
    // carrying the viewer's cookies. Rejecting it here is intended, not
    // collateral — the scraper reads already-absolute `src` values off the
    // Readmoo DOM and can never emit this shape.
    {
      label:
        "a bare scheme with no // that resolves against the rendering page",
      coverUrl: "https:cdn.readmoo.com/x.jpg",
    },
  ])(
    "should reject $label with 400 INVALID_COVER_URL",
    async ({ coverUrl }) => {
      const { familyId, token2 } = await createFamilyWithTwoMembers();

      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...validBorrowBody, bookCoverUrl: coverUrl },
        token2,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("INVALID_COVER_URL");
    },
  );

  it("should not persist a borrow request when the cover URL is rejected", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, bookCoverUrl: "https://attacker.example/b.png" },
      token2,
    );
    expect(res.status).toBe(400);

    const index = await kv.get(kvKeys.borrowsByFamily(familyId), "json");
    expect(index).toBeNull();
  });

  it.each([
    {
      label: "a readmoo.com subdomain",
      coverUrl: "https://cdn.readmoo.com/cover/x.jpg",
    },
    {
      label: "a readmoo.tw subdomain",
      coverUrl: "https://cdn.readmoo.tw/cover/x.jpg",
    },
    {
      label: "an explicit default port",
      coverUrl: "https://cdn.readmoo.com:443/x.jpg",
    },
  ])(
    "should accept $label and store it verbatim (201)",
    async ({ coverUrl }) => {
      const { familyId, token2 } = await createFamilyWithTwoMembers();

      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...validBorrowBody, bookCoverUrl: coverUrl },
        token2,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as Json;
      expect(json.data.bookCoverUrl).toBe(coverUrl);

      const stored = await readIndexEntry(familyId, json.data.requestId);
      expect(stored?.bookCoverUrl).toBe(coverUrl);
    },
  );

  it("should not charge the borrow-create counter for a rejected cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const { res, calls } = await prodRequest(
      "POST",
      `/api/family/${familyId}/borrow`,
      {
        ...validBorrowBody,
        bookCoverUrl: "https://attacker.example/b.png?u=victim",
      },
      token2,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_COVER_URL");

    // A format error must not burn quota — otherwise a malformed request is a
    // free lever for exhausting the caller's own borrow budget.
    expect(perUserCharges(calls)).toHaveLength(0);
    expect(await perUserCounterKeys()).toHaveLength(0);
  });

  it("should not charge the borrow-create counter for a wrong-typed cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const { res, calls } = await prodRequest(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, bookCoverUrl: 0 },
      token2,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_FIELDS");

    // Matched pair with the INVALID_COVER_URL case above: the two guards are
    // different, so the sibling stays green if the INVALID_FIELDS type guard is
    // ever moved AFTER `enforcePerUserRateLimit`. This is the case that goes
    // red — a wrong-typed body must not burn the caller's borrow-create quota.
    expect(perUserCharges(calls)).toHaveLength(0);
    expect(await perUserCounterKeys()).toHaveLength(0);
  });

  it("should charge the borrow-create counter once for an accepted cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const { res, calls } = await prodRequest(
      "POST",
      `/api/family/${familyId}/borrow`,
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(201);

    // Positive companion for the two "not charged" cases above: without it a
    // handler that never charged at all would keep them green. Exactly one
    // charge, on the AUTHENTICATED caller's own id (security-ux Invariant 6).
    expect(perUserCharges(calls)).toEqual([
      `${PER_USER_COUNTER_PREFIX}${BORROW_CREATE_SCOPE}:${USER2}`,
    ]);
    // …and it cost no KV operation, which is what #160 item 1 bought.
    expect(await perUserCounterKeys()).toHaveLength(0);
  });
});

// ===========================================================================
// POST /api/family/:id/borrow — free-text length caps
// ===========================================================================
//
// Since the borrow index was denormalised (#160 item 2) every record of a
// family lives inside ONE KV value (`borrows:family:{familyId}`) that every
// member reads in full on every borrow list and that is rewritten on every
// borrow write. Unbounded free text is therefore a way for one member to
// inflate what the whole family pays for, on both the read and the write side.
// The four bounds below are that ceiling; they are imported, never spelled as
// numbers, so moving one is a deliberate product change rather than a test
// failure that says nothing.

/**
 * Build a Readmoo cover URL of EXACTLY `length` characters, so the case that
 * sits one over the cap is still a URL the whitelist would otherwise accept.
 * Without that, an over-cap value could be refused for the wrong reason and
 * the length guard would never be exercised.
 */
const COVER_URL_PREFIX = "https://cdn.readmoo.com/cover/";
function readmooCoverUrlOfLength(length: number): string {
  return COVER_URL_PREFIX + "a".repeat(length - COVER_URL_PREFIX.length);
}

/** Each capped field, with a generator for a value of any exact length. */
const CAPPED_FIELDS = [
  {
    field: "bookId",
    max: BORROW_BOOK_ID_MAX_LENGTH,
    valueOfLength: (n: number) => "b".repeat(n),
  },
  {
    field: "bookTitle",
    max: BORROW_BOOK_TITLE_MAX_LENGTH,
    valueOfLength: (n: number) => "t".repeat(n),
  },
  {
    field: "bookAuthor",
    max: BORROW_BOOK_AUTHOR_MAX_LENGTH,
    valueOfLength: (n: number) => "a".repeat(n),
  },
  {
    field: "bookCoverUrl",
    max: BORROW_COVER_URL_MAX_LENGTH,
    valueOfLength: readmooCoverUrlOfLength,
  },
] as const;

describe("POST /api/family/:id/borrow field length caps", () => {
  it.each(CAPPED_FIELDS)(
    "should reject $field one character over its cap with 400 INVALID_FIELDS",
    async ({ field, max, valueOfLength }) => {
      const { familyId, token2 } = await createFamilyWithTwoMembers();
      const value = valueOfLength(max + 1);
      expect(value).toHaveLength(max + 1);

      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...validBorrowBody, [field]: value },
        token2,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      // Never MISSING_FIELDS (the value is present) and — for the cover URL —
      // never INVALID_COVER_URL: the over-cap value IS on the whitelist, so
      // this code is what proves the LENGTH guard refused it.
      expect(json.error.code).toBe("INVALID_FIELDS");

      // Nothing persisted, so an oversized field cannot reach the shared value
      // even once.
      expect(await kv.get(kvKeys.borrowsByFamily(familyId), "json")).toBeNull();
    },
  );

  it.each(CAPPED_FIELDS)(
    "should accept $field at exactly its cap and store it verbatim",
    async ({ field, max, valueOfLength }) => {
      const { familyId, token2 } = await createFamilyWithTwoMembers();
      const value = valueOfLength(max);
      expect(value).toHaveLength(max);

      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...validBorrowBody, [field]: value },
        token2,
      );

      // The positive companion for the rejections above: without it a guard
      // that refused every value of this field would keep them all green.
      expect(res.status).toBe(201);
      const json = (await res.json()) as Json;
      expect(json.data[field]).toBe(value);

      const stored = await readIndexEntry(familyId, json.data.requestId);
      expect(stored?.[field]).toBe(value);
    },
  );

  it("should not charge the borrow-create counter for an over-cap field", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const { res, calls } = await prodRequest(
      "POST",
      `/api/family/${familyId}/borrow`,
      {
        ...validBorrowBody,
        bookTitle: "t".repeat(BORROW_BOOK_TITLE_MAX_LENGTH + 1),
      },
      token2,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_FIELDS");

    // The cap is checked in the same guard slot as the string-type check,
    // BEFORE `enforcePerUserRateLimit` — a malformed request must not burn the
    // caller's own borrow quota. The matching "charged once" case lives in the
    // bookCoverUrl describe above.
    expect(perUserCharges(calls)).toHaveLength(0);
    expect(await perUserCounterKeys()).toHaveLength(0);
  });
});

// ===========================================================================
// GET /api/family/:id/borrow — list borrow requests
// ===========================================================================

describe("GET /api/family/:id/borrow", () => {
  /** Create a PENDING borrow request; returns its requestId. */
  async function createBorrow(
    familyId: string,
    borrowerToken: string,
    ownerId: string,
    bookId: string,
  ) {
    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId, bookId },
      borrowerToken,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    return json.data.requestId as string;
  }

  /** GET the family borrow list as `token`; asserts 200 and returns `data`. */
  async function listBorrows(familyId: string, token: string) {
    const res = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    return json.data as BorrowRequest[];
  }

  it("should return all borrow requests the caller is a party to", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Create two borrow requests
    await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1, bookId: "book-1" },
      token2,
    );
    await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1, bookId: "book-2" },
      token2,
    );

    const res = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data).toHaveLength(2);
    expect(json.data[0].bookId).toBe("book-1");
    expect(json.data[1].bookId).toBe("book-2");
  });

  it("should hide a record from a family member who is neither borrower nor owner", async () => {
    const { familyId, token2, token3 } = await createFamilyWithThreeMembers();

    // USER2 borrows USER1's book — USER3 is in the family but not a party.
    const requestId = await createBorrow(familyId, token2, USER1, "book-1");

    // The record really exists IN THE INDEX the list handler reads; emptiness
    // below must come from the party filter, not from a missing record. Reading
    // the `borrow:{requestId}` pointer would not prove that — it exists even
    // for a record the trim has evicted from the index.
    expect(await readIndexEntry(familyId, requestId)).toBeDefined();

    const visible = await listBorrows(familyId, token3);
    expect(visible).toEqual([]);
  });

  it("should return the record to both parties of the transaction", async () => {
    const { familyId, token1, token2 } = await createFamilyWithThreeMembers();

    const requestId = await createBorrow(familyId, token2, USER1, "book-1");

    const ownerView = await listBorrows(familyId, token1);
    expect(ownerView).toHaveLength(1);
    expect(ownerView[0].requestId).toBe(requestId);

    const borrowerView = await listBorrows(familyId, token2);
    expect(borrowerView).toHaveLength(1);
    expect(borrowerView[0].requestId).toBe(requestId);
  });

  it("should scope each caller's list to the records they are a party to", async () => {
    const { familyId, token1, token2, token3 } =
      await createFamilyWithThreeMembers();

    // Two records sharing an owner (USER1) but with different borrowers.
    const req2to1 = await createBorrow(familyId, token2, USER1, "book-1");
    const req3to1 = await createBorrow(familyId, token3, USER1, "book-2");

    const borrower2View = await listBorrows(familyId, token2);
    expect(borrower2View.map((r) => r.requestId)).toEqual([req2to1]);
    expect(borrower2View.every((r) => r.borrowerId !== USER3)).toBe(true);

    const borrower3View = await listBorrows(familyId, token3);
    expect(borrower3View.map((r) => r.requestId)).toEqual([req3to1]);
    expect(borrower3View.every((r) => r.borrowerId !== USER2)).toBe(true);

    // The shared owner is a party to both.
    const ownerView = await listBorrows(familyId, token1);
    expect(ownerView.map((r) => r.requestId)).toEqual([req2to1, req3to1]);
  });

  it("should return empty array when no requests exist", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data).toEqual([]);
  });

  it("should return 401 if not authenticated", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const res = await request("GET", `/api/family/${familyId}/borrow`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 if caller is not a family member", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    // user3 is not in the family
    const { authToken: token3 } = await createFamilyAndGetToken(USER3);

    const res = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token3,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should return 404 if family not found", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "GET",
      "/api/family/zzzz-zzzz/borrow",
      undefined,
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return 400 for invalid family ID format", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "GET",
      "/api/family/INVALID/borrow",
      undefined,
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });
});

// ===========================================================================
// PATCH /api/borrow/:requestId — update borrow status
// ===========================================================================

describe("PATCH /api/borrow/:requestId", () => {
  /** Helper: create a PENDING borrow request and return its requestId. */
  async function createPendingBorrowRequest(familyId: string, token2: string) {
    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token2,
    );
    const json = (await res.json()) as Json;
    return json.data.requestId as string;
  }

  // --- Valid transitions ---

  it("should allow PENDING -> LENT (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.LENT);
    expect(json.data.updatedAt).toBeDefined();
  });

  it("should allow PENDING -> REJECTED (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.REJECTED);
  });

  it("should allow PENDING -> CANCELLED (by borrower)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.CANCELLED);
  });

  it("should allow LENT -> RETURNED (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // First transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Then mark as RETURNED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.RETURNED);
  });

  it("should allow LENT -> RETURNED (by borrower)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // First transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Borrower marks as RETURNED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token2,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.RETURNED);
  });

  // --- Invalid transitions ---

  it("should return 422 for PENDING -> RETURNED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for LENT -> CANCELLED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Try invalid: LENT -> CANCELLED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for REJECTED -> any transition", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Transition to REJECTED (terminal)
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );

    // Try REJECTED -> LENT
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for RETURNED -> any transition", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // PENDING -> LENT -> RETURNED (terminal)
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );

    // Try RETURNED -> LENT
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for CANCELLED -> any transition", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Cancel
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );

    // Try CANCELLED -> PENDING (or any)
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token2,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  // --- Permission checks ---

  it("should return 403 if borrower tries to LENT", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token2, // borrower
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if borrower tries to REJECTED", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token2, // borrower
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if owner tries to CANCELLED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token1, // owner
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if unrelated user tries any transition", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Create user3 with their own token
    const { authToken: token3 } = await createFamilyAndGetToken(USER3);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token3,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  // --- Other error cases ---

  it("should return 404 if requestId not found", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    // Well-formed UUID v4 that doesn't exist in KV
    const validButMissingId = crypto.randomUUID();
    const res = await request(
      "PATCH",
      `/api/borrow/${validButMissingId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("should return 400 if requestId format is invalid", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PATCH",
      "/api/borrow/not-a-valid-uuid",
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_REQUEST_ID");
  });

  it("should return 400 if status field is missing", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request("PATCH", `/api/borrow/${requestId}`, {}, token1);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 401 if not authenticated", async () => {
    const res = await request("PATCH", "/api/borrow/some-request-id", {
      status: BorrowStatus.LENT,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 for invalid JSON body", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = app.request(
      `/api/borrow/${requestId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: "{invalid json}",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect((await res).status).toBe(400);
  });

  it("should persist updated status in KV", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // The status lives in the family index; PATCH rewrites that key only.
    const stored = await readIndexEntry(familyId, requestId);
    expect(stored?.status).toBe(BorrowStatus.LENT);

    // The pointer is untouched by a status change — it carries `familyId` and
    // nothing a transition could alter.
    expect(await readPointer(requestId)).toEqual({ familyId });
  });

  it("should return 422 for invalid target status value", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: 99 },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });
});
