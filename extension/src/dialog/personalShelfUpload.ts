import {
  ApiClient,
  BookEntry,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import type { ApiErrorPayload } from "moo-family-bookshelf-shared/api/types";
import {
  putBooksRebasingOnConflict,
  type FullPutRead,
  type PersonalBooksRaw,
} from "moo-family-bookshelf-shared/personal/fullPutConflict";
import {
  decideSaveStrategy,
  type PatchChange,
} from "moo-family-bookshelf-shared/personal/saveStrategy";
import { dropResolvedLegacyBooks } from "../sync/legacyBooks";
import { loadSavedBooks } from "../sync/savedBooks";

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

export interface PersonalShelfUploadParams {
  apiClient: ApiClient;
  userId: string;
  displayName: string;
  /** The list the save is computed from. */
  books: BookEntry[];
  /** The unsaved-toggle ids at send time. */
  dirtyBookIds: ReadonlySet<string>;
  /** The record the screen last read; null = no server record. */
  raw: PersonalBooksRaw;
}

export interface LandedSave {
  usePut: boolean;
  /** PUT: the list the landed PUT sent (rebased after a conflict). PATCH: `books`. */
  books: BookEntry[];
  /** PUT: every sent book's flag. PATCH: the `changes`. */
  sent: PatchChange[];
  /** PUT: the record the landed PUT built on, with the newest known `lastUpdated`. */
  raw: PersonalBooksRaw;
}

export type PersonalShelfUploadResult =
  { ok: true; landed: LandedSave } | { ok: false; error: ApiErrorPayload };

/** Re-read parsing: the dialog's own load rule, so a promoted twin keeps its inherited share. */
function parseSavedShelf(data: unknown): FullPutRead<BookEntry> {
  const saved = loadSavedBooks(data);
  return { books: dropResolvedLegacyBooks(saved.books), raw: saved.raw };
}

async function putShelf(
  p: PersonalShelfUploadParams,
): Promise<PersonalShelfUploadResult> {
  const result = await putBooksRebasingOnConflict({
    books: p.books,
    dirtyBookIds: p.dirtyBookIds,
    raw: p.raw,
    put: ({ raw, books, expectedLastUpdated }) =>
      p.apiClient.updatePersonalBooks(p.userId, {
        ...raw,
        schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
        userId: p.userId,
        displayName: p.displayName,
        books,
        lastUpdated: new Date().toISOString(),
        // Undefined is dropped by JSON.stringify, so no precondition is sent.
        expectedLastUpdated,
      }),
    get: () => p.apiClient.getPersonalBooks(p.userId),
    parse: parseSavedShelf,
  });
  if (!result.ok) return result;
  const sent = result.books.map((b) => ({
    bookId: b.bookId,
    isShared: b.isShared,
  }));
  return {
    ok: true,
    landed: { usePut: true, books: result.books, sent, raw: result.raw },
  };
}

/**
 * Upload one personal-shelf Save: a PATCH of the `decideSaveStrategy` diff, or
 * — when a partial update can't be safe — a full PUT that re-reads and rebases
 * on `BOOKS_CONFLICT` (`putBooksRebasingOnConflict`). Writes nothing locally;
 * a thrown request propagates.
 */
export async function uploadPersonalShelf(
  p: PersonalShelfUploadParams,
): Promise<PersonalShelfUploadResult> {
  const { usePut, patchChanges } = decideSaveStrategy({
    books: p.books,
    dirtyBookIds: p.dirtyBookIds,
    savedRawPayload: p.raw,
    maxPatchChanges: MAX_PATCH_CHANGES,
    includePromoted: true, // load-time legacy resolution can promote twins
  });
  if (usePut) return putShelf(p);
  const response = await p.apiClient.patchPersonalBooks(p.userId, patchChanges);
  if (response.error) return { ok: false, error: response.error };
  return {
    ok: true,
    landed: { usePut: false, books: p.books, sent: patchChanges, raw: p.raw },
  };
}
