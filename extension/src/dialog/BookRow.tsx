import React from "react";
import { BookEntry, BoolFlag } from "../api/client";
import { LazyCover } from "./LazyCover";

interface BookRowProps {
  book: BookEntry;
  selected: boolean;
  isDirty?: boolean;
  isMobile?: boolean;
  onSelect: (bookId: string) => void;
  onToggle: (bookId: string) => void;
}

export const BookRow = React.memo(function BookRow({ book, selected, isMobile = false, onSelect, onToggle }: BookRowProps) {
  const isOn = book.isShared === BoolFlag.TRUE;

  const handleRowClick = (e: React.MouseEvent) => {
    // Don't select when clicking the toggle button or the checkbox itself
    const target = e.target as HTMLElement;
    if (target.closest("[data-toggle-btn]") || target.tagName === "INPUT") return;
    onSelect(book.bookId);
  };

  const rowClass = selected ? "moo-shelf-row moo-shelf-row--selected" : "moo-shelf-row";
  const toggleClass = isOn ? "moo-shelf-row__toggle moo-shelf-row__toggle--on" : "moo-shelf-row__toggle";

  return (
    <div onClick={handleRowClick} className={rowClass}>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onSelect(book.bookId)}
        aria-label={`選取 ${book.title}`}
        className="moo-shelf-row__checkbox"
      />
      <LazyCover
        src={book.coverUrl}
        alt={book.title}
        width={40}
        height={60}
        className="moo-shelf-row__cover"
        fallback={<div className="moo-shelf-row__cover-fallback" />}
      />
      <div className="moo-shelf-row__info">
        <div className="moo-shelf-row__title-line">
          <span
            className={
              isMobile
                ? "moo-shelf-row__title moo-shelf-row__title--mobile"
                : "moo-shelf-row__title"
            }
          >
            {book.title}
          </span>
          {book.isArchived === BoolFlag.TRUE && (
            <span className="moo-shelf-row__archived-badge">封存</span>
          )}
        </div>
        {book.author && <div className="moo-shelf-row__author">{book.author}</div>}
      </div>
      <button data-toggle-btn onClick={() => onToggle(book.bookId)} className={toggleClass}>
        {isOn ? "開放" : "未開放"}
      </button>
    </div>
  );
});
