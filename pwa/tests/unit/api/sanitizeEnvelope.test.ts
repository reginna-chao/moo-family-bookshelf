import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, BoolFlag, BorrowStatus } from "@/api/client";

/**
 * The WIRING half of the backend-text hardening. `pwa/tests/unit/entityText.test.ts`
 * proves the sanitizers are correct in isolation; this file proves they are
 * actually CALLED — a method that silently loses its `sanitizeEnvelope(...)` /
 * `sanitizeRecord(...)` / `sanitizeBorrowRequests(...)` wrapper would keep every
 * unit test green while shipping the white screen back.
 *
 * Threat model (full version at `shared/src/api/safeText.ts`): the client reads
 * its envelope through a bare cast and the endpoint is user-configurable — a
 * sync code's `@host` segment repoints the whole PWA at a self-hosted (BYO)
 * backend. An object reaching a JSX child throws React 19's "Objects are not
 * valid as a React child"; a non-string reaching `.toLowerCase()` / `.trim()` /
 * `.localeCompare()` throws a TypeError. The PWA has no ErrorBoundary, so
 * either one is a permanent white screen until the user reloads.
 *
 * `getPublicShelf` is the highest-stakes case in this file: it bypasses
 * `readEnvelope` with its OWN `fetch` + bare cast, and its consumer
 * (`PublicShelfPage`) is reachable by anyone holding a share link — including a
 * visitor who never configured the endpoint and cannot diagnose a blank page.
 * The sanitizer is the only guard on that path.
 *
 * Every hostile fixture below is a value `JSON.parse` can actually produce.
 */

const ENDPOINT = "https://api.example.com";
const FAMILY_ID = "fam-abc123";
const USER_ID = "a".repeat(64);
const OTHER_USER_ID = "b".repeat(64);
const SHELF_ID = "shelf-1";
const REQUEST_ID = "req-123";
const LIST_REQUEST_ID = "req-hostile-1";
const SHARE_TOKEN = "tok-public-abc";

const mockFetch = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** The same record minus one key, with the remaining key order preserved. */
function omit<T extends object>(
  record: T,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => entryKey !== key),
  );
}

/** Read `a.b.0.c` out of a resolved payload. */
function pick(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return acc;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

// --- Hostile fixtures ---

const HOSTILE_MEMBER = {
  userId: ["a", "b"],
  displayName: { "zh-TW": "小明" },
  canLend: BoolFlag.FALSE,
  readmooName: 7,
};

const HOSTILE_BOOK = {
  bookId: { id: 1 },
  title: { "zh-TW": "小王子" },
  author: 42,
  isbn: [],
  coverUrl: "https://cdn.readmoo.com/cover/1.jpg",
  readmooUrl: { href: "https://readmoo.com" },
  category: null,
  isShared: BoolFlag.TRUE,
};

const HOSTILE_GROUP = {
  familyId: { id: "fam" },
  ownerId: 42,
  members: [HOSTILE_MEMBER],
  maxMembers: 6,
  createdAt: { seconds: 1_700_000_000 },
  apiEndpoint: { host: "evil.example.com" },
  authToken: "tok-secret-value",
  expiresAt: 1_700_000_000_000,
};

const HOSTILE_BOOKSHELF = {
  familyId: { id: "fam" },
  members: [
    {
      userId: { id: 1 },
      displayName: ["小明"],
      books: [HOSTILE_BOOK],
      lastUpdated: { seconds: 1 },
    },
  ],
};

const HOSTILE_PERSONAL = {
  schemaVersion: 1,
  userId: { id: 1 },
  displayName: { "zh-TW": "小明" },
  books: [HOSTILE_BOOK],
  lastUpdated: 1_700_000_000_000,
};

const HOSTILE_REQUEST = {
  requestId: { id: "req" },
  familyId: ["fam"],
  borrowerId: 1,
  borrowerName: { "zh-TW": "小華" },
  ownerId: {},
  bookId: [],
  bookTitle: { "zh-TW": "小王子" },
  bookAuthor: 42,
  bookCoverUrl: "https://cdn.readmoo.com/cover/1.jpg",
  status: BorrowStatus.PENDING,
  createdAt: { seconds: 1 },
  updatedAt: [2026],
};

/**
 * The borrow LIST element, which answers to a different (stricter) sanitizer
 * than `HOSTILE_REQUEST` above. Three deliberate differences:
 * - a usable `requestId`, because `sanitizeBorrowRequests` DROPS an element
 *   without one instead of degrading it to `""`;
 * - a NON-string `bookCoverUrl`, because the list path normalizes that field
 *   too (the single-object path leaves it alone);
 * - two extra properties, which the 12-field rebuild must strip.
 */
const HOSTILE_LIST_REQUEST = {
  ...HOSTILE_REQUEST,
  requestId: LIST_REQUEST_ID,
  bookCoverUrl: { href: "https://cdn.readmoo.com/cover/1.jpg" },
  evil: "x",
  nested: { deep: true },
};

const HOSTILE_SHELF = {
  shelfId: { id: "shelf" },
  shareToken: 42,
  title: { "zh-TW": "小明 的公開書櫃" },
  expiresDays: 30,
  createdAt: 1_700_000_000_000,
  expiresAt: null,
  selectionMode: "all-shared",
};

const HOSTILE_SHELF_DATA = {
  title: { "zh-TW": "小明 的公開書櫃" },
  books: [HOSTILE_BOOK],
  createdAt: 1_700_000_000_000,
  expiresAt: null,
};

/** A path in the RESOLVED value and the value it must carry after sanitizing. */
interface Expectation {
  path: string;
  value: unknown;
}

interface WiringCase {
  name: string;
  data: unknown;
  invoke: (client: ApiClient) => Promise<unknown>;
  expected: Expectation[];
}

const GROUP_EXPECTATIONS: Expectation[] = [
  { path: "data.familyId", value: "" },
  { path: "data.ownerId", value: "" },
  { path: "data.createdAt", value: "" },
  { path: "data.members.0.userId", value: "" },
  { path: "data.members.0.displayName", value: "" },
  { path: "data.members.0.readmooName", value: "" },
  // Tri-state: a non-string endpoint degrades to null, never to "".
  { path: "data.apiEndpoint", value: null },
  // Deliberate exclusions — a credential, a flag and a number.
  { path: "data.authToken", value: "tok-secret-value" },
  { path: "data.members.0.canLend", value: BoolFlag.FALSE },
  { path: "data.maxMembers", value: 6 },
];

/**
 * The two SINGLE-OBJECT borrow paths (`createBorrowRequest` /
 * `updateBorrowStatus`), which run `sanitizeRecord` + `sanitizeBorrowRequestText`.
 * The list path answers to a different sanitizer — see `LIST_BORROW_EXPECTATIONS`.
 */
const BORROW_EXPECTATIONS: Expectation[] = [
  { path: "requestId", value: "" },
  { path: "familyId", value: "" },
  { path: "borrowerId", value: "" },
  { path: "borrowerName", value: "" },
  { path: "ownerId", value: "" },
  { path: "bookId", value: "" },
  { path: "bookTitle", value: "" },
  { path: "bookAuthor", value: "" },
  { path: "createdAt", value: "" },
  { path: "updatedAt", value: "" },
  // Excluded on purpose: the badge lookup hardens `status` itself, and the
  // cover URL only ever reaches an attribute.
  { path: "status", value: BorrowStatus.PENDING },
  { path: "bookCoverUrl", value: "https://cdn.readmoo.com/cover/1.jpg" },
];

/**
 * `listBorrowRequests` is owned by `sanitizeBorrowRequests`
 * (`pwa/src/api/borrowValidation.ts`, PR #144), NOT by
 * `sanitizeBorrowRequestText`. Its contract is strictly stronger, and these rows
 * are what tells the two apart: `requestId` survives verbatim (an unusable one
 * drops the whole element rather than degrading to `""`), `bookCoverUrl` IS
 * normalized here, and every surviving element is rebuilt from exactly the 12
 * interface fields, so hostile extras cannot reach React state.
 */
const LIST_BORROW_EXPECTATIONS: Expectation[] = [
  { path: "0.requestId", value: LIST_REQUEST_ID },
  { path: "0.familyId", value: "" },
  { path: "0.borrowerId", value: "" },
  { path: "0.borrowerName", value: "" },
  { path: "0.ownerId", value: "" },
  { path: "0.bookId", value: "" },
  { path: "0.bookTitle", value: "" },
  { path: "0.bookAuthor", value: "" },
  { path: "0.bookCoverUrl", value: "" },
  { path: "0.createdAt", value: "" },
  { path: "0.updatedAt", value: "" },
  // Still excluded on purpose — the badge lookup hardens `status` itself.
  { path: "0.status", value: BorrowStatus.PENDING },
  // Stripped by the 12-field rebuild, never spread through.
  { path: "0.evil", value: undefined },
  { path: "0.nested", value: undefined },
];

const SHELF_RESULT_EXPECTATIONS: Expectation[] = [
  { path: "shelf.shelfId", value: "" },
  { path: "shelf.shareToken", value: "" },
  { path: "shelf.title", value: "" },
  { path: "shelf.selectionMode", value: "all-shared" },
  { path: "shelf.expiresDays", value: 30 },
];

/**
 * One row per production call site that applies a sanitizer. `checkVersion` and
 * `getPublicShelf` both bypass `request()` with their own `fetch`, so they get
 * dedicated cases below. A new wired method needs a row here, or its boundary
 * ships unpinned.
 */
const WIRING_CASES: WiringCase[] = [
  {
    name: "getFamilyMembers",
    data: HOSTILE_GROUP,
    invoke: (client) => client.getFamilyMembers(FAMILY_ID),
    expected: GROUP_EXPECTATIONS,
  },
  {
    name: "createFamily",
    data: HOSTILE_GROUP,
    invoke: (client) => client.createFamily(USER_ID, "小明"),
    expected: GROUP_EXPECTATIONS,
  },
  {
    name: "getFamilyBookshelf",
    data: HOSTILE_BOOKSHELF,
    invoke: (client) => client.getFamilyBookshelf(FAMILY_ID),
    expected: [
      { path: "data.familyId", value: "" },
      { path: "data.members.0.userId", value: "" },
      { path: "data.members.0.displayName", value: "" },
      // PWA-only tri-state: `null` means "never synced", so a hostile value
      // degrades to null rather than to "".
      { path: "data.members.0.lastUpdated", value: null },
      { path: "data.members.0.books.0.bookId", value: "" },
      { path: "data.members.0.books.0.title", value: "" },
      { path: "data.members.0.books.0.author", value: "" },
      { path: "data.members.0.books.0.isbn", value: "" },
      { path: "data.members.0.books.0.readmooUrl", value: "" },
      { path: "data.members.0.books.0.category", value: "" },
      {
        path: "data.members.0.books.0.coverUrl",
        value: "https://cdn.readmoo.com/cover/1.jpg",
      },
      { path: "data.members.0.books.0.isShared", value: BoolFlag.TRUE },
    ],
  },
  {
    name: "getPersonalBooks",
    data: HOSTILE_PERSONAL,
    invoke: (client) => client.getPersonalBooks(USER_ID),
    expected: [
      { path: "data.userId", value: "" },
      { path: "data.displayName", value: "" },
      { path: "data.lastUpdated", value: "" },
      { path: "data.books.0.title", value: "" },
      { path: "data.books.0.author", value: "" },
      { path: "data.schemaVersion", value: 1 },
    ],
  },
  {
    name: "listBorrowRequests",
    data: [HOSTILE_LIST_REQUEST],
    invoke: (client) => client.listBorrowRequests(FAMILY_ID),
    expected: LIST_BORROW_EXPECTATIONS,
  },
  {
    name: "createBorrowRequest",
    data: HOSTILE_REQUEST,
    invoke: (client) =>
      client.createBorrowRequest(FAMILY_ID, {
        bookId: "210012345000",
        bookTitle: "小王子",
        bookAuthor: "Saint-Exupéry",
        bookCoverUrl: "https://cdn.readmoo.com/cover/1.jpg",
        ownerId: OTHER_USER_ID,
      }),
    expected: BORROW_EXPECTATIONS,
  },
  {
    name: "updateBorrowStatus",
    data: HOSTILE_REQUEST,
    invoke: (client) =>
      client.updateBorrowStatus(REQUEST_ID, BorrowStatus.LENT),
    expected: BORROW_EXPECTATIONS,
  },
  {
    name: "updateMemberSettings",
    data: HOSTILE_MEMBER,
    invoke: (client) =>
      client.updateMemberSettings(FAMILY_ID, USER_ID, {
        canLend: BoolFlag.FALSE,
      }),
    expected: [
      { path: "userId", value: "" },
      { path: "displayName", value: "" },
      { path: "readmooName", value: "" },
      { path: "canLend", value: BoolFlag.FALSE },
    ],
  },
  {
    name: "listPublicShelves",
    data: { shelves: [HOSTILE_SHELF] },
    invoke: (client) => client.listPublicShelves(USER_ID),
    expected: [
      { path: "shelves.0.shelfId", value: "" },
      { path: "shelves.0.shareToken", value: "" },
      { path: "shelves.0.title", value: "" },
      { path: "shelves.0.selectionMode", value: "all-shared" },
    ],
  },
  {
    name: "createPublicShelf",
    data: { shelf: HOSTILE_SHELF },
    invoke: (client) =>
      client.createPublicShelf(USER_ID, { title: "書櫃", expiresDays: 30 }),
    expected: SHELF_RESULT_EXPECTATIONS,
  },
  {
    name: "updatePublicShelf",
    data: { shelf: HOSTILE_SHELF },
    invoke: (client) =>
      client.updatePublicShelf(USER_ID, SHELF_ID, { title: "書櫃" }),
    expected: SHELF_RESULT_EXPECTATIONS,
  },
  {
    name: "resetPublicShelfToken",
    data: { shelf: HOSTILE_SHELF },
    invoke: (client) => client.resetPublicShelfToken(USER_ID, SHELF_ID),
    expected: SHELF_RESULT_EXPECTATIONS,
  },
];

describe("ApiClient backend-text sanitization", () => {
  let client: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    client = new ApiClient(ENDPOINT);
    client.setAuthToken("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("wired call sites", () => {
    it.each(WIRING_CASES)(
      "$name coerces the backend text fields before they leave the client",
      async ({ data, invoke, expected }) => {
        mockFetch.mockResolvedValue(jsonResponse({ data }));

        const result = await invoke(client);

        for (const { path, value } of expected) {
          expect(pick(result, path)).toStrictEqual(value);
        }
      },
    );

    it.each(WIRING_CASES)(
      "$name resolves instead of throwing on a hostile payload",
      async ({ data, invoke }) => {
        mockFetch.mockResolvedValue(jsonResponse({ data }));

        await expect(invoke(client)).resolves.toBeDefined();
      },
    );

    it("checkVersion degrades a hostile serverVersion", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ data: { apiVersion: 3, serverVersion: { major: 1 } } }),
      );

      const result = await client.checkVersion();

      expect(result?.serverVersion).toBe("");
      expect(result?.apiVersion).toBe(3);
    });

    it("checkVersion still returns null when the envelope carries no data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));

      await expect(client.checkVersion()).resolves.toBeNull();
    });
  });

  /**
   * `getPublicShelf` never touches `readEnvelope` — it parses its own response
   * with a bare cast (`pwa/src/api/client.ts`), so the sanitizer applied to its
   * return value is the SOLE guard between a hostile public snapshot and
   * `PublicShelfPage`, which renders `title` / `book.title` / `book.author`
   * straight into JSX and calls `.toLowerCase()` on them while searching.
   */
  describe("getPublicShelf (readEnvelope bypass)", () => {
    it("degrades the snapshot title and every book text field", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ data: HOSTILE_SHELF_DATA }));

      const result = await client.getPublicShelf(SHARE_TOKEN);

      expect(result.title).toBe("");
      expect(result.books[0].bookId).toBe("");
      expect(result.books[0].title).toBe("");
      expect(result.books[0].author).toBe("");
      expect(result.books[0].isbn).toBe("");
      expect(result.books[0].readmooUrl).toBe("");
      expect(result.books[0].category).toBe("");
    });

    it("leaves the cover URL and the flags of a snapshot book untouched", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ data: HOSTILE_SHELF_DATA }));

      const result = await client.getPublicShelf(SHARE_TOKEN);

      expect(result.books[0].coverUrl).toBe(
        "https://cdn.readmoo.com/cover/1.jpg",
      );
      expect(result.books[0].isShared).toBe(BoolFlag.TRUE);
      expect(result.createdAt).toBe(1_700_000_000_000);
      expect(result.expiresAt).toBeNull();
    });

    it("returns a valid snapshot JSON.stringify-identical", async () => {
      const valid = {
        title: "小明 的公開書櫃",
        books: [
          {
            bookId: "210012345000",
            title: "小王子",
            author: "Saint-Exupéry",
            isbn: "9789573317249",
            coverUrl: "https://cdn.readmoo.com/cover/1.jpg",
            readmooUrl: "https://readmoo.com/book/210012345000",
            category: "文學小說",
            isShared: BoolFlag.TRUE,
          },
        ],
        createdAt: 1_700_000_000_000,
        expiresAt: null,
      };
      mockFetch.mockResolvedValue(jsonResponse({ data: valid }));

      const result = await client.getPublicShelf(SHARE_TOKEN);

      expect(JSON.stringify(result)).toBe(JSON.stringify(valid));
    });

    it("passes a books list that is not an array straight through", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ data: { ...HOSTILE_SHELF_DATA, books: "nope" } }),
      );

      const result = await client.getPublicShelf(SHARE_TOKEN);

      expect(result.books).toBe("nope");
      expect(result.title).toBe("");
    });

    it("lets a null book survive inside the snapshot list", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          data: { ...HOSTILE_SHELF_DATA, books: [null, HOSTILE_BOOK] },
        }),
      );

      const result = await client.getPublicShelf(SHARE_TOKEN);

      expect(result.books[0]).toBeNull();
      expect(result.books[1].title).toBe("");
    });

    // Sanitizing must not swallow the two failure modes the page branches on.
    it("still throws the coded error an error envelope carries", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(
          { error: { code: "NOT_FOUND", message: "Unknown share token" } },
          404,
        ),
      );

      await expect(client.getPublicShelf(SHARE_TOKEN)).rejects.toThrow(
        "NOT_FOUND: Unknown share token",
      );
    });

    it("still throws EMPTY_RESPONSE when the body carries no data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));

      await expect(client.getPublicShelf(SHARE_TOKEN)).rejects.toThrow(
        "EMPTY_RESPONSE",
      );
    });
  });

  /**
   * A REAL payload must survive the boundary byte-identical. If this drifts,
   * the layer has stopped coercing types and started rewriting content — which
   * would silently corrupt what the user sees and what the next save uploads.
   */
  describe("valid payloads", () => {
    const VALID_GROUP = {
      familyId: FAMILY_ID,
      ownerId: USER_ID,
      members: [
        {
          userId: USER_ID,
          displayName: "小明",
          canLend: BoolFlag.TRUE,
          readmooName: "ming@readmoo",
        },
      ],
      maxMembers: 6,
      createdAt: "2026-04-26T00:00:00Z",
      apiEndpoint: "https://byo.example.com",
      authToken: "tok-secret-value",
      expiresAt: 1_700_000_000_000,
    };

    it("returns a valid family group JSON.stringify-identical", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ data: VALID_GROUP }));

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(JSON.stringify(result.data)).toBe(JSON.stringify(VALID_GROUP));
    });

    it("keeps an apiEndpoint of null as null rather than an empty string", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ data: { ...VALID_GROUP, apiEndpoint: null } }),
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.apiEndpoint).toBeNull();
    });

    it("keeps an omitted apiEndpoint absent from the JSON payload", async () => {
      const withoutEndpoint = omit(VALID_GROUP, "apiEndpoint");
      mockFetch.mockResolvedValue(jsonResponse({ data: withoutEndpoint }));

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.apiEndpoint).toBeUndefined();
      expect(JSON.stringify(result.data)).toBe(JSON.stringify(withoutEndpoint));
    });
  });

  /**
   * `sanitizeEnvelope` short-circuits on `data === undefined`, so an error
   * envelope keeps its exact shape. Anything else would break the callers that
   * branch on `res.error.code`.
   */
  describe("error envelopes", () => {
    it("passes an error envelope through untouched", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(
          { error: { code: "FORBIDDEN", message: "Not a member" } },
          403,
        ),
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data).toBeUndefined();
      expect(result.error).toEqual({
        code: "FORBIDDEN",
        message: "Not a member",
      });
    });

    it("keeps the retryAfter hint on a rate-limit envelope", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Slow down",
              retryAfter: 42,
            },
          },
          429,
        ),
      );

      const result = await client.getFamilyBookshelf(FAMILY_ID);

      expect(result.error?.retryAfter).toBe(42);
    });
  });

  /**
   * The fail-safe contract: a `data` that cannot carry the expected fields must
   * reach the caller exactly as it did before this layer existed. Reading
   * through it would throw a TypeError out of the client — turning the
   * hardening into the very failure it prevents.
   *
   * The borrow LIST is the one deliberate exception: `sanitizeBorrowRequests`
   * (PR #144) fails CLOSED instead — a non-array container degrades to `[]` and
   * an unaddressable element is dropped, because an element with no usable
   * `requestId` can serve neither as a React key nor as the target of
   * `PATCH /api/borrow/:id`.
   */
  describe("structurally broken payloads", () => {
    it("passes a members list that is not an array straight through", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ data: { ...HOSTILE_GROUP, members: "not-an-array" } }),
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.members).toBe("not-an-array");
      expect(result.data?.familyId).toBe("");
    });

    it("lets a null member survive inside an otherwise valid list", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          data: { ...HOSTILE_GROUP, members: [null, HOSTILE_MEMBER] },
        }),
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.members[0]).toBeNull();
      expect(result.data?.members[1].displayName).toBe("");
    });

    it("passes a non-object data payload straight through", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ data: "a bare string, not a record" }),
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data).toBe("a bare string, not a record");
    });

    it("degrades a borrow list that is not an array to an empty list", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockResolvedValue(jsonResponse({ data: "not-a-list" }));

      await expect(client.listBorrowRequests(FAMILY_ID)).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[borrowValidation]"),
      );
    });

    it("drops a null borrow request from the list instead of passing it through", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockResolvedValue(
        jsonResponse({ data: [null, HOSTILE_LIST_REQUEST] }),
      );

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result).toHaveLength(1);
      expect(result[0].requestId).toBe(LIST_REQUEST_ID);
      expect(result[0].bookTitle).toBe("");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropped 1"),
      );
    });
  });
});
