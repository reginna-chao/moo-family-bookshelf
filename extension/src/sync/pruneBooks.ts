/** Pruning (#241): drop saved books Readmoo no longer holds for the account, judged against the fiber
 *  bridge's library ids as a KEEP-set. See docs/architecture.md → 書單同步. */

import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";
import { BookEntry, BoolFlag } from "../api/client";
import { titleKey } from "./legacyBooks";

/** Never remove more than this share of the real-id books in one sync. */
export const PRUNE_MAX_RATIO = 0.25;
/** A small library may still lose up to this many books per sync even when the ratio would forbid it. */
export const PRUNE_MIN_ALLOWANCE = 2;
/** Hard cap per sync: refunds come one or two at a time; bounds the damage of a partially read list. */
export const PRUNE_MAX_PER_SYNC = 20;

export interface PruneContext {
  /** Every bookId of this scrape (library + archive when synced). */
  scrapedIds: ReadonlySet<string>;
  /** `ScrapeResult.libraryIds` — every id Readmoo holds for the account; null = unknown. */
  libraryIds: ReadonlySet<string> | null;
  /** Book ids the user has lent out through the app (LENT, user is owner). */
  lentBookIds: ReadonlySet<string>;
  /** Every bookId the server held BEFORE this sync's scrape began (not the current read). */
  serverIds: ReadonlySet<string>;
  /** The 同步封存書 setting for this sync. */
  syncArchived: BoolFlag;
  /** Title keys of scraped books left out of the upload (`FieldCapFit.skippedTitles`, #326): a saved
   *  entry carrying one may be that book under its old id, so it is never removed. */
  protectedTitles?: ReadonlySet<string>;
}

/** One saved book removed because Readmoo no longer holds it. */
export interface RemovedBook {
  bookId: string;
  isShared: BoolFlag;
}

export interface PruneResult {
  /** The list to upload — the input array itself when nothing is removed. */
  books: BookEntry[];
  /** Every removed entry, in list order. */
  removedBooks: RemovedBook[];
  /** Always `removedBooks.length`. */
  removedCount: number;
  /** Removed entries whose `isShared` is `BoolFlag.TRUE`. */
  removedSharedCount: number;
}

function unchanged(books: BookEntry[]): PruneResult {
  return { books, removedBooks: [], removedCount: 0, removedSharedCount: 0 };
}

/** True when every scraped id is in the library ids — the two reads describe the same account. */
function libraryCoversScrape(
  scrapedIds: ReadonlySet<string>,
  libraryIds: ReadonlySet<string>,
): boolean {
  let covered = 0;
  for (const id of scrapedIds) if (libraryIds.has(id)) covered++;
  if (covered === scrapedIds.size) return true;
  console.warn(
    "[moo] prune skipped: fiber library ids do not cover the scrape",
    { scraped: scrapedIds.size, covered },
  );
  return false;
}

/** A real-id server entry that neither this scrape, Readmoo's library nor a MooFamily loan explains,
 *  not an archived book hidden by an unsynced archive, and not titled like a left-out scraped book. */
function isPruneCandidate(
  entry: BookEntry,
  ctx: PruneContext,
  libraryIds: ReadonlySet<string>,
): boolean {
  const archiveHidden =
    ctx.syncArchived !== BoolFlag.TRUE && entry.isArchived === BoolFlag.TRUE;
  return (
    !archiveHidden &&
    isRealBookId(entry.bookId) &&
    ctx.serverIds.has(entry.bookId) &&
    !ctx.scrapedIds.has(entry.bookId) &&
    !libraryIds.has(entry.bookId) &&
    !ctx.lentBookIds.has(entry.bookId) &&
    !ctx.protectedTitles?.has(titleKey(entry))
  );
}

/** How many entries one sync may remove from a list holding `realTotal` real-id books: the ratio
 *  share, at least `PRUNE_MIN_ALLOWANCE`, never more than `PRUNE_MAX_PER_SYNC`. */
function pruneAllowance(realTotal: number): number {
  return Math.min(
    PRUNE_MAX_PER_SYNC,
    Math.max(PRUNE_MIN_ALLOWANCE, Math.floor(realTotal * PRUNE_MAX_RATIO)),
  );
}

/**
 * Remove saved real-id entries Readmoo no longer holds for the account. A
 * no-op when the library ids are unknown, the scrape is empty, the library ids
 * do not cover the scrape, or it would remove more than `pruneAllowance`
 * entries (count-only warnings). Legacy short-id entries are never touched
 * (#234). Order is preserved, the input is not mutated, and the same array is
 * returned when nothing is removed.
 */
export function pruneRemovedBooks(
  books: BookEntry[],
  ctx: PruneContext,
): PruneResult {
  const { libraryIds } = ctx;
  if (libraryIds === null) return unchanged(books);
  // An empty read looks exactly like a library still loading; requiring at least one
  // scraped book also keeps the upload non-empty.
  if (ctx.scrapedIds.size === 0) return unchanged(books);
  if (!libraryCoversScrape(ctx.scrapedIds, libraryIds)) return unchanged(books);

  const candidates = new Set(
    books.filter((entry) => isPruneCandidate(entry, ctx, libraryIds)),
  );
  if (candidates.size === 0) return unchanged(books);

  const realTotal = books.filter((entry) => isRealBookId(entry.bookId)).length;
  const allowed = pruneAllowance(realTotal);
  if (candidates.size > allowed) {
    console.warn("[moo] prune skipped: too many books would be removed", {
      candidates: candidates.size,
      realTotal,
      allowed,
    });
    return unchanged(books);
  }

  const removedBooks = [...candidates].map((entry) => ({
    bookId: entry.bookId,
    isShared: entry.isShared === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE,
  }));
  return {
    books: books.filter((entry) => !candidates.has(entry)),
    removedBooks,
    removedCount: removedBooks.length,
    removedSharedCount: removedBooks.filter((b) => b.isShared === BoolFlag.TRUE)
      .length,
  };
}
