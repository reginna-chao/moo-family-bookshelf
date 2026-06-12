import { useMemo } from "react";
import { BoolFlag } from "../api/client";
import type { BookWithMember } from "./BookCard";
import type { MemberBooks } from "./FamilyDataContext";
import { countHidden } from "./familyShelfPrefs";
import type { MemberFilterValue } from "./MemberDropdown";

interface BookOwnership {
  ownerId: string;
}

export type FamilyShelfBook = BookWithMember & BookOwnership;

function toBookWithMember(
  member: MemberBooks,
  updatedBookIds: Set<string>,
): FamilyShelfBook[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({
    ...b,
    memberName: name,
    ownerId: member.userId,
    isUpdated: updatedBookIds.has(b.bookId) ? BoolFlag.TRUE : BoolFlag.FALSE,
  }));
}

function selectMembers(
  members: MemberBooks[],
  filterMember: MemberFilterValue,
  userId: string,
): MemberBooks[] {
  if (filterMember === "all") {
    return members;
  }
  if (filterMember === "all-except-self") {
    return members.filter((m) => m.userId !== userId);
  }
  return members.filter((m) => m.userId === filterMember);
}

export interface UseFamilyShelfBooksParams {
  members: MemberBooks[];
  filterMember: MemberFilterValue;
  userId: string;
  updatedBookIds: Set<string>;
  hiddenRefs: Set<string>;
  isHidden: (ownerId: string, bookId: string) => boolean;
  showHidden: boolean;
}

export interface UseFamilyShelfBooksResult {
  /** Books after member-filter and hidden-view filter (pre category/search). */
  memberFilteredBooks: FamilyShelfBook[];
  /** Total shared cards across all members (filter-independent). */
  totalBooks: number;
  /** Count of currently-hidden shared cards (orphan refs excluded). */
  hiddenCount: number;
  /** totalBooks - hiddenCount. */
  visibleCount: number;
  /** Localized heading suffix, e.g. "(可見 3 本，隱藏 1 本)". */
  headingCount: string;
}

/**
 * Family-shelf heading counts + the member/hidden filter pipeline stage.
 *
 * The hidden-view filter is applied FIRST, before category/search/sort/
 * load-more downstream. Counts are member/search-filter-independent.
 */
export function useFamilyShelfBooks({
  members,
  filterMember,
  userId,
  updatedBookIds,
  hiddenRefs,
  isHidden,
  showHidden,
}: UseFamilyShelfBooksParams): UseFamilyShelfBooksResult {
  const totalBooks = members.reduce((sum, m) => sum + m.books.length, 0);

  const hiddenCount = useMemo(
    () => countHidden(members, hiddenRefs),
    [members, hiddenRefs],
  );
  const visibleCount = totalBooks - hiddenCount;

  const memberFilteredBooks = useMemo(() => {
    const selected = selectMembers(members, filterMember, userId);
    const all = selected.flatMap((m) => toBookWithMember(m, updatedBookIds));
    // Hidden-filter is applied FIRST, before category/search/sort/load-more.
    return all.filter((b) => {
      const hidden = isHidden(b.ownerId, b.bookId);
      return showHidden ? hidden : !hidden;
    });
  }, [members, filterMember, userId, updatedBookIds, isHidden, showHidden]);

  const headingCount =
    hiddenCount > 0
      ? `(可見 ${visibleCount} 本，隱藏 ${hiddenCount} 本)`
      : `(可見 ${visibleCount} 本)`;

  return {
    memberFilteredBooks,
    totalBooks,
    hiddenCount,
    visibleCount,
    headingCount,
  };
}
