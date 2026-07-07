import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowDownWideNarrow } from "lucide-react";
import type { BookSortMode } from "@/utils/sortBooks";

export interface BookSortDropdownProps {
  value: BookSortMode;
  onChange: (mode: BookSortMode) => void;
}

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title", label: "依書名排序" },
  { value: "author", label: "依作者排序" },
];

/**
 * Sort dropdown (PWA): icon-button trigger + popover listbox, mirroring the
 * Extension BookSortDropdown behavior with Tailwind styling. Closes on outside
 * click — the mousedown listener is attached only while open and cleaned up.
 */
export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isActive = value !== "default";

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function handleSelect(mode: BookSortMode) {
    onChange(mode);
    setOpen(false);
  }

  return (
    <div ref={popoverRef} className="relative flex-shrink-0">
      <button
        onClick={handleToggle}
        aria-label="書籍排序"
        aria-expanded={open}
        className={`flex items-center justify-center w-10 h-10 rounded-lg border transition-colors ${
          isActive
            ? "border-blue-500 bg-blue-50 text-blue-600"
            : "border-gray-300 bg-white text-gray-400"
        }`}
      >
        <ArrowDownWideNarrow size={16} />
      </button>
      {open && (
        <div
          className="absolute top-12 right-0 min-w-[160px] max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
          role="listbox"
          aria-label="書籍排序選單"
        >
          {OPTIONS.map((opt) => {
            const selected = opt.value === value;
            const rowClass = selected
              ? "bg-blue-50 text-blue-600"
              : "text-gray-700 hover:bg-gray-50";
            return (
              <button
                key={opt.value}
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(opt.value)}
                className={`w-full px-3 py-2 text-sm text-left ${rowClass}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
