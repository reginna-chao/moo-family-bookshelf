import { describe, it, expect } from "vitest";
import { decideSaveStrategy } from "moo-family-bookshelf-shared/personal/saveStrategy";

/** Minimal book factory — the function only constrains `{ bookId: string }`. */
const b = (bookId: string) => ({ bookId });
/** Variant carrying an extra field, to confirm full objects are returned. */
const bShared = (bookId: string, isShared: number) => ({ bookId, isShared });

/** Build a server payload whose `books` is the server-known set. */
const serverPayload = (...ids: string[]) => ({ books: ids.map(b) });

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
      books: [b("b1"), b("b2")],
      dirtyBookIds: new Set(["b2"]),
      savedRawPayload: serverPayload("b1"),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(true);
  });

  it("uses PATCH when all dirty books are server-known and under the cap", () => {
    const { usePut } = decideSaveStrategy({
      books: [b("b1"), b("b2"), b("b3")],
      dirtyBookIds: new Set(["b1", "b2"]),
      savedRawPayload: serverPayload("b1", "b2", "b3"),
      maxPatchChanges: 1000,
    });
    expect(usePut).toBe(false);
  });

  // --- dirtyBooks selection ---

  it("returns exactly the dirty books in original order, with full objects", () => {
    const result = decideSaveStrategy({
      books: [bShared("b1", 0), bShared("b2", 1), bShared("b3", 0)],
      dirtyBookIds: new Set(["b1", "b3"]),
      savedRawPayload: serverPayload("b1", "b2", "b3"),
      maxPatchChanges: 1000,
    });
    expect(result.dirtyBooks).toEqual([
      { bookId: "b1", isShared: 0 },
      { bookId: "b3", isShared: 0 },
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
    const { usePut, dirtyBooks } = decideSaveStrategy({
      books: [b("b1"), b("b2")],
      dirtyBookIds: new Set<string>(),
      savedRawPayload: serverPayload("b1", "b2"),
      maxPatchChanges: 1000,
    });
    expect(dirtyBooks).toEqual([]);
    expect(usePut).toBe(false);
  });
});
