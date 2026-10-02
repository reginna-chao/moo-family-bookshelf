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
import { mergeBooks } from "./mergeBooks";
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
  /** Fetched once per sync and reused by every attempt; null = fetch failed. */
  requests: BorrowRequest[] | null;
}

export interface SyncUploadResult {
  books: BookEntry[];
  renamedBooks: RenamedBook[];
  /** The stored record's `lastUpdated` the landed PUT answered; undefined when the PUT response carries no usable `lastUpdated`. */
  lastUpdated?: string;
}

interface SyncUpload extends Omit<SyncUploadResult, "lastUpdated"> {
  record: PersonalBooks & { expectedLastUpdated?: string };
}

/** GET the saved record; throws on a failed read or a redesign-shaped scrape. Writes nothing. */
export async function fetchSavedBooksForSync(
  ctx: Pick<
    SyncUploadContext,
    "apiClient" | "userId" | "scrape" | "scrapedIds"
  >,
): Promise<LoadSavedResult> {
  const response = await ctx.apiClient.getPersonalBooks(ctx.userId);
  const saved = loadSavedBooksForSync(response);
  assertSyncNotPaused(saved.books, ctx.scrapedIds, ctx.scrape.archiveCovered);
  return saved;
}

/** Merge, id-change resolution and the upload record for one read. Writes nothing. */
function buildSyncUpload(
  ctx: SyncUploadContext,
  saved: LoadSavedResult,
): SyncUpload {
  const merged = mergeBooks(ctx.scrape.books, saved.books);
  const { books, renamedBooks } = resolveForUpload(
    merged,
    ctx.scrape,
    saved.books,
    ctx.requests,
    ctx,
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
  return { record, books, renamedBooks };
}

/**
 * PUT the merged list, re-reading and rebuilding on `BOOKS_CONFLICT` up to `MAX_SYNC_UPLOAD_ATTEMPTS`
 * PUTs; any other error or a last-attempt conflict throws. Returns the attempt that landed,
 * with the stamp its PUT answered (the dialog's next precondition).
 */
export async function uploadSyncBooksRereadingOnConflict(
  ctx: SyncUploadContext,
  firstRead: LoadSavedResult,
): Promise<SyncUploadResult> {
  let saved = firstRead;
  for (let attempt = 1; ; attempt += 1) {
    const { record, books, renamedBooks } = buildSyncUpload(ctx, saved);
    const response = await ctx.apiClient.updatePersonalBooks(
      ctx.userId,
      record,
    );
    if (!response.error) {
      const lastUpdated = landedLastUpdatedOf(response.data);
      return { books, renamedBooks, lastUpdated };
    }
    const retry =
      response.error.code === BOOKS_CONFLICT_CODE &&
      attempt < MAX_SYNC_UPLOAD_ATTEMPTS;
    if (!retry) {
      throw new Error(
        booksSaveErrorText(response.error, SYNC_UPLOAD_FAILED_MESSAGE),
      );
    }
    saved = await fetchSavedBooksForSync(ctx);
  }
}
