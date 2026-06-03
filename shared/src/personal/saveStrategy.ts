/**
 * Decide whether a personal-shelf save should go out as a partial PATCH
 * (diff of the dirty books) or a full PUT.
 *
 * Shared by the Extension and PWA save flows so the (regression-prone)
 * decision stays identical on both sides. Pure function, no side effects.
 *
 * Falls back to PUT when the diff cannot be safely expressed as a PATCH:
 *  - no server record yet (`savedRawPayload === null`) → PATCH would 404
 *  - a dirty book is not on the server (a new, un-synced scraped book) →
 *    PATCH silently drops unknown bookIds, so the change would be lost
 *  - the dirty set exceeds the backend's `changes` cap
 */
export interface SaveStrategyInput<T extends { bookId: string }> {
  books: T[];
  dirtyBookIds: ReadonlySet<string>;
  /** Server payload captured at load (its `books` is the server-known set); null = no server record. */
  savedRawPayload: { books?: unknown } | null;
  /** Backend cap on PATCH `changes` length; over this → PUT. */
  maxPatchChanges: number;
}

export interface SaveStrategy<T> {
  /** true → full PUT; false → PATCH the dirtyBooks diff. */
  usePut: boolean;
  /** The dirty subset of `books` (the PATCH changes source). */
  dirtyBooks: T[];
}

export function decideSaveStrategy<T extends { bookId: string }>(
  input: SaveStrategyInput<T>,
): SaveStrategy<T> {
  const { books, dirtyBookIds, savedRawPayload, maxPatchChanges } = input;
  const dirtyBooks = books.filter((b) => dirtyBookIds.has(b.bookId));
  const rawServerBooks = savedRawPayload?.books;
  const serverKnownIds = new Set(
    (Array.isArray(rawServerBooks) ? (rawServerBooks as Array<{ bookId: string }>) : []).map(
      (b) => b.bookId,
    ),
  );
  const usePut =
    savedRawPayload === null ||
    dirtyBookIds.size > maxPatchChanges ||
    dirtyBooks.some((b) => !serverKnownIds.has(b.bookId));
  return { usePut, dirtyBooks };
}
