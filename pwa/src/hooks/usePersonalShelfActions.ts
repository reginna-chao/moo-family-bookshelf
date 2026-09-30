import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { BoolFlag } from "@/api/client";
import type { BookEntry } from "@/api/client";

export interface UsePersonalShelfActionsOptions {
  setBooks: Dispatch<SetStateAction<BookEntry[]>>;
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  markDirty: (bookId: string) => void;
  markManyDirty: (bookIds: Iterable<string>) => void;
}

export interface UsePersonalShelfActionsReturn {
  handleBatchShare: () => void;
  handleBatchHide: () => void;
  handleToggle: (bookId: string) => void;
  toggleSelect: (bookId: string) => void;
}

/** Local-only share edits and row selection; nothing here talks to the server. */
export function usePersonalShelfActions({
  setBooks,
  selectedIds,
  setSelectedIds,
  markDirty,
  markManyDirty,
}: UsePersonalShelfActionsOptions): UsePersonalShelfActionsReturn {
  const handleBatchShare = useCallback(() => {
    setBooks((prev) =>
      prev.map((b) =>
        selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.TRUE } : b,
      ),
    );
    markManyDirty(selectedIds);
    setSelectedIds(new Set());
  }, [selectedIds, markManyDirty, setBooks, setSelectedIds]);

  const handleBatchHide = useCallback(() => {
    setBooks((prev) =>
      prev.map((b) =>
        selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.FALSE } : b,
      ),
    );
    markManyDirty(selectedIds);
    setSelectedIds(new Set());
  }, [selectedIds, markManyDirty, setBooks, setSelectedIds]);

  const handleToggle = useCallback(
    (bookId: string) => {
      setBooks((prev) =>
        prev.map((b) =>
          b.bookId === bookId
            ? {
                ...b,
                isShared:
                  b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE,
              }
            : b,
        ),
      );
      markDirty(bookId);
    },
    [markDirty, setBooks],
  );

  const toggleSelect = useCallback(
    (bookId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(bookId)) next.delete(bookId);
        else next.add(bookId);
        return next;
      });
    },
    [setSelectedIds],
  );

  return { handleBatchShare, handleBatchHide, handleToggle, toggleSelect };
}
