import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  kvKeys,
  BorrowStatus,
  BoolFlag,
  type BorrowRequest,
} from "../../src/kv/schema";
import { NOBODY, USER1, USER2, USER3 } from "../helpers/ids";

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

  it("should return 403 INVALID_OWNER if ownerId is the same as caller (can't borrow own book)", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: USER1 },
      token1, // user1 trying to borrow from user1
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_OWNER");
  });

  it("should return 403 INVALID_OWNER if ownerId is not a family member", async () => {
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

    // Verify KV storage
    const stored = (await kv.get(
      kvKeys.borrow(requestId),
      "json",
    )) as BorrowRequest;
    expect(stored).not.toBeNull();
    expect(stored.requestId).toBe(requestId);
    expect(stored.status).toBe(BorrowStatus.PENDING);

    // Verify index
    const index = (await kv.get(
      kvKeys.borrowsByFamily(familyId),
      "json",
    )) as string[];
    expect(index).toContain(requestId);
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
      // and the list endpoint hands the value straight to the clients.
      const stored = (await kv.get(
        kvKeys.borrow(json.data.requestId),
        "json",
      )) as BorrowRequest;
      expect(stored.bookCoverUrl).toBe("");
      expect("bookCoverUrl" in stored).toBe(true);
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

      const stored = (await kv.get(
        kvKeys.borrow(json.data.requestId),
        "json",
      )) as BorrowRequest;
      expect(stored.bookCoverUrl).toBe(coverUrl);
    },
  );

  // --- Rate-limit accounting (these cases run WITHOUT DEV_MODE) ---
  //
  // DEV_MODE short-circuits `enforcePerUserRateLimit`, so the borrow POST below
  // goes through a helper that omits it. Family setup deliberately keeps using
  // the DEV_MODE helper: it must not spend any of the caller's budget.

  /** Same as {@link request} but WITHOUT `DEV_MODE`, so the live limiters run. */
  function prodRequest(
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
    return app.request(path, init, { KV: kv });
  }

  /** Every per-userId counter key currently in KV, whatever the scope. */
  async function perUserCounterKeys(): Promise<string[]> {
    const listed = await kv.list();
    return listed.keys
      .map((k: { name: string }) => k.name)
      .filter((name: string) => name.startsWith(PER_USER_COUNTER_PREFIX));
  }

  it("should not charge the borrow-create counter for a rejected cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await prodRequest(
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
    expect(await perUserCounterKeys()).toHaveLength(0);
  });

  it("should not charge the borrow-create counter for a wrong-typed cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await prodRequest(
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
    expect(await perUserCounterKeys()).toHaveLength(0);
  });

  it("should charge the borrow-create counter once for an accepted cover URL", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await prodRequest(
      "POST",
      `/api/family/${familyId}/borrow`,
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(201);

    const keys = await perUserCounterKeys();
    expect(keys).toEqual([
      expect.stringContaining(
        `${PER_USER_COUNTER_PREFIX}${BORROW_CREATE_SCOPE}:${USER2}:`,
      ),
    ]);
    expect(await kv.get(keys[0])).toBe("1");
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

    // The record really exists; emptiness below must come from the filter.
    expect(await kv.get(kvKeys.borrow(requestId), "json")).not.toBeNull();

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

    const stored = (await kv.get(
      kvKeys.borrow(requestId),
      "json",
    )) as BorrowRequest;
    expect(stored.status).toBe(BorrowStatus.LENT);
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
