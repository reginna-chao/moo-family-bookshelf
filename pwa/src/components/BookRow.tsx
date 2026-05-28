import React from "react";
import { BookOpen } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { BookEntry } from "@/api/client";
import { LazyCover } from "@/components/LazyCover";

export interface BookRowProps {
  book: BookEntry;
  selected: boolean;
  isDirty: boolean;
  onSelect: (bookId: string) => void;
  onToggle: (bookId: string) => void;
}

export const BookRow = React.memo(function BookRow({
  book,
  selected,
  isDirty: _isDirty, // reserved for v1.4 visual indicator; included in memo compare
  onSelect,
  onToggle,
}: BookRowProps) {
  const isShared = book.isShared === BoolFlag.TRUE;

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-toggle-btn]") || target.tagName === "INPUT") return;
    onSelect(book.bookId);
  };

  return (
    <div
      onClick={handleRowClick}
      className="flex items-center gap-3 py-3 border-b border-gray-100 cursor-pointer"
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onSelect(book.bookId)}
        aria-label={`選取 ${book.title}`}
        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
      />
      <LazyCover
        src={book.coverUrl}
        alt=""
        className="w-10 h-[54px] rounded object-cover flex-shrink-0"
        fallback={
          <div className="w-10 h-[54px] rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
            <BookOpen size={18} className="text-gray-300" aria-hidden="true" />
          </div>
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium text-gray-900 truncate">{book.title}</p>
          {book.isArchived === BoolFlag.TRUE && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium flex-shrink-0">
              封存
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 truncate">{book.author}</p>
      </div>
      <button
        data-toggle-btn
        onClick={() => onToggle(book.bookId)}
        aria-pressed={isShared}
        aria-label={`${book.title} ${isShared ? "已開放分享" : "未開放分享"}`}
        className={`px-3 py-1 text-xs rounded-full font-medium flex-shrink-0 ${
          isShared ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-500"
        }`}
      >
        {isShared ? "開放" : "未開放"}
      </button>
    </div>
  );
});
