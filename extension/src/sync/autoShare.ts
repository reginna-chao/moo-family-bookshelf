/** 新書預設開放 (#238): mark books new to the server (never one removed while unshared, #312) as shared
 *  at sync time, run only AFTER id-change resolution and pruning (`syncUpload.ts`). See docs/architecture.md → 書單同步. */

import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";
import { BookEntry, BoolFlag } from "../api/client";
import { isLegacyBookEntry, titleKey } from "./legacyBooks";
import type { RenamedBook } from "./renamedBooks";

/** More new books than this in one sync → nothing is auto-shared (a misread library, not purchases). */
export const AUTO_SHARE_MAX_NEW = 100;

export interface AutoShareContext {
  /** The stored 新書預設開放 setting of the record this upload is built on. */
  enabled: BoolFlag;
  /** No usable record, or an empty one: the first sync never auto-shares. */
  firstSync: boolean;
  /** Every bookId of this scrape. */
  scrapedIds: ReadonlySet<string>;
  /** Every bookId of the CURRENT read (the record this upload replaces). */
  serverIds: ReadonlySet<string>;
  /** Targets of an id change (renamed books, resolved legacy entries): an old book, never a new one. */
  renamedNewIds: ReadonlySet<string>;
  /** Titles of current-read entries this scrape did not find; a new id carrying one may be an
   *  unpaired id change, so it is never auto-shared. */
  savedOnlyTitles: ReadonlySet<string>;
  /** Server-owned `removedUnsharedBookIds` of that read (#312): books removed while NOT shared —
   *  an old book coming back, never a new one. */
  removedUnsharedIds: ReadonlySet<string>;
}

export interface AutoShareResult {
  /** The list to upload — the input array itself when nothing is auto-shared. */
  books: BookEntry[];
  /** Books switched to shared by this call. */
  autoSharedCount: number;
  /** New books left unshared because there were more than `AUTO_SHARE_MAX_NEW`; 0 otherwise. */
  autoShareHeldCount: number;
}

/** The saved record a sync builds its upload on (`LoadSavedResult`). */
interface SavedRead {
  books: readonly BookEntry[];
  raw: Record<string, unknown> | null;
}

function isNewToServer(entry: BookEntry, ctx: AutoShareContext): boolean {
  return (
    ctx.scrapedIds.has(entry.bookId) &&
    !ctx.serverIds.has(entry.bookId) &&
    !ctx.renamedNewIds.has(entry.bookId) &&
    !ctx.removedUnsharedIds.has(entry.bookId) &&
    !ctx.savedOnlyTitles.has(titleKey(entry)) &&
    entry.isShared !== BoolFlag.TRUE &&
    entry.isArchived !== BoolFlag.TRUE
  );
}

/**
 * Mark every book new to the server as shared, when the stored setting is on.
 * "New" = scraped this time, absent from the current read, not the target of
 * a resolved id change, not removed from the server while unshared (#312: it
 * comes back unshared and does not count toward `AUTO_SHARE_MAX_NEW`), not
 * titled like a saved book this scrape did not find (a possible unpaired id
 * change), not already shared, and not archived (an archived book first
 * uploaded once 同步封存書籍 is on stays unshared). Nothing changes when the
 * setting is off, on a first sync, or when more than `AUTO_SHARE_MAX_NEW`
 * books are new (then `autoShareHeldCount` reports them, with one counts-only
 * warning).
 * Order is preserved, the input is not mutated, and the same array is
 * returned when nothing is marked. Writes nothing.
 */
export function autoShareNewBooks(
  books: BookEntry[],
  ctx: AutoShareContext,
): AutoShareResult {
  const unchanged = { books, autoSharedCount: 0, autoShareHeldCount: 0 };
  if (ctx.enabled !== BoolFlag.TRUE || ctx.firstSync) return unchanged;
  const fresh = new Set(books.filter((entry) => isNewToServer(entry, ctx)));
  if (fresh.size === 0) return unchanged;
  if (fresh.size > AUTO_SHARE_MAX_NEW) {
    console.warn("[moo] auto-share skipped: too many new books", {
      newCount: fresh.size,
      max: AUTO_SHARE_MAX_NEW,
    });
    return { ...unchanged, autoShareHeldCount: fresh.size };
  }
  return {
    books: books.map((entry) =>
      fresh.has(entry) ? { ...entry, isShared: BoolFlag.TRUE } : entry,
    ),
    autoSharedCount: fresh.size,
    autoShareHeldCount: 0,
  };
}

/** Real entries a saved legacy entry resolved onto in `mergeBooks` (`dropResolvedLegacyBooks`): a
 *  legacy entry missing from `merged` was resolved, and its target is the real entry with its title. */
function legacyTargetIds(
  savedBooks: readonly BookEntry[],
  merged: readonly BookEntry[],
): string[] {
  const mergedIds = new Set(merged.map((b) => b.bookId));
  const resolvedTitles = new Set(
    savedBooks
      .filter((b) => isLegacyBookEntry(b) && !mergedIds.has(b.bookId))
      .map(titleKey)
      .filter((key) => key !== ""),
  );
  return merged
    .filter((b) => !isLegacyBookEntry(b) && resolvedTitles.has(titleKey(b)))
    .map((b) => b.bookId);
}

/** `removedUnsharedBookIds` of a read, checked at the boundary: a non-array is empty and only
 *  real book ids are kept, so a malformed value never throws. */
function removedUnsharedIdsOf(raw: SavedRead["raw"]): Set<string> {
  const value: unknown = raw?.removedUnsharedBookIds;
  if (!Array.isArray(value)) return new Set();
  return new Set(
    (value as unknown[]).filter((id): id is string => isRealBookId(id)),
  );
}

/**
 * The `AutoShareContext` of one upload attempt: the setting, the server ids and
 * the removed-while-unshared ids come from that attempt's read, so a 409 re-read
 * recomputes them all. `merged` is the `mergeBooks` output, before id-change
 * resolution. Pure.
 */
export function autoShareContextFor(
  saved: SavedRead,
  merged: readonly BookEntry[],
  renamedBooks: readonly RenamedBook[],
  scrapedIds: ReadonlySet<string>,
): AutoShareContext {
  const enabled =
    saved.raw?.newBookDefaultShared === BoolFlag.TRUE
      ? BoolFlag.TRUE
      : BoolFlag.FALSE;
  return {
    enabled,
    firstSync: saved.raw === null || saved.books.length === 0,
    scrapedIds,
    serverIds: new Set(saved.books.map((b) => b.bookId)),
    renamedNewIds: new Set([
      ...renamedBooks.map((r) => r.newId),
      ...legacyTargetIds(saved.books, merged),
    ]),
    savedOnlyTitles: new Set(
      saved.books
        .filter((b) => !scrapedIds.has(b.bookId))
        .map(titleKey)
        .filter((key) => key !== ""),
    ),
    removedUnsharedIds: removedUnsharedIdsOf(saved.raw),
  };
}
