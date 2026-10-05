/** The last SUCCESSFUL book sync as useBookSync holds it (moved out of useBookSync.ts). */

import type { BookEntry } from "../api/client";
import type { SyncBooksResult } from "../sync/syncBooks";
import type { RenamedBook } from "../sync/renamedBooks";

/** The last SUCCESSFUL sync, held as one value so its parts never mismatch. */
export interface LastSync {
  books: BookEntry[];
  renamedBooks: RenamedBook[];
  renamedBookCount: number;
  /** The `lastUpdated` this sync's own PUT stored; undefined when the PUT response carries none. */
  lastUpdated?: string;
}

export const NO_SYNC: LastSync = {
  books: [],
  renamedBooks: [],
  renamedBookCount: 0,
};

export function lastSyncOf(result: SyncBooksResult): LastSync {
  const renamedBooks = result.renamedBooks ?? [];
  return {
    books: result.books,
    renamedBooks,
    renamedBookCount: result.renamedBookCount ?? renamedBooks.length,
    lastUpdated: result.lastUpdated,
  };
}
