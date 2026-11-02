/** Store-page chip index: which family members shared each book, built by the Extension Dialog and
 *  read on Readmoo store pages. See docs/architecture.md → 購買頁家人開放提示. */

import { isRealBookId } from "../api/bookId";

export interface StorePageIndex {
  version: 1;
  /** The user the index was built for; the store page shows nothing when it differs from the stored userId. */
  viewerUserId: string;
  /** ISO 8601 build time. */
  updatedAt: string;
  /** bookId → display names of the family members sharing it (deduplicated, sorted). */
  books: Record<string, string[]>;
}

export const STORE_INDEX_VERSION = 1;
/** Longer names are truncated when the index is built or parsed. */
export const MAX_STORE_INDEX_NAME_LENGTH = 50;
/** An index holding more books than this is rejected as a whole on parse. */
export const MAX_STORE_INDEX_BOOKS = 20000;
/** An index older than this no longer names anyone; the store page shows the stale hint instead. */
export const STORE_INDEX_MAX_AGE_DAYS = 30;
export const STORE_INDEX_MAX_AGE_MS =
  STORE_INDEX_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface StoreIndexMember {
  userId: string;
  displayName: string;
  books: readonly { bookId: string }[];
}

/** Trimmed and truncated by code point (never splitting a surrogate pair); `""` when blank. */
function cleanName(name: string): string {
  return Array.from(name.trim()).slice(0, MAX_STORE_INDEX_NAME_LENGTH).join("");
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

/**
 * Build the index from the family-shelf members the Dialog already holds.
 * Skips the viewer's own entry (their own books never get a chip) and every
 * book id that is not a real Readmoo id; a blank display name falls back to
 * the first 8 characters of the member's userId.
 */
export function buildStorePageIndex(
  members: readonly StoreIndexMember[],
  viewerUserId: string,
  now: Date,
): StorePageIndex {
  const names = new Map<string, string[]>();
  for (const member of members) {
    if (member.userId === viewerUserId) continue;
    const name = cleanName(member.displayName) || member.userId.slice(0, 8);
    if (!name) continue;
    for (const { bookId } of member.books) {
      if (!isRealBookId(bookId)) continue;
      const list = names.get(bookId) ?? [];
      list.push(name);
      names.set(bookId, list);
    }
  }
  const books = Object.fromEntries(
    [...names].map(([bookId, list]) => [bookId, sortedUnique(list)]),
  );
  return {
    version: STORE_INDEX_VERSION,
    viewerUserId,
    updatedAt: now.toISOString(),
    books,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The cleaned names, or `null` when `value` is not an array of strings. */
function parseNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const name = cleanName(item);
    if (name) cleaned.push(name);
  }
  return sortedUnique(cleaned);
}

function parseBooks(raw: unknown): Record<string, string[]> | null {
  if (!isPlainObject(raw)) return null;
  // Object.keys lists own keys only, so a "__proto__" key is seen (and refused) rather than inherited.
  const keys = Object.keys(raw);
  if (keys.length > MAX_STORE_INDEX_BOOKS) return null;
  const books: Record<string, string[]> = {};
  for (const key of keys) {
    if (!isRealBookId(key)) return null;
    const names = parseNames(raw[key]);
    if (names === null) return null;
    if (names.length > 0) books[key] = names;
  }
  return books;
}

/**
 * Validate a stored index read back from extension storage. Any malformed
 * field rejects the whole index (`null`), so the store page shows no chip.
 */
export function parseStorePageIndex(raw: unknown): StorePageIndex | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== STORE_INDEX_VERSION) return null;
  const { viewerUserId, updatedAt } = raw;
  if (typeof viewerUserId !== "string" || viewerUserId === "") return null;
  if (typeof updatedAt !== "string") return null;
  const books = parseBooks(raw.books);
  if (books === null) return null;
  return { version: STORE_INDEX_VERSION, viewerUserId, updatedAt, books };
}

/** Names of the members sharing `bookId`, or `[]` when nobody does. */
export function lookupStoreChipNames(
  index: StorePageIndex,
  bookId: string,
): string[] {
  if (!Object.hasOwn(index.books, bookId)) return [];
  return [...index.books[bookId]];
}

/** How far in the future `updatedAt` may lie (clock skew) and still count as fresh. */
export const STORE_INDEX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Whether the index is recent enough to name anyone: `updatedAt` parses, is at
 * most `STORE_INDEX_MAX_AGE_MS` before `now`, and at most
 * `STORE_INDEX_FUTURE_TOLERANCE_MS` after it. A future `updatedAt` within the
 * tolerance counts as fresh; beyond it (a clock that ran ahead when the index
 * was written) as stale, as does an unparsable one.
 */
export function isStoreIndexFresh(index: StorePageIndex, now: number): boolean {
  const builtAt = Date.parse(index.updatedAt);
  if (!Number.isFinite(builtAt)) return false;
  if (builtAt - now > STORE_INDEX_FUTURE_TOLERANCE_MS) return false;
  return now - builtAt <= STORE_INDEX_MAX_AGE_MS;
}

/** The chip's text, e.g. 「小明、小華 已開放這本書」. */
export function formatStoreChipText(names: readonly string[]): string {
  return `${names.join("、")} 已開放這本書`;
}

/** The stale hint shown in the chip's place once the index is older than `STORE_INDEX_MAX_AGE_DAYS`. */
export function formatStoreStaleText(): string {
  return `家人開放資料超過 ${STORE_INDEX_MAX_AGE_DAYS} 天沒更新，打開家庭書櫃就會更新`;
}
