/** The last SUCCESSFUL book sync as useBookSync holds it (moved out of useBookSync.ts). */

import type { BookEntry } from "../api/client";
import type { SyncBooksResult } from "../sync/syncBooks";
import type { RenamedBook } from "../sync/renamedBooks";

/** What the personal shelf's sync notices report about the last successful sync (0 = no notice). */
export interface SyncNoticeCounts {
  /** Books moved to their new Readmoo id. */
  renamedBookCount: number;
  /** Books removed because Readmoo no longer holds them. */
  removedBookCount: number;
  /** How many of the removed books were shared. */
  removedSharedCount: number;
  /** Books new to the server marked shared by 新書預設開放. */
  autoSharedCount: number;
  /** New books 新書預設開放 left unshared because there were too many. */
  autoShareHeldCount: number;
  /** New books left out of the sync: a title, author or category over the server's cap, or the same
   *  title as such a book (`sync/fieldCaps.ts`). */
  fieldCapSkippedCount: number;
}

/** The last SUCCESSFUL sync, held as one value so its parts never mismatch. */
export interface LastSync extends SyncNoticeCounts {
  books: BookEntry[];
  renamedBooks: RenamedBook[];
  /** The `lastUpdated` this sync's own PUT stored; undefined when the PUT response carries none. */
  lastUpdated?: string;
}

export const NO_SYNC: LastSync = {
  books: [],
  renamedBooks: [],
  renamedBookCount: 0,
  removedBookCount: 0,
  removedSharedCount: 0,
  autoSharedCount: 0,
  autoShareHeldCount: 0,
  fieldCapSkippedCount: 0,
};

export function lastSyncOf(result: SyncBooksResult): LastSync {
  const renamedBooks = result.renamedBooks ?? [];
  return {
    books: result.books,
    renamedBooks,
    renamedBookCount: result.renamedBookCount ?? renamedBooks.length,
    removedBookCount:
      result.removedBookCount ?? result.removedBooks?.length ?? 0,
    removedSharedCount: result.removedSharedCount ?? 0,
    autoSharedCount: result.autoSharedCount ?? 0,
    autoShareHeldCount: result.autoShareHeldCount ?? 0,
    fieldCapSkippedCount: result.fieldCapSkippedCount ?? 0,
    lastUpdated: result.lastUpdated,
  };
}

/** The notice counts of `sync`, as their own object. */
export function syncNoticeCountsOf(sync: LastSync): SyncNoticeCounts {
  return {
    renamedBookCount: sync.renamedBookCount,
    removedBookCount: sync.removedBookCount,
    removedSharedCount: sync.removedSharedCount,
    autoSharedCount: sync.autoSharedCount,
    autoShareHeldCount: sync.autoShareHeldCount,
    fieldCapSkippedCount: sync.fieldCapSkippedCount,
  };
}
