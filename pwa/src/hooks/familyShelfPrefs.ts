import type { MemberBooks } from "./useFamilyData";

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
  members: MemberBooks[],
  refs: Set<string>,
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
  members: MemberBooks[],
  hiddenRefs: Set<string>,
): number {
  return countRefs(members, hiddenRefs);
}

/** Count how many CURRENT shared cards are favorited. */
export function countFavorites(
  members: MemberBooks[],
  favoriteRefs: Set<string>,
): number {
  return countRefs(members, favoriteRefs);
}
