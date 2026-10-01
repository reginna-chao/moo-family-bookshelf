/**
 * Steps of `syncBooks` (sync/syncBooks.ts) that write nothing: the scrape,
 * the borrow-list fetch and the id-change resolution of the merged list. Kept
 * apart so the orchestrator stays short.
 */

import browser from "webextension-polyfill";
import { ApiClient, BookEntry, BoolFlag, BorrowRequest } from "../api/client";
import { SYNC_ARCHIVED_KEY } from "../constants";
import {
  scrapeLibrary,
  scrapeArchivedBooks,
  type ScrapeProgressCallback,
  type ScrapeResult,
} from "../content/scraper";
import { combineScrapeResults } from "../content/scrapeResult";
import {
  lentBookIdsOf,
  resolveRenamedBooks,
  type RenameResult,
} from "./renamedBooks";

export interface SyncScrape extends ScrapeResult {
  /** The 同步封存書 setting this scrape ran with. */
  syncArchived: BoolFlag;
  /**
   * The archive was fully scraped this time (同步封存書 on AND the archive
   * scrape complete) — unlike `complete`, false whenever the archive was skipped.
   */
  archiveCovered: boolean;
}

async function readSyncArchived(): Promise<BoolFlag> {
  try {
    const result = await browser.storage.local.get([SYNC_ARCHIVED_KEY]);
    return (
      (result[SYNC_ARCHIVED_KEY] as BoolFlag | undefined) ?? BoolFlag.FALSE
    );
  } catch {
    // Archive setting unavailable — skip archive sync
    return BoolFlag.FALSE;
  }
}

/**
 * Scrape the library, plus the archive when 同步封存書 is on. The result is
 * complete only when both parts are (see `content/scrapeResult.ts`).
 */
export async function scrapeForSync(
  onProgress?: ScrapeProgressCallback,
): Promise<SyncScrape> {
  const library = await scrapeLibrary({ onProgress });
  const syncArchived = await readSyncArchived();
  const archive =
    syncArchived === BoolFlag.TRUE
      ? await scrapeArchivedBooks({ onProgress })
      : null;
  return {
    ...combineScrapeResults(library, archive),
    syncArchived,
    archiveCovered: archive?.complete === true,
  };
}

/**
 * The family's borrow list, fetched ONCE per sync — reused by the id-change
 * resolution (lent books are kept) and the post-upload auto-return. null when
 * the fetch fails: both consumers are then skipped.
 */
export async function fetchBorrowRequestsForSync(
  apiClient: ApiClient,
  familyId: string,
): Promise<BorrowRequest[] | null> {
  try {
    return await apiClient.listBorrowRequests(familyId);
  } catch (err) {
    console.warn(
      "[syncBooks] Borrow list unavailable; skipping id-change resolution and auto-return:",
      err,
    );
    return null;
  }
}

/**
 * Id-change resolution runs only on a COMPLETE scrape, and — with a family —
 * only when the borrow list was obtained (lent books must stay); otherwise the
 * merged list is uploaded as-is. Pure.
 */
export function resolveForUpload(
  merged: BookEntry[],
  scrape: SyncScrape,
  savedBooks: BookEntry[],
  requests: BorrowRequest[] | null,
  options: { familyId?: string; userId: string },
): RenameResult {
  const borrowKnown = !options.familyId || requests !== null;
  if (!scrape.complete || !borrowKnown) {
    return { books: merged, renamedBooks: [], renamedCount: 0 };
  }
  return resolveRenamedBooks(merged, {
    scrapedIds: new Set(scrape.books.map((b) => b.bookId)),
    serverIds: new Set(savedBooks.map((b) => b.bookId)),
    lentBookIds: lentBookIdsOf(requests ?? [], options.userId),
    syncArchived: scrape.syncArchived,
  });
}
