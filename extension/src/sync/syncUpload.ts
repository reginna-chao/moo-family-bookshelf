// Read → merge → upload half of `syncBooks`: a save landing between read and PUT
// gets 409 BOOKS_CONFLICT, and the sync redoes the read-dependent steps (#249).

import {
  ApiClient,
  BookEntry,
  BorrowRequest,
  PersonalBooks,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import {
  BOOKS_CONFLICT_CODE,
  booksSaveErrorText,
} from "moo-family-bookshelf-shared/personal/saveErrors";
// `safeText` keeps a read string byte-identical, so the read value goes back unchanged.
import {
  expectedLastUpdatedOf,
  landedLastUpdatedOf,
} from "moo-family-bookshelf-shared/personal/fullPutConflict";
import { autoShareContextFor, autoShareNewBooks } from "./autoShare";
import { fitScrapeToFieldCaps, warnFieldCapFit } from "./fieldCaps";
import { mergeBooks } from "./mergeBooks";
import type { RemovedBook } from "./pruneBooks";
import type { RenamedBook } from "./renamedBooks";
import { loadSavedBooksForSync, type LoadSavedResult } from "./savedBooks";
import { assertSyncNotPaused } from "./syncBreaker";
import { resolveForUpload, type SyncScrape } from "./syncSteps";

/** PUTs per sync: the first one plus two retries after a conflict. */
export const MAX_SYNC_UPLOAD_ATTEMPTS = 3;

const SYNC_UPLOAD_FAILED_MESSAGE = "同步書單失敗，請稍後再試";

export interface SyncUploadContext {
  apiClient: ApiClient;
  userId: string;
  familyId?: string;
  displayName: string;
  scrape: SyncScrape;
  scrapedIds: ReadonlySet<string>;
  /** Ids the server held before the scrape began; only bounds pruning (constant across re-reads, so a
   *  book another device adds meanwhile is never pruned). The upload basis is the post-scrape read. */
  preScrapeServerIds: ReadonlySet<string>;
  /** Fetched once per sync and reused by every attempt; null = fetch failed. */
  requests: BorrowRequest[] | null;
}

export interface SyncUploadResult {
  books: BookEntry[];
  renamedBooks: RenamedBook[];
  /** Saved books pruned because Readmoo no longer holds them (`sync/pruneBooks.ts`). */
  removedBooks: RemovedBook[];
  removedCount: number;
  removedSharedCount: number;
  /** Books new to the server marked shared by 新書預設開放, and new books left unshared because there
   *  were too many (`sync/autoShare.ts`). */
  autoSharedCount: number;
  autoShareHeldCount: number;
  /** New books left out because a field is over the server's cap, plus their same-title new twins (`sync/fieldCaps.ts`). */
  fieldCapSkippedCount: number;
  /** The stored record's `lastUpdated` the landed PUT answered; undefined when the PUT response carries no usable `lastUpdated`. */
  lastUpdated?: string;
}

interface SyncUpload extends Omit<SyncUploadResult, "lastUpdated"> {
  record: PersonalBooks & { expectedLastUpdated?: string };
}

/** GET the saved record; throws on a failed read. No breaker check. Writes nothing. */
export async function readSavedBooksForSync(
  ctx: Pick<SyncUploadContext, "apiClient" | "userId">,
): Promise<LoadSavedResult> {
  const response = await ctx.apiClient.getPersonalBooks(ctx.userId);
  return loadSavedBooksForSync(response);
}

/** GET the saved record; throws on a failed read or a redesign-shaped scrape. Writes nothing. */
export async function fetchSavedBooksForSync(
  ctx: Pick<
    SyncUploadContext,
    "apiClient" | "userId" | "scrape" | "scrapedIds"
  >,
): Promise<LoadSavedResult> {
  const saved = await readSavedBooksForSync(ctx);
  assertSyncNotPaused(saved.books, ctx.scrapedIds, ctx.scrape.archiveCovered);
  return saved;
}

/** Merge, id-change resolution, pruning, auto-share and the upload record for one read. Writes nothing. */
function buildSyncUpload(
  ctx: SyncUploadContext,
  saved: LoadSavedResult,
): SyncUpload {
  // Fitted per read (a 409 re-read changes `saved`). A left-out book is absent from `merged` (never
  // uploaded or auto-shared), but its title keeps same-title matches ambiguous and its old entry unpruned.
  const fit = fitScrapeToFieldCaps(ctx.scrape.books, saved.books);
  warnFieldCapFit(fit);
  const { skippedTitles } = fit;
  const merged = mergeBooks(fit.books, saved.books, undefined, skippedTitles);
  const plan = resolveForUpload(merged, ctx.scrape, saved.books, ctx.requests, {
    ...ctx,
    skippedTitles,
  });
  // Never earlier: id-change resolution only promotes TRUE, so a flag set before it would stick.
  const shareCtx = autoShareContextFor(
    saved,
    merged,
    plan.renamedBooks,
    ctx.scrapedIds,
  );
  const { books, autoSharedCount, autoShareHeldCount } = autoShareNewBooks(
    plan.books,
    shareCtx,
  );
  const record = {
    ...saved.raw,
    schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
    userId: ctx.userId,
    displayName: ctx.displayName,
    books,
    lastUpdated: new Date().toISOString(),
    // Undefined is dropped by JSON.stringify, so no precondition is sent.
    expectedLastUpdated: expectedLastUpdatedOf(saved.raw),
  };
  return {
    record,
    books,
    renamedBooks: plan.renamedBooks,
    removedBooks: plan.removedBooks,
    removedCount: plan.removedCount,
    removedSharedCount: plan.removedSharedCount,
    autoSharedCount,
    autoShareHeldCount,
    fieldCapSkippedCount: fit.skippedCount,
  };
}

/**
 * PUT the merged list, re-reading and rebuilding on `BOOKS_CONFLICT` up to `MAX_SYNC_UPLOAD_ATTEMPTS`
 * PUTs; any other error, a last-attempt conflict, or a re-read that finds no record
 * throws. Returns the attempt that landed, with the stamp its PUT answered (the
 * dialog's next precondition).
 */
export async function uploadSyncBooksRereadingOnConflict(
  ctx: SyncUploadContext,
  firstRead: LoadSavedResult,
): Promise<SyncUploadResult> {
  let saved = firstRead;
  for (let attempt = 1; ; attempt += 1) {
    const { record, ...result } = buildSyncUpload(ctx, saved);
    const response = await ctx.apiClient.updatePersonalBooks(
      ctx.userId,
      record,
    );
    if (!response.error) {
      const lastUpdated = landedLastUpdatedOf(response.data);
      return { ...result, lastUpdated };
    }
    const failure = booksSaveErrorText(
      response.error,
      SYNC_UPLOAD_FAILED_MESSAGE,
    );
    const retry =
      response.error.code === BOOKS_CONFLICT_CODE &&
      attempt < MAX_SYNC_UPLOAD_ATTEMPTS;
    if (!retry) throw new Error(failure);
    saved = await fetchSavedBooksForSync(ctx);
    // No record on the re-read: a retry would carry no precondition and reset
    // every share flag, so report the conflict instead (as fullPutConflict.ts).
    if (saved.raw === null) throw new Error(failure);
  }
}
