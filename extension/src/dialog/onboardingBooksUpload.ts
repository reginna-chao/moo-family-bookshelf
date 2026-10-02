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
import { assertSyncNotPaused } from "../sync/syncBreaker";
import { holdBackRenameCandidates } from "../sync/syncSteps";
import { MAX_SYNC_UPLOAD_ATTEMPTS } from "../sync/syncUpload";

export interface OnboardingBooksUploadParams {
  apiClient: ApiClient;
  userId: string;
  scrapedBooks: ScrapedBook[];
}

/** GET the saved list; throws on a failed read or a redesign-shaped scrape (archive never scraped). */
async function readSavedForOnboarding(
  p: OnboardingBooksUploadParams,
  scrapedIds: ReadonlySet<string>,
): Promise<LoadSavedResult> {
  const saved = loadSavedBooksForSync(
    await p.apiClient.getPersonalBooks(p.userId),
  );
  assertSyncNotPaused(saved.books, scrapedIds, false);
  return saved;
}

/** The upload record for one read. Onboarding never resolves renames, so it holds back their candidates. */
function buildOnboardingRecord(
  p: OnboardingBooksUploadParams,
  scrapedIds: ReadonlySet<string>,
  saved: LoadSavedResult,
): PersonalBooks & { expectedLastUpdated?: string } {
  const merged = mergeBooks(p.scrapedBooks, saved.books);
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
 * record). A failed read throws.
 */
export async function uploadOnboardingBooks(
  p: OnboardingBooksUploadParams,
): Promise<ApiErrorPayload | null> {
  const scrapedIds = new Set(p.scrapedBooks.map((b) => b.bookId));
  let saved = await readSavedForOnboarding(p, scrapedIds);
  for (let attempt = 1; ; attempt += 1) {
    const response = await p.apiClient.updatePersonalBooks(
      p.userId,
      buildOnboardingRecord(p, scrapedIds, saved),
    );
    if (!response.error) return null;
    const retry =
      response.error.code === BOOKS_CONFLICT_CODE &&
      attempt < MAX_SYNC_UPLOAD_ATTEMPTS;
    if (!retry) return response.error;
    saved = await readSavedForOnboarding(p, scrapedIds);
    // No record on the re-read: a retry would carry no precondition and reset
    // every share flag, so report the conflict instead (as the sync does).
    if (saved.raw === null) return response.error;
  }
}
