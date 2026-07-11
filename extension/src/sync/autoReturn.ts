/**
 * Auto-detect returned books during a bookshelf sync.
 *
 * When a Readmoo book is lent out it disappears entirely from the owner's
 * library page; returning/recalling it makes it reappear. `mergeBooks` keeps
 * saved-only books, so a lent book is never removed from the share list — which
 * means a reappearance in a fresh scrape is a reliable "book is back" signal.
 * So if a book the current user owns and has an active LENT request for shows up
 * again in a scrape, mark that request RETURNED.
 *
 * SPA residue guard: a freshly-lent book can linger in the un-refreshed page DOM,
 * so LENT requests updated less than `minLentAgeMs` ago are skipped.
 */

import { ApiClient, BorrowRequest, BorrowStatus } from "../api/client";

const DEFAULT_MIN_LENT_AGE_MS = 30 * 60 * 1000;

/**
 * Pure detection: which LENT requests owned by `ownerId` correspond to a book
 * that has reappeared in the scrape (`scrapedBookIds`) and is old enough to
 * trust. Requests whose `updatedAt` fails to parse are skipped (conservative).
 */
export function detectReturnedRequests(
  requests: BorrowRequest[],
  scrapedBookIds: Set<string>,
  ownerId: string,
  now: number,
  minLentAgeMs: number = DEFAULT_MIN_LENT_AGE_MS,
): BorrowRequest[] {
  return requests.filter((request) => {
    if (request.ownerId !== ownerId) return false;
    if (request.status !== BorrowStatus.LENT) return false;
    if (!scrapedBookIds.has(request.bookId)) return false;
    const updatedAt = Date.parse(request.updatedAt);
    if (Number.isNaN(updatedAt)) return false;
    return now - updatedAt >= minLentAgeMs;
  });
}

/**
 * Side effect: mark each detected request RETURNED via the API, one by one
 * (no batch endpoint exists; the count is naturally tiny). A per-request failure
 * is logged and skipped. Returns the number of successful updates.
 */
export async function applyAutoReturns(
  apiClient: ApiClient,
  requests: BorrowRequest[],
): Promise<number> {
  let count = 0;
  for (const request of requests) {
    try {
      await apiClient.updateBorrowStatus(request.requestId, BorrowStatus.RETURNED);
      count++;
    } catch (err) {
      console.warn(
        `[autoReturn] Failed to mark request ${request.requestId} as RETURNED:`,
        err,
      );
    }
  }
  return count;
}
