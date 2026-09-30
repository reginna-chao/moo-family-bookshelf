import type { ReactNode } from "react";
import { Users, UsersRound, User, Heart, EyeOff } from "lucide-react";
import {
  FAVORITE_FILTER_VALUE,
  HIDDEN_FILTER_VALUE,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import { countVisibleByMemberScope } from "moo-family-bookshelf-shared/familyShelf/memberScopeCounts";

export interface MemberOption {
  key: string;
  value: MemberFilterValue;
  label: string;
  icon: ReactNode;
  /** Books this option will show (before category / search); hidden excluded. */
  count: number;
}

/**
 * Build the member-filter options. Ordering is fixed:
 * all / all-except-self / self / each other member with books / favorite / hidden.
 * Member-scope counts exclude hidden books; favorite / hidden keep their totals.
 */
export function buildOptions(
  members: MemberBooks[],
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
      key: "all",
      value: "all",
      label: "所有人的書",
      icon: <Users size={16} aria-hidden="true" />,
      count: counts.all,
    },
    {
      key: "all-except-self",
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: counts.allExceptSelf,
    },
    {
      key: "self",
      value: userId,
      label: "自己的書",
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(userId) ?? 0,
    },
    ...othersWithBooks.map((m) => ({
      key: m.userId,
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(m.userId) ?? 0,
    })),
    {
      key: FAVORITE_FILTER_VALUE,
      value: FAVORITE_FILTER_VALUE,
      label: "我的最愛",
      icon: <Heart size={16} aria-hidden="true" />,
      count: favoriteCount,
    },
    {
      key: HIDDEN_FILTER_VALUE,
      value: HIDDEN_FILTER_VALUE,
      label: "隱藏的書",
      icon: <EyeOff size={16} aria-hidden="true" />,
      count: hiddenCount,
    },
  ];
}
