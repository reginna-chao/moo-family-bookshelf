import { useState, useEffect, useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ApiClient, BookEntry } from "@/api/client";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { usePersonalShelfDirty } from "@/hooks/usePersonalShelfDirty";
import { normalizePersonalBooks } from "@/hooks/personalShelfUpload";
import { usePersonalShelfSave } from "@/hooks/usePersonalShelfSave";
import type { LoadState } from "@/hooks/usePersonalShelfSave";
import { usePersonalShelfActions } from "@/hooks/usePersonalShelfActions";

export interface UsePersonalShelfEditorReturn {
  books: BookEntry[];
  displayName: string;
  state: LoadState;
  errorMessage: string;
  dirtyBookIds: Set<string>;
  isDirty: boolean;
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  loadBooks: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleCancelChanges: () => void;
  handleBatchShare: () => void;
  handleBatchHide: () => void;
  handleToggle: (bookId: string) => void;
  toggleSelect: (bookId: string) => void;
}

/**
 * Owns the personal shelf's book list, unsaved changes and row selection:
 * loads on mount, uploads only on an explicit Save.
 */
export function usePersonalShelfEditor(
  userId: string,
  apiClient: ApiClient,
): UsePersonalShelfEditorReturn {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const latestBooksRef = useRef(books);
  latestBooksRef.current = books;
  const [displayName, setDisplayName] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const {
    dirtyBookIds,
    isDirty,
    markDirty,
    markManyDirty,
    clearDirty,
    clearDirtyIds,
  } = usePersonalShelfDirty();
  const dirtyRef = useRef(dirtyBookIds);
  dirtyRef.current = dirtyBookIds;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const originalBooksRef = useRef<BookEntry[]>([]);
  /** Raw server response — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);

  const handleSave = usePersonalShelfSave({
    userId,
    apiClient,
    displayName,
    books,
    setBooks,
    latestBooksRef,
    dirtyBookIds,
    dirtyRef,
    clearDirtyIds,
    originalBooksRef,
    savedRawPayload,
    setState,
    setErrorMessage,
  });

  const loadBooks = useCallback(async () => {
    setState("loading");
    setErrorMessage("");
    try {
      const response = await apiClient.getPersonalBooks(userId);
      if (response.error) {
        setErrorMessage(
          safeErrorText(response.error.message, "載入失敗，請稍後再試"),
        );
        setState("error");
        return;
      }

      if (!response.data) {
        setBooks([]);
        setState("ready");
        return;
      }

      const data = response.data;
      savedRawPayload.current = data as Record<string, unknown>;
      setDisplayName(data.displayName ?? "");
      const normalized = normalizePersonalBooks(data);
      setBooks(normalized);
      originalBooksRef.current = normalized;
      clearDirty();
      setSelectedIds(new Set());
      setState("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "載入失敗");
      setState("error");
    }
  }, [userId, apiClient, clearDirty]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const handleCancelChanges = useCallback(() => {
    setBooks(originalBooksRef.current);
    clearDirty();
    setSelectedIds(new Set());
    setState("ready");
  }, [clearDirty]);

  const { handleBatchShare, handleBatchHide, handleToggle, toggleSelect } =
    usePersonalShelfActions({
      setBooks,
      selectedIds,
      setSelectedIds,
      markDirty,
      markManyDirty,
    });

  return {
    books,
    displayName,
    state,
    errorMessage,
    dirtyBookIds,
    isDirty,
    selectedIds,
    setSelectedIds,
    loadBooks,
    handleSave,
    handleCancelChanges,
    handleBatchShare,
    handleBatchHide,
    handleToggle,
    toggleSelect,
  };
}
