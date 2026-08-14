/**
 * Local-vs-server reconciliation for the public-shelf editable fields.
 *
 * The dialog writes title / expiry through debounced, fire-and-forget requests,
 * so a rejected write (429 above all) leaves the input showing a value the
 * server never stored. This module is the single definition of "diverged",
 * shared by the Extension and the PWA so the rule cannot drift between them.
 *
 * Parameter types are structural on purpose: neither app's `PublicShelf` type is
 * imported here, so `shared/` keeps no dependency on either consumer.
 */

/** The server-confirmed values a local edit is compared against. */
export interface PublicShelfSnapshot {
  title: string;
  expiresDays: number | null;
}

/** Body of `PUT /api/user/:id/public-shelf/:shelfId`. */
export interface PublicShelfUpdate {
  title?: string;
  expiresDays?: number | null;
}

/**
 * Fields whose local value has not reached the server.
 *
 * Only divergent fields belong in the payload: the API recomputes `expiresAt`
 * whenever `expiresDays` is present, so echoing an unchanged value back would
 * silently extend the shelf's lifetime. The title is compared trimmed because
 * the server stores it trimmed — otherwise a trailing space would read as
 * permanently unsaved.
 */
export function divergentFields(
  shelf: PublicShelfSnapshot,
  title: string,
  expiresDays: number | null,
): PublicShelfUpdate {
  const body: PublicShelfUpdate = {};
  if (title.trim() !== shelf.title) body.title = title;
  if (expiresDays !== shelf.expiresDays) body.expiresDays = expiresDays;
  return body;
}

/** True when at least one field is waiting to be pushed to the server. */
export function hasDivergentFields(
  shelf: PublicShelfSnapshot | null,
  title: string,
  expiresDays: number | null,
): boolean {
  if (!shelf) return false;
  return Object.keys(divergentFields(shelf, title, expiresDays)).length > 0;
}

/**
 * Title the input should show once a write is confirmed.
 *
 * The server strips characters `trim()` does not (zero-width, control), so a
 * confirmed write can echo back a title the input never held — adopting it is
 * what stops the "unsaved" notice from sticking forever on a value the user can
 * never reproduce. Left untouched when the user has typed since (`current !==
 * sent`), so a landing response cannot clobber a field being edited, and when
 * the write carried no title at all (`sent === undefined`).
 */
export function reconcileTitle(
  current: string,
  sent: string | undefined,
  stored: string,
): string {
  if (sent === undefined || current !== sent) return current;
  return stored;
}
