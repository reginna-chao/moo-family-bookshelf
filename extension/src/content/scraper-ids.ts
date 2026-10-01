/**
 * Book-id sources for one `.library-item` card, tried in order by the scraper:
 * the fiber bridge's `data-moo-book-id`, the reader-link href, then the
 * `.privacy` element. Every source must yield a real Readmoo book id
 * (`isRealBookId`, 12+ digits) — an id from any other namespace would upload a
 * ghost entry that never matches the book again.
 */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";
import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";
import { warnOnce } from "./readmoo-dom";

const ATTR_BOOK_ID = "data-moo-book-id";

/**
 * What one id source found:
 * - `string` — a real book id; use it.
 * - `undefined` — this source holds no id; try the next source.
 * - `null` — this source holds an id that is not a real book id; skip the
 *   book (it reappears on a later sync once a real id is available).
 */
export type BookIdLookup = string | null | undefined;

function acceptRealId(
  raw: string | null,
  label: string,
  source: string,
): BookIdLookup {
  if (!raw) return undefined;
  if (isRealBookId(raw)) return raw;
  warnOnce(
    label,
    `[moo] rejected ${source} bookId "${raw}" — not a 12+ digit book id; skipping this book`,
  );
  return null;
}

/** Book id stamped on the card by the fiber bridge (`data-moo-book-id`). */
export function bookIdFromFiber(item: Element): BookIdLookup {
  return acceptRealId(
    item.getAttribute(ATTR_BOOK_ID),
    "scraper:fiber-id-rejected",
    "fiber data-moo-book-id",
  );
}

/** Last path segment of `href`, or null when it is not a parseable URL. */
function lastPathSegment(href: string): string | null {
  try {
    const segments = new URL(href).pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Book id from the `a.reader-link` href (last path segment). The link lives
 * under `.cover` on the new host and under `.openbook` on the legacy one; the
 * href format is identical on both.
 */
export function bookIdFromHref(href: string): BookIdLookup {
  return acceptRealId(
    lastPathSegment(href),
    "scraper:href-id-rejected",
    "reader-link href",
  );
}

/**
 * Last-resort book id from a `.privacy` element (`id="privacy-{id}"`); null
 * when there is none or it is rejected.
 *
 * LENGTH GUARD — the two sites put DIFFERENT ids in this attribute:
 *   - legacy `read.readmoo.com`: the 15-digit book id itself, so the fallback
 *     yields a usable id and this guard never rejects anything.
 *   - new `next.readmoo.com`: an 8-digit INTERNAL id from a different
 *     namespace. Accepting it would upload a book keyed by an id that matches
 *     no real book — a ghost entry in the user's shelf that never resolves.
 */
export function bookIdFromPrivacy(item: Element): string | null {
  const privacy = item.querySelector<HTMLElement>(READMOO_SELECTORS.privacyId);
  if (!privacy) return null;
  const match = privacy.id.match(/^privacy-(\d+)$/);
  if (match && isRealBookId(match[1])) return match[1];

  warnOnce(
    "scraper:privacy-id-rejected",
    `[moo] rejected .privacy fallback bookId "${privacy.id}" — not a 12+ digit book id; skipping this book`,
  );
  return null;
}
