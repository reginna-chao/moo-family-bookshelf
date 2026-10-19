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
import { overLongBookFieldMessage } from "../../src/routes/user";
import {
  BOOK_TITLE_MAX_LENGTH,
  BOOK_AUTHOR_MAX_LENGTH,
  BOOK_ISBN_MAX_LENGTH,
  BOOK_CATEGORY_MAX_LENGTH,
} from "../../src/utils/validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * PUT /api/user/:id/books — grandfathered over-cap text values (#326).
 *
 * The per-field caps of #321 (`putBooksFieldLength.test.ts`) would lock out of
 * sync every user whose record was saved before the caps existed: the
 * Extension echoes the stored title / author / isbn / category on every full
 * PUT. So an over-cap value is ACCEPTED when, and only when, the stored
 * `user:{id}` record holds the byte-identical string in the SAME field of the
 * entry with the SAME bookId. Everything else over the cap is still
 * `400 INVALID_PAYLOAD` naming the field, with no `user:{id}` write:
 *  - a different over-cap value for that bookId (the user cannot grow it);
 *  - the identical value under another bookId (grandfathering is per bookId);
 *  - the identical value in another field (per field: a grandfathered title
 *    exempts neither a new over-cap author nor its own string as an author);
 *  - a value stored exactly AT the cap (it was never over, so nothing is
 *    grandfathered and one char more is new);
 *  - a value no longer stored (once a shorter value replaced it, the old
 *    over-cap one is new again).
 *
 * Grandfathered values are stored verbatim — never truncated or blanked: a cut
 * title would break the Extension's same-title rename matching that guards
 * 新書預設開放.
 *
 * Precedence: the cap check now needs the stored record, so it runs after the
 * handler's KV reads, but still BEFORE the `expectedLastUpdated` 409 — a bad
 * body answers 400 even when its precondition is stale too. The positive
 * companion (grandfathered body + stale precondition ⇒ 409) proves the
 * precondition was live in that request.
 *
 * Requests run with `DEV_MODE`, so the per-user rate-limit counter is skipped
 * and a rejected request performs no KV `put` at all (see `watchKvOps`). Reads
 * are not asserted: a rejected request does read the record first.
 */

const BOOK_A = "210439468000101";
const BOOK_B = "210439468000102";
const STORED_LAST_UPDATED = "2020-01-01T00:00:00.000Z";

type TextField = "title" | "author" | "isbn" | "category";

/** Field, cap, and the character used to build values of a given length. */
const FIELD_LIMITS: [TextField, number, string][] = [
  ["title", BOOK_TITLE_MAX_LENGTH, "書"],
  ["author", BOOK_AUTHOR_MAX_LENGTH, "a"],
  ["isbn", BOOK_ISBN_MAX_LENGTH, "9"],
  ["category", BOOK_CATEGORY_MAX_LENGTH, "c"],
];

/** A 250-char title saved before the 200-char cap existed. */
const LEGACY_TITLE = "舊".repeat(250);
const OTHER_LONG_TITLE = "新".repeat(250);
const LEGACY_AUTHOR = "a".repeat(BOOK_AUTHOR_MAX_LENGTH + 50);

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

function putBooks(
  books: unknown[],
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/user/${USER1}/books`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ books, ...extra }),
      },
      { KV: kv, DEV_MODE: "1" },
    ),
  );
}

/** Seed the stored `user:{id}` record; returns its raw stored string. */
async function seedStoredRecord(books: BookEntry[]): Promise<string> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Test User",
    books,
    lastUpdated: STORED_LAST_UPDATED,
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(record));
  return (await kv.get(kvKeys.user(USER1))) as string;
}

function storedRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
}

function limitMessage(field: TextField, max: number): string {
  return `Each book's ${field} must be at most ${max} characters`;
}

/** 400 INVALID_PAYLOAD naming `field`, stored record untouched, no KV put. */
async function expectRejected(
  res: Response,
  field: TextField,
  max: number,
  previousRaw: string,
  ops: ReturnType<typeof watchKvOps>,
) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as Json;
  expect(json.error).toEqual({
    code: "INVALID_PAYLOAD",
    message: limitMessage(field, max),
  });
  expect(await kv.get(kvKeys.user(USER1))).toBe(previousRaw);
  expect(ops.putKeys()).toEqual([]);
}

beforeEach(async () => {
  kv = createMockKV();
  token = await seedAuthToken(kv, USER1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/books — grandfathered over-cap values", () => {
  it("accepts the identical stored 250-char title and keeps it verbatim while the share flag changes", async () => {
    await seedStoredRecord([book(BOOK_A, { title: LEGACY_TITLE })]);

    const res = await putBooks([
      book(BOOK_A, { title: LEGACY_TITLE, isShared: BoolFlag.TRUE }),
    ]);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books[0].title).toBe(LEGACY_TITLE);
    const stored = (await storedRecord())?.books;
    expect(stored).toEqual([
      book(BOOK_A, { title: LEGACY_TITLE, isShared: BoolFlag.TRUE }),
    ]);
    expect(stored?.[0]?.title).toHaveLength(250);
  });

  describe.each(FIELD_LIMITS)("%s (max %i)", (field, max, char) => {
    it("accepts an identical stored over-cap value and stores it verbatim", async () => {
      const legacy = char.repeat(max + 10);
      await seedStoredRecord([book(BOOK_A, { [field]: legacy })]);

      const res = await putBooks([book(BOOK_A, { [field]: legacy })]);

      expect(res.status).toBe(200);
      expect((await storedRecord())?.books[0]?.[field]).toBe(legacy);
    });

    it("rejects a different over-cap value for the same bookId", async () => {
      const previousRaw = await seedStoredRecord([
        book(BOOK_A, { [field]: char.repeat(max + 10) }),
      ]);
      const ops = watchKvOps(kv);

      const res = await putBooks([
        book(BOOK_A, { [field]: `${char.repeat(max + 10)}x` }),
      ]);

      await expectRejected(res, field, max, previousRaw, ops);
    });
  });

  it("rejects a different 250-char title for the stored bookId, naming title", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { title: LEGACY_TITLE }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([book(BOOK_A, { title: OTHER_LONG_TITLE })]);

    await expectRejected(res, "title", BOOK_TITLE_MAX_LENGTH, previousRaw, ops);
  });

  it("rejects a NEW bookId with a 201-char title even when the stored over-cap book is sent unchanged", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { title: LEGACY_TITLE }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([
      book(BOOK_A, { title: LEGACY_TITLE }),
      book(BOOK_B, { title: "x".repeat(BOOK_TITLE_MAX_LENGTH + 1) }),
    ]);

    await expectRejected(res, "title", BOOK_TITLE_MAX_LENGTH, previousRaw, ops);
  });

  it("rejects the stored over-cap title copied onto a different bookId", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { title: LEGACY_TITLE }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([
      book(BOOK_A, { title: LEGACY_TITLE }),
      book(BOOK_B, { title: LEGACY_TITLE }),
    ]);

    await expectRejected(res, "title", BOOK_TITLE_MAX_LENGTH, previousRaw, ops);
  });

  it("rejects a new 501-char author on an entry whose over-cap title is grandfathered, naming author", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { title: LEGACY_TITLE }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([
      book(BOOK_A, {
        title: LEGACY_TITLE,
        author: "a".repeat(BOOK_AUTHOR_MAX_LENGTH + 1),
      }),
    ]);

    await expectRejected(
      res,
      "author",
      BOOK_AUTHOR_MAX_LENGTH,
      previousRaw,
      ops,
    );
  });

  it("rejects a new over-cap title on an entry whose over-cap author is grandfathered, naming title", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { author: LEGACY_AUTHOR }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([
      book(BOOK_A, { author: LEGACY_AUTHOR, title: OTHER_LONG_TITLE }),
    ]);

    await expectRejected(res, "title", BOOK_TITLE_MAX_LENGTH, previousRaw, ops);
  });

  it("stops grandfathering a value once a shorter one replaced it in KV", async () => {
    await seedStoredRecord([book(BOOK_A, { title: LEGACY_TITLE })]);
    const shortened = await putBooks([book(BOOK_A, { title: "Short title" })]);
    expect(shortened.status).toBe(200);
    const shortenedRaw = (await kv.get(kvKeys.user(USER1))) as string;
    const ops = watchKvOps(kv);

    const res = await putBooks([book(BOOK_A, { title: LEGACY_TITLE })]);

    await expectRejected(
      res,
      "title",
      BOOK_TITLE_MAX_LENGTH,
      shortenedRaw,
      ops,
    );
  });
});

// See the header → "Precedence".
describe("PUT /api/user/:id/books — cap check vs expectedLastUpdated", () => {
  it("answers 400, not 409, for a new over-cap value sent with a stale expectedLastUpdated", async () => {
    const previousRaw = await seedStoredRecord([book(BOOK_A)]);
    const ops = watchKvOps(kv);

    const res = await putBooks(
      [book(BOOK_A, { title: "x".repeat(BOOK_TITLE_MAX_LENGTH + 1) })],
      { expectedLastUpdated: "1999-12-31T00:00:00.000Z" },
    );

    await expectRejected(res, "title", BOOK_TITLE_MAX_LENGTH, previousRaw, ops);
  });

  it("answers 409 for a grandfathered body sent with a stale expectedLastUpdated", async () => {
    const previousRaw = await seedStoredRecord([
      book(BOOK_A, { title: LEGACY_TITLE }),
    ]);
    const ops = watchKvOps(kv);

    const res = await putBooks([book(BOOK_A, { title: LEGACY_TITLE })], {
      expectedLastUpdated: "1999-12-31T00:00:00.000Z",
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("BOOKS_CONFLICT");
    expect(await kv.get(kvKeys.user(USER1))).toBe(previousRaw);
    expect(ops.putKeys()).toEqual([]);
  });

  it("answers 200 for a grandfathered body sent with the matching expectedLastUpdated", async () => {
    await seedStoredRecord([book(BOOK_A, { title: LEGACY_TITLE })]);

    const res = await putBooks([book(BOOK_A, { title: LEGACY_TITLE })], {
      expectedLastUpdated: STORED_LAST_UPDATED,
    });

    expect(res.status).toBe(200);
    expect((await storedRecord())?.books[0]?.title).toBe(LEGACY_TITLE);
  });
});

describe("overLongBookFieldMessage", () => {
  const atCapTitle = "t".repeat(BOOK_TITLE_MAX_LENGTH);
  const longTitle = "t".repeat(BOOK_TITLE_MAX_LENGTH + 1);
  const longAuthor = "a".repeat(BOOK_AUTHOR_MAX_LENGTH + 1);
  const titleMsg = limitMessage("title", BOOK_TITLE_MAX_LENGTH);
  const authorMsg = limitMessage("author", BOOK_AUTHOR_MAX_LENGTH);
  const categoryMsg = limitMessage("category", BOOK_CATEGORY_MAX_LENGTH);

  it.each<[string, BookEntry[], BookEntry[] | undefined, string | null]>([
    ["no books at all", [], undefined, null],
    ["fitting values, no stored record", [book(BOOK_A)], undefined, null],
    [
      "values exactly at the cap, empty stored list",
      [book(BOOK_A, { title: atCapTitle })],
      [],
      null,
    ],
    [
      "identical stored over-cap title",
      [book(BOOK_A, { title: longTitle })],
      [book(BOOK_A, { title: longTitle })],
      null,
    ],
    [
      "identical stored over-cap values in all four fields",
      [
        book(BOOK_A, {
          title: longTitle,
          author: longAuthor,
          isbn: "9".repeat(BOOK_ISBN_MAX_LENGTH + 1),
          category: "c".repeat(BOOK_CATEGORY_MAX_LENGTH + 1),
        }),
      ],
      [
        book(BOOK_A, {
          title: longTitle,
          author: longAuthor,
          isbn: "9".repeat(BOOK_ISBN_MAX_LENGTH + 1),
          category: "c".repeat(BOOK_CATEGORY_MAX_LENGTH + 1),
        }),
      ],
      null,
    ],
    [
      "over-cap title, no stored record",
      [book(BOOK_A, { title: longTitle })],
      undefined,
      titleMsg,
    ],
    [
      "stored title exactly at the cap, PUT one char longer",
      [book(BOOK_A, { title: `${atCapTitle}t` })],
      [book(BOOK_A, { title: atCapTitle })],
      titleMsg,
    ],
    [
      "title and author both over, neither stored: title is named first",
      [book(BOOK_A, { author: longAuthor, title: longTitle })],
      [book(BOOK_A)],
      titleMsg,
    ],
    [
      "grandfathered title does not cover a new over-cap author",
      [book(BOOK_A, { title: longTitle, author: longAuthor })],
      [book(BOOK_A, { title: longTitle })],
      authorMsg,
    ],
    [
      "identical over-cap value stored under another bookId",
      [book(BOOK_B, { title: longTitle })],
      [book(BOOK_A, { title: longTitle })],
      titleMsg,
    ],
    [
      "identical string stored in another field of the same bookId",
      [book(BOOK_A, { title: longAuthor, author: longAuthor })],
      [book(BOOK_A, { author: longAuthor })],
      titleMsg,
    ],
    [
      "first entry grandfathered, second entry has a new over-cap category",
      [
        book(BOOK_A, { title: longTitle }),
        book(BOOK_B, { category: "c".repeat(BOOK_CATEGORY_MAX_LENGTH + 1) }),
      ],
      [book(BOOK_A, { title: longTitle })],
      categoryMsg,
    ],
    [
      "first over-cap entry wins over a later one",
      [
        book(BOOK_A, { author: longAuthor }),
        book(BOOK_B, { title: longTitle }),
      ],
      undefined,
      authorMsg,
    ],
  ])("%s", (_label, books, existingBooks, expected) => {
    expect(overLongBookFieldMessage(books, existingBooks)).toBe(expected);
  });
});
