import React, { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BookEntry } from "../api/client";
import { importKey, encrypt, decrypt } from "../crypto/encrypt";
import { scrapeBooks } from "../content/scraper";
import { mergeBooks } from "./mergeBooks";
import { BookRow } from "./BookRow";
import { StatusFilterBar, StatusFilter } from "./StatusFilterBar";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";
import { useBookSync } from "./useBookSync";
import { FloatingActionBar } from "./FloatingActionBar";

export interface PersonalShelfProps {
  userId: string;
  apiClient: ApiClient;
}

type Status = "scraping" | "ready" | "saving" | "saved" | "error";

async function loadSavedBooks(
  data: Record<string, unknown>,
  encKeyString: string,
): Promise<BookEntry[]> {
  // If the API returned an encrypted payload string, decrypt it
  if (typeof data.payload === "string") {
    const key = await importKey(encKeyString);
    const decrypted = await decrypt(data.payload, key);
    const parsed = JSON.parse(decrypted) as { books: BookEntry[] };
    return parsed.books;
  }
  // If data comes back with structured books array
  if (Array.isArray(data.books)) {
    return data.books as BookEntry[];
  }
  return [];
}

export function PersonalShelf({ userId, apiClient }: PersonalShelfProps) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const originalBooks = useRef<BookEntry[]>([]);
  const [status, setStatus] = useState<Status>("scraping");
  const [errorMessage, setErrorMessage] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { syncStatus, syncError, triggerManualSync, lastSyncBooks } = useBookSync({
    userId,
    apiClient,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const storageResult = await chrome.storage.local.get(["encryptionKey"]);
        const encKeyString = storageResult.encryptionKey as string | undefined;

        const scrapedBooks = await scrapeBooks();

        const apiResponse = await apiClient.getPersonalBooks(userId);

        if (cancelled) return;

        let savedBooks: BookEntry[] = [];
        if (apiResponse.data && encKeyString) {
          try {
            savedBooks = await loadSavedBooks(
              apiResponse.data as unknown as Record<string, unknown>,
              encKeyString,
            );
          } catch {
            // Decryption failed — likely key mismatch from reinstall.
            // Treat as no saved data; user can re-save with current key.
            console.warn("[PersonalShelf] Decrypt failed, ignoring saved data");
            savedBooks = [];
          }
        }
        if (cancelled) return;

        const merged = mergeBooks(scrapedBooks, savedBooks);
        originalBooks.current = merged;
        setBooks(merged);
        setStatus("ready");
      } catch (err) {
        console.error("[PersonalShelf] Error:", err);
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "載入失敗");
        setStatus("error");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [userId, apiClient]);

  // When auto-sync or manual sync finishes, merge new books into local state
  useEffect(() => {
    if (lastSyncBooks.length > 0 && status === "ready") {
      setBooks((prev) => mergeBooks(
        lastSyncBooks.map((b) => ({
          bookId: b.bookId,
          title: b.title,
          author: b.author,
          coverUrl: b.coverUrl,
          readmooUrl: b.readmooUrl,
        })),
        prev,
      ));
    }
  }, [lastSyncBooks, status]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) => (b.bookId === bookId ? { ...b, isShared: !b.isShared } : b)),
    );
    setIsDirty(true);
  }, []);

  const handleSelect = useCallback((bookId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const handleBatchShare = useCallback(() => {
    setBooks((prev) =>
      prev.map((b) => (selectedIds.has(b.bookId) ? { ...b, isShared: true } : b)),
    );
    setSelectedIds(new Set());
    setIsDirty(true);
  }, [selectedIds]);

  const handleBatchHide = useCallback(() => {
    setBooks((prev) =>
      prev.map((b) => (selectedIds.has(b.bookId) ? { ...b, isShared: false } : b)),
    );
    setSelectedIds(new Set());
    setIsDirty(true);
  }, [selectedIds]);

  const handleSave = useCallback(async () => {
    setStatus("saving");
    setErrorMessage("");
    try {
      const storageResult = await chrome.storage.local.get(["encryptionKey", "displayName"]);
      const encKeyString = storageResult.encryptionKey as string | undefined;
      if (!encKeyString) throw new Error("找不到加密金鑰");
      const storedDisplayName = (storageResult.displayName as string | undefined) ?? "";

      const key = await importKey(encKeyString);
      const payload = JSON.stringify({
        userId,
        displayName: storedDisplayName,
        books,
        lastUpdated: new Date().toISOString(),
      });
      const encrypted = await encrypt(payload, key);
      const response = await apiClient.updatePersonalBooks(userId, encrypted);
      if (response.error) {
        setErrorMessage(response.error.message);
        setStatus("error");
        return;
      }
      originalBooks.current = books;
      setIsDirty(false);
      setStatus("saved");
      setTimeout(() => setStatus("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setStatus("error");
    }
  }, [books, userId, apiClient]);

  const handleCancel = useCallback(() => {
    setBooks(originalBooks.current);
    setIsDirty(false);
    setSelectedIds(new Set());
  }, []);

  const statusFilteredBooks = (() => {
    if (statusFilter === "shared") return books.filter((b) => b.isShared);
    if (statusFilter === "not-shared") return books.filter((b) => !b.isShared);
    return books;
  })();

  const { searchTerm, setSearchTerm, filteredItems: displayedBooks, isFiltering } =
    useSearch(statusFilteredBooks);

  if (status === "scraping") {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>
        正在爬取書單...
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>{errorMessage}</p>
        <button
          onClick={() => setStatus("ready")}
          style={{
            padding: "8px 16px",
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          返回
        </button>
      </div>
    );
  }

  const isSyncing = syncStatus === "syncing";
  const syncLabel = isSyncing ? "同步中..." : syncStatus === "done" ? "同步完成" : "同步書櫃";

  const allVisibleSelected =
    displayedBooks.length > 0 && displayedBooks.every((b) => selectedIds.has(b.bookId));

  const handleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayedBooks.map((b) => b.bookId)));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          個人書櫃管理
          <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: 13 }}>
            ({books.length} 本)
          </span>
        </h3>
        <button
          onClick={triggerManualSync}
          disabled={isSyncing}
          style={{
            padding: "6px 12px",
            border: "1px solid #2563eb",
            borderRadius: 6,
            background: isSyncing ? "#93c5fd" : "transparent",
            color: "#2563eb",
            fontWeight: 500,
            fontSize: 13,
            cursor: isSyncing ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {syncLabel}
        </button>
      </div>
      {syncStatus === "error" && syncError && (
        <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{syncError}</p>
      )}

      {books.length > 0 && (
        <>
          <StatusFilterBar value={statusFilter} onChange={setStatusFilter} />

          <SearchBar
            value={searchTerm}
            onChange={setSearchTerm}
            totalCount={statusFilteredBooks.length}
            filteredCount={displayedBooks.length}
            isFiltering={isFiltering}
          />

          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <button
              onClick={handleSelectAll}
              style={{
                padding: "4px 10px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                background: "transparent",
                color: "#475569",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {allVisibleSelected ? "取消全選" : "全選"}
            </button>
          </div>
        </>
      )}

      {books.length === 0 && (
        <p style={{ color: "#94a3b8", textAlign: "center", marginTop: 24 }}>尚無書籍</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {displayedBooks.map((book) => (
          <BookRow
            key={book.bookId}
            book={book}
            selected={selectedIds.has(book.bookId)}
            onSelect={handleSelect}
            onToggle={handleToggle}
          />
        ))}
      </div>

      <FloatingActionBar
        selectedCount={selectedIds.size}
        isDirty={isDirty}
        isSaving={status === "saving"}
        isSaved={status === "saved"}
        onBatchShare={handleBatchShare}
        onBatchHide={handleBatchHide}
        onCancel={handleCancel}
        onSave={handleSave}
      />
    </div>
  );
}
