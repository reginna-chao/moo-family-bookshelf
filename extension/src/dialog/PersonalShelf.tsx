import { useState, useEffect, useCallback, useRef, CSSProperties } from "react";
import { Share2 } from "lucide-react";
import { ApiClient, BoolFlag } from "../api/client";
import { BookRow } from "./BookRow";
import { StatusFilterBar, StatusFilter } from "./StatusFilterBar";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";
import { useBookSync } from "./useBookSync";
import { FloatingActionBar } from "./FloatingActionBar";
import { CategoryFilter, filterByCategory } from "./CategoryDropdown";
import { usePersonalBooks } from "./usePersonalBooks";
import { PublicShareDialog } from "./PublicShareDialog";

export interface PersonalShelfProps {
  userId: string;
  apiClient: ApiClient;
}

function archiveTabStyle(active: boolean): CSSProperties {
  return {
    flex: 1, padding: "8px 0", border: "none", background: "transparent",
    fontWeight: active ? 600 : 400, color: active ? "#2563eb" : "#64748b",
    fontSize: 13, cursor: "pointer",
    borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
  };
}

export function PersonalShelf({ userId, apiClient }: PersonalShelfProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [archiveView, setArchiveView] = useState<"active" | "archived">("active");
  const [syncArchived, setSyncArchived] = useState<number>(0);
  const [showPublicShare, setShowPublicShare] = useState(false);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    chrome.storage.local.get("displayName").then((r) => {
      setDisplayName((r.displayName as string) ?? "");
    });
  }, []);

  const { syncStatus, syncError, triggerManualSync, lastSyncBooks } = useBookSync({
    userId,
    apiClient,
  });

  const {
    books, setBooks, status, setStatus, errorMessage,
    isDirty, setIsDirty, handleToggle, handleSave, handleCancel: handleCancelBooks,
  } = usePersonalBooks({ userId, apiClient, lastSyncBooks });

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SYNC_ARCHIVED" }, (response) => {
      if (response?.syncArchived !== undefined) {
        setSyncArchived(response.syncArchived);
      }
    });
  }, []);

  useEffect(() => {
    if (syncArchived === BoolFlag.FALSE) {
      setArchiveView("active");
    }
  }, [syncArchived]);

  const resetSearchRef = useRef<() => void>(() => {});

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
  }, []);

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
    setSelectedIds(new Set());
    setIsDirty(true);
  }, [selectedIds, setBooks, setIsDirty]);
  const handleBatchShare = useCallback(() => batchSetShared(BoolFlag.TRUE), [batchSetShared]);
  const handleBatchHide = useCallback(() => batchSetShared(BoolFlag.FALSE), [batchSetShared]);

  const handleCancel = useCallback(() => {
    handleCancelBooks();
    setSelectedIds(new Set());
  }, [handleCancelBooks]);

  const activeBooks = books.filter(b => b.isArchived !== BoolFlag.TRUE);
  const archivedBooks = books.filter(b => b.isArchived === BoolFlag.TRUE);
  const currentViewBooks = archiveView === "active" ? activeBooks : archivedBooks;

  const statusFilteredBooks = statusFilter === "shared"
    ? currentViewBooks.filter((b) => b.isShared === BoolFlag.TRUE)
    : statusFilter === "not-shared"
      ? currentViewBooks.filter((b) => b.isShared === BoolFlag.FALSE)
      : currentViewBooks;

  const categoryFilteredBooks = filterByCategory(statusFilteredBooks, categoryFilter);

  const { searchTerm, setSearchTerm, resetSearch, filteredItems: displayedBooks, isFiltering } =
    useSearch(categoryFilteredBooks);
  resetSearchRef.current = resetSearch;

  if (status === "scraping") {
    return <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>正在爬取書單...</div>;
  }
  if (status === "error") {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>{errorMessage}</p>
        <button onClick={() => setStatus("ready")} style={{
          padding: "8px 16px", border: "1px solid #2563eb", borderRadius: 8,
          background: "transparent", color: "#2563eb", fontWeight: 600, cursor: "pointer",
        }}>返回</button>
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
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>個人書櫃管理
          <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: 13 }}>({currentViewBooks.length} 本)</span>
        </h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowPublicShare(true)} style={{
            padding: "6px 12px", border: "1px solid #2563eb", borderRadius: 6, color: "#2563eb",
            background: "transparent", fontWeight: 500, fontSize: 13, cursor: "pointer",
            whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4,
          }}><Share2 size={13} />公開分享</button>
          <button onClick={triggerManualSync} disabled={isSyncing} style={{
            padding: "6px 12px", border: "1px solid #2563eb", borderRadius: 6, color: "#2563eb",
            background: isSyncing ? "#93c5fd" : "transparent", fontWeight: 500, fontSize: 13,
            cursor: isSyncing ? "not-allowed" : "pointer", whiteSpace: "nowrap",
          }}>{syncLabel}</button>
        </div>
      </div>

      {syncStatus === "error" && syncError && (
        <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{syncError}</p>
      )}

      {syncArchived === BoolFlag.TRUE && (
        <div role="tablist" style={{ display: "flex", gap: 0, marginBottom: 8, borderBottom: "1px solid #e2e8f0" }}>
          <button role="tab" aria-selected={archiveView === "active"}
            onClick={() => handleArchiveViewChange("active")} style={archiveTabStyle(archiveView === "active")}>
            未封存 ({activeBooks.length})
          </button>
          <button role="tab" aria-selected={archiveView === "archived"}
            onClick={() => handleArchiveViewChange("archived")} style={archiveTabStyle(archiveView === "archived")}>
            封存 ({archivedBooks.length})
          </button>
        </div>
      )}

      {currentViewBooks.length > 0 && (
        <>
          <StatusFilterBar value={statusFilter} onChange={handleStatusFilterChange} />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
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
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <button onClick={handleSelectAll} style={{
              padding: "4px 10px", border: "1px solid #cbd5e1", borderRadius: 6,
              background: "transparent", color: "#475569", fontSize: 12, fontWeight: 500, cursor: "pointer",
            }}>{allVisibleSelected ? "取消全選" : "全選"}</button>
          </div>
        </>
      )}

      {currentViewBooks.length === 0 && (
        <p style={{ color: "#94a3b8", textAlign: "center", marginTop: 24 }}>
          {archiveView === "archived" ? "尚無封存書籍" : "尚無書籍"}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {displayedBooks.map((book) => (
          <BookRow key={book.bookId} book={book} selected={selectedIds.has(book.bookId)} onSelect={handleSelect} onToggle={handleToggle} />
        ))}
      </div>

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
