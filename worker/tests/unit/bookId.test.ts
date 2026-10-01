import { describe, it, expect } from "vitest";
import {
  isRealBookId,
  REAL_BOOK_ID_PATTERN,
} from "moo-family-bookshelf-shared/api/bookId";
import { dropNewMalformedBookIds } from "../../src/routes/user";
import { BoolFlag, type BookEntry } from "../../src/kv/schema";

/** A real-shaped Readmoo bookId (15 digits, the length seen in production). */
const REAL_ID = "210439468000101";
const OTHER_REAL_ID = "210439468000102";

function book(bookId: string): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
  };
}

// ===========================================================================
// isRealBookId — the shared shape rule (Extension scraper + Worker PUT books)
// ===========================================================================

describe("isRealBookId", () => {
  it.each<{ label: string; input: unknown; expected: boolean }>([
    {
      label: "11 digits (one short of the floor)",
      input: "1".repeat(11),
      expected: false,
    },
    { label: "exactly 12 digits", input: "1".repeat(12), expected: true },
    { label: "a 15-digit production id", input: REAL_ID, expected: true },
    { label: "a long all-digit id", input: "9".repeat(40), expected: true },
    { label: "a legacy short id", input: "b1", expected: false },
    { label: "a short numeric id", input: "210439", expected: false },
    {
      label: "digits with a letter inside",
      input: "21043946800a101",
      expected: false,
    },
    {
      label: "digits with a hyphen",
      input: "210439-468000101",
      expected: false,
    },
    { label: "the empty string", input: "", expected: false },
    { label: "a leading space", input: ` ${REAL_ID}`, expected: false },
    { label: "a trailing space", input: `${REAL_ID} `, expected: false },
    { label: "a trailing newline", input: `${REAL_ID}\n`, expected: false },
    {
      label: "full-width digits",
      input: "２１０４３９４６８０００１０１",
      expected: false,
    },
    {
      label: "a number (not a string)",
      input: 210439468000101,
      expected: false,
    },
    { label: "null", input: null, expected: false },
    { label: "undefined", input: undefined, expected: false },
    { label: "an object", input: { bookId: REAL_ID }, expected: false },
    { label: "an array wrapping a real id", input: [REAL_ID], expected: false },
  ])("returns $expected for $label", ({ input, expected }) => {
    expect(isRealBookId(input)).toBe(expected);
  });

  it("agrees with the exported REAL_BOOK_ID_PATTERN on string input", () => {
    for (const id of ["1".repeat(11), "1".repeat(12), REAL_ID, "b1", ""]) {
      expect(isRealBookId(id)).toBe(REAL_BOOK_ID_PATTERN.test(id));
    }
  });
});

// ===========================================================================
// dropNewMalformedBookIds — PUT /api/user/:id/books boundary filter
// ===========================================================================

describe("dropNewMalformedBookIds", () => {
  it.each<{
    label: string;
    incoming: string[];
    stored: string[] | null | undefined;
    kept: string[];
    dropped: number;
  }>([
    {
      label: "drops a new short id",
      incoming: ["b1"],
      stored: [REAL_ID],
      kept: [],
      dropped: 1,
    },
    {
      label: "keeps a short id already in the stored record (grandfathered)",
      incoming: ["b1"],
      stored: ["b1"],
      kept: ["b1"],
      dropped: 0,
    },
    {
      label: "keeps a new real id",
      incoming: [REAL_ID],
      stored: [],
      kept: [REAL_ID],
      dropped: 0,
    },
    {
      label:
        "drops every malformed id when there is no stored record (undefined)",
      incoming: ["b1", REAL_ID, "b2"],
      stored: undefined,
      kept: [REAL_ID],
      dropped: 2,
    },
    {
      label: "drops every malformed id when there is no stored record (null)",
      incoming: ["b1", "b2"],
      stored: null,
      kept: [],
      dropped: 2,
    },
    {
      label: "drops every malformed id when the stored list is empty",
      incoming: ["b1", REAL_ID],
      stored: [],
      kept: [REAL_ID],
      dropped: 1,
    },
    {
      label: "grandfathers only the EXACT stored id, not a near spelling",
      incoming: ["b1", "B1", "b1 "],
      stored: ["b1"],
      kept: ["b1"],
      dropped: 2,
    },
    {
      label:
        "keeps a stored short id and a real id while dropping a new short id",
      incoming: ["legacy-1", "new-1", REAL_ID],
      stored: ["legacy-1"],
      kept: ["legacy-1", REAL_ID],
      dropped: 1,
    },
    {
      label: "returns an empty list unchanged",
      incoming: [],
      stored: ["b1"],
      kept: [],
      dropped: 0,
    },
  ])("$label", ({ incoming, stored, kept, dropped }) => {
    const existing =
      stored === null || stored === undefined ? stored : stored.map(book);
    // The handler passes `existing?.books` (undefined with no record); null is
    // cast through to pin that the guard tolerates it as well.
    const result = dropNewMalformedBookIds(
      incoming.map(book),
      existing as readonly BookEntry[] | undefined,
    );

    expect(result.books.map((b) => b.bookId)).toEqual(kept);
    expect(result.dropped).toBe(dropped);
    expect(result.dropped).toBe(incoming.length - result.books.length);
  });

  it("preserves the incoming order of the books it keeps", () => {
    const incoming = [OTHER_REAL_ID, "drop-me", "legacy", REAL_ID, "drop-too"];

    const result = dropNewMalformedBookIds(incoming.map(book), [
      book("legacy"),
    ]);

    expect(result.books.map((b) => b.bookId)).toEqual([
      OTHER_REAL_ID,
      "legacy",
      REAL_ID,
    ]);
  });

  it("returns the kept entries themselves, with every field intact", () => {
    const shared = { ...book(REAL_ID), isShared: BoolFlag.TRUE, title: "T" };

    const result = dropNewMalformedBookIds([shared], undefined);

    expect(result.books[0]).toEqual(shared);
  });

  it("does not mutate the incoming list or the stored list", () => {
    const incoming = [book("b1"), book(REAL_ID), book("b2")];
    const stored = [book("b2")];
    const incomingSnapshot = structuredClone(incoming);
    const storedSnapshot = structuredClone(stored);

    const result = dropNewMalformedBookIds(incoming, stored);

    expect(incoming).toEqual(incomingSnapshot);
    expect(stored).toEqual(storedSnapshot);
    // A fresh array, so a caller holding the input never sees it shrink.
    expect(result.books).not.toBe(incoming);
    expect(result.books.map((b) => b.bookId)).toEqual([REAL_ID, "b2"]);
  });
});
