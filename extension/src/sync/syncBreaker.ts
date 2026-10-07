/** Sync circuit breaker: refuse to upload a scrape that looks like a Readmoo redesign rather than the
 *  user's library, on every scrape-upload path. See docs/architecture.md → 書單同步. */

import { BoolFlag, type BookEntry } from "../api/client";
import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";

/** The breaker only engages once the server holds at least this many real-id books. */
export const SYNC_BREAKER_MIN_SERVER_BOOKS = 50;

/** Pause when fewer than this share of the server's real-id books were scraped again. */
export const SYNC_BREAKER_MIN_OVERLAP_RATIO = 0.5;

/** Shown to the user when a sync is paused by the breaker. */
export const SYNC_PAUSED_MESSAGE = "讀墨可能改版了，已暫停同步書櫃";

export interface SyncBreakerVerdict {
  paused: boolean;
  /** Server entries whose bookId is a real Readmoo book id — archived ones excluded when the scrape
   *  did not cover the archive. */
  serverValid: number;
  /** How many of those the scrape found again. */
  overlap: number;
}

/**
 * Pure: decide whether this scrape may be uploaded over `serverBooks`.
 * `archiveCovered` = this scrape covered the archive (同步封存書 on AND the
 * archive scrape complete). When it did not, saved archived books cannot be in
 * `scrapedIds`, so they are left out of both counts instead of reading as lost.
 */
export function evaluateSyncBreaker(
  serverBooks: readonly BookEntry[],
  scrapedIds: ReadonlySet<string>,
  archiveCovered: boolean,
): SyncBreakerVerdict {
  const valid = serverBooks.filter(
    (b) =>
      isRealBookId(b.bookId) &&
      (archiveCovered || b.isArchived !== BoolFlag.TRUE),
  );
  const overlap = valid.filter((b) => scrapedIds.has(b.bookId)).length;
  const serverValid = valid.length;
  const paused =
    serverValid >= SYNC_BREAKER_MIN_SERVER_BOOKS &&
    overlap / serverValid < SYNC_BREAKER_MIN_OVERLAP_RATIO;
  return { paused, serverValid, overlap };
}

/**
 * Throw `SYNC_PAUSED_MESSAGE` (after a counts-only console warning) when the
 * breaker pauses this sync. Both upload paths surface a thrown error's message
 * as their sync error, before any upload or `LAST_SYNC_AT_KEY` write.
 */
export function assertSyncNotPaused(
  serverBooks: readonly BookEntry[],
  scrapedIds: ReadonlySet<string>,
  archiveCovered: boolean,
): void {
  const { paused, serverValid, overlap } = evaluateSyncBreaker(
    serverBooks,
    scrapedIds,
    archiveCovered,
  );
  if (!paused) return;
  console.warn(
    "[moo] sync paused: most saved books were not found in this scrape",
    { serverValid, overlap },
  );
  throw new Error(SYNC_PAUSED_MESSAGE);
}
