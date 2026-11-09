// Onboarding's first sync: read → merge → full PUT, with the read `lastUpdated` as
// the precondition; on BOOKS_CONFLICT it re-reads and rebuilds, like the sync (#259).

import {
  ApiClient,
  PersonalBooks,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import type { ScrapedBook } from "../content/scraper";
import type { ApiErrorPayload } from "moo-family-bookshelf-shared/api/types";
import { BOOKS_CONFLICT_CODE } from "moo-family-bookshelf-shared/personal/saveErrors";
import { expectedLastUpdatedOf } from "moo-family-bookshelf-shared/personal/fullPutConflict";
import { mergeBooks } from "./mergeBooks";
import {
  loadSavedBooksForSync,
  type LoadSavedResult,
} from "../sync/savedBooks";
import { fitScrapeToFieldCaps, warnFieldCapFit } from "../sync/fieldCaps";
import { assertSyncNotPaused } from "../sync/syncBreaker";
import { holdBackRenameCandidates } from "../sync/syncSteps";
import { MAX_SYNC_UPLOAD_ATTEMPTS } from "../sync/syncUpload";
import { pinSyncApi, type SyncApi } from "../sync/pinnedSyncApi";

export interface OnboardingBooksUploadParams {
  apiClient: ApiClient;
  userId: string;
  scrapedBooks: ScrapedBook[];
}

/** GET the saved list; throws on a failed read or a redesign-shaped scrape (archive never scraped). */
async function readSavedForOnboarding(
  api: Pick<SyncApi, "getPersonalBooks">,
  userId: string,
  scrapedIds: ReadonlySet<string>,
): Promise<LoadSavedResult> {
  const saved = loadSavedBooksForSync(await api.getPersonalBooks(userId));
  assertSyncNotPaused(saved.books, scrapedIds, false);
  return saved;
}

/** The upload record for one read. Onboarding never resolves renames, so it holds back their candidates. */
function buildOnboardingRecord(
  p: OnboardingBooksUploadParams,
  scrapedIds: ReadonlySet<string>,
  saved: LoadSavedResult,
): PersonalBooks & { expectedLastUpdated?: string } {
  // Fitted per read, like the sync (`sync/fieldCaps.ts`); `scrapedIds` stays the full scrape. Holding
  // back needs no `skippedTitles`: it only drops brand-new entries, never a saved one.
  const fit = fitScrapeToFieldCaps(p.scrapedBooks, saved.books);
  warnFieldCapFit(fit);
  const merged = mergeBooks(
    fit.books,
    saved.books,
    undefined,
    fit.skippedTitles,
  );
  return {
    schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
    userId: p.userId,
    displayName: "",
    books: holdBackRenameCandidates(merged, scrapedIds, saved.books).books,
    lastUpdated: new Date().toISOString(),
    // Undefined is dropped by JSON.stringify, so no precondition is sent.
    expectedLastUpdated: expectedLastUpdatedOf(saved.raw),
  };
}

/**
 * Upload the onboarding scrape over the saved list, re-reading and rebuilding
 * on `BOOKS_CONFLICT` up to `MAX_SYNC_UPLOAD_ATTEMPTS` PUTs. Returns null once
 * a PUT lands, else the last upload error (also when a re-read finds no
 * record). Once the client's endpoint differs from the one at entry, the next
 * call rejects with `SyncServerChangedError` without being sent. A failed read
 * and this rejection both throw.
 */
export async function uploadOnboardingBooks(
  p: OnboardingBooksUploadParams,
): Promise<ApiErrorPayload | null> {
  // Pinned before any await (#471): a family teardown during the read resets the
  // client's endpoint, and the PUT must not carry the book list to that server.
  const api = pinSyncApi(p.apiClient);
  const scrapedIds = new Set(p.scrapedBooks.map((b) => b.bookId));
  let saved = await readSavedForOnboarding(api, p.userId, scrapedIds);
  for (let attempt = 1; ; attempt += 1) {
    const response = await api.updatePersonalBooks(
      p.userId,
      buildOnboardingRecord(p, scrapedIds, saved),
    );
    if (!response.error) return null;
    const retry =
      response.error.code === BOOKS_CONFLICT_CODE &&
      attempt < MAX_SYNC_UPLOAD_ATTEMPTS;
    if (!retry) return response.error;
    saved = await readSavedForOnboarding(api, p.userId, scrapedIds);
    // No record on the re-read: a retry would carry no precondition and reset
    // every share flag, so report the conflict instead (as the sync does).
    if (saved.raw === null) return response.error;
  }
}
