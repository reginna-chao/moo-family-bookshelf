import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import { BoolFlag, BorrowStatus } from "@/api/types";

// Pin DEFAULT_API_ENDPOINT (avoids import.meta.env dependence) while keeping
// every other real constant the client module imports.
vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

/**
 * The WIRING half of the backend-text hardening. `extension/tests/unit/entityText.test.ts`
 * proves the sanitizers are correct in isolation; this file proves they are
 * actually CALLED — a method that silently loses its `sanitizeEnvelope(...)` /
 * `sanitizeRecord(...)` wrapper would keep every unit test green while shipping
 * the white screen back.
 *
 * Threat model (full version at `shared/src/api/safeText.ts`): the client reads
 * its envelope through a bare cast and the endpoint is user-configurable — a
 * sync code's `@host` segment repoints the whole Extension at a self-hosted
 * (BYO) backend. An object reaching a JSX child throws React 19's "Objects are
 * not valid as a React child"; a non-string reaching `.toLowerCase()` /
 * `.trim()` / `.localeCompare()` throws a TypeError. The Dialog has no
 * ErrorBoundary, so either one is a permanent white screen on the very surface
 * where the user would switch the endpoint back.
 *
 * Every hostile fixture below is a value `JSON.parse` can actually produce.
 */

const MOCK_ENDPOINT = "https://test.workers.dev";
const FAMILY_ID = "fam-abc123";
const USER_ID = "a".repeat(64);
const OTHER_USER_ID = "b".repeat(64);
const SHELF_ID = "shelf-1";
const REQUEST_ID = "req-123";

function mockFetchSuccess(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
}

function mockFetchBody(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
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
  members: [
    {
      userId: { id: 1 },
      displayName: ["小明"],
      books: [HOSTILE_BOOK],
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

const HOSTILE_SHELF = {
  shelfId: { id: "shelf" },
  shareToken: 42,
  title: { "zh-TW": "小明 的公開書櫃" },
  expiresDays: 30,
  createdAt: 1_700_000_000_000,
  expiresAt: null,
  selectionMode: "all-shared",
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

const BORROW_EXPECTATIONS = (prefix: string): Expectation[] => [
  { path: `${prefix}requestId`, value: "" },
  { path: `${prefix}familyId`, value: "" },
  { path: `${prefix}borrowerId`, value: "" },
  { path: `${prefix}borrowerName`, value: "" },
  { path: `${prefix}ownerId`, value: "" },
  { path: `${prefix}bookId`, value: "" },
  { path: `${prefix}bookTitle`, value: "" },
  { path: `${prefix}bookAuthor`, value: "" },
  { path: `${prefix}createdAt`, value: "" },
  { path: `${prefix}updatedAt`, value: "" },
  // Excluded on purpose: the badge lookup hardens `status` itself, and the
  // cover URL only ever reaches an attribute.
  { path: `${prefix}status`, value: BorrowStatus.PENDING },
  {
    path: `${prefix}bookCoverUrl`,
    value: "https://cdn.readmoo.com/cover/1.jpg",
  },
];

const SHELF_RESULT_EXPECTATIONS: Expectation[] = [
  { path: "shelf.shelfId", value: "" },
  { path: "shelf.shareToken", value: "" },
  { path: "shelf.title", value: "" },
  { path: "shelf.selectionMode", value: "all-shared" },
  { path: "shelf.expiresDays", value: 30 },
];

/**
 * One row per production call site that applies a sanitizer, covering all 15
 * envelope-based methods (`checkVersion`, the 16th, bypasses `request()` and
 * gets its own case below). A new wired method needs a row here, or its
 * boundary ships unpinned.
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
    name: "joinFamily",
    data: HOSTILE_GROUP,
    invoke: (client) => client.joinFamily(FAMILY_ID, USER_ID, "小明"),
    expected: GROUP_EXPECTATIONS,
  },
  {
    name: "transferOwnership",
    data: HOSTILE_GROUP,
    invoke: (client) =>
      client.transferOwnership(FAMILY_ID, USER_ID, OTHER_USER_ID),
    expected: GROUP_EXPECTATIONS,
  },
  {
    name: "getFamilyBookshelf",
    data: HOSTILE_BOOKSHELF,
    invoke: (client) => client.getFamilyBookshelf(FAMILY_ID),
    expected: [
      { path: "data.members.0.userId", value: "" },
      { path: "data.members.0.displayName", value: "" },
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
    data: [HOSTILE_REQUEST],
    invoke: (client) => client.listBorrowRequests(FAMILY_ID),
    expected: BORROW_EXPECTATIONS("0."),
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
    expected: BORROW_EXPECTATIONS(""),
  },
  {
    name: "updateBorrowStatus",
    data: HOSTILE_REQUEST,
    invoke: (client) =>
      client.updateBorrowStatus(REQUEST_ID, BorrowStatus.LENT),
    expected: BORROW_EXPECTATIONS(""),
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
    name: "generateOtp",
    data: { code: { digits: [4, 8, 2] }, expiresAt: 1_700_000_000_000 },
    invoke: (client) => client.generateOtp(USER_ID),
    expected: [
      { path: "data.code", value: "" },
      { path: "data.expiresAt", value: 1_700_000_000_000 },
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
    client.setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("wired call sites", () => {
    it.each(WIRING_CASES)(
      "$name coerces the backend text fields before they leave the client",
      async ({ data, invoke, expected }) => {
        globalThis.fetch = mockFetchSuccess(data);

        const result = await invoke(client);

        for (const { path, value } of expected) {
          expect(pick(result, path)).toStrictEqual(value);
        }
      },
    );

    it.each(WIRING_CASES)(
      "$name resolves instead of throwing on a hostile payload",
      async ({ data, invoke }) => {
        globalThis.fetch = mockFetchSuccess(data);

        await expect(invoke(client)).resolves.toBeDefined();
      },
    );

    // `checkVersion` is the one method that bypasses `request()` with its own
    // `fetch` + bare cast, so it needs its own row rather than a table entry.
    it("checkVersion degrades a hostile serverVersion", async () => {
      globalThis.fetch = mockFetchSuccess({
        apiVersion: 3,
        serverVersion: { major: 1, minor: 6 },
      });

      const result = await client.checkVersion();

      expect(result?.serverVersion).toBe("");
      expect(result?.apiVersion).toBe(3);
    });

    it("checkVersion still returns null when the envelope carries no data", async () => {
      globalThis.fetch = mockFetchBody({});

      await expect(client.checkVersion()).resolves.toBeNull();
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
      globalThis.fetch = mockFetchSuccess(VALID_GROUP);

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(JSON.stringify(result.data)).toBe(JSON.stringify(VALID_GROUP));
    });

    it("keeps an apiEndpoint of null as null rather than an empty string", async () => {
      globalThis.fetch = mockFetchSuccess({
        ...VALID_GROUP,
        apiEndpoint: null,
      });

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.apiEndpoint).toBeNull();
    });

    it("keeps an omitted apiEndpoint absent from the JSON payload", async () => {
      const withoutEndpoint = omit(VALID_GROUP, "apiEndpoint");
      globalThis.fetch = mockFetchSuccess(withoutEndpoint);

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
      globalThis.fetch = mockFetchBody(
        { error: { code: "FORBIDDEN", message: "Not a member" } },
        403,
      );

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data).toBeUndefined();
      expect(result.error).toEqual({
        code: "FORBIDDEN",
        message: "Not a member",
      });
    });

    it("keeps the retryAfter hint on a rate-limit envelope", async () => {
      globalThis.fetch = mockFetchBody(
        {
          error: { code: "RATE_LIMITED", message: "Slow down", retryAfter: 42 },
        },
        429,
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
   */
  describe("structurally broken payloads", () => {
    it("passes a members list that is not an array straight through", async () => {
      globalThis.fetch = mockFetchSuccess({
        ...HOSTILE_GROUP,
        members: "not-an-array",
      });

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.members).toBe("not-an-array");
      expect(result.data?.familyId).toBe("");
    });

    it("lets a null member survive inside an otherwise valid list", async () => {
      globalThis.fetch = mockFetchSuccess({
        ...HOSTILE_GROUP,
        members: [null, HOSTILE_MEMBER],
      });

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data?.members[0]).toBeNull();
      expect(result.data?.members[1].displayName).toBe("");
    });

    it("passes a non-object data payload straight through", async () => {
      globalThis.fetch = mockFetchSuccess("a bare string, not a record");

      const result = await client.getFamilyMembers(FAMILY_ID);

      expect(result.data).toBe("a bare string, not a record");
    });

    it("passes a borrow list that is not an array straight through", async () => {
      globalThis.fetch = mockFetchSuccess("not-a-list");

      await expect(client.listBorrowRequests(FAMILY_ID)).resolves.toBe(
        "not-a-list",
      );
    });

    it("lets a null borrow request survive inside the list", async () => {
      globalThis.fetch = mockFetchSuccess([null, HOSTILE_REQUEST]);

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result[0]).toBeNull();
      expect(result[1].bookTitle).toBe("");
    });
  });
});
