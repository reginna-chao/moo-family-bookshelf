import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { USER1 } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type UserBooksRecord,
} from "../../src/kv/schema";
import {
  BOOK_TITLE_MAX_LENGTH,
  BOOK_AUTHOR_MAX_LENGTH,
  BOOK_ISBN_MAX_LENGTH,
  BOOK_CATEGORY_MAX_LENGTH,
  BOOK_URL_MAX_LENGTH,
} from "../../src/utils/validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * PUT /api/user/:id/books — per-book free-text length ceilings (#321).
 *
 * A STRING `title` / `author` / `isbn` / `category` longer than its
 * `BOOK_*_MAX_LENGTH` (measured with JS `.length`, UTF-16 code units) rejects
 * the WHOLE request with `400 INVALID_PAYLOAD` and writes nothing — the stored
 * `user:{id}` record stays byte-identical. Rejected, never truncated: a cut
 * title would break the Extension's same-title rename matching that guards
 * 新書預設開放. The message names the first failing field, entries checked in
 * order and fields in the order title, author, isbn, category.
 *
 * Unchanged behaviour pinned alongside: a value exactly at the ceiling is
 * stored verbatim, and a NON-string value (array, number, object) is still
 * coerced to `""` and accepted, whatever its serialized size.
 *
 * Field order: the order cases write their payload keys in REVERSE of the
 * checked order (category, isbn, author, title) and build the entry without
 * `book()`, so an implementation that walks the payload's own keys would name
 * `category` every time and fail; only the fixed order passes.
 *
 * URL ceilings: a `coverUrl` / `readmooUrl` longer than `BOOK_URL_MAX_LENGTH`
 * is SANITIZED, not rejected — stored as `""` while the request succeeds and
 * the rest of the entry is kept. The values are a whitelisted Readmoo prefix
 * padded to length, and the at-ceiling twin is asserted stored non-empty, so
 * the blank can only come from the length check, never from the whitelist.
 * PATCH rebuilds every stored book through the same sanitizers, so a stored
 * over-long URL leaves KV on the next PATCH that applies a change.
 *
 * Requests run with `DEV_MODE`, so the per-user rate-limit counter is skipped
 * and a rejected request performs no KV `put` at all (see `watchKvOps`).
 */

const BOOK_A = "210439468000101";
const BOOK_B = "210439468000102";
const BOOK_C = "210439468000103";
const PREVIOUS_LAST_UPDATED = "2020-01-01T00:00:00.000Z";

type TextField = "title" | "author" | "isbn" | "category";

/** Field, ceiling, and the character used to build values of a given length. */
const FIELD_LIMITS: [TextField, number, string][] = [
  ["title", BOOK_TITLE_MAX_LENGTH, "書"],
  ["author", BOOK_AUTHOR_MAX_LENGTH, "a"],
  ["isbn", BOOK_ISBN_MAX_LENGTH, "9"],
  ["category", BOOK_CATEGORY_MAX_LENGTH, "c"],
];

const MAX_OF: Record<TextField, number> = {
  title: BOOK_TITLE_MAX_LENGTH,
  author: BOOK_AUTHOR_MAX_LENGTH,
  isbn: BOOK_ISBN_MAX_LENGTH,
  category: BOOK_CATEGORY_MAX_LENGTH,
};

/** The checked order, reversed: payload key order for the field-order cases. */
const REVERSED_FIELD_ORDER: TextField[] = [
  "category",
  "isbn",
  "author",
  "title",
];

const COVER_PREFIX = "https://cdn.readmoo.com/cover/";
const BOOK_URL_PREFIX = "https://readmoo.com/book/";

type UrlField = "coverUrl" | "readmooUrl";

const URL_FIELDS: [UrlField, string][] = [
  ["coverUrl", COVER_PREFIX],
  ["readmooUrl", BOOK_URL_PREFIX],
];

/** A whitelisted Readmoo URL padded to exactly `length` characters. */
function urlOfLength(prefix: string, length: number): string {
  return prefix + "a".repeat(length - prefix.length);
}

let kv: KVNamespace;
let token: string;

function book(bookId: string, overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

function putBooks(books: unknown[]): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/user/${USER1}/books`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ books }),
      },
      { KV: kv, DEV_MODE: "1" },
    ),
  );
}

function patchBooks(changes: unknown[]): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/user/${USER1}/books`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ changes }),
      },
      { KV: kv, DEV_MODE: "1" },
    ),
  );
}

/** Seed a previous `user:{id}` record; returns its raw stored string. */
async function seedPreviousRecord(books: BookEntry[]): Promise<string> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Test User",
    books,
    lastUpdated: PREVIOUS_LAST_UPDATED,
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(record));
  return (await kv.get(kvKeys.user(USER1))) as string;
}

function storedRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
}

async function expectInvalidPayload(res: Response, message: string) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as Json;
  expect(json.error).toEqual({ code: "INVALID_PAYLOAD", message });
}

function limitMessage(field: TextField, max: number): string {
  return `Each book's ${field} must be at most ${max} characters`;
}

beforeEach(async () => {
  kv = createMockKV();
  token = await seedAuthToken(kv, USER1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/books — free-text length ceilings", () => {
  it("rejects a 10,000-character title with 400 and writes nothing to a fresh account", async () => {
    const ops = watchKvOps(kv);

    const res = await putBooks([book(BOOK_A, { title: "x".repeat(10_000) })]);

    await expectInvalidPayload(
      res,
      limitMessage("title", BOOK_TITLE_MAX_LENGTH),
    );
    expect(await storedRecord()).toBeNull();
    expect(ops.putKeys()).toEqual([]);
  });

  it("rejects a 10,000-character title with 400 and leaves the previous record byte-identical", async () => {
    const previousRaw = await seedPreviousRecord([book(BOOK_A)]);
    const ops = watchKvOps(kv);

    const res = await putBooks([book(BOOK_A, { title: "x".repeat(10_000) })]);

    await expectInvalidPayload(
      res,
      limitMessage("title", BOOK_TITLE_MAX_LENGTH),
    );
    expect(await kv.get(kvKeys.user(USER1))).toBe(previousRaw);
    expect(ops.putKeys()).toEqual([]);
  });

  describe.each(FIELD_LIMITS)("%s (max %i)", (field, max, char) => {
    it("stores a value exactly at the ceiling verbatim", async () => {
      const atLimit = char.repeat(max);
      expect(atLimit.length).toBe(max);

      const res = await putBooks([book(BOOK_A, { [field]: atLimit })]);

      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.data.books[0][field]).toBe(atLimit);
      const record = await storedRecord();
      expect(record?.books[0]?.[field]).toBe(atLimit);
    });

    it("rejects a value one over the ceiling with a message naming the field", async () => {
      const previousRaw = await seedPreviousRecord([book(BOOK_A)]);

      const res = await putBooks([
        book(BOOK_A, { [field]: char.repeat(max + 1) }),
      ]);

      await expectInvalidPayload(res, limitMessage(field, max));
      expect(await kv.get(kvKeys.user(USER1))).toBe(previousRaw);
    });
  });

  it("counts UTF-16 code units, so a title of 200 code units in surrogate pairs fits and 202 does not", async () => {
    const emojiAtLimit = "📚".repeat(BOOK_TITLE_MAX_LENGTH / 2);
    expect(emojiAtLimit.length).toBe(BOOK_TITLE_MAX_LENGTH);

    const ok = await putBooks([book(BOOK_A, { title: emojiAtLimit })]);
    expect(ok.status).toBe(200);
    expect((await storedRecord())?.books[0]?.title).toBe(emojiAtLimit);

    const over = await putBooks([book(BOOK_A, { title: `${emojiAtLimit}📚` })]);
    await expectInvalidPayload(
      over,
      limitMessage("title", BOOK_TITLE_MAX_LENGTH),
    );
    expect((await storedRecord())?.books[0]?.title).toBe(emojiAtLimit);
  });

  it("rejects the whole payload when one entry among valid books is over-long", async () => {
    const previousRaw = await seedPreviousRecord([book(BOOK_A)]);
    const ops = watchKvOps(kv);

    const res = await putBooks([
      book(BOOK_A, { isShared: BoolFlag.TRUE }),
      book(BOOK_B, { author: "a".repeat(BOOK_AUTHOR_MAX_LENGTH + 1) }),
      book(BOOK_C),
    ]);

    await expectInvalidPayload(
      res,
      limitMessage("author", BOOK_AUTHOR_MAX_LENGTH),
    );
    // No partial save: the valid neighbours (and BOOK_A's share flip) are not stored either.
    expect(await kv.get(kvKeys.user(USER1))).toBe(previousRaw);
    expect(ops.putKeys()).toEqual([]);
  });

  it.each<[TextField[], TextField]>([
    [["category", "isbn", "author", "title"], "title"],
    [["category", "isbn", "author"], "author"],
    [["category", "isbn"], "isbn"],
  ])(
    "with %j over-long and keys written in reverse order, names %s (order title, author, isbn, category)",
    async (overLongFields, expected) => {
      // Raw entry, keys inserted in reverse checked order. See the header → "Field order".
      const entry: Record<string, unknown> = { bookId: BOOK_A };
      for (const field of REVERSED_FIELD_ORDER) {
        entry[field] = overLongFields.includes(field)
          ? "x".repeat(MAX_OF[field] + 1)
          : "ok";
      }
      expect(Object.keys(entry)).toEqual(["bookId", ...REVERSED_FIELD_ORDER]);

      const res = await putBooks([entry]);

      await expectInvalidPayload(res, limitMessage(expected, MAX_OF[expected]));
    },
  );

  it("names the failing field of the first over-long entry, not a later one", async () => {
    const res = await putBooks([
      book(BOOK_A),
      book(BOOK_B, { category: "c".repeat(BOOK_CATEGORY_MAX_LENGTH + 1) }),
      book(BOOK_C, { title: "x".repeat(BOOK_TITLE_MAX_LENGTH + 1) }),
    ]);

    await expectInvalidPayload(
      res,
      limitMessage("category", BOOK_CATEGORY_MAX_LENGTH),
    );
  });

  it("still coerces non-string text fields to empty strings and accepts them, whatever their size", async () => {
    const huge = "x".repeat(10_000);

    const res = await putBooks([
      {
        bookId: BOOK_A,
        title: [huge, huge],
        author: 1e300,
        isbn: { value: huge },
        category: [huge],
        isShared: BoolFlag.FALSE,
      },
    ]);

    expect(res.status).toBe(200);
    const stored = (await storedRecord())?.books[0];
    expect(stored?.bookId).toBe(BOOK_A);
    expect(stored).toMatchObject({
      title: "",
      author: "",
      isbn: "",
      category: "",
    });
    expect(await kv.get(kvKeys.user(USER1))).not.toContain(huge);
  });
});

// See the header → "URL ceilings".
describe.each(URL_FIELDS)(
  "PUT /api/user/:id/books — %s length ceiling",
  (field, prefix) => {
    it("stores a whitelisted URL exactly at the ceiling verbatim", async () => {
      const atLimit = urlOfLength(prefix, BOOK_URL_MAX_LENGTH);
      expect(atLimit).toHaveLength(BOOK_URL_MAX_LENGTH);

      const res = await putBooks([book(BOOK_A, { [field]: atLimit })]);

      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.data.books[0][field]).toBe(atLimit);
      expect((await storedRecord())?.books[0]?.[field]).toBe(atLimit);
    });

    it("blanks a whitelisted URL one over the ceiling and still saves the rest of the entry", async () => {
      const entry = book(BOOK_A, {
        title: "Kept title",
        author: "Kept author",
        isShared: BoolFlag.TRUE,
        [field]: urlOfLength(prefix, BOOK_URL_MAX_LENGTH + 1),
      });

      const res = await putBooks([entry]);

      expect(res.status).toBe(200);
      expect((await storedRecord())?.books).toEqual([
        { ...entry, [field]: "" },
      ]);
    });
  },
);

describe("PATCH /api/user/:id/books — over-long stored URLs", () => {
  it("blanks a stored over-long whitelisted coverUrl when a PATCH flips isShared", async () => {
    const atLimit = urlOfLength(COVER_PREFIX, BOOK_URL_MAX_LENGTH);
    await seedPreviousRecord([
      book(BOOK_A, {
        coverUrl: urlOfLength(COVER_PREFIX, BOOK_URL_MAX_LENGTH + 1),
      }),
      book(BOOK_B, { coverUrl: atLimit }),
    ]);

    const res = await patchBooks([{ bookId: BOOK_A, isShared: BoolFlag.TRUE }]);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.applied).toBe(1);
    expect((await storedRecord())?.books).toEqual([
      book(BOOK_A, { coverUrl: "", isShared: BoolFlag.TRUE }),
      book(BOOK_B, { coverUrl: atLimit }),
    ]);
  });
});
