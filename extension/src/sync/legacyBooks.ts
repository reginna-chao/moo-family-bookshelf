import { BookEntry, BoolFlag } from "../api/client";
import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";

// The real-book-id rule lives in `shared/` so the scraper, this cleanup and the Worker's PUT books
// boundary cannot drift; re-exported so existing `../sync/legacyBooks` importers keep working.
export {
  REAL_BOOK_ID_PATTERN,
  isRealBookId,
} from "moo-family-bookshelf-shared/api/bookId";

/**
 * True iff the entry is keyed by a short (non-book) id. Such entries were
 * uploaded by the `.privacy` fallback path before its 12-digit guard (#86):
 * on `next.readmoo.com` that attribute holds a 7–8 digit internal id, so the
 * entry never matches the real 15-digit id the current scraper writes, and the
 * saved-only rule of `mergeBooks` kept both copies (#234).
 */
export function isLegacyBookEntry(entry: BookEntry): boolean {
  return !isRealBookId(entry.bookId);
}

function titleKey(entry: BookEntry): string {
  return typeof entry.title === "string" ? entry.title.trim() : "";
}

/** Title → the single real entry carrying it; a title shared by 2+ real entries maps to `null`
 *  (ambiguous), and empty titles are not indexed. */
function indexRealByTitle(books: BookEntry[]): Map<string, BookEntry | null> {
  const index = new Map<string, BookEntry | null>();
  for (const entry of books) {
    const key = titleKey(entry);
    if (key === "" || isLegacyBookEntry(entry)) continue;
    index.set(key, index.has(key) ? null : entry);
  }
  return index;
}

/**
 * Remove each legacy (short-id, see `isLegacyBookEntry`) entry that resolves to
 * a real entry — exactly one real entry with the same trimmed, non-empty
 * title. A removed legacy entry that was shared moves its flag onto that real
 * entry (a new object; a TRUE flag is never cleared). Ids in `keepFlagsFor`
 * keep their flag — the user's pending toggle wins over an inherited share.
 *
 * Legacy entries with no same-title real entry, or with two or more, are kept
 * unchanged: until the scrape produces the book's real id, the legacy entry is
 * the only record of that book's share setting, so dropping it would silently
 * unshare the book. The next sync that produces the real id resolves it
 * through this same rule. Pruning books removed from Readmoo is #241.
 *
 * Order is preserved, the input is not mutated, and the same array is
 * returned when nothing is removed.
 */
export function dropResolvedLegacyBooks(
  books: BookEntry[],
  keepFlagsFor?: ReadonlySet<string>,
): BookEntry[] {
  const realByTitle = indexRealByTitle(books);
  const resolveTarget = (entry: BookEntry): BookEntry | null =>
    isLegacyBookEntry(entry)
      ? (realByTitle.get(titleKey(entry)) ?? null)
      : null;

  const promoted = new Set<BookEntry>();
  let removedAny = false;
  for (const entry of books) {
    const target = resolveTarget(entry);
    if (!target) continue;
    removedAny = true;
    if (entry.isShared !== BoolFlag.TRUE) continue;
    if (!keepFlagsFor?.has(target.bookId)) promoted.add(target);
  }
  if (!removedAny) return books;

  return books
    .filter((entry) => resolveTarget(entry) === null)
    .map((entry) =>
      promoted.has(entry) && entry.isShared !== BoolFlag.TRUE
        ? { ...entry, isShared: BoolFlag.TRUE }
        : entry,
    );
}
