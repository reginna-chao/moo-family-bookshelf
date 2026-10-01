import type { BookEntry } from "../api/client";
import type { RenamedBook } from "../sync/renamedBooks";
import {
  applyPatchChanges,
  type PatchChange,
} from "moo-family-bookshelf-shared/personal/saveStrategy";

/**
 * The list to display after a successful sync: the sync result — exactly what
 * the server now holds — with the LOCAL `isShared` kept for every dirty id
 * still present, so an unsaved toggle survives the sync (save-before-sync,
 * Invariant 3). A dirty id the sync replaced or dropped is not re-added.
 *
 * Pure: the inputs are not mutated; untouched entries are reused as-is.
 */
export function overlayUnsavedShares(
  synced: readonly BookEntry[],
  local: readonly BookEntry[],
  dirtyIds: ReadonlySet<string>,
): BookEntry[] {
  if (dirtyIds.size === 0) return [...synced];
  const localById = new Map(local.map((b) => [b.bookId, b]));
  return synced.map((book) => {
    const localBook = dirtyIds.has(book.bookId)
      ? localById.get(book.bookId)
      : undefined;
    if (!localBook || localBook.isShared === book.isShared) return book;
    return { ...book, isShared: localBook.isShared };
  });
}

/**
 * The dirty set after a sync moved books to new ids: each dirty old id is
 * replaced by its new id. Returns `dirtyIds` itself when nothing moved.
 * Pure.
 */
export function moveRenamedDirtyIds<S extends ReadonlySet<string>>(
  dirtyIds: S,
  renamed: readonly RenamedBook[],
): S | Set<string> {
  const moved = renamed.filter((r) => dirtyIds.has(r.oldId));
  if (moved.length === 0) return dirtyIds;
  const next = new Set(dirtyIds);
  for (const { oldId } of moved) next.delete(oldId);
  for (const { newId } of moved) next.add(newId);
  return next;
}

/**
 * The local list with every dirty, renamed entry re-keyed to its new id, so
 * the unsaved flag of the old id lands on the new one. A new id carrying its
 * own unsaved toggle keeps that toggle instead.
 */
function rekeyRenamedLocal(
  local: readonly BookEntry[],
  dirtyIds: ReadonlySet<string>,
  renamed: readonly RenamedBook[],
): readonly BookEntry[] {
  const carried = renamed.filter(
    (r) => dirtyIds.has(r.oldId) && !dirtyIds.has(r.newId),
  );
  if (carried.length === 0) return local;
  const newIdByOld = new Map(carried.map((r) => [r.oldId, r.newId]));
  const replaced = new Set(newIdByOld.values());
  return local
    .filter((book) => !replaced.has(book.bookId))
    .map((book) => {
      const newId = newIdByOld.get(book.bookId);
      return newId === undefined ? book : { ...book, bookId: newId };
    });
}

export interface SyncedShelf {
  /** The list to display. */
  books: BookEntry[];
  /** The dirty set to keep (`dirtyIds` itself when unchanged). */
  dirtyBookIds: ReadonlySet<string>;
}

/**
 * Apply a successful sync result to the screen. On top of
 * `overlayUnsavedShares`, an unsaved toggle on a book the sync moved to a new
 * Readmoo id follows the book: the new id shows the local flag and becomes
 * dirty, the old id leaves the dirty set. Nothing here is uploaded — the toggle
 * stays unsaved (Invariant 3). Pure.
 */
export function reconcileSyncedShelf(
  synced: readonly BookEntry[],
  local: readonly BookEntry[],
  dirtyIds: ReadonlySet<string>,
  renamed: readonly RenamedBook[],
): SyncedShelf {
  const dirtyBookIds = moveRenamedDirtyIds(dirtyIds, renamed);
  const rekeyed = rekeyRenamedLocal(local, dirtyIds, renamed);
  return {
    books: overlayUnsavedShares(synced, rekeyed, dirtyBookIds),
    dirtyBookIds,
  };
}

export interface SavedShelfInput {
  /** The list the save was computed from. */
  books: BookEntry[];
  usePut: boolean;
  /** Flags the save sent: the PATCH `changes`, or the dirty books' flags on PUT. */
  sent: readonly PatchChange[];
  /** The server `books` snapshot as it is now. */
  serverBooks: unknown;
  /** A sync result applied while the save was in flight; null when none was. */
  landedSync: BookEntry[] | null;
}

export interface SavedShelf {
  /** The new cancel baseline (also what the local cache stores). */
  baseline: BookEntry[];
  /** The new server `books` snapshot. */
  serverBooks: unknown;
}

/**
 * Baseline and server snapshot after a successful save. When a sync landed
 * mid-save both are the sync result with the sent flags folded in — the
 * pre-sync list the save was computed from may still hold an id the sync
 * replaced, and would bring it back on Cancel or on the next save. Pure.
 */
export function settleSavedShelf(input: SavedShelfInput): SavedShelf {
  const sent = [...input.sent];
  if (input.landedSync !== null) {
    // An array of BookEntry stays one: only `isShared` is replaced.
    const rebased = applyPatchChanges(input.landedSync, sent) as BookEntry[];
    return { baseline: rebased, serverBooks: rebased };
  }
  return {
    baseline: input.books,
    // PATCH adds no ids; marking un-synced books known would lose them.
    serverBooks: input.usePut
      ? input.books
      : applyPatchChanges(input.serverBooks, sent),
  };
}
