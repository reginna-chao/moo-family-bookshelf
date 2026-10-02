import type { BoolFlag } from "../api/types";

/** The fields `savedDirtyIds` reads off a personal-shelf book entry. */
export interface ShareFlagEntry {
  bookId: string;
  isShared: BoolFlag;
}

/**
 * The send-time unsaved ids that a successful save has really saved — the ids
 * the caller may now clear from its unsaved set. A share toggle made while the
 * request was in flight must stay unsaved: the server holds the flag that was
 * sent, not the one on screen.
 *
 * `sentBooks` is the list the save was computed from, `latestBooks` the list on
 * screen when the save succeeds, `sentDirtyIds` the unsaved set at send time.
 * Per id in `sentDirtyIds`:
 *  - absent from `latestBooks` → saved (nothing on screen is left unsaved; a
 *    sync that moved the book to a new id already carries the mark to that id)
 *  - in both lists with the same `isShared` → saved
 *  - in both lists with a different `isShared` → stays unsaved
 *  - absent from `sentBooks` but on screen → stays unsaved (no flag for it was
 *    computed from `sentBooks`, so nothing confirms the server holds it)
 *
 * Ids outside `sentDirtyIds` (marked unsaved after the send) are never
 * returned, so they stay unsaved too. Pure.
 */
export function savedDirtyIds(
  sentBooks: readonly ShareFlagEntry[],
  latestBooks: readonly ShareFlagEntry[],
  sentDirtyIds: ReadonlySet<string>,
): string[] {
  const sentFlags = new Map(sentBooks.map((b) => [b.bookId, b.isShared]));
  const latestFlags = new Map(latestBooks.map((b) => [b.bookId, b.isShared]));
  return [...sentDirtyIds].filter((id) => {
    const latest = latestFlags.get(id);
    if (latest === undefined) return true;
    const sent = sentFlags.get(id);
    return sent !== undefined && latest === sent;
  });
}
