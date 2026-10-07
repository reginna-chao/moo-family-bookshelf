import { describe, it, expect } from "vitest";
import {
  applyPatchChanges,
  decideSaveStrategy,
} from "moo-family-bookshelf-shared/personal/saveStrategy";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";

/**
 * Personal-shelf save strategy (`shared/src/personal/saveStrategy.ts`):
 * `decideSaveStrategy` (PUT vs PATCH and the PATCH change list) and
 * `applyPatchChanges`.
 *
 * Legacy cleanup (#234): when the server holds a book the local list no longer
 * has, PATCH never removes a server book, so a legacy entry dropped locally is
 * sent as an explicit unshare instead of forcing a full PUT.
 *
 * Promoted twins (#234 C3): a non-dirty, server-known book whose local flag
 * differs from the load-time server flag inherited a dropped legacy entry's
 * share; it must go out too (order: dirty, then promoted, then unshare).
 *
 * Flag coercion: both sides coerce through the same rule — only BoolFlag.TRUE
 * (1) is shared, anything else (boolean `true`, missing, null) is FALSE — the
 * same coercion the Worker's toBoolFlag applies on PUT.
 *
 * includePromoted gate (PWA shape): the PWA normalizes local flags by
 * truthiness while the snapshot keeps the raw server value, so a stored boolean
 * `true` / `"0"` reads as a local-vs-snapshot difference. Without the gate,
 * saving any other book would share those without an opt-in.
 */

/** Minimal book factory — the function constrains `{ bookId, isShared }`. */
const b = (bookId: string, isShared: BoolFlag = BoolFlag.FALSE) => ({
  bookId,
  isShared,
});
/** Variant carrying an extra field, to confirm full objects are returned. */
const bFull = (bookId: string, isShared: BoolFlag) => ({
  bookId,
  isShared,
  title: `title-${bookId}`,
});

/** Build a server payload whose `books` is the server-known set. */
const serverPayload = (...ids: string[]) => ({ books: ids.map((id) => b(id)) });

describe("decideSaveStrategy", () => {
  // --- usePut fallback branches (each isolated) ---

  it("uses PUT when there is no server record (savedRawPayload null)", () => {
    const { usePut } = decideSaveStrategy({
      books: [b("b1")],
      dirtyBookIds: new Set(["b1"]),
      savedRawPayload: null,
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  it("uses PUT when there is no server record, even with nothing dirty", () => {
    // Isolates the `savedRawPayload === null` clause: with an empty dirty set the
    // unknown-book clause is false, so only the null check can force PUT here.
    const { usePut } = decideSaveStrategy({
      books: [],
      dirtyBookIds: new Set<string>(),
      savedRawPayload: null,
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  it("uses PUT when the dirty set exceeds maxPatchChanges (cap is the only trigger)", () => {
    // Record present, all dirty books server-known, under no other fallback —
    // only the size cap (3 > 2) forces PUT.
    const { usePut } = decideSaveStrategy({
      books: [b("b1"), b("b2"), b("b3")],
      dirtyBookIds: new Set(["b1", "b2", "b3"]),
      savedRawPayload: serverPayload("b1", "b2", "b3"),
      maxPatchChanges: 2,
    });
    expect(usePut).toBe(true);
  });

  it("uses PUT when a dirty book is not on the server (un-synced new book)", () => {
    // Record present, under cap — only the unknown bookId forces PUT.
    const { usePut } = decideSaveStrategy({
      books: [b("b1"), b("b2", BoolFlag.TRUE)],
      dirtyBookIds: new Set(["b2"]),
      savedRawPayload: serverPayload("b1"),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  it("uses PATCH when all dirty books are server-known and under the cap", () => {
    const { usePut } = decideSaveStrategy({
      books: [b("b1", BoolFlag.TRUE), b("b2"), b("b3")],
      dirtyBookIds: new Set(["b1", "b2"]),
      savedRawPayload: serverPayload("b1", "b2", "b3"),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(false);
  });

  // --- patchChanges for a plain dirty save (positive companion) ---

  it("builds patchChanges from exactly the dirty books' { bookId, isShared } pairs", () => {
    const { usePut, patchChanges } = decideSaveStrategy({
      books: [
        bFull("b1", BoolFlag.TRUE),
        bFull("b2", BoolFlag.TRUE),
        bFull("b3", BoolFlag.FALSE),
      ],
      dirtyBookIds: new Set(["b1", "b3"]),
      // Server b2 matches the local non-dirty b2 (TRUE), so b2 is not a
      // promoted twin and only the dirty pairs may go out.
      savedRawPayload: {
        books: [b("b1"), b("b2", BoolFlag.TRUE), b("b3")],
      },
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(false);
    // Exact equality: no extra fields (title), no promoted and no unshare entries.
    expect(patchChanges).toEqual([
      { bookId: "b1", isShared: BoolFlag.TRUE },
      { bookId: "b3", isShared: BoolFlag.FALSE },
    ]);
  });

  // --- server holds a book the local list no longer has (#234 legacy cleanup) ---
  // Sent as an explicit unshare, not a forced PUT. See the file header.

  const LEGACY_ID = "14563038";
  const REAL_ID = "210180801000101";

  it("uses PATCH that unshares a server-held bookId the local list dropped", () => {
    // R is server-known and under the cap; L is server-only and still shared.
    const { usePut, dirtyBooks, patchChanges } = decideSaveStrategy({
      books: [b(REAL_ID, BoolFlag.TRUE)],
      dirtyBookIds: new Set([REAL_ID]),
      savedRawPayload: { books: [b(LEGACY_ID, BoolFlag.TRUE), b(REAL_ID)] },
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(false);
    expect(dirtyBooks).toEqual([{ bookId: REAL_ID, isShared: BoolFlag.TRUE }]);
    // Dirty books first, then one unshare per server-only id.
    expect(patchChanges).toEqual([
      { bookId: REAL_ID, isShared: BoolFlag.TRUE },
      { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
    ]);
  });

  it("emits unshares for server-only ids in server order", () => {
    const { patchChanges } = decideSaveStrategy({
      books: [b("b2", BoolFlag.TRUE)],
      dirtyBookIds: new Set(["b2"]),
      savedRawPayload: {
        books: [b("z9", BoolFlag.TRUE), b("b2"), b("a1", BoolFlag.TRUE)],
      },
      maxPatchChanges: 1000,
    });
    expect(patchChanges).toEqual([
      { bookId: "b2", isShared: BoolFlag.TRUE },
      { bookId: "z9", isShared: BoolFlag.FALSE },
      { bookId: "a1", isShared: BoolFlag.FALSE },
    ]);
  });

  it("uses PUT when the only dirty id is a server-only book absent from the local list", () => {
    // The dirty id resolves to no local book, so dirtyBooks is empty and the
    // unknown-book clause cannot fire — only the dirty-absent clause forces PUT.
    const { usePut, dirtyBooks } = decideSaveStrategy({
      books: [b(REAL_ID)],
      dirtyBookIds: new Set([LEGACY_ID]),
      savedRawPayload: serverPayload(LEGACY_ID, REAL_ID),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
    expect(dirtyBooks).toEqual([]);
  });

  it("keeps PATCH with no unshare entries when every server book is still local (server ⊆ local)", () => {
    // Positive companion: the local list is a superset of the server's, with a
    // server-known dirty book — no unshare may be emitted.
    const { usePut, patchChanges } = decideSaveStrategy({
      books: [b(LEGACY_ID), b(REAL_ID, BoolFlag.TRUE), b("210180801000102")],
      dirtyBookIds: new Set([REAL_ID]),
      savedRawPayload: serverPayload(LEGACY_ID, REAL_ID),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(false);
    expect(patchChanges).toEqual([
      { bookId: REAL_ID, isShared: BoolFlag.TRUE },
    ]);
  });

  // --- only server-only ids still shared on the server are unshared ---

  it.each([
    {
      label: "stored FALSE → no unshare",
      serverFlag: BoolFlag.FALSE,
      expectedChanges: [{ bookId: REAL_ID, isShared: BoolFlag.TRUE }],
    },
    {
      label: "stored TRUE → unshare",
      serverFlag: BoolFlag.TRUE,
      expectedChanges: [
        { bookId: REAL_ID, isShared: BoolFlag.TRUE },
        { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
      ],
    },
  ])(
    "unshares a server-only id only when the server still shares it ($label)",
    ({ serverFlag, expectedChanges }) => {
      const input = {
        books: [b(REAL_ID, BoolFlag.TRUE)],
        dirtyBookIds: new Set([REAL_ID]),
        savedRawPayload: { books: [b(LEGACY_ID, serverFlag), b(REAL_ID)] },
      };
      const { usePut, patchChanges } = decideSaveStrategy({
        ...input,
        maxPatchChanges: 1000,
      });
      expect(usePut).toBe(false);
      expect(patchChanges).toEqual(expectedChanges);
      // Cap contribution: a cap of 1 holds the dirty book alone, so PATCH
      // survives it only when the server-only id adds no change.
      const atCapOfOne = decideSaveStrategy({ ...input, maxPatchChanges: 1 });
      expect(atCapOfOne.usePut).toBe(serverFlag === BoolFlag.TRUE);
    },
  );

  // --- the cap counts unshares too ---

  it.each([
    // dirty 1 + unshares 2 = 3
    { label: "sum exceeds the cap → PUT", maxPatchChanges: 2, expected: true },
    {
      label: "sum equals the cap → PATCH",
      maxPatchChanges: 3,
      expected: false,
    },
  ])(
    "counts unshares against maxPatchChanges: $label",
    ({ maxPatchChanges, expected }) => {
      const { usePut, patchChanges } = decideSaveStrategy({
        books: [b("b1", BoolFlag.TRUE)],
        dirtyBookIds: new Set(["b1"]),
        savedRawPayload: {
          books: [
            b("b1"),
            b("gone1", BoolFlag.TRUE),
            b("gone2", BoolFlag.TRUE),
          ],
        },
        maxPatchChanges,
      });
      expect(usePut).toBe(expected);
      expect(patchChanges).toHaveLength(3);
    },
  );

  // --- promoted twins (#234 C3) ---
  // A promoted (inherited-share) book must go out too. See the file header.

  it("sends dirty, then promoted, then unshare changes in that order", () => {
    const OTHER_ID = "210000000000003";
    const { usePut, dirtyBooks, patchChanges } = decideSaveStrategy({
      books: [b(REAL_ID, BoolFlag.TRUE), b(OTHER_ID, BoolFlag.TRUE)],
      dirtyBookIds: new Set([OTHER_ID]),
      savedRawPayload: {
        books: [
          b(LEGACY_ID, BoolFlag.TRUE),
          b(REAL_ID, BoolFlag.FALSE),
          b(OTHER_ID, BoolFlag.FALSE),
        ],
      },
      maxPatchChanges: 1000,
      includePromoted: true,
    });
    expect(usePut).toBe(false);
    expect(dirtyBooks.map((x) => x.bookId)).toEqual([OTHER_ID]);
    expect(patchChanges).toEqual([
      { bookId: OTHER_ID, isShared: BoolFlag.TRUE },
      { bookId: REAL_ID, isShared: BoolFlag.TRUE },
      { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
    ]);
  });

  it("does not send a non-dirty book whose local flag equals the server flag", () => {
    const { patchChanges } = decideSaveStrategy({
      books: [
        b("b1", BoolFlag.TRUE),
        b("b2", BoolFlag.TRUE),
        b("b3", BoolFlag.FALSE),
      ],
      dirtyBookIds: new Set(["b1"]),
      savedRawPayload: {
        books: [b("b1"), b("b2", BoolFlag.TRUE), b("b3", BoolFlag.FALSE)],
      },
      maxPatchChanges: 1000,
      // With the gate open, so equality — not the gate — keeps b2/b3 out.
      includePromoted: true,
    });
    expect(patchChanges).toEqual([{ bookId: "b1", isShared: BoolFlag.TRUE }]);
  });

  it.each([
    // Only BoolFlag.TRUE (1) is shared, anything else is FALSE — as the Worker's
    // toBoolFlag does on PUT.
    { label: "boolean true on both sides", server: true, local: true },
    { label: "server true, local FALSE", server: true, local: BoolFlag.FALSE },
    {
      label: "server missing, local FALSE",
      server: undefined,
      local: BoolFlag.FALSE,
    },
    { label: "server null, local FALSE", server: null, local: BoolFlag.FALSE },
  ])(
    "does not treat a non-dirty book as promoted when the coerced flags match ($label)",
    ({ server, local }) => {
      const { usePut, patchChanges } = decideSaveStrategy({
        books: [
          b("b1", BoolFlag.TRUE),
          { bookId: "b2", isShared: local as unknown as BoolFlag },
        ],
        dirtyBookIds: new Set(["b1"]),
        savedRawPayload: {
          books: [b("b1"), { bookId: "b2", isShared: server }],
        },
        maxPatchChanges: 1000,
        // With the gate open, so coercion — not the gate — keeps b2 out.
        includePromoted: true,
      });
      expect(usePut).toBe(false);
      expect(patchChanges).toEqual([{ bookId: "b1", isShared: BoolFlag.TRUE }]);
    },
  );

  it.each([
    // dirty 1 + promoted 1 + unshare 1 = 3
    { label: "sum exceeds the cap → PUT", maxPatchChanges: 2, expected: true },
    {
      label: "sum equals the cap → PATCH",
      maxPatchChanges: 3,
      expected: false,
    },
  ])(
    "counts promoted twins against maxPatchChanges: $label",
    ({ maxPatchChanges, expected }) => {
      const { usePut, patchChanges } = decideSaveStrategy({
        books: [b("b1", BoolFlag.TRUE), b("r1", BoolFlag.TRUE)],
        dirtyBookIds: new Set(["b1"]),
        // r1 is stored FALSE (local TRUE → promoted); gone1 is still shared.
        savedRawPayload: {
          books: [b("b1"), b("r1"), b("gone1", BoolFlag.TRUE)],
        },
        maxPatchChanges,
        includePromoted: true,
      });
      expect(usePut).toBe(expected);
      expect(patchChanges).toEqual([
        { bookId: "b1", isShared: BoolFlag.TRUE },
        { bookId: "r1", isShared: BoolFlag.TRUE },
        { bookId: "gone1", isShared: BoolFlag.FALSE },
      ]);
    },
  );

  // --- includePromoted gate (PWA shape) ---
  // Without the gate, PWA truthiness diffs would share books without an opt-in.

  const pwaShapeInput = () => ({
    books: [
      b("x", BoolFlag.TRUE),
      b("y", BoolFlag.TRUE),
      b("z", BoolFlag.TRUE),
    ],
    dirtyBookIds: new Set(["z"]),
    savedRawPayload: {
      books: [
        { bookId: "x", isShared: true },
        { bookId: "y", isShared: "0" },
        { bookId: "z", isShared: BoolFlag.FALSE },
      ],
    },
    maxPatchChanges: 1000,
  });

  it("sends only the dirty book when includePromoted is omitted (PWA truthy-normalized flags)", () => {
    const { usePut, patchChanges } = decideSaveStrategy(pwaShapeInput());
    expect(usePut).toBe(false);
    expect(patchChanges).toEqual([{ bookId: "z", isShared: BoolFlag.TRUE }]);
  });

  it("would send the truthy-normalized books as promoted with includePromoted: true (why the gate exists)", () => {
    const { usePut, patchChanges } = decideSaveStrategy({
      ...pwaShapeInput(),
      includePromoted: true,
    });
    expect(usePut).toBe(false);
    expect(patchChanges).toEqual([
      { bookId: "z", isShared: BoolFlag.TRUE },
      { bookId: "x", isShared: BoolFlag.TRUE },
      { bookId: "y", isShared: BoolFlag.TRUE },
    ]);
  });

  it("does not count would-be-promoted books against the cap when includePromoted is omitted", () => {
    // dirty 1 + would-be-promoted 2 = 3 with the gate open; only 1 without it.
    const input = { ...pwaShapeInput(), maxPatchChanges: 1 };
    expect(decideSaveStrategy(input).usePut).toBe(false);
    // Positive companion: the same input with the gate open exceeds the cap.
    expect(decideSaveStrategy({ ...input, includePromoted: true }).usePut).toBe(
      true,
    );
  });

  // --- malformed server entries are skipped ---

  it.each([
    { label: "empty-string bookId", entry: { bookId: "" } },
    { label: "numeric bookId", entry: { bookId: 42 } },
    { label: "missing bookId", entry: { isShared: BoolFlag.TRUE } },
    { label: "null entry", entry: null },
  ])(
    "skips a server entry with $label from patchChanges without forcing PUT",
    ({ entry }) => {
      const { usePut, patchChanges } = decideSaveStrategy({
        books: [b("b1", BoolFlag.TRUE)],
        dirtyBookIds: new Set(["b1"]),
        savedRawPayload: { books: [b("b1"), entry] },
        maxPatchChanges: 1000,
      });
      expect(usePut).toBe(false);
      expect(patchChanges).toEqual([{ bookId: "b1", isShared: BoolFlag.TRUE }]);
    },
  );

  // --- dirtyBooks selection ---

  it("returns exactly the dirty books in original order, with full objects", () => {
    const result = decideSaveStrategy({
      books: [
        bFull("b1", BoolFlag.FALSE),
        bFull("b2", BoolFlag.TRUE),
        bFull("b3", BoolFlag.FALSE),
      ],
      dirtyBookIds: new Set(["b1", "b3"]),
      savedRawPayload: serverPayload("b1", "b2", "b3"),
      maxPatchChanges: 1000,
    });
    expect(result.dirtyBooks).toEqual([
      { bookId: "b1", isShared: BoolFlag.FALSE, title: "title-b1" },
      { bookId: "b3", isShared: BoolFlag.FALSE, title: "title-b3" },
    ]);
    expect(result.dirtyBooks.map((x) => x.bookId)).not.toContain("b2");
    expect(result.usePut).toBe(false);
  });

  // --- Array.isArray guard (review fix S1) ---

  it("treats a non-array savedRawPayload.books as no known books → PUT (string case)", () => {
    const { usePut } = decideSaveStrategy({
      books: [b("b1")],
      dirtyBookIds: new Set(["b1"]),
      savedRawPayload: { books: "oops" } as { books?: unknown },
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  it("treats a missing savedRawPayload.books as no known books → PUT", () => {
    const { usePut } = decideSaveStrategy({
      books: [b("b1")],
      dirtyBookIds: new Set(["b1"]),
      savedRawPayload: {},
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  // --- empty dirty set (pure-function behavior; callers own the early return) ---

  it("returns no dirty books and PATCH (usePut false) when nothing is dirty", () => {
    const { usePut, dirtyBooks, patchChanges } = decideSaveStrategy({
      books: [b("b1"), b("b2")],
      dirtyBookIds: new Set<string>(),
      savedRawPayload: serverPayload("b1", "b2"),
      maxPatchChanges: 1000,
    });
    expect(dirtyBooks).toEqual([]);
    expect(patchChanges).toEqual([]);
    expect(usePut).toBe(false);
  });
});

describe("applyPatchChanges", () => {
  it.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "a string", value: "oops" },
    { label: "an object", value: { b1: BoolFlag.TRUE } },
  ])("returns non-array input ($label) unchanged", ({ value }) => {
    expect(
      applyPatchChanges(value, [{ bookId: "b1", isShared: BoolFlag.TRUE }]),
    ).toBe(value);
  });

  it("replaces isShared only on entries whose bookId was sent, keeping other fields", () => {
    const server = [
      { bookId: "b1", isShared: BoolFlag.FALSE, title: "一" },
      { bookId: "b2", isShared: BoolFlag.FALSE, title: "二" },
      { bookId: "b3", isShared: BoolFlag.TRUE, title: "三" },
    ];
    const next = applyPatchChanges(server, [
      { bookId: "b1", isShared: BoolFlag.TRUE },
      { bookId: "b3", isShared: BoolFlag.FALSE },
    ]);
    expect(next).toEqual([
      { bookId: "b1", isShared: BoolFlag.TRUE, title: "一" },
      { bookId: "b2", isShared: BoolFlag.FALSE, title: "二" },
      { bookId: "b3", isShared: BoolFlag.FALSE, title: "三" },
    ]);
  });

  it("returns untouched entries as the same object references in a new array", () => {
    const untouched = { bookId: "b2", isShared: BoolFlag.FALSE };
    const server = [{ bookId: "b1", isShared: BoolFlag.FALSE }, untouched];
    const next = applyPatchChanges(server, [
      { bookId: "b1", isShared: BoolFlag.TRUE },
    ]) as unknown[];
    expect(next).not.toBe(server);
    expect(next[1]).toBe(untouched);
    // The sent entry is a new object, not the input one rewritten.
    expect(next[0]).not.toBe(server[0]);
  });

  it("leaves entries without a string bookId untouched", () => {
    const numeric = { bookId: 42, isShared: BoolFlag.FALSE };
    const missing = { isShared: BoolFlag.FALSE };
    const server = [numeric, missing, null, "junk"];
    const next = applyPatchChanges(server, [
      { bookId: "42", isShared: BoolFlag.TRUE },
    ]) as unknown[];
    expect(next).toHaveLength(4);
    expect(next[0]).toBe(numeric);
    expect(next[1]).toBe(missing);
    expect(next[2]).toBeNull();
    expect(next[3]).toBe("junk");
    expect(numeric.isShared).toBe(BoolFlag.FALSE);
  });

  it("never adds an entry for a sent bookId the snapshot does not hold", () => {
    const server = [{ bookId: "b1", isShared: BoolFlag.FALSE }];
    const next = applyPatchChanges(server, [
      { bookId: "b1", isShared: BoolFlag.TRUE },
      { bookId: "new1", isShared: BoolFlag.TRUE },
    ]);
    expect(next).toEqual([{ bookId: "b1", isShared: BoolFlag.TRUE }]);
  });

  it("does not mutate the input array or its entries", () => {
    const server = [
      { bookId: "b1", isShared: BoolFlag.FALSE },
      { bookId: "b2", isShared: BoolFlag.TRUE },
    ];
    const before = structuredClone(server);
    applyPatchChanges(server, [
      { bookId: "b1", isShared: BoolFlag.TRUE },
      { bookId: "b2", isShared: BoolFlag.FALSE },
    ]);
    expect(server).toEqual(before);
  });
});
