/**
 * Id-change resolution (#236): when Readmoo gives a book a new id, the additive
 * merge keeps the saved old id forever next to the scraped new one. This pure
 * step replaces such an OLD entry with its NEW twin — only when nothing else
 * can explain the old id's absence from a complete scrape.
 *
 * A saved book missing from a complete scrape may also be archived (while
 * archived books are not synced), lent out, or refunded / deleted. Those cases
 * are indistinguishable from each other and are always KEPT; only a
 * one-to-one same-title match against a brand-new id counts as a rename.
 *
 * Generalises `dropResolvedLegacyBooks` (short legacy ids, #234), which still
 * runs inside `mergeBooks`; this step runs after it, on the merged list.
 */

import {
  BookEntry,
  BoolFlag,
  BorrowRequest,
  BorrowStatus,
} from "../api/client";

export interface RenameContext {
  /** Every bookId of a COMPLETE scrape (library + archive when synced). */
  scrapedIds: ReadonlySet<string>;
  /** Every bookId the server held before this sync. */
  serverIds: ReadonlySet<string>;
  /** Book ids the user has lent out through the app (LENT, user is owner). */
  lentBookIds: ReadonlySet<string>;
  /** The 同步封存書 setting for this sync. */
  syncArchived: BoolFlag;
}

/** One saved book moved to its new Readmoo id. */
export interface RenamedBook {
  oldId: string;
  newId: string;
}

export interface RenameResult {
  books: BookEntry[];
  /** Every replacement made, in list order of the old entries. */
  renamedBooks: RenamedBook[];
  /** Always `renamedBooks.length`. */
  renamedCount: number;
}

/** Pure: book ids of LENT requests where `ownerId` is the lender. */
export function lentBookIdsOf(
  requests: readonly BorrowRequest[],
  ownerId: string,
): Set<string> {
  const lent = requests.filter(
    (r) => r.status === BorrowStatus.LENT && r.ownerId === ownerId,
  );
  return new Set(lent.map((r) => r.bookId));
}

function titleKey(entry: BookEntry): string {
  return typeof entry.title === "string" ? entry.title.trim() : "";
}

function countByTitle(books: readonly BookEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of books) {
    const key = titleKey(entry);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Saved-only, not lent, and not an archived book hidden by an unsynced archive. */
function isReplaceableOld(entry: BookEntry, ctx: RenameContext): boolean {
  if (ctx.scrapedIds.has(entry.bookId)) return false;
  if (!ctx.serverIds.has(entry.bookId)) return false;
  if (ctx.lentBookIds.has(entry.bookId)) return false;
  const archiveHidden =
    ctx.syncArchived !== BoolFlag.TRUE && entry.isArchived === BoolFlag.TRUE;
  return !archiveHidden;
}

/** The id sets that tell scraped, server-held and brand-new entries apart. */
export type IdContext = Pick<RenameContext, "scrapedIds" | "serverIds">;

function isBrandNew(entry: BookEntry, ctx: IdContext): boolean {
  return ctx.scrapedIds.has(entry.bookId) && !ctx.serverIds.has(entry.bookId);
}

export interface DeferResult {
  /** The list to upload — the input array itself when nothing is held back. */
  books: BookEntry[];
  /** How many brand-new entries were held back. */
  deferredCount: number;
}

/**
 * For a sync that cannot judge renames (incomplete scrape, or the family's
 * borrow list unavailable): hold back every brand-new entry whose trimmed,
 * non-empty title equals that of a saved-only server entry. Uploading it would
 * make it a server entry, and a server entry is never brand-new again — so a
 * real rename could never be resolved later and the duplicate would stay. A
 * later sync that can judge renames it or adds it. Order is preserved and the
 * input is not mutated.
 */
export function deferRenameCandidates(
  books: BookEntry[],
  ctx: IdContext,
): DeferResult {
  const savedOnlyTitles = new Set<string>();
  for (const entry of books) {
    const savedOnly =
      ctx.serverIds.has(entry.bookId) && !ctx.scrapedIds.has(entry.bookId);
    if (savedOnly && titleKey(entry) !== "")
      savedOnlyTitles.add(titleKey(entry));
  }
  const kept = books.filter(
    (entry) =>
      !(isBrandNew(entry, ctx) && savedOnlyTitles.has(titleKey(entry))),
  );
  const deferredCount = books.length - kept.length;
  return deferredCount === 0
    ? { books, deferredCount }
    : { books: kept, deferredCount };
}

/**
 * Old entry → its new twin. A title carried by anything other than exactly
 * this old entry plus one brand-new entry is skipped, and so is a target
 * claimed by two old entries (ambiguous).
 */
function pairRenamed(
  books: readonly BookEntry[],
  ctx: RenameContext,
): Map<BookEntry, BookEntry> {
  const titleCounts = countByTitle(books);
  const newByTitle = new Map<string, BookEntry>();
  for (const entry of books) {
    if (isBrandNew(entry, ctx)) newByTitle.set(titleKey(entry), entry);
  }
  const pairs = new Map<BookEntry, BookEntry>();
  const claims = new Map<BookEntry, number>();
  for (const entry of books) {
    const key = titleKey(entry);
    const target = newByTitle.get(key);
    if (!target || titleCounts.get(key) !== 2) continue;
    if (!isReplaceableOld(entry, ctx)) continue;
    pairs.set(entry, target);
    claims.set(target, (claims.get(target) ?? 0) + 1);
  }
  for (const [old, target] of pairs) {
    if (claims.get(target) !== 1) pairs.delete(old);
  }
  return pairs;
}

/**
 * Remove every old entry paired with a new twin; a shared old entry passes
 * `isShared: TRUE` to its twin (a new object — a TRUE flag is never cleared).
 * Order is preserved, the input is not mutated, and the same array is
 * returned when nothing is replaced.
 */
export function resolveRenamedBooks(
  books: BookEntry[],
  ctx: RenameContext,
): RenameResult {
  const pairs = pairRenamed(books, ctx);
  if (pairs.size === 0) return { books, renamedBooks: [], renamedCount: 0 };

  const promoted = new Set<BookEntry>();
  for (const [old, target] of pairs) {
    if (old.isShared === BoolFlag.TRUE) promoted.add(target);
  }
  const resolved = books
    .filter((entry) => !pairs.has(entry))
    .map((entry) =>
      promoted.has(entry) && entry.isShared !== BoolFlag.TRUE
        ? { ...entry, isShared: BoolFlag.TRUE }
        : entry,
    );
  const renamedBooks = [...pairs].map(([old, target]) => ({
    oldId: old.bookId,
    newId: target.bookId,
  }));
  return { books: resolved, renamedBooks, renamedCount: renamedBooks.length };
}
