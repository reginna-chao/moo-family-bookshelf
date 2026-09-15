import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiClient,
  BoolFlag,
  type ApiResponse,
  type BookEntry,
  type FamilyBookshelf,
} from "@/api/client";
import { sanitizeFamilyBookshelfResponse } from "moo-family-bookshelf-shared/api/bookshelfValidation";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT = "https://api.example.com";
const FAMILY_ID = "fam-abc";
const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const BOOK_A = "210012345000";
const BOOK_B = "210067890000";

/** The PWA's own bookshelf member shape — it carries `lastUpdated`. */
type BookshelfMember = FamilyBookshelf["members"][number];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/**
 * A fully VALID book: every declared-string field really is a string, so the
 * text layer that runs second is a no-op on it and anything that changes has to
 * have come from the structural layer.
 */
function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: BOOK_A,
    title: "小王子",
    author: "Saint-Exupéry",
    isbn: "9789573317249",
    coverUrl: "https://cdn.readmoo.com/cover/1.jpg",
    readmooUrl: "https://readmoo.com/book/210012345000",
    category: "文學小說",
    isShared: BoolFlag.TRUE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

function makeMember(overrides: Partial<BookshelfMember> = {}): BookshelfMember {
  return {
    userId: USER_A,
    displayName: "小明",
    books: [makeBook()],
    lastUpdated: "2026-04-26T00:00:00Z",
    ...overrides,
  };
}

/** Read a value as a bag of unknowns — the tables feed fields the type forbids. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** A valid member with one field replaced by an untrusted value. */
function memberWith(field: string, value: unknown): Record<string, unknown> {
  return { ...makeMember(), [field]: value };
}

/** A valid member with one field absent entirely. */
function memberWithout(field: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(makeMember()).filter(([key]) => key !== field),
  );
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

/** Values that can never serve as an identity, whatever the field is called. */
const UNUSABLE_IDS: Array<{ name: string; value: unknown }> = [
  { name: "an empty string", value: "" },
  { name: "a number", value: 42 },
  { name: "null", value: null },
  { name: "a boolean", value: true },
  { name: "an object", value: { id: 1 } },
  { name: "an array", value: ["a", "b"] },
];

/** Containers that are not a list at all — reused by `members` and `books`. */
const NON_ARRAY_CONTAINERS: Array<{ name: string; value: unknown }> = [
  { name: "missing", value: undefined },
  { name: "null", value: null },
  { name: "a string", value: "[]" },
  { name: "a number", value: 42 },
  { name: "a boolean", value: true },
  { name: "a plain object", value: {} },
  { name: "an object wrapping the list", value: { list: [] } },
];

/**
 * Runtime boundary validation of the `GET /api/family/:id/bookshelf` payload.
 *
 * Driven through the public `getFamilyBookshelf` surface instead of importing
 * `sanitizeFamilyBookshelfResponse` directly: the contract is what a caller
 * receives when a self-hosted (BYO) or hostile backend answers, not the shape of
 * the helper. This method hands back the whole `{ data, error }` envelope —
 * callers unwrap it themselves — so the passthrough cases below are about the
 * envelope, not about a thrown error.
 *
 * Driving the public surface means what these cases pin is the COMPOSED
 * contract of the TWO layers `getFamilyBookshelf` wires, in this order:
 *  1. `shared/src/api/bookshelfValidation.ts` — the STRUCTURAL layer. It DROPS
 *     a member with no usable `userId` and a book with no usable `bookId`,
 *     because normalizing an IDENTITY to `""` keeps the element and two such
 *     elements then collide (duplicate React keys, an empty member label,
 *     collapsed family-shelf preference refs, a collapsed update-tracking
 *     baseline). Survivors are kept by SPREAD, never rebuilt — which is what
 *     leaves the tri-state `lastUpdated` in place for layer 2.
 *  2. `shared/src/api/entityText.ts` — the declared-STRING coercion, which then
 *     blanks a survivor's `displayName` / `title` / `author` / … in place.
 * Where a case can tell the two apart it says so, because a regression in
 * either layer must fail here instead of being absorbed by the other. Fixtures
 * are deliberately VALID except for the one field under test, so a field that
 * changes without being asked to is the structural layer overreaching.
 *
 * The same case tables live in
 * `extension/tests/unit/api/bookshelf-client.test.ts`. Layer 1 is the SHARED
 * implementation both apps import, so the mirrored tables prove each app's own
 * COMPOSITION of the two layers still holds — that part stays per-app.
 */
describe("ApiClient getFamilyBookshelf (PWA)", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient(ENDPOINT);
    client.setAuthToken("test-token");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request wiring", () => {
    it("sends GET to /api/family/:id/bookshelf and returns the bookshelf envelope", async () => {
      const bookshelf = { familyId: FAMILY_ID, members: [makeMember()] };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: bookshelf }));

      const result = await client.getFamilyBookshelf(FAMILY_ID);

      expect(result.data).toEqual(bookshelf);
      expect(result.error).toBeUndefined();
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/bookshelf`);
      // Default fetch init has no method (GET)
      expect(call[1]?.method ?? "GET").toBe("GET");
      expect(call[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      );
    });
  });

  describe("payload validation", () => {
    /** Mirrors the literal in `shared/src/api/bookshelfValidation.ts`. */
    const MALFORMED_CONTAINER_WARNING =
      "[bookshelfValidation] malformed members payload: expected an array, treating as empty";

    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** Serve an arbitrary (untyped) payload as the `data` of a 200 envelope. */
    async function fetchBookshelf(
      data: unknown,
    ): Promise<ApiResponse<FamilyBookshelf>> {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data }));
      return client.getFamilyBookshelf(FAMILY_ID);
    }

    /** The sanitized `data` of a 200 envelope — fails loudly if it went missing. */
    async function sanitizedBookshelf(data: unknown): Promise<FamilyBookshelf> {
      const res = await fetchBookshelf(data);
      if (res.data === undefined || res.data === null) {
        throw new Error("expected a sanitized bookshelf in the envelope");
      }
      return res.data;
    }

    /** The sanitized member list for a bookshelf whose `members` is `members`. */
    async function sanitizedMembers(
      members: unknown,
    ): Promise<BookshelfMember[]> {
      const bookshelf = await sanitizedBookshelf({
        familyId: FAMILY_ID,
        members,
      });
      return bookshelf.members;
    }

    /** The single surviving member of a one-element list. */
    async function sanitizedMember(element: unknown): Promise<BookshelfMember> {
      const members = await sanitizedMembers([element]);
      expect(members).toHaveLength(1);
      return members[0];
    }

    /** The surviving books of a single member whose `books` field is `books`. */
    async function sanitizedBooks(books: unknown): Promise<BookEntry[]> {
      const member = await sanitizedMember(memberWith("books", books));
      return member.books;
    }

    describe("envelope passthrough", () => {
      it("passes an error envelope through without validating or warning", async () => {
        // An auth failure must never be laundered into an empty bookshelf
        // (Invariant 2) — the caller's own `if (response.error)` has to still
        // see the error it would have seen.
        mockFetch.mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: "FORBIDDEN",
                message: "Not a member of this family",
              },
            },
            403,
          ),
        );

        const result = await client.getFamilyBookshelf(FAMILY_ID);

        expect(result.error).toEqual({
          code: "FORBIDDEN",
          message: "Not a member of this family",
        });
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps the error verbatim and stands the structural layer down when a 200 envelope carries both", async () => {
        // The two layers answer this envelope differently, and both answers
        // matter. Layer 1 stands down entirely, because an auth failure must
        // never be laundered into a bookshelf (Invariant 2). Layer 2 has no
        // such rule — it short-circuits on ABSENT data only — so the claimed
        // list still degrades. Neither can turn the failure into a success:
        // `error` reaches the caller's own `if (response.error)` byte-identical.
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: { members: 42 },
            error: { code: "STALE_DATA", message: "Rebuild in progress" },
          }),
        );

        const result = await client.getFamilyBookshelf(FAMILY_ID);

        expect(result.error).toEqual({
          code: "STALE_DATA",
          message: "Rebuild in progress",
        });
        // Silence is the proof layer 1 did not run: `members: 42` is exactly
        // what its malformed-container branch warns about, and the text layer's
        // own degradation of that field is deliberately quiet.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(result.data).toStrictEqual({ members: [] });
      });

      it("passes a data-less success envelope through as-is", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({}));

        const result = await client.getFamilyBookshelf(FAMILY_ID);

        expect(result).toEqual({});
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("passes a null-data envelope through as-is", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));

        const result = await client.getFamilyBookshelf(FAMILY_ID);

        expect(result.data).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("still validates when error is null, because callers read error as truthy", async () => {
        // `if (response.error)` reads `error: null` as success and consumes
        // `data`, so this envelope is exactly the one that must NOT be waved
        // through — while the null itself is preserved for the caller. This is
        // the BYO-backend case the module calls out by name.
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: {
              familyId: FAMILY_ID,
              members: [memberWith("userId", 42), makeMember()],
            },
            error: null,
          }),
        );

        const result = await client.getFamilyBookshelf(FAMILY_ID);

        expect(result.error).toBeNull();
        expect(result.data?.members).toHaveLength(1);
        expect(result.data?.members[0].userId).toBe(USER_A);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("malformed container", () => {
      it.each(NON_ARRAY_CONTAINERS)(
        "returns an empty member list and warns once when members is $name",
        async ({ value }) => {
          const members = await sanitizedMembers(value);

          expect(members).toEqual([]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(MALFORMED_CONTAINER_WARNING);
        },
      );

      const NON_RECORD_DATA: Array<{ name: string; data: unknown }> = [
        { name: "a string", data: "members" },
        { name: "a number", data: 42 },
        { name: "a boolean", data: true },
        { name: "an empty array", data: [] },
        { name: "an array of members", data: [makeMember()] },
      ];

      it.each(NON_RECORD_DATA)(
        "materializes an empty bookshelf and warns once when data is $name",
        async ({ data }) => {
          const bookshelf = await sanitizedBookshelf(data);

          // A non-record `data` carries no bookshelf field at all — not even
          // `familyId` — so it degrades to the renderable EMPTY state rather
          // than throwing one render later.
          expect(bookshelf).toStrictEqual({ members: [] });
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(MALFORMED_CONTAINER_WARNING);
        },
      );
    });

    describe("member dropping", () => {
      const DROPPED_MEMBERS: Array<{ name: string; element: unknown }> = [
        { name: "null", element: null },
        { name: "undefined", element: undefined },
        { name: "a string primitive", element: USER_A },
        { name: "a number primitive", element: 42 },
        { name: "a boolean primitive", element: true },
        { name: "an array", element: [USER_A] },
        { name: "an array wrapping a member", element: [makeMember()] },
        { name: "an object with no userId", element: memberWithout("userId") },
        ...UNUSABLE_IDS.map(({ name, value }) => ({
          name: `a member whose userId is ${name}`,
          element: memberWith("userId", value),
        })),
      ];

      it.each(DROPPED_MEMBERS)(
        "drops $name while keeping a valid sibling",
        async ({ element }) => {
          const survivor = makeMember({ userId: USER_B });

          const members = await sanitizedMembers([element, survivor]);

          expect(members).toEqual([survivor]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            "[bookshelfValidation] dropped 1 malformed family member(s)",
          );
        },
      );

      // The positive companion to the table above: the criterion really is "a
      // non-empty string", not "anything that happens to be there", so a real
      // userId must survive untouched. Without this, a layer that dropped
      // EVERY member would keep the drop table green.
      const KEPT_IDS: Array<{ name: string; value: string }> = [
        { name: "a 64-hex userId", value: USER_A },
        { name: "a one-character userId", value: "x" },
        { name: "a userId with a leading space", value: " padded" },
      ];

      it.each(KEPT_IDS)(
        "keeps a member whose userId is $name",
        async ({ value }) => {
          const member = await sanitizedMember(memberWith("userId", value));

          expect(member.userId).toBe(value);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("preserves the order of the surviving members around a dropped one", async () => {
        const first = makeMember({ userId: USER_A });
        const last = makeMember({ userId: USER_B });

        const members = await sanitizedMembers([first, null, last]);

        expect(members.map((member) => member.userId)).toEqual([
          USER_A,
          USER_B,
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("member preservation", () => {
      it("keeps a surviving member by spread rather than rebuilding it from a fixed field list", async () => {
        // The structural layer deliberately does NOT enumerate the member's
        // fields: the wire shape can gain a field (`lastUpdated` is a
        // meaningful tri-state), and a fixed list would silently drop it.
        const member = await sanitizedMember({
          ...makeMember(),
          futureField: "kept",
        });

        expect(asRecord(member).futureField).toBe("kept");
        expect(member.userId).toBe(USER_A);
        expect(member.displayName).toBe("小明");
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it.each([
        { name: "a timestamp string", value: "2026-04-26T00:00:00Z" },
        // `null` is a MEANINGFUL tri-state here ("never synced"), so it must
        // survive as `null` rather than being dropped or blanked.
        { name: "null", value: null },
      ])("keeps a member's lastUpdated when it is $name", async ({ value }) => {
        const member = await sanitizedMember(memberWith("lastUpdated", value));

        expect(member.lastUpdated).toBe(value);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("passes every other top-level field through by spread while rebuilding members", async () => {
        // `familyId` is the PWA's own top-level field and the structural layer
        // does not own it; an unknown future one has to survive the same way.
        const bookshelf = await sanitizedBookshelf({
          familyId: FAMILY_ID,
          members: [makeMember()],
          futureField: "kept",
        });

        expect(bookshelf.familyId).toBe(FAMILY_ID);
        expect(asRecord(bookshelf).futureField).toBe("kept");
        expect(bookshelf.members).toHaveLength(1);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("returns a new bookshelf object and leaves the parsed payload unmutated", async () => {
        const payload = {
          familyId: FAMILY_ID,
          members: [memberWith("books", [makeBook()])],
        };

        const res = await fetchBookshelf(payload);

        expect(res.data).not.toBe(payload);
        expect(res.data?.members).not.toBe(payload.members);
        expect(asRecord(payload.members[0]).books).toHaveLength(1);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("book list handling", () => {
      it.each(NON_ARRAY_CONTAINERS)(
        "degrades a books list that is $name to an empty list",
        async ({ value }) => {
          const books = await sanitizedBooks(value);

          expect(books).toEqual([]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            "[bookshelfValidation] dropped 0 malformed book(s); " +
              "1 member(s) had an unusable books list",
          );
        },
      );

      const DROPPED_BOOKS: Array<{ name: string; element: unknown }> = [
        { name: "null", element: null },
        { name: "undefined", element: undefined },
        { name: "a string primitive", element: BOOK_A },
        { name: "a number primitive", element: 42 },
        { name: "a boolean primitive", element: false },
        { name: "an array", element: [BOOK_A] },
        { name: "an array wrapping a book", element: [makeBook()] },
        { name: "an object with no bookId", element: bookWithout("bookId") },
        ...UNUSABLE_IDS.map(({ name, value }) => ({
          name: `a book whose bookId is ${name}`,
          element: bookWith("bookId", value),
        })),
      ];

      it.each(DROPPED_BOOKS)(
        "drops $name while keeping a valid sibling",
        async ({ element }) => {
          const survivor = makeBook({ bookId: BOOK_B });

          const books = await sanitizedBooks([element, survivor]);

          expect(books).toEqual([survivor]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            "[bookshelfValidation] dropped 1 malformed book(s); " +
              "0 member(s) had an unusable books list",
          );
        },
      );

      it("preserves the order of the surviving books around dropped ones", async () => {
        const first = makeBook({ bookId: BOOK_A });
        const last = makeBook({ bookId: BOOK_B });

        const books = await sanitizedBooks([null, first, { bookId: "" }, last]);

        expect(books.map((book) => book.bookId)).toEqual([BOOK_A, BOOK_B]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it("keeps an empty books list as an empty list without warning", async () => {
        const books = await sanitizedBooks([]);

        expect(books).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("book preservation", () => {
      it("passes a surviving book through byte-identically, flags and cover URL included", async () => {
        // The load-bearing case for the "never rebuild a book" rule.
        // `isShared`, `isArchived` and `coverUrl` all sit OUTSIDE the text
        // layer's field list, so a structural layer that rebuilt the book from
        // a fixed list would silently delete them — and `isShared` is the
        // family-shelf filter itself, so losing it empties the shelf.
        const book = makeBook({
          isShared: BoolFlag.TRUE,
          isArchived: BoolFlag.TRUE,
        });

        const books = await sanitizedBooks([book]);

        expect(books).toHaveLength(1);
        expect(books[0]).toStrictEqual(book);
        expect(books[0].isShared).toBe(BoolFlag.TRUE);
        expect(books[0].isArchived).toBe(BoolFlag.TRUE);
        expect(books[0].coverUrl).toBe("https://cdn.readmoo.com/cover/1.jpg");
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps an unknown extra book field instead of stripping it", async () => {
        const books = await sanitizedBooks([
          { ...makeBook(), futureField: "kept" },
        ]);

        expect(asRecord(books[0]).futureField).toBe("kept");
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("returns a whole valid payload JSON.stringify-identical", async () => {
        const payload = {
          familyId: FAMILY_ID,
          members: [
            makeMember({ userId: USER_A, books: [makeBook()] }),
            makeMember({
              userId: USER_B,
              displayName: "小華",
              lastUpdated: null,
              books: [makeBook({ bookId: BOOK_B, isShared: BoolFlag.FALSE })],
            }),
          ],
        };

        const bookshelf = await sanitizedBookshelf(payload);

        expect(JSON.stringify(bookshelf)).toBe(JSON.stringify(payload));
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("aggregate warnings", () => {
      it("emits exactly one member-side line for ten malformed members, not one per element", async () => {
        const malformed = Array.from({ length: 10 }, () => null);

        const members = await sanitizedMembers([
          ...malformed,
          makeMember({ userId: USER_B }),
        ]);

        expect(members).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "[bookshelfValidation] dropped 10 malformed family member(s)",
        );
      });

      it("combines every member's book losses into ONE line", async () => {
        // Three members each lose a book and a fourth has no usable list at
        // all — still a single line, because a hostile payload must not become
        // log spam.
        const members = await sanitizedMembers([
          memberWith("books", [null, makeBook()]),
          { ...makeMember({ userId: USER_B }), books: [42] },
          { ...makeMember({ userId: "c" }), books: [{ bookId: "" }] },
          { ...makeMember({ userId: "d" }), books: "not-an-array" },
        ]);

        expect(members).toHaveLength(4);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "[bookshelfValidation] dropped 3 malformed book(s); " +
            "1 member(s) had an unusable books list",
        );
      });

      it("emits at most two lines for a maximally hostile response", async () => {
        // The ceiling the module documents: one line for the member half, one
        // for the book half, however much is wrong.
        const members = await sanitizedMembers([
          null,
          42,
          { userId: "" },
          memberWith("books", [null, null, makeBook()]),
          { ...makeMember({ userId: USER_B }), books: "not-an-array" },
          { ...makeMember({ userId: "c" }), books: [{ bookId: {} }] },
        ]);

        expect(members).toHaveLength(3);
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenNthCalledWith(
          1,
          "[bookshelfValidation] dropped 3 malformed family member(s)",
        );
        expect(warnSpy).toHaveBeenNthCalledWith(
          2,
          "[bookshelfValidation] dropped 3 malformed book(s); " +
            "1 member(s) had an unusable books list",
        );
      });

      it("keeps the container warning and the dropped-count warning mutually exclusive", async () => {
        await sanitizedMembers("nope");

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(MALFORMED_CONTAINER_WARNING);
      });

      it("does not count a dropped member's books against the book tally", async () => {
        // A dropped member never reaches `sanitizeBooks`, so its malformed
        // books are not knowable and must not inflate the second line.
        await sanitizedMembers([
          { userId: 42, books: [null, null] },
          makeMember({ userId: USER_B }),
        ]);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "[bookshelfValidation] dropped 1 malformed family member(s)",
        );
      });

      it("emits no warning for a fully valid payload", async () => {
        const list = [
          makeMember({ userId: USER_A }),
          makeMember({ userId: USER_B, books: [] }),
        ];

        const members = await sanitizedMembers(list);

        expect(members).toEqual(list);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("emits no warning for an empty member list", async () => {
        const members = await sanitizedMembers([]);

        expect(members).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * The validator's own boundary, called directly.
 *
 * Everything above drives `sanitizeFamilyBookshelfResponse` through
 * `getFamilyBookshelf`, where the shared TEXT layer runs after it and rebuilds
 * every object it touches. Two contracts are invisible from there, and both are
 * pinned on the export itself instead:
 *
 *  - the errored envelope is handed BACK unmodified and by IDENTITY
 *    (`sanitizeEnvelope` would rebuild it), which is Invariant 2 at its source;
 *  - the structural layer's own prototype handling. The text layer's spread
 *    re-flattens each object into a fresh one with `Object.prototype`, so a
 *    regression HERE — say a merge that assigns rather than spreads, letting an
 *    own `"__proto__"` key reach the setter — is laundered before a composed
 *    test can see it. Verified: that exact mutation leaves the composed suite
 *    fully green and turns these cases red.
 */
describe("sanitizeFamilyBookshelfResponse (direct import)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** The validated `data` of a success envelope, as a bag of unknowns. */
  function validate(data: unknown): Record<string, unknown> {
    const res = sanitizeFamilyBookshelfResponse<Record<string, unknown>>({
      data,
    });
    if (res.data === undefined || res.data === null) {
      throw new Error("expected validated data in the envelope");
    }
    return res.data;
  }

  /** The validated members of a success envelope. */
  function validatedMembers(data: unknown): Record<string, unknown>[] {
    return validate(data).members as Record<string, unknown>[];
  }

  it("passes an error envelope through untouched", () => {
    const res: ApiResponse<unknown> = {
      data: { members: 42 },
      error: { code: "FORBIDDEN", message: "Not a member of this family" },
    };

    const result = sanitizeFamilyBookshelfResponse(res);

    expect(result).toBe(res);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  describe("prototype safety", () => {
    // Only `JSON.parse` can produce an OWN "__proto__" key (an object literal
    // would set the prototype instead) — which is exactly what a real
    // `response.json()` does with a hostile body. Each case asserts BOTH the
    // security claim (`Object.prototype` is untouched) and the detectable
    // proxy for it (the returned object still has `Object.prototype`), because
    // the first alone stays green for a merge that only re-points the ELEMENT's
    // prototype.
    it("does not apply a member's JSON-supplied __proto__", () => {
      const hostile: unknown = JSON.parse(
        `{"familyId":"${FAMILY_ID}","members":[{"userId":"${USER_B}","displayName":"Hostile","books":[],"__proto__":{"polluted":"yes"}}]}`,
      );

      const member = validatedMembers(hostile)[0];

      expect(asRecord({}).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(member)).toBe(Object.prototype);
      expect(member.polluted).toBeUndefined();
      expect(member.userId).toBe(USER_B);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not apply a book's JSON-supplied __proto__", () => {
      const hostile: unknown = JSON.parse(
        `{"familyId":"${FAMILY_ID}","members":[{"userId":"${USER_B}","displayName":"Hostile","books":[{"bookId":"${BOOK_A}","__proto__":{"polluted":"yes"}}]}]}`,
      );

      const books = validatedMembers(hostile)[0].books as Record<
        string,
        unknown
      >[];

      expect(asRecord({}).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(books[0])).toBe(Object.prototype);
      expect(books[0].polluted).toBeUndefined();
      expect(books[0].bookId).toBe(BOOK_A);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not apply a top-level JSON-supplied __proto__", () => {
      const hostile: unknown = JSON.parse(
        '{"members":[],"__proto__":{"polluted":"yes"}}',
      );

      const bookshelf = validate(hostile);

      expect(asRecord({}).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(bookshelf)).toBe(Object.prototype);
      expect(bookshelf.polluted).toBeUndefined();
      expect(bookshelf.members).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
