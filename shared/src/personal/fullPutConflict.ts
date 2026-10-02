import { BoolFlag } from "../api/types";
import type { ApiErrorPayload, ApiResponse } from "../api/types";
import { BOOKS_CONFLICT_CODE } from "./saveErrors";
import type { ShareFlagEntry } from "./savedDirty";

/** PUTs per personal-shelf save: the first one plus two retries after a conflict. */
export const MAX_SAVE_PUT_ATTEMPTS = 3;

/** A stored personal-books record as read by GET; null = no record. */
export type PersonalBooksRaw = Record<string, unknown> | null;

/**
 * The `lastUpdated` a read returned, unchanged, to send back as the PUT's
 * `expectedLastUpdated`; undefined (no precondition) for no record or an
 * empty / non-string value.
 */
export function expectedLastUpdatedOf(
  raw: { lastUpdated?: unknown } | null | undefined,
): string | undefined {
  const value = raw?.lastUpdated;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The new `lastUpdated` a successful full PUT answered with: the Worker returns
 * `{ data: record }`. Undefined when `data` carries no usable `lastUpdated`
 * (a non-conforming self-hosted backend), so the caller keeps the stamp it holds.
 */
export function landedLastUpdatedOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  return expectedLastUpdatedOf(data as { lastUpdated?: unknown });
}

/**
 * `books` with each entry's `isShared` taken from the same bookId in `source`,
 * except ids in `keepIds` (and ids `source` lacks), which keep their own flag.
 * The book set and order of `books` never change. Returns `books` itself when
 * no flag differs. Pure.
 */
export function overlayShareFlags<T extends ShareFlagEntry>(
  books: T[],
  source: readonly ShareFlagEntry[],
  keepIds: ReadonlySet<string>,
): T[] {
  const flags = new Map<string, ShareFlagEntry["isShared"]>();
  for (const entry of source as readonly (ShareFlagEntry | null)[]) {
    if (typeof entry?.bookId === "string")
      flags.set(entry.bookId, entry.isShared);
  }
  let changed = false;
  const next = books.map((book) => {
    if (keepIds.has(book.bookId)) return book;
    const flag = flags.get(book.bookId);
    if (flag === undefined || flag === book.isShared) return book;
    changed = true;
    return { ...book, isShared: flag };
  });
  return changed ? next : books;
}

/** One full PUT: the record it builds on, the list it sends, its precondition. */
export interface FullPutAttempt<T> {
  raw: PersonalBooksRaw;
  books: T[];
  expectedLastUpdated: string | undefined;
}

/** A re-read record, parsed by the caller's own load rule. */
export interface FullPutRead<T> {
  books: T[];
  raw: PersonalBooksRaw;
}

export interface FullPutRebaseInput<T extends ShareFlagEntry> {
  /** The list the save sends. */
  books: T[];
  /**
   * The save's unsaved-toggle ids: their local flag survives a rebase. Any
   * other id a re-read lacks is sent not-shared.
   */
  dirtyBookIds: ReadonlySet<string>;
  /** The record the screen last read. */
  raw: PersonalBooksRaw;
  /** Send one attempt; the caller builds the PUT body from it. */
  put: (attempt: FullPutAttempt<T>) => Promise<ApiResponse<unknown>>;
  /** Re-read the stored record (GET). */
  get: () => Promise<ApiResponse<unknown>>;
  /** The caller's load-time parsing of a GET `data` value. */
  parse: (data: unknown) => FullPutRead<T>;
}

export type FullPutResult<T> =
  | {
      ok: true;
      /** The list the landed PUT sent. */
      books: T[];
      /** The record it was built on, carrying the newest known `lastUpdated`. */
      raw: PersonalBooksRaw;
    }
  | { ok: false; error: ApiErrorPayload };

/**
 * Full-PUT save that never writes back a flag another device changed after
 * this screen's read. Each PUT carries the read `lastUpdated`; on
 * `BOOKS_CONFLICT` the record is re-read and the list rebased onto it — the
 * local book set, the local flag for every `dirtyBookIds` id, the re-read flag
 * for every other book the server holds, and NOT-shared for every other book
 * the server no longer holds (removed after this screen's read, e.g. a Readmoo
 * id change, #236; never written back shared) — then sent again, at most
 * `MAX_SAVE_PUT_ATTEMPTS` PUTs. Any other error, a failed re-read, a re-read
 * that finds no record, or a conflict on the last attempt returns `ok: false`
 * (both re-read cases report the conflict): a retry built on no record would
 * carry no precondition and write the local flags unconditionally. A thrown
 * `put` / `get` propagates.
 */
export async function putBooksRebasingOnConflict<T extends ShareFlagEntry>(
  input: FullPutRebaseInput<T>,
): Promise<FullPutResult<T>> {
  let attempt: FullPutAttempt<T> = {
    raw: input.raw,
    books: input.books,
    expectedLastUpdated: expectedLastUpdatedOf(input.raw),
  };
  for (let n = 1; ; n += 1) {
    const response = await input.put(attempt);
    if (!response.error) {
      return {
        ok: true,
        books: attempt.books,
        raw: withLandedLastUpdated(attempt.raw, response.data),
      };
    }
    const retry =
      response.error.code === BOOKS_CONFLICT_CODE && n < MAX_SAVE_PUT_ATTEMPTS;
    if (!retry) return { ok: false, error: response.error };
    const reread = await input.get();
    if (reread.error) return { ok: false, error: response.error };
    const fresh = input.parse(reread.data);
    if (fresh.raw === null) return { ok: false, error: response.error };
    attempt = rebaseAttempt(input, fresh);
  }
}

function rebaseAttempt<T extends ShareFlagEntry>(
  input: FullPutRebaseInput<T>,
  fresh: FullPutRead<T>,
): FullPutAttempt<T> {
  const overlaid = overlayShareFlags(
    input.books,
    fresh.books,
    input.dirtyBookIds,
  );
  return {
    raw: fresh.raw,
    books: unshareRemovedBooks(overlaid, fresh.books, input.dirtyBookIds),
    expectedLastUpdated: expectedLastUpdatedOf(fresh.raw),
  };
}

// A non-dirty id the re-read lacks was removed elsewhere after this screen's
// read (#236 id change): never send it shared. Set and order stay unchanged.
function unshareRemovedBooks<T extends ShareFlagEntry>(
  books: T[],
  serverBooks: readonly ShareFlagEntry[],
  dirtyIds: ReadonlySet<string>,
): T[] {
  const serverIds = new Set<string>();
  for (const entry of serverBooks as readonly (ShareFlagEntry | null)[]) {
    if (typeof entry?.bookId === "string") serverIds.add(entry.bookId);
  }
  let changed = false;
  const next = books.map((book) => {
    if (book.isShared !== BoolFlag.TRUE) return book;
    if (dirtyIds.has(book.bookId) || serverIds.has(book.bookId)) return book;
    changed = true;
    return { ...book, isShared: BoolFlag.FALSE };
  });
  return changed ? next : books;
}

// A PUT response with no usable `lastUpdated` (a non-conforming self-hosted
// backend) keeps the stamp the attempt read.
function withLandedLastUpdated(
  raw: PersonalBooksRaw,
  data: unknown,
): PersonalBooksRaw {
  const stamp = landedLastUpdatedOf(data);
  return stamp === undefined ? raw : { ...raw, lastUpdated: stamp };
}
