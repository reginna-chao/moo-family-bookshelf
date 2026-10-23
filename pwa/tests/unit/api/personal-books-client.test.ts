import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiClient,
  BoolFlag,
  type ApiResponse,
  type BookEntry,
  type PersonalBooks,
} from "@/api/client";
import { sanitizePersonalBooksResponse } from "moo-family-bookshelf-shared/api/personalBooksValidation";

/**
 * Runtime boundary validation of the `GET /api/user/:id/books` payload —
 * `ApiClient.getPersonalBooks` and `sanitizePersonalBooksResponse` (issue #348).
 *
 * Driven through the public `getPersonalBooks` surface: the contract is what a
 * caller receives when a self-hosted (BYO) or hostile backend answers. What the
 * client cases pin is the COMPOSED contract of the TWO layers it wires, in order:
 *  1. `shared/src/api/personalBooksValidation.ts` — the STRUCTURAL layer. It only
 *     coerces each plain-object book's `BoolFlag` fields: `isShared` is
 *     `BoolFlag.TRUE` for exactly `1` and `BoolFlag.FALSE` for anything else
 *     (default closed — the same rule as the Worker's own `toBoolFlag`, so a
 *     saved `isShared: true` reads as NOT shared), and `isArchived` survives only
 *     as an exact `0` / `1`, otherwise its KEY is omitted. It never drops,
 *     reorders or re-keys a book: the next full PUT replaces the server's list
 *     with the client's, so a dropped book would be deleted from the server.
 *     Every other book field and `data` field passes through by spread. Non-object
 *     elements and a non-array `books` pass through untouched.
 *  2. `shared/src/api/entityText.ts` (`sanitizePersonalBooksText`) — the
 *     declared-STRING coercion, built on `safeText.ts`: its `sanitizeList` DROPS
 *     non-object elements and turns a non-array `books` into `[]`, and the client's
 *     `sanitizeEnvelope` → `sanitizeRecord` turns a non-object `data` into the empty
 *     entity. So the composed result shows those degradations, and the cases that
 *     need to see layer 1 alone live in the direct-import suite at the bottom.
 * Fixtures are VALID except for the field under test, so the text layer is a
 * no-op on them and any change came from layer 1. The same case tables live in
 * `extension/tests/unit/api/personal-books-client.test.ts`; layer 1 is the shared
 * implementation, so the mirrored tables prove each app's own composition. The
 * PWA client rejects a userId that is not 64 hex characters (`assertHexId`), so
 * every case uses one.
 *
 * Warnings: at most ONE aggregate `[personalBooksValidation]` line per response,
 * counting coerced flag values — a missing `isShared` counts (the schema requires
 * it), a missing `isArchived` does not (absent means active). The values
 * themselves are never logged. An error envelope makes layer 1 stand down, and
 * its silence on a payload full of bad flags is the proof it did not run.
 *
 * The direct-import suite pins what the composed one cannot see, because the
 * text layer re-spreads every book into a fresh object: the errored / empty
 * envelopes returned by IDENTITY, non-object elements kept in place (the text
 * layer is what drops them), and the structural layer's own prototype handling.
 * `JSON.parse` yields an OWN "__proto__" key, as a real `response.json()` does
 * with a hostile body (a plain, non-computed object literal would set the
 * prototype instead), so the fixtures are parsed, not written as literals.
 *
 * The Extension twin also runs the saved list through its sync merge; the PWA
 * has no sync path (it cannot scrape Readmoo), so that case is Extension-only.
 */

const MOCK_ENDPOINT = "https://api.example.com";
const USER_ID = "a".repeat(64);
const BOOK_A = "210012345000001";
const BOOK_B = "210067890000002";
const BOOK_C = "210011112222003";

/** Mirrors the literal in `shared/src/api/personalBooksValidation.ts`. */
function coercedWarning(count: number): string {
  return `[personalBooksValidation] coerced ${count} book flag value(s) that were not an exact BoolFlag`;
}

/** A fully VALID book: the text layer is a no-op on it. */
function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: BOOK_A,
    title: "小王子",
    author: "Saint-Exupéry",
    isbn: "9789573317249",
    coverUrl: "https://cdn.readmoo.com/cover/1.jpg",
    readmooUrl: "https://readmoo.com/book/210012345000001",
    category: "文學小說",
    isShared: BoolFlag.TRUE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

/** A valid book with one field replaced by an untrusted value. */
function bookWith(field: string, value: unknown): Record<string, unknown> {
  return { ...makeBook(), [field]: value };
}

/** A valid book with one field absent entirely. */
function bookWithout(field: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(makeBook()).filter(([key]) => key !== field),
  );
}

/** A valid personal-books payload around the given (untyped) list. */
function makePayload(books: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    userId: USER_ID,
    displayName: "小明",
    lastUpdated: "2026-10-01T00:00:00.000Z",
    books,
  };
}

/** Read a value as a bag of unknowns — the tables feed fields the type forbids. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function mockFetchEnvelope(envelope: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(envelope),
  });
}

const NON_TRUE_IS_SHARED: Array<{ name: string; value: unknown }> = [
  { name: "the boolean true", value: true },
  { name: 'the string "1"', value: "1" },
  { name: "the number 2", value: 2 },
  { name: "null", value: null },
  { name: "an object", value: { v: 1 } },
];

const UNUSABLE_IS_ARCHIVED: Array<{ name: string; value: unknown }> = [
  { name: "the boolean true", value: true },
  { name: "null", value: null },
  { name: 'the string "0"', value: "0" },
  { name: "the number 2", value: 2 },
];

// The COMPOSED two-layer contract via the public surface. See the file header.
describe("ApiClient getPersonalBooks (PWA)", () => {
  let client: ApiClient;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ApiClient(MOCK_ENDPOINT);
    client.setAuthToken("test-token");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  async function fetchEnvelope(
    envelope: unknown,
  ): Promise<ApiResponse<PersonalBooks>> {
    globalThis.fetch = mockFetchEnvelope(envelope);
    return client.getPersonalBooks(USER_ID);
  }

  /** The books of a success envelope whose `data` is the given payload. */
  async function fetchBooks(books: unknown[]): Promise<BookEntry[]> {
    const res = await fetchEnvelope({ data: makePayload(books) });
    if (!res.data) throw new Error("expected data in the envelope");
    return res.data.books;
  }

  it("sends GET to /api/user/:id/books and returns a clean payload unchanged", async () => {
    const payload = makePayload([makeBook()]);
    const result = await fetchEnvelope({ data: payload });

    expect(result.data).toEqual(payload);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/user/${USER_ID}/books`);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  describe("isShared", () => {
    it.each([
      { name: "exactly 1", value: 1, expected: BoolFlag.TRUE },
      { name: "exactly 0", value: 0, expected: BoolFlag.FALSE },
    ])(
      "keeps $name as a BoolFlag without warning",
      async ({ value, expected }) => {
        const [book] = await fetchBooks([bookWith("isShared", value)]);

        expect(book.isShared).toBe(expected);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it.each(NON_TRUE_IS_SHARED)(
      "coerces $name to BoolFlag.FALSE and warns once",
      async ({ value }) => {
        const [book] = await fetchBooks([bookWith("isShared", value)]);

        expect(book.isShared).toBe(BoolFlag.FALSE);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(coercedWarning(1));
      },
    );

    it("materializes a missing isShared as BoolFlag.FALSE and counts it", async () => {
      const [book] = await fetchBooks([bookWithout("isShared")]);

      expect(book.isShared).toBe(BoolFlag.FALSE);
      expect(warnSpy).toHaveBeenCalledWith(coercedWarning(1));
    });

    it("reads a saved isShared: true as NOT shared (issue #348)", async () => {
      // Settled design: default closed, same as the Worker's `toBoolFlag` — only an exact 1 shares.
      const [book] = await fetchBooks([bookWith("isShared", true)]);

      expect(book.isShared).toBe(BoolFlag.FALSE);
      expect(book.isShared).not.toBe(true);
    });
  });

  describe("isArchived", () => {
    it.each([
      { name: "exactly 1", value: BoolFlag.TRUE },
      { name: "exactly 0", value: BoolFlag.FALSE },
    ])("keeps $name without warning", async ({ value }) => {
      const [book] = await fetchBooks([bookWith("isArchived", value)]);

      expect(book.isArchived).toBe(value);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(UNUSABLE_IS_ARCHIVED)(
      "omits the key for $name and warns once",
      async ({ value }) => {
        const [book] = await fetchBooks([bookWith("isArchived", value)]);

        expect("isArchived" in book).toBe(false);
        expect(book.bookId).toBe(BOOK_A);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(coercedWarning(1));
      },
    );

    it("leaves a missing isArchived absent and does not warn", async () => {
      const [book] = await fetchBooks([bookWithout("isArchived")]);

      expect("isArchived" in book).toBe(false);
      expect(book.isShared).toBe(BoolFlag.TRUE);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("list shape", () => {
    it("keeps every object book in order; the text layer drops the non-objects", async () => {
      // Layer 1 passes 42 / null / [] through in place; layer 2's `sanitizeList` drops them.
      const books = await fetchBooks([
        bookWith("isShared", true),
        42,
        makeBook({ bookId: BOOK_B }),
        null,
        bookWithout("isShared"),
        ["x"],
      ]);

      expect(books.map((b) => b.bookId)).toEqual([BOOK_A, BOOK_B, BOOK_A]);
      expect(books.map((b) => b.isShared)).toEqual([
        BoolFlag.FALSE,
        BoolFlag.TRUE,
        BoolFlag.FALSE,
      ]);
    });

    it("never drops a book whose only defect is its flags", async () => {
      const books = await fetchBooks([
        bookWith("isShared", "yes"),
        { ...bookWith("isShared", 2), bookId: BOOK_B, isArchived: null },
        { ...bookWithout("isShared"), bookId: BOOK_C },
      ]);

      expect(books.map((b) => b.bookId)).toEqual([BOOK_A, BOOK_B, BOOK_C]);
    });

    it("preserves unknown book fields and every other data field", async () => {
      const book = { ...bookWith("isShared", true), futureField: { a: 1 } };
      const payload = {
        ...makePayload([book]),
        removedUnsharedBookIds: [BOOK_C],
        familyShelfPrefs: { hidden: [BOOK_B], favorites: [BOOK_A] },
        newBookDefaultShared: BoolFlag.TRUE,
        unknownTopLevel: "keep-me",
      };

      const result = await fetchEnvelope({ data: payload });
      const data = asRecord(result.data);

      expect(data.removedUnsharedBookIds).toEqual([BOOK_C]);
      expect(data.familyShelfPrefs).toEqual({
        hidden: [BOOK_B],
        favorites: [BOOK_A],
      });
      expect(data.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(data.unknownTopLevel).toBe("keep-me");
      expect(data.schemaVersion).toBe(1);
      const [validated] = data.books as Record<string, unknown>[];
      expect(validated.futureField).toEqual({ a: 1 });
      expect(validated.coverUrl).toBe(makeBook().coverUrl);
      expect(validated.isShared).toBe(BoolFlag.FALSE);
    });

    it("does not mutate the parsed payload", async () => {
      const book = bookWith("isShared", true);
      await fetchBooks([book]);

      expect(book.isShared).toBe(true);
    });

    it("degrades a non-array books to an empty list without a structural warning", async () => {
      // Layer 1 passes `books: "oops"` through; layer 2's `sanitizeList` turns it into [].
      const result = await fetchEnvelope({
        data: { ...makePayload([]), books: "oops" },
      });

      expect(result.data?.books).toEqual([]);
      expect(result.data?.userId).toBe(USER_ID);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("warnings", () => {
    it("emits exactly one aggregate warning for several coerced flags", async () => {
      await fetchBooks([
        bookWith("isShared", true),
        { ...bookWith("isShared", "1"), bookId: BOOK_B, isArchived: null },
        { ...bookWithout("isShared"), bookId: BOOK_C },
        bookWithout("isArchived"),
      ]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(coercedWarning(4));
    });

    it("never logs the offending values", async () => {
      await fetchBooks([
        bookWith("isShared", "SENTINEL_SHARED"),
        bookWith("isArchived", "SENTINEL_ARCHIVED"),
      ]);

      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logged).toContain("[personalBooksValidation]");
      expect(logged).not.toContain("SENTINEL");
    });

    it("stays silent for a clean list", async () => {
      await fetchBooks([
        makeBook(),
        makeBook({ bookId: BOOK_B, isShared: BoolFlag.FALSE }),
        bookWithout("isArchived"),
      ]);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("envelope passthrough", () => {
    it("leaves an error envelope's flags alone and does not warn", async () => {
      // Callers check `error` first (`loadSavedBooksForSync` throws), so layer 1 stands down.
      const error = { code: "FORBIDDEN", message: "Not allowed" };
      const result = await fetchEnvelope({
        data: makePayload([bookWith("isShared", true)]),
        error,
      });

      expect(result.error).toEqual(error);
      expect(asRecord(result.data?.books[0]).isShared).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("validates data beside error: null and keeps the null", async () => {
      const result = await fetchEnvelope({
        data: makePayload([bookWith("isShared", true)]),
        error: null,
      });

      expect(result.error).toBeNull();
      expect(result.data?.books[0].isShared).toBe(BoolFlag.FALSE);
      expect(warnSpy).toHaveBeenCalledWith(coercedWarning(1));
    });

    it("passes data: null through as null", async () => {
      const result = await fetchEnvelope({ data: null });

      expect(result.data).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("passes a missing data key through as absent", async () => {
      const result = await fetchEnvelope({});

      expect(result.data).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      { name: "a string", value: "oops" },
      { name: "a number", value: 42 },
      { name: "an array of books", value: [bookWith("isShared", true)] },
    ])(
      "degrades $name data to the empty entity without a structural warning",
      async ({ value }) => {
        // Layer 1 passes a non-object `data` through; layer 2 materializes the empty entity.
        const result = await fetchEnvelope({ data: value });

        expect(result.data).toEqual({
          userId: "",
          displayName: "",
          lastUpdated: "",
          books: [],
        });
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("does not let a book's JSON-supplied __proto__ pollute Object.prototype", async () => {
    const hostile: unknown = JSON.parse(
      `{"data":{"userId":"${USER_ID}","displayName":"x","lastUpdated":"t","books":[{"bookId":"${BOOK_A}","title":"t","author":"a","isbn":"","readmooUrl":"","category":"","isShared":true,"__proto__":{"polluted":"yes"}}]}}`,
    );

    const result = await fetchEnvelope(hostile);
    const book = result.data?.books[0];

    expect(asRecord({}).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(book)).toBe(Object.prototype);
    expect(asRecord(book).polluted).toBeUndefined();
    expect(book?.isShared).toBe(BoolFlag.FALSE);
  });
});

// What the composed suite cannot see (identity passthrough, in-place non-objects,
// own prototype handling). See the file header.
describe("sanitizePersonalBooksResponse (direct import)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function validatedBooks(books: unknown): unknown[] {
    const res = sanitizePersonalBooksResponse<Record<string, unknown>>({
      data: { ...makePayload([]), books },
    });
    return asRecord(res.data).books as unknown[];
  }

  it.each<{ name: string; res: ApiResponse<unknown> }>([
    {
      name: "an error envelope",
      res: {
        data: makePayload([bookWith("isShared", true)]),
        error: { code: "FORBIDDEN", message: "x" },
      },
    },
    { name: "data: null", res: { data: null } },
    { name: "missing data", res: {} },
    { name: "a non-object data", res: { data: "oops" } },
    { name: "an array data", res: { data: [bookWith("isShared", true)] } },
    {
      name: "a non-array books",
      res: { data: { ...makePayload([]), books: 42 } },
    },
  ])("returns $name by identity without warning", ({ res }) => {
    expect(sanitizePersonalBooksResponse(res)).toBe(res);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps non-object elements in place and the count unchanged", () => {
    const array = ["x"];
    const books = validatedBooks([42, bookWith("isShared", true), null, array]);

    expect(books).toHaveLength(4);
    expect(books[0]).toBe(42);
    expect(books[2]).toBeNull();
    expect(books[3]).toBe(array);
    expect(asRecord(books[1]).isShared).toBe(BoolFlag.FALSE);
  });

  it("never touches a bookId, even an unusable one", () => {
    const books = validatedBooks([
      bookWith("bookId", 42),
      bookWithout("bookId"),
    ]);

    expect(books).toHaveLength(2);
    expect(asRecord(books[0]).bookId).toBe(42);
    expect("bookId" in asRecord(books[1])).toBe(false);
  });

  it("keeps a JSON-supplied __proto__ as an own key without applying it", () => {
    const books = validatedBooks(
      JSON.parse(
        `[{"bookId":"${BOOK_A}","isShared":1,"__proto__":{"polluted":"yes"}}]`,
      ),
    );
    const book = asRecord(books[0]);

    expect(asRecord({}).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(book)).toBe(Object.prototype);
    expect(book.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(book, "__proto__")).toBe(true);
    expect(book.isShared).toBe(BoolFlag.TRUE);
  });
});
