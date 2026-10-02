import { BoolFlag, PERSONAL_BOOKS_SCHEMA_VERSION } from "@/api/client";
import type { ApiClient, BookEntry, PersonalBooks } from "@/api/client";
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

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

/** The shelf's book list out of a stored record, flags normalized to `BoolFlag`. */
export function normalizePersonalBooks(data: PersonalBooks): BookEntry[] {
  const rawBooks = Array.isArray(data.books) ? data.books : [];
  // Normalize: Extension may store boolean for isShared/isArchived, PWA uses BoolFlag
  return rawBooks.map((b) => ({
    ...b,
    isShared: b.isShared ? BoolFlag.TRUE : BoolFlag.FALSE,
    isArchived: b.isArchived ? BoolFlag.TRUE : BoolFlag.FALSE,
  }));
}

/** Re-read parsing for a save: the shelf's own load rule. */
function parsePersonalBooksRead(data: unknown): FullPutRead<BookEntry> {
  if (!data || typeof data !== "object") return { books: [], raw: null };
  const record = data as PersonalBooks;
  return { books: normalizePersonalBooks(record), raw: record };
}

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

export type LandedSave =
  | {
      usePut: true;
      /** The list the landed PUT sent (rebased after a conflict). */
      books: BookEntry[];
      /** The record it built on, with the newest known `lastUpdated`. */
      raw: PersonalBooksRaw;
    }
  | { usePut: false; books: BookEntry[]; patchChanges: PatchChange[] };

export type PersonalShelfUploadResult =
  { ok: true; landed: LandedSave } | { ok: false; error: ApiErrorPayload };

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
    parse: parsePersonalBooksRead,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    landed: { usePut: true, books: result.books, raw: result.raw },
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
  // No `includePromoted`: see its note in saveStrategy (PWA flags are normalized).
  const { usePut, patchChanges } = decideSaveStrategy({
    books: p.books,
    dirtyBookIds: p.dirtyBookIds,
    savedRawPayload: p.raw,
    maxPatchChanges: MAX_PATCH_CHANGES,
  });
  if (usePut) return putShelf(p);
  const response = await p.apiClient.patchPersonalBooks(p.userId, patchChanges);
  if (response.error) return { ok: false, error: response.error };
  return { ok: true, landed: { usePut: false, books: p.books, patchChanges } };
}
