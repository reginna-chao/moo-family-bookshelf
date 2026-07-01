import { useMemo } from "react";
import { BoolFlag } from "@/api/client";
import type { BookEntry } from "@/api/client";
import { MemberBooks } from "@/hooks/useFamilyData";
import { countHidden, countFavorites } from "@/hooks/familyShelfPrefs";

export interface BookWithMember extends BookEntry {
  memberName: string;
  ownerId: string;
  isUpdated: BoolFlag;
}

/** Sentinel filter value for the cross-everyone hidden-books view. */
export const HIDDEN_FILTER_VALUE = "__hidden__";

/** Sentinel filter value for the cross-everyone favorites view. */
export const FAVORITE_FILTER_VALUE = "__favorite__";

export type MemberFilterValue = "all" | "all-except-self" | string;

function toBookWithMember(
  member: MemberBooks,
  updatedBookIds: Set<string>,
): BookWithMember[] {
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
  // Hidden / favorite views span all members, ignoring member scoping.
  if (
    filterMember === "all" ||
    filterMember === HIDDEN_FILTER_VALUE ||
    filterMember === FAVORITE_FILTER_VALUE
  ) {
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
  favoriteRefs: Set<string>;
  isFavorite: (ownerId: string, bookId: string) => boolean;
}

export interface UseFamilyShelfBooksResult {
  /** Books after member-filter and hidden/favorite-view filter (pre category/search). */
  memberFilteredBooks: BookWithMember[];
  /** Total shared cards across all members (filter-independent). */
  totalBooks: number;
  /** Count of currently-hidden shared cards (orphan refs excluded). */
  hiddenCount: number;
  /** Count of currently-favorited shared cards (orphan refs excluded). */
  favoriteCount: number;
  /** totalBooks - hiddenCount. */
  visibleCount: number;
  /** Localized heading suffix; favorite view shows "(最愛 N 本)". */
  headingCount: string;
}

/** Apply the active view's pre-category/search filter to the flattened books. */
function applyViewFilter(
  books: BookWithMember[],
  showHidden: boolean,
  showFavorite: boolean,
  isHidden: (ownerId: string, bookId: string) => boolean,
  isFavorite: (ownerId: string, bookId: string) => boolean,
): BookWithMember[] {
  // Favorite view spans all members and is INDEPENDENT of hidden status.
  if (showFavorite) {
    return books.filter((b) => isFavorite(b.ownerId, b.bookId));
  }
  return books.filter((b) => {
    const hidden = isHidden(b.ownerId, b.bookId);
    return showHidden ? hidden : !hidden;
  });
}

/** Build the localized heading suffix for the active view. */
function buildHeadingCount(
  showFavorite: boolean,
  favoriteCount: number,
  visibleCount: number,
  hiddenCount: number,
): string {
  if (showFavorite) {
    return `(最愛 ${favoriteCount} 本)`;
  }
  if (hiddenCount > 0) {
    return `(可見 ${visibleCount} 本，隱藏 ${hiddenCount} 本)`;
  }
  return `(可見 ${visibleCount} 本)`;
}

/**
 * Family-shelf heading counts + the member/hidden/favorite filter pipeline stage.
 *
 * The view filter is applied FIRST, before category/search/sort/load-more
 * downstream. Counts are member/search-filter-independent.
 */
export function useFamilyShelfBooks({
  members,
  filterMember,
  userId,
  updatedBookIds,
  hiddenRefs,
  isHidden,
  favoriteRefs,
  isFavorite,
}: UseFamilyShelfBooksParams): UseFamilyShelfBooksResult {
  const showHidden = filterMember === HIDDEN_FILTER_VALUE;
  const showFavorite = filterMember === FAVORITE_FILTER_VALUE;
  const totalBooks = useMemo(
    () => members.reduce((sum, m) => sum + m.books.length, 0),
    [members],
  );

  const hiddenCount = useMemo(
    () => countHidden(members, hiddenRefs),
    [members, hiddenRefs],
  );
  const favoriteCount = useMemo(
    () => countFavorites(members, favoriteRefs),
    [members, favoriteRefs],
  );
  const visibleCount = totalBooks - hiddenCount;

  const memberFilteredBooks = useMemo(() => {
    const selected = selectMembers(members, filterMember, userId);
    const all = selected.flatMap((m) => toBookWithMember(m, updatedBookIds));
    // View filter is applied FIRST, before category/search/sort/load-more.
    return applyViewFilter(all, showHidden, showFavorite, isHidden, isFavorite);
  }, [
    members,
    filterMember,
    userId,
    updatedBookIds,
    isHidden,
    isFavorite,
    showHidden,
    showFavorite,
  ]);

  const headingCount = buildHeadingCount(
    showFavorite,
    favoriteCount,
    visibleCount,
    hiddenCount,
  );

  return {
    memberFilteredBooks,
    totalBooks,
    hiddenCount,
    favoriteCount,
    visibleCount,
    headingCount,
  };
}
