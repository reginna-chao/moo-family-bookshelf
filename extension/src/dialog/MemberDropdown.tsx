import React from "react";
import { useIsMobile } from "../hooks/useIsMobile";

/** Sentinel filter value for the cross-everyone hidden-books view. */
export const HIDDEN_FILTER_VALUE = "__hidden__";

/** Sentinel filter value for the cross-everyone favorites view. */
export const FAVORITE_FILTER_VALUE = "__favorite__";

export type MemberFilterValue = "all-except-self" | "all" | string;

interface MemberInfo {
  userId: string;
  displayName: string;
  books: { bookId: string }[];
}

export interface MemberDropdownProps {
  members: MemberInfo[];
  userId: string;
  value: MemberFilterValue;
  onChange: (value: MemberFilterValue) => void;
}

export function MemberDropdown({ members, userId, value, onChange }: MemberDropdownProps) {
  const isMobile = useIsMobile();
  const othersWithBooks = members.filter((m) => m.userId !== userId && m.books.length > 0);
  const className = isMobile
    ? "moo-form-select moo-form-select--full moo-form-select--mobile"
    : "moo-form-select moo-form-select--full";

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MemberFilterValue)}
      aria-label="篩選成員"
      className={className}
    >
      <option value="all">所有人的書</option>
      <option value="all-except-self">其他家人的書</option>
      <option value={userId}>自己的書</option>
      {othersWithBooks.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.displayName || m.userId.slice(0, 8)}
        </option>
      ))}
      <option value={FAVORITE_FILTER_VALUE}>我的最愛</option>
      <option value={HIDDEN_FILTER_VALUE}>隱藏的書</option>
    </select>
  );
}
