import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import browser from "webextension-polyfill";
import { Share2, RefreshCw } from "lucide-react";
import { ApiClient, BoolFlag } from "../api/client";
import { BookRow } from "./BookRow";
import { StatusFilterBar, StatusFilter } from "./StatusFilterBar";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";
import { useLoadMore } from "./useLoadMore";
import { useBookSync } from "./useBookSync";
import { FloatingActionBar } from "./FloatingActionBar";
import { CategoryFilter, filterByCategory } from "./CategoryDropdown";
import { usePersonalBooks } from "./usePersonalBooks";
import { PublicShareDialog } from "./PublicShareDialog";
import { useFamilyData } from "./FamilyDataContext";
import { useBookSort } from "./useBookSort";
import { sortBooks } from "./sortBooks";
import { BookSortDropdown } from "./BookSortDropdown";
import { useIsMobile } from "../hooks/useIsMobile";

export interface PersonalShelfProps {
  userId: string;
  apiClient: ApiClient;
  /** Items shown per page in the personal shelf list. Injectable for tests; production uses the default. */
  pageSize?: number;
}

function toolButtonClass(isMobile: boolean, extra = ""): string {
  const base = isMobile ? "moo-shelf__tool-btn moo-shelf__tool-btn--icon" : "moo-shelf__tool-btn";
  return extra ? `${base} ${extra}` : base;
}

function archiveTabClass(active: boolean): string {
  return active ? "moo-shelf__archive-tab moo-shelf__archive-tab--active" : "moo-shelf__archive-tab";
}

export function PersonalShelf({ userId, apiClient, pageSize }: PersonalShelfProps) {
  const isMobile = useIsMobile();
  const { members } = useFamilyData();
  const selfMember = members.find((m) => m.userId === userId);
  const displayName = selfMember?.displayName ?? "";

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [archiveView, setArchiveView] = useState<"active" | "archived">("active");
  const [syncArchived, setSyncArchived] = useState<number>(0);
  const [showPublicShare, setShowPublicShare] = useState(false);
  const { sort, setSort } = useBookSort("personal");

  const { syncStatus, syncError, triggerManualSync, lastSyncBooks, progressMessage } = useBookSync({
    userId,
    apiClient,
  });

  const {
    books, setBooks, status, setStatus, errorMessage,
    isDirty, dirtyBookIds, markManyDirty,
    handleToggle, handleSave, handleCancel: handleCancelBooks,
  } = usePersonalBooks({ userId, apiClient, lastSyncBooks, displayName });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_SYNC_ARCHIVED",
        })) as { syncArchived?: number } | undefined;
        if (cancelled) return;
        if (response?.syncArchived !== undefined) {
          setSyncArchived(response.syncArchived);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (syncArchived === BoolFlag.FALSE) {
      setArchiveView("active");
    }
  }, [syncArchived]);

  const resetSearchRef = useRef<() => void>(() => {});

  const activeBooks = books.filter(b => b.isArchived !== BoolFlag.TRUE);
  const archivedBooks = books.filter(b => b.isArchived === BoolFlag.TRUE);
  const currentViewBooks = archiveView === "active" ? activeBooks : archivedBooks;

  const statusFilteredBooks = statusFilter === "shared"
    ? currentViewBooks.filter((b) => b.isShared === BoolFlag.TRUE)
    : statusFilter === "not-shared"
      ? currentViewBooks.filter((b) => b.isShared === BoolFlag.FALSE)
      : currentViewBooks;

  const categoryFilteredBooks = filterByCategory(statusFilteredBooks, categoryFilter);

  const { searchTerm, setSearchTerm, resetSearch, filteredItems, isFiltering } =
    useSearch(categoryFilteredBooks);
  resetSearchRef.current = resetSearch;

  const sortedBooks = useMemo(() => sortBooks(filteredItems, sort), [filteredItems, sort]);

  const narrowingActive = searchTerm !== "" || statusFilter !== "all" || categoryFilter !== "";
  const { visibleItems: displayedBooks, hasMore, loadMore, reset: resetLoadMore } = useLoadMore({
    items: sortedBooks,
    narrowingActive,
    pageSize,
  });

  const handleStatusFilterChange = useCallback((value: StatusFilter) => {
    setStatusFilter(value);
    setCategoryFilter("");
    setCategoryOpen(false);
    resetSearchRef.current();
  }, []);

  const handleArchiveViewChange = useCallback((view: "active" | "archived") => {
    setArchiveView(view);
    setCategoryFilter("");
    setCategoryOpen(false);
    resetSearchRef.current();
    resetLoadMore();
  }, [resetLoadMore]);

  const handleSelect = useCallback((bookId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const batchSetShared = useCallback((flag: BoolFlag) => {
    setBooks((prev) => prev.map((b) => (selectedIds.has(b.bookId) ? { ...b, isShared: flag } : b)));
    markManyDirty(selectedIds);
    setSelectedIds(new Set());
  }, [selectedIds, setBooks, markManyDirty]);
  const handleBatchShare = useCallback(() => batchSetShared(BoolFlag.TRUE), [batchSetShared]);
  const handleBatchHide = useCallback(() => batchSetShared(BoolFlag.FALSE), [batchSetShared]);

  const handleCancel = useCallback(() => {
    handleCancelBooks();
    setSelectedIds(new Set());
  }, [handleCancelBooks]);

  if (status === "loading") {
    return (
      <div className="moo-shelf__state moo-shelf__state--center">
        <div>載入中...</div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="moo-shelf__state">
        <p className="moo-shelf__state-error">{errorMessage}</p>
        <button onClick={() => setStatus("ready")} className="moo-shelf__state-retry">
          返回
        </button>
      </div>
    );
  }

  const isSyncing = syncStatus === "syncing";
  const syncLabel = isSyncing ? "同步中..." : syncStatus === "done" ? "同步完成" : "同步書櫃";
  const allVisibleSelected = displayedBooks.length > 0 && displayedBooks.every((b) => selectedIds.has(b.bookId));

  const handleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(displayedBooks.map((b) => b.bookId)));
  };

  return (
    <div className="moo-shelf">
      <div className="moo-shelf__header">
        <h3 className="moo-shelf__heading">個人書櫃管理
          <span className="moo-shelf__heading-count">({currentViewBooks.length} 本)</span>
        </h3>
        <div className="moo-shelf__header-actions">
          <button
            onClick={() => setShowPublicShare(true)}
            aria-label="公開分享"
            title="公開分享"
            className={toolButtonClass(isMobile)}
          >
            <Share2 size={13} />
            {!isMobile && "公開分享"}
          </button>
          <button
            onClick={triggerManualSync}
            disabled={isSyncing}
            aria-label={syncLabel}
            title={syncLabel}
            className={toolButtonClass(isMobile, isSyncing ? "moo-shelf__tool-btn--syncing" : "")}
          >
            <RefreshCw size={13} className={isSyncing ? "moo-spin" : undefined} />
            {!isMobile && syncLabel}
          </button>
        </div>
      </div>

      {progressMessage && (
        <div className="moo-shelf__progress">{progressMessage}</div>
      )}

      {syncStatus === "error" && syncError && (
        <p className="moo-shelf__sync-error">{syncError}</p>
      )}

      {syncArchived === BoolFlag.TRUE && (
        <div role="tablist" className="moo-shelf__archive-tabs">
          <button role="tab" aria-selected={archiveView === "active"}
            onClick={() => handleArchiveViewChange("active")} className={archiveTabClass(archiveView === "active")}>
            未封存 ({activeBooks.length})
          </button>
          <button role="tab" aria-selected={archiveView === "archived"}
            onClick={() => handleArchiveViewChange("archived")} className={archiveTabClass(archiveView === "archived")}>
            封存 ({archivedBooks.length})
          </button>
        </div>
      )}

      {currentViewBooks.length > 0 && (
        <>
          <div className="moo-shelf__filter-row">
            <div className="moo-shelf__grow">
              <StatusFilterBar value={statusFilter} onChange={handleStatusFilterChange} />
            </div>
            <BookSortDropdown value={sort} onChange={setSort} />
          </div>
          <div className="moo-shelf__search-row">
            <div className="moo-shelf__grow">
              <SearchBar
                value={searchTerm} onChange={setSearchTerm}
                totalCount={categoryFilteredBooks.length} filteredCount={displayedBooks.length} isFiltering={isFiltering}
              />
            </div>
            <CategoryFilter
              books={statusFilteredBooks} value={categoryFilter} onChange={setCategoryFilter}
              open={categoryOpen} onToggle={() => setCategoryOpen(prev => !prev)}
            />
          </div>
          <div className="moo-shelf__select-all-row">
            <button onClick={handleSelectAll} className="moo-shelf__select-all">
              {allVisibleSelected ? "取消全選" : "全選"}
            </button>
          </div>
        </>
      )}

      {currentViewBooks.length === 0 && (
        <p className="moo-shelf__empty">
          {archiveView === "archived" ? "尚無封存書籍" : "尚無書籍"}
        </p>
      )}

      <div className="moo-shelf__list">
        {displayedBooks.map((book) => (
          <BookRow
            key={book.bookId}
            book={book}
            selected={selectedIds.has(book.bookId)}
            isDirty={dirtyBookIds.has(book.bookId)}
            onSelect={handleSelect}
            onToggle={handleToggle}
          />
        ))}
      </div>

      {hasMore && (
        <button onClick={loadMore} className="moo-shelf__load-more">
          載入更多（已顯示 {displayedBooks.length} / 共 {filteredItems.length} 本）
        </button>
      )}

      <FloatingActionBar
        selectedCount={selectedIds.size} isDirty={isDirty} isSaving={status === "saving"} isSaved={status === "saved"}
        onBatchShare={handleBatchShare} onBatchHide={handleBatchHide} onCancel={handleCancel} onSave={handleSave}
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
