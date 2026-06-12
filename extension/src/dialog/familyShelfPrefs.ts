import type { MemberBooks } from "./FamilyDataContext";

/** Build a copy-scoped family-shelf preference ref: `{ownerId}:{bookId}`. */
export function familyPrefRef(ownerId: string, bookId: string): string {
  return `${ownerId}:${bookId}`;
}

/**
 * Count how many CURRENT shared cards are hidden.
 *
 * Membership is checked against current cards only, so orphan refs (pointing
 * to a no-longer-existing owner/book) are naturally excluded from the count.
 */
export function countHidden(
  members: MemberBooks[],
  hiddenRefs: Set<string>,
): number {
  let count = 0;
  for (const member of members) {
    for (const book of member.books) {
      if (hiddenRefs.has(familyPrefRef(member.userId, book.bookId))) {
        count += 1;
      }
    }
  }
  return count;
}
