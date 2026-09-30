import type { ReactNode } from "react";
import { Users, UsersRound, User, Heart, EyeOff } from "lucide-react";
import type { FamilyShelfMemberBooks } from "moo-family-bookshelf-shared/familyShelf/prefRefs";
import { countVisibleByMemberScope } from "moo-family-bookshelf-shared/familyShelf/memberScopeCounts";

/** Sentinel filter value for the cross-everyone hidden-books view. */
export const HIDDEN_FILTER_VALUE = "__hidden__";

/** Sentinel filter value for the cross-everyone favorites view. */
export const FAVORITE_FILTER_VALUE = "__favorite__";

export type MemberFilterValue = "all-except-self" | "all" | string;

export type MemberInfo = FamilyShelfMemberBooks & { displayName: string };

export interface MemberOption {
  value: MemberFilterValue;
  label: string;
  icon: ReactNode;
  /** Books this option will show (before category / search); hidden excluded. */
  count: number;
}

/**
 * Build the member-filter options. Ordering is fixed:
 * all / all-except-self / self / each other member with books / favorite / hidden.
 * Each `value` is unique and doubles as the React key.
 * Member-scope counts exclude hidden books; favorite / hidden keep their totals.
 */
export function buildOptions(
  members: MemberInfo[],
  userId: string,
  favoriteCount: number,
  hiddenCount: number,
  hiddenRefs: ReadonlySet<string>,
): MemberOption[] {
  const counts = countVisibleByMemberScope(members, userId, hiddenRefs);
  const othersWithBooks = members.filter(
    (m) => m.userId !== userId && m.books.length > 0,
  );

  return [
    {
      value: "all",
      label: "所有人的書",
      icon: <Users size={16} aria-hidden="true" />,
      count: counts.all,
    },
    {
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: counts.allExceptSelf,
    },
    {
      value: userId,
      label: "自己的書",
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(userId) ?? 0,
    },
    ...othersWithBooks.map((m) => ({
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(m.userId) ?? 0,
    })),
    {
      value: FAVORITE_FILTER_VALUE,
      label: "我的最愛",
      icon: <Heart size={16} aria-hidden="true" />,
      count: favoriteCount,
    },
    {
      value: HIDDEN_FILTER_VALUE,
      label: "隱藏的書",
      icon: <EyeOff size={16} aria-hidden="true" />,
      count: hiddenCount,
    },
  ];
}
