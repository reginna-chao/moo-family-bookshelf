import React from "react";

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
  const othersWithBooks = members.filter((m) => m.userId !== userId && m.books.length > 0);

  return (
    <div style={{ marginBottom: 12 }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as MemberFilterValue)}
        aria-label="篩選成員"
        style={{
          width: "100%",
          padding: "8px 12px",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          fontSize: 14,
          background: "white",
          color: "#334155",
          cursor: "pointer",
          outline: "none",
        }}
      >
        <option value="all">所有人的書</option>
        <option value="all-except-self">其他家人的書</option>
        <option value={userId}>自己的書</option>
        {othersWithBooks.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName || m.userId.slice(0, 8)}
          </option>
        ))}
      </select>
    </div>
  );
}
