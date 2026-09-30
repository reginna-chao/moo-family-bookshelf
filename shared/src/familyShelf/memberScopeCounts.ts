import { familyPrefRef, type FamilyShelfMemberBooks } from "./prefRefs";

/**
 * How many books each member-filter scope will show once picked — before any
 * category / search narrowing. Hidden books are EXCLUDED, matching the family
 * shelf's own view filter (a card is hidden iff
 * `hiddenRefs.has(familyPrefRef(ownerId, bookId))`).
 */
export interface MemberScopeCounts {
  /** Visible cards across every member (the "all" scope). */
  all: number;
  /** Visible cards across every member except the viewer ("all-except-self"). */
  allExceptSelf: number;
  /** Visible cards per member userId (viewer included); a missing id means 0. */
  byMember: ReadonlyMap<string, number>;
}

/** Count one member's cards that are not hidden. */
function countVisibleCards(
  member: FamilyShelfMemberBooks,
  hiddenRefs: ReadonlySet<string>,
): number {
  let visible = 0;
  for (const book of member.books) {
    if (!hiddenRefs.has(familyPrefRef(member.userId, book.bookId))) {
      visible += 1;
    }
  }
  return visible;
}

/**
 * Compute the visible-book count of every member-filter scope in one pass
 * over the members. Shared by the Extension and PWA member dropdowns so the
 * number on the trigger and in the menu cannot drift between the two.
 */
export function countVisibleByMemberScope(
  members: readonly FamilyShelfMemberBooks[],
  viewerId: string,
  hiddenRefs: ReadonlySet<string>,
): MemberScopeCounts {
  const byMember = new Map<string, number>();
  let all = 0;
  let allExceptSelf = 0;
  for (const member of members) {
    const visible = countVisibleCards(member, hiddenRefs);
    byMember.set(member.userId, (byMember.get(member.userId) ?? 0) + visible);
    all += visible;
    if (member.userId !== viewerId) {
      allExceptSelf += visible;
    }
  }
  return { all, allExceptSelf, byMember };
}
