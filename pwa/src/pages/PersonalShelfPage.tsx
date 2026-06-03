import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Share2 } from "lucide-react";
import { BoolFlag, PERSONAL_BOOKS_SCHEMA_VERSION } from "@/api/client";
import type { ApiClient, BookEntry } from "@/api/client";
import { decideSaveStrategy } from "moo-family-bookshelf-shared/personal/saveStrategy";
import { useSearch } from "@/hooks/useSearch";
import { useLoadMore } from "@/hooks/useLoadMore";
import { FloatingActionBar, shouldShowFloatingBar } from "@/components/FloatingActionBar";
import { CategoryFilter, filterByCategory } from "@/components/CategoryFilter";
import { BookRow } from "@/components/BookRow";
import { PublicShareDialog } from "@/components/PublicShareDialog";
import { namespacedKey } from "@/hooks/useAuth";
import { useBookSort } from "@/hooks/useBookSort";
import { sortBooks } from "@/utils/sortBooks";
import { BookSortDropdown } from "@/components/BookSortDropdown";

interface PersonalShelfPageProps {
  userId: string;
  apiClient: ApiClient;
}

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

type LoadState = "loading" | "ready" | "saving" | "saved" | "error";
type StatusFilter = "all" | "shared" | "not-shared";

export function PersonalShelfPage({
  userId,
  apiClient,
}: PersonalShelfPageProps) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [dirtyBookIds, setDirtyBookIds] = useState<Set<string>>(new Set());
  const isDirty = dirtyBookIds.size > 0;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [archiveView, setArchiveView] = useState<"active" | "archived">("active");
  const [showPublicShare, setShowPublicShare] = useState(false);
  const { sort, setSort } = useBookSort(userId, "personal");
  const originalBooksRef = useRef<BookEntry[]>([]);
  /** Raw server response — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);

  const markDirty = useCallback((bookId: string) => {
    setDirtyBookIds((prev) => {
      if (prev.has(bookId)) return prev;
      const next = new Set(prev);
      next.add(bookId);
      return next;
    });
  }, []);

  const markManyDirty = useCallback((bookIds: Iterable<string>) => {
    setDirtyBookIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of bookIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const clearDirty = useCallback(() => {
    setDirtyBookIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  const loadBooks = useCallback(async () => {
    setState("loading");
    setErrorMessage("");
    try {
      const response = await apiClient.getPersonalBooks(userId);
      if (response.error) {
        setErrorMessage(response.error.message);
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
      const rawBooks = Array.isArray(data.books) ? data.books : [];
      // Normalize: Extension may store boolean for isShared/isArchived, PWA uses BoolFlag
      const normalized = rawBooks.map((b) => ({
        ...b,
        isShared: b.isShared ? BoolFlag.TRUE : BoolFlag.FALSE,
        isArchived: b.isArchived ? BoolFlag.TRUE : BoolFlag.FALSE,
      }));
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

  const handleSave = useCallback(async () => {
    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      setState("saved");
      setTimeout(() => setState("ready"), 1500);
      return;
    }

    setState("saving");

    // PATCH only the dirty books, unless the diff can't be safely expressed as
    // a partial update (new un-synced books, no server record, or over the cap)
    // — those fall back to a full PUT so nothing is silently dropped.
    const { usePut, dirtyBooks } = decideSaveStrategy({
      books,
      dirtyBookIds,
      savedRawPayload: savedRawPayload.current,
      maxPatchChanges: MAX_PATCH_CHANGES,
    });

    try {
      const response = usePut
        ? await apiClient.updatePersonalBooks(userId, {
            ...savedRawPayload.current,
            schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
            userId,
            displayName,
            books,
            lastUpdated: new Date().toISOString(),
          })
        : await apiClient.patchPersonalBooks(
            userId,
            dirtyBooks.map((b) => ({ bookId: b.bookId, isShared: b.isShared })),
          );
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }
      originalBooksRef.current = books;
      // Only a PUT persists the full local list; a PATCH leaves the server's
      // book set unchanged (it can only update isShared of existing books).
      // Marking PATCH-time books as server-known would wrongly classify
      // un-synced scraped books as known and silently drop them on a later PATCH.
      if (usePut) {
        savedRawPayload.current = { ...(savedRawPayload.current ?? {}), books };
      }
      clearDirty();
      setState("saved");
      // Signal FamilyShelfPage to re-fetch
      window.dispatchEvent(new CustomEvent("personalShelfSaved"));
      setTimeout(() => setState("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setState("error");
    }
  }, [userId, displayName, books, apiClient, clearDirty, dirtyBookIds]);

  const handleCancelChanges = useCallback(() => {
    setBooks(originalBooksRef.current);
    clearDirty();
    setSelectedIds(new Set());
    setState("ready");
  }, [clearDirty]);

  const handleBatchShare = useCallback(() => {
    setBooks(prev => prev.map(b => selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.TRUE } : b));
    markManyDirty(selectedIds);
    setSelectedIds(new Set());
  }, [selectedIds, markManyDirty]);

  const handleBatchHide = useCallback(() => {
    setBooks(prev => prev.map(b => selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.FALSE } : b));
    markManyDirty(selectedIds);
    setSelectedIds(new Set());
  }, [selectedIds, markManyDirty]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.bookId === bookId ? { ...b, isShared: b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE } : b,
      ),
    );
    markDirty(bookId);
  }, [markDirty]);

  const toggleSelect = useCallback((bookId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const syncArchived = localStorage.getItem(namespacedKey(userId, "syncArchived")) === "1";
  const activeBooks = useMemo(() => books.filter(b => b.isArchived !== BoolFlag.TRUE), [books]);
  const archivedBooks = useMemo(() => books.filter(b => b.isArchived === BoolFlag.TRUE), [books]);
  const showArchiveTabs = syncArchived && archivedBooks.length > 0;
  const currentViewBooks = showArchiveTabs && archiveView === "archived" ? archivedBooks : activeBooks;
  const showFloatingBar = shouldShowFloatingBar({
    selectedCount: selectedIds.size,
    isDirty,
    isSaving: state === "saving",
    isSaved: state === "saved",
  });

  const statusFilteredBooks = useMemo(() => {
    if (statusFilter === "shared") return currentViewBooks.filter((b) => b.isShared === BoolFlag.TRUE);
    if (statusFilter === "not-shared") return currentViewBooks.filter((b) => b.isShared === BoolFlag.FALSE);
    return currentViewBooks;
  }, [currentViewBooks, statusFilter]);

  const categoryFilteredBooks = useMemo(
    () => filterByCategory(statusFilteredBooks, categoryFilter),
    [statusFilteredBooks, categoryFilter],
  );

  const {
    searchTerm,
    setSearchTerm,
    filteredItems,
    isFiltering,
  } = useSearch(categoryFilteredBooks);

  const sortedBooks = useMemo(() => sortBooks(filteredItems, sort), [filteredItems, sort]);

  const narrowingActive = searchTerm !== "" || statusFilter !== "all" || categoryFilter !== "";
  const { visibleItems: visibleBooks, hasMore, loadMore, reset: resetLoadMore } = useLoadMore({
    items: sortedBooks,
    narrowingActive,
  });

  const handleSelectAll = useCallback(() => {
    const allVisible = visibleBooks.every(b => selectedIds.has(b.bookId));
    if (allVisible && visibleBooks.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleBooks.map(b => b.bookId)));
    }
  }, [visibleBooks, selectedIds]);

  const allVisibleSelected = visibleBooks.length > 0 && visibleBooks.every(b => selectedIds.has(b.bookId));

  if (state === "loading") {
    return (
      <div className="p-4 text-center" role="status" aria-label="載入中">
        <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
        <p className="text-gray-500 text-sm mt-3">載入個人書櫃中...</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="p-4">
        <p className="text-red-500 text-sm mb-3">{errorMessage}</p>
        <button
          onClick={() => void loadBooks()}
          className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-600 rounded-lg"
        >
          重試
        </button>
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="p-4 text-center">
        <p className="text-gray-400 mt-4">尚無已同步的書籍</p>
        <p className="text-gray-300 text-sm mt-2">請先在桌面版 Chrome 擴充功能中同步書單</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0">
      <div
        data-testid="personal-shelf-list-container"
        className={`p-4 flex-1 ${showFloatingBar ? "pb-[var(--personal-shelf-bottom-clearance)]" : ""}`}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold text-gray-900">
            個人書櫃
            <span className="text-gray-400 text-sm font-normal ml-2">({currentViewBooks.length} 本)</span>
          </h2>
          <button
            onClick={() => setShowPublicShare(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50"
          >
            <Share2 size={13} /> 公開分享
          </button>
        </div>

        {showArchiveTabs && (
          <div role="tablist" className="flex border-b border-gray-200 mb-3">
            <button
              role="tab"
              aria-selected={archiveView === "active"}
              onClick={() => { setArchiveView("active"); setCategoryFilter(""); resetLoadMore(); }}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
                archiveView === "active"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500"
              }`}
            >
              未封存 ({activeBooks.length})
            </button>
            <button
              role="tab"
              aria-selected={archiveView === "archived"}
              onClick={() => { setArchiveView("archived"); setCategoryFilter(""); resetLoadMore(); }}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
                archiveView === "archived"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500"
              }`}
            >
              封存 ({archivedBooks.length})
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 mb-3">
          <div className="flex gap-2 flex-1">
            {(["all", "shared", "not-shared"] as const).map((f) => (
              <button
                key={f}
                onClick={() => { setStatusFilter(f); setCategoryFilter(""); }}
                aria-pressed={statusFilter === f}
                className={`px-3 py-1.5 text-xs rounded-full ${
                  statusFilter === f ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                {f === "all" ? "全部" : f === "shared" ? "已開放" : "未開放"}
              </button>
            ))}
          </div>
          <BookSortDropdown value={sort} onChange={setSort} />
        </div>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜尋書名或作者"
            aria-label="搜尋書名或作者"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          />
          <CategoryFilter
            books={statusFilteredBooks}
            value={categoryFilter}
            onChange={setCategoryFilter}
          />
        </div>

        {visibleBooks.length > 0 && (
          <div className="flex items-center justify-between mb-2">
            {isFiltering && (
              <p className="text-gray-400 text-xs">找到 {visibleBooks.length} 本</p>
            )}
            <button
              onClick={handleSelectAll}
              className="text-xs text-blue-600 hover:text-blue-800 ml-auto"
            >
              {allVisibleSelected ? "取消全選" : "全選"}
            </button>
          </div>
        )}

        {isFiltering && visibleBooks.length === 0 && (
          <p className="text-gray-400 text-xs mb-2">找到 {visibleBooks.length} 本</p>
        )}

        {visibleBooks.length === 0 ? (
          <p className="text-gray-400 text-sm text-center mt-4">
            {isFiltering ? "找不到符合的書籍" : "目前篩選條件下沒有書籍"}
          </p>
        ) : (
          <>
          <div>
            {visibleBooks.map((book) => (
              <BookRow
                key={book.bookId}
                book={book}
                selected={selectedIds.has(book.bookId)}
                isDirty={dirtyBookIds.has(book.bookId)}
                onSelect={toggleSelect}
                onToggle={handleToggle}
              />
            ))}
          </div>

          {hasMore && (
            <button
              onClick={loadMore}
              className="w-full py-2.5 mt-3 text-sm font-medium text-blue-600 border border-blue-600 rounded-lg"
            >
              載入更多（已顯示 {visibleBooks.length} / 共 {filteredItems.length} 本）
            </button>
          )}
          </>
        )}
      </div>

      <FloatingActionBar
        selectedCount={selectedIds.size}
        isDirty={isDirty}
        isSaving={state === "saving"}
        isSaved={state === "saved"}
        onBatchShare={handleBatchShare}
        onBatchHide={handleBatchHide}
        onCancelChanges={handleCancelChanges}
        onSave={() => void handleSave()}
      />

      {showPublicShare && (
        <PublicShareDialog
          userId={userId}
          apiClient={apiClient}
          defaultDisplayName={displayName || "我"}
          onClose={() => setShowPublicShare(false)}
        />
      )}
    </div>
  );
}
