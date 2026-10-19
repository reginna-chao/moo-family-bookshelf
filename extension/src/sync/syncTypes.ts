/** Options and result of `syncBooks` (sync/syncBooks.ts), which re-exports both. */

import type { ApiClient, BookEntry } from "../api/client";
import type { ScrapeProgressCallback } from "../content/scraper";
import type { RemovedBook } from "./pruneBooks";
import type { RenamedBook } from "./renamedBooks";

export interface SyncBooksOptions {
  /** Navigate to #/library before scraping (and restore hash after) */
  navigate: boolean;
  /** The userId for API calls */
  userId: string;
  /** API client instance */
  apiClient: ApiClient;
  /** Optional progress callback for the paginated scrape (Wave G) */
  onProgress?: ScrapeProgressCallback;
  /** When present, the borrow list is fetched once before upload: lent books are shielded from
   *  id-change resolution, and reappeared books get their LENT requests marked RETURNED after it. */
  familyId?: string;
}

export interface SyncBooksResult {
  success: boolean;
  books: BookEntry[];
  error?: string;
  /** RequestIds of LENT requests auto-marked RETURNED this sync (best-effort); callers derive the
   *  count via `.length` and apply the local status change. */
  autoReturnedRequestIds?: string[];
  /** Saved books replaced by their new Readmoo id this sync (`sync/renamedBooks.ts`). */
  renamedBooks?: RenamedBook[];
  /** Always `renamedBooks.length` on success. */
  renamedBookCount?: number;
  /** Saved books pruned because Readmoo no longer holds them (`sync/pruneBooks.ts`). */
  removedBooks?: RemovedBook[];
  /** On success: `removedBooks.length`, and how many of those were shared. */
  removedBookCount?: number;
  removedSharedCount?: number;
  /** On success: books marked shared by 新書預設開放, and new books it left unshared because there
   *  were too many (`sync/autoShare.ts`). */
  autoSharedCount?: number;
  autoShareHeldCount?: number;
  /** On success: new books left out because a field is over the server's cap, plus new books held back
   *  for sharing a title with one of them (`sync/fieldCaps.ts`). */
  fieldCapSkippedCount?: number;
  /** The `lastUpdated` this sync's own landed PUT stored (`SyncUploadResult`). */
  lastUpdated?: string;
}
