import { describe, it, expect } from "vitest";
import {
  moveRenamedDirtyIds,
  overlayUnsavedShares,
  reconcileSyncedShelf,
  settleSavedShelf,
} from "@/dialog/syncedShelf";
import { BoolFlag, type BookEntry } from "@/api/client";
import type { RenamedBook } from "@/sync/renamedBooks";

const A = "210000000000001";
const B = "210000000000002";
const C = "210000000000003";
/** A book the sync moved from OLD_X to NEW_Y. */
const OLD_X = "210000000000011";
const NEW_Y = "210000000000012";
const X_TO_Y: RenamedBook[] = [{ oldId: OLD_X, newId: NEW_Y }];

function flags(books: readonly BookEntry[]): Array<[string, BoolFlag]> {
  return books.map((b) => [b.bookId, b.isShared]);
}

function makeBook(bookId: string, isShared = BoolFlag.FALSE): BookEntry {
  return {
    bookId,
    title: `書 ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  };
}

describe("overlayUnsavedShares", () => {
  it("returns a copy of the sync result when nothing is dirty", () => {
    const synced = [makeBook(A, BoolFlag.TRUE), makeBook(B)];
    const local = [makeBook(A, BoolFlag.FALSE), makeBook(C)];

    const result = overlayUnsavedShares(synced, local, new Set());

    expect(result).toEqual(synced);
    expect(result).not.toBe(synced);
  });

  it("keeps the local flag of every dirty id still in the sync result", () => {
    const synced = [makeBook(A, BoolFlag.FALSE), makeBook(B, BoolFlag.TRUE)];
    const local = [makeBook(A, BoolFlag.TRUE), makeBook(B, BoolFlag.FALSE)];

    const result = overlayUnsavedShares(synced, local, new Set([A, B]));

    expect(result.map((b) => [b.bookId, b.isShared])).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.FALSE],
    ]);
  });

  it("uses the sync result's metadata even for a dirty id", () => {
    const synced = [{ ...makeBook(A), title: "新書名" }];
    const local = [{ ...makeBook(A, BoolFlag.TRUE), title: "舊書名" }];

    const [book] = overlayUnsavedShares(synced, local, new Set([A]));

    expect(book).toMatchObject({ title: "新書名", isShared: BoolFlag.TRUE });
  });

  it("does not re-add a dirty id that the sync replaced or dropped", () => {
    const synced = [makeBook(B)];
    const local = [makeBook(A, BoolFlag.TRUE), makeBook(B)];

    const result = overlayUnsavedShares(synced, local, new Set([A]));

    expect(result.map((b) => b.bookId)).toEqual([B]);
  });

  it("ignores the local flag of a book that is not dirty", () => {
    const synced = [makeBook(A, BoolFlag.FALSE)];
    const local = [makeBook(A, BoolFlag.TRUE)];

    expect(overlayUnsavedShares(synced, local, new Set([B]))[0].isShared).toBe(
      BoolFlag.FALSE,
    );
  });

  it("is pure and reuses untouched entries", () => {
    const synced = [makeBook(A), makeBook(B)];
    const local = [makeBook(A, BoolFlag.TRUE), makeBook(B)];
    const syncedBefore = synced.map((b) => ({ ...b }));
    const localBefore = local.map((b) => ({ ...b }));

    const result = overlayUnsavedShares(synced, local, new Set([A, B]));

    expect(synced).toEqual(syncedBefore);
    expect(local).toEqual(localBefore);
    expect(result[0]).not.toBe(synced[0]); // flag differed → new object
    expect(result[1]).toBe(synced[1]); // same flag → reused
  });
});

describe("moveRenamedDirtyIds", () => {
  it("replaces a dirty old id by its new id in a new Set", () => {
    const dirty = new Set([OLD_X, A]);

    const result = moveRenamedDirtyIds(dirty, X_TO_Y);

    expect([...result].sort()).toEqual([A, NEW_Y].sort());
    expect(result).not.toBe(dirty);
    // The input Set is left untouched.
    expect([...dirty].sort()).toEqual([A, OLD_X].sort());
  });

  it("returns the very same Set when no dirty id was renamed", () => {
    const dirty = new Set([A]);

    expect(moveRenamedDirtyIds(dirty, X_TO_Y)).toBe(dirty);
    expect(moveRenamedDirtyIds(dirty, [])).toBe(dirty);
  });

  it("moves only the renames whose old id is dirty", () => {
    const dirty = new Set([OLD_X]);
    const renamed: RenamedBook[] = [
      { oldId: OLD_X, newId: NEW_Y },
      { oldId: A, newId: B },
    ];

    expect([...moveRenamedDirtyIds(dirty, renamed)]).toEqual([NEW_Y]);
  });
});

describe("reconcileSyncedShelf", () => {
  it("moves an unsaved toggle on a renamed book to its new id", () => {
    // The server had X shared; the user unshared it locally (unsaved); the
    // sync replaced X by Y, which inherited the server's shared flag.
    const synced = [makeBook(NEW_Y, BoolFlag.TRUE), makeBook(A)];
    const local = [makeBook(OLD_X, BoolFlag.FALSE), makeBook(A)];

    const result = reconcileSyncedShelf(
      synced,
      local,
      new Set([OLD_X]),
      X_TO_Y,
    );

    expect(flags(result.books)).toEqual([
      [NEW_Y, BoolFlag.FALSE],
      [A, BoolFlag.FALSE],
    ]);
    expect([...result.dirtyBookIds]).toEqual([NEW_Y]);
    expect(result.books.map((b) => b.bookId)).not.toContain(OLD_X);
  });

  it("carries the old id's flag even when the local list already holds the new id", () => {
    const synced = [makeBook(NEW_Y, BoolFlag.TRUE)];
    const local = [
      makeBook(OLD_X, BoolFlag.FALSE),
      makeBook(NEW_Y, BoolFlag.TRUE),
    ];

    const result = reconcileSyncedShelf(
      synced,
      local,
      new Set([OLD_X]),
      X_TO_Y,
    );

    expect(flags(result.books)).toEqual([[NEW_Y, BoolFlag.FALSE]]);
    expect([...result.dirtyBookIds]).toEqual([NEW_Y]);
  });

  it("keeps the new id's own unsaved toggle over the old id's", () => {
    // Both ids carry an unsaved toggle, with different local flags: Y's wins.
    const synced = [makeBook(NEW_Y, BoolFlag.TRUE)];
    const local = [
      makeBook(OLD_X, BoolFlag.TRUE),
      makeBook(NEW_Y, BoolFlag.FALSE),
    ];

    const result = reconcileSyncedShelf(
      synced,
      local,
      new Set([OLD_X, NEW_Y]),
      X_TO_Y,
    );

    expect(flags(result.books)).toEqual([[NEW_Y, BoolFlag.FALSE]]);
    expect([...result.dirtyBookIds]).toEqual([NEW_Y]);
  });

  it("changes nothing for a rename whose old id has no unsaved toggle", () => {
    const synced = [
      makeBook(NEW_Y, BoolFlag.TRUE),
      makeBook(A, BoolFlag.FALSE),
    ];
    const local = [makeBook(OLD_X, BoolFlag.FALSE), makeBook(A, BoolFlag.TRUE)];
    const dirty = new Set([A]);

    const result = reconcileSyncedShelf(synced, local, dirty, X_TO_Y);

    // Y shows the server's flag; A keeps its unsaved toggle as before.
    expect(flags(result.books)).toEqual([
      [NEW_Y, BoolFlag.TRUE],
      [A, BoolFlag.TRUE],
    ]);
    expect(result.dirtyBookIds).toBe(dirty);
  });

  it("returns the same dirty Set and the plain overlay when nothing was renamed", () => {
    const synced = [makeBook(A, BoolFlag.FALSE), makeBook(B)];
    const local = [makeBook(A, BoolFlag.TRUE), makeBook(C)];
    const dirty = new Set([A]);

    const result = reconcileSyncedShelf(synced, local, dirty, []);

    expect(result.dirtyBookIds).toBe(dirty);
    expect(result.books).toEqual(overlayUnsavedShares(synced, local, dirty));
  });

  it("is pure: no input is mutated", () => {
    const synced = [makeBook(NEW_Y, BoolFlag.TRUE), makeBook(A)];
    const local = [makeBook(OLD_X, BoolFlag.FALSE), makeBook(A)];
    const dirty = new Set([OLD_X]);
    const renamed = X_TO_Y.map((r) => ({ ...r }));
    const syncedBefore = synced.map((b) => ({ ...b }));
    const localBefore = local.map((b) => ({ ...b }));

    reconcileSyncedShelf(synced, local, dirty, renamed);

    expect(synced).toEqual(syncedBefore);
    expect(local).toEqual(localBefore);
    expect([...dirty]).toEqual([OLD_X]);
    expect(renamed).toEqual(X_TO_Y);
  });
});

describe("settleSavedShelf", () => {
  /** The list the save was computed from: X still there, A toggled on. */
  const saveList = [makeBook(OLD_X, BoolFlag.TRUE), makeBook(A, BoolFlag.TRUE)];
  /** The server snapshot at save time. */
  const serverAtSave = [
    makeBook(OLD_X, BoolFlag.TRUE),
    makeBook(A, BoolFlag.FALSE),
  ];
  const sentA = [{ bookId: A, isShared: BoolFlag.TRUE }];
  /** A sync result that landed mid-save: X replaced by Y. */
  const landed = [makeBook(NEW_Y, BoolFlag.TRUE), makeBook(A, BoolFlag.FALSE)];

  describe("without a mid-save sync (the pre-#236 rule)", () => {
    it("PATCH: the baseline is the saved list, the snapshot folds in the sent flags", () => {
      const settled = settleSavedShelf({
        books: saveList,
        usePut: false,
        sent: sentA,
        serverBooks: serverAtSave,
        landedSync: null,
      });

      expect(settled.baseline).toBe(saveList);
      expect(flags(settled.serverBooks as BookEntry[])).toEqual([
        [OLD_X, BoolFlag.TRUE],
        [A, BoolFlag.TRUE],
      ]);
    });

    it("PATCH: a book the server does not hold is not added to the snapshot", () => {
      const withLocalOnly = [...saveList, makeBook(C, BoolFlag.TRUE)];

      const settled = settleSavedShelf({
        books: withLocalOnly,
        usePut: false,
        sent: sentA,
        serverBooks: serverAtSave,
        landedSync: null,
      });

      expect((settled.serverBooks as BookEntry[]).map((b) => b.bookId)).toEqual(
        [OLD_X, A],
      );
    });

    it("PUT: baseline and snapshot are both the saved list", () => {
      const settled = settleSavedShelf({
        books: saveList,
        usePut: true,
        sent: sentA,
        serverBooks: serverAtSave,
        landedSync: null,
      });

      expect(settled.baseline).toBe(saveList);
      expect(settled.serverBooks).toBe(saveList);
    });
  });

  describe.each([
    { strategy: "PATCH", usePut: false },
    { strategy: "PUT", usePut: true },
  ])("with a sync result landed mid-save ($strategy)", ({ usePut }) => {
    it("rebases baseline and snapshot on the sync result with the sent flags folded in", () => {
      const settled = settleSavedShelf({
        books: saveList,
        usePut,
        sent: sentA,
        serverBooks: serverAtSave,
        landedSync: landed,
      });

      const expected: Array<[string, BoolFlag]> = [
        [NEW_Y, BoolFlag.TRUE],
        [A, BoolFlag.TRUE],
      ];
      expect(flags(settled.baseline)).toEqual(expected);
      expect(flags(settled.serverBooks as BookEntry[])).toEqual(expected);
      // The replaced old id never comes back.
      expect(settled.baseline.map((b) => b.bookId)).not.toContain(OLD_X);
    });

    it("does not re-add a sent id the sync result no longer holds", () => {
      const settled = settleSavedShelf({
        books: saveList,
        usePut,
        sent: [
          { bookId: OLD_X, isShared: BoolFlag.FALSE },
          { bookId: A, isShared: BoolFlag.TRUE },
        ],
        serverBooks: serverAtSave,
        landedSync: landed,
      });

      expect(settled.baseline.map((b) => b.bookId)).toEqual([NEW_Y, A]);
      // Y keeps the sync's flag: X's unshare does not leak onto it.
      expect(settled.baseline[0].isShared).toBe(BoolFlag.TRUE);
    });
  });

  it("is pure: no input is mutated", () => {
    const sent = [{ bookId: A, isShared: BoolFlag.TRUE }];
    const landedCopy = landed.map((b) => ({ ...b }));
    const saveCopy = saveList.map((b) => ({ ...b }));
    const serverCopy = serverAtSave.map((b) => ({ ...b }));

    settleSavedShelf({
      books: saveList,
      usePut: false,
      sent,
      serverBooks: serverAtSave,
      landedSync: landed,
    });

    expect(landed).toEqual(landedCopy);
    expect(saveList).toEqual(saveCopy);
    expect(serverAtSave).toEqual(serverCopy);
    expect(sent).toEqual([{ bookId: A, isShared: BoolFlag.TRUE }]);
  });
});
