/**
 * The minimum a family-shelf member must carry for pref-ref counting and
 * update tracking: who owns the books, and each book's id. Structural on
 * purpose — the Extension's and the PWA's `MemberBooks` (and the wire
 * `FamilyBookshelfMember`) all satisfy it without a cast.
 */
export interface FamilyShelfMemberBooks {
  userId: string;
  books: readonly { bookId: string }[];
}

/** Build a copy-scoped family-shelf preference ref: `{ownerId}:{bookId}`. */
export function familyPrefRef(ownerId: string, bookId: string): string {
  return `${ownerId}:${bookId}`;
}

/**
 * Count how many CURRENT shared cards are present in `refs`.
 *
 * Membership is checked against current cards only, so orphan refs (pointing
 * to a no-longer-existing owner/book) are naturally excluded from the count.
 */
export function countRefs(
  members: readonly FamilyShelfMemberBooks[],
  refs: ReadonlySet<string>,
): number {
  let count = 0;
  for (const member of members) {
    for (const book of member.books) {
      if (refs.has(familyPrefRef(member.userId, book.bookId))) {
        count += 1;
      }
    }
  }
  return count;
}

/** Count how many CURRENT shared cards are hidden. */
export function countHidden(
  members: readonly FamilyShelfMemberBooks[],
  hiddenRefs: ReadonlySet<string>,
): number {
  return countRefs(members, hiddenRefs);
}

/** Count how many CURRENT shared cards are favorited. */
export function countFavorites(
  members: readonly FamilyShelfMemberBooks[],
  favoriteRefs: ReadonlySet<string>,
): number {
  return countRefs(members, favoriteRefs);
}
