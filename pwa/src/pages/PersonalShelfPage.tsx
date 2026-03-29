import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BookOpen } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { ApiClient, BookEntry } from "@/api/client";
import { importKey, encrypt, decrypt } from "@/crypto/encrypt";
import { useSearch } from "@/hooks/useSearch";
import { FloatingActionBar } from "@/components/FloatingActionBar";
import { namespacedKey } from "@/hooks/useAuth";

interface PersonalShelfPageProps {
  userId: string;
  apiClient: ApiClient;
  encryptionKey: string;
}

type LoadState = "loading" | "ready" | "saving" | "saved" | "error";
type StatusFilter = "all" | "shared" | "not-shared";

export function PersonalShelfPage({
  userId,
  apiClient,
  encryptionKey,
}: PersonalShelfPageProps) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [archiveView, setArchiveView] = useState<"active" | "archived">("active");
  const originalBooksRef = useRef<BookEntry[]>([]);

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

      if (!response.data?.payload) {
        setBooks([]);
        setState("ready");
        return;
      }

      const key = await importKey(encryptionKey);
      const decrypted = await decrypt(response.data.payload, key);
      const parsed: unknown = JSON.parse(decrypted);

      if (typeof parsed !== "object" || parsed === null) {
        setBooks([]);
        setState("ready");
        return;
      }

      const obj = parsed as Record<string, unknown>;
      setDisplayName(typeof obj.displayName === "string" ? obj.displayName : "");
      const rawBooks = Array.isArray(obj.books) ? (obj.books as BookEntry[]) : [];
      // Normalize: Extension may store boolean for isShared/isArchived, PWA uses BoolFlag
      const normalized = rawBooks.map((b) => ({
        ...b,
        isShared: b.isShared ? BoolFlag.TRUE : BoolFlag.FALSE,
        isArchived: b.isArchived ? BoolFlag.TRUE : BoolFlag.FALSE,
      }));
      setBooks(normalized);
      originalBooksRef.current = normalized;
      setIsDirty(false);
      setSelectedIds(new Set());
      setState("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "載入失敗");
      setState("error");
    }
  }, [userId, apiClient, encryptionKey]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const handleSave = useCallback(async () => {
    setState("saving");
    try {
      const key = await importKey(encryptionKey);
      const payload = JSON.stringify({
        userId,
        displayName,
        books,
        lastUpdated: new Date().toISOString(),
      });
      const encrypted = await encrypt(payload, key);
      const response = await apiClient.updatePersonalBooks(userId, encrypted);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }
      originalBooksRef.current = books;
      setIsDirty(false);
      setState("saved");
      setTimeout(() => setState("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setState("error");
    }
  }, [encryptionKey, userId, displayName, books, apiClient]);

  const handleCancelChanges = useCallback(() => {
    setBooks(originalBooksRef.current);
    setIsDirty(false);
    setSelectedIds(new Set());
    setState("ready");
  }, []);

  const handleBatchShare = useCallback(() => {
    setBooks(prev => prev.map(b => selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.TRUE } : b));
    setSelectedIds(new Set());
    setIsDirty(true);
  }, [selectedIds]);

  const handleBatchHide = useCallback(() => {
    setBooks(prev => prev.map(b => selectedIds.has(b.bookId) ? { ...b, isShared: BoolFlag.FALSE } : b));
    setSelectedIds(new Set());
    setIsDirty(true);
  }, [selectedIds]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.bookId === bookId ? { ...b, isShared: b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE } : b,
      ),
    );
    setIsDirty(true);
  }, []);

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

  const statusFilteredBooks = useMemo(() => {
    if (statusFilter === "shared") return currentViewBooks.filter((b) => b.isShared === BoolFlag.TRUE);
    if (statusFilter === "not-shared") return currentViewBooks.filter((b) => b.isShared === BoolFlag.FALSE);
    return currentViewBooks;
  }, [currentViewBooks, statusFilter]);

  const {
    searchTerm,
    setSearchTerm,
    filteredItems: visibleBooks,
    isFiltering,
  } = useSearch(statusFilteredBooks);

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
      <div className="p-4 flex-1">
        <h2 className="text-xl font-bold text-gray-900 mb-3">
          個人書櫃
          <span className="text-gray-400 text-sm font-normal ml-2">({currentViewBooks.length} 本)</span>
        </h2>

        {showArchiveTabs && (
          <div role="tablist" className="flex border-b border-gray-200 mb-3">
            <button
              role="tab"
              aria-selected={archiveView === "active"}
              onClick={() => setArchiveView("active")}
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
              onClick={() => setArchiveView("archived")}
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

        <div className="flex gap-2 mb-3">
          {(["all", "shared", "not-shared"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              aria-pressed={statusFilter === f}
              className={`px-3 py-1.5 text-xs rounded-full ${
                statusFilter === f ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600"
              }`}
            >
              {f === "all" ? "全部" : f === "shared" ? "已開放" : "未開放"}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="搜尋書名或作者"
          aria-label="搜尋書名或作者"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />

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
          <div>
            {visibleBooks.map((book) => (
              <div key={book.bookId} className="flex items-center gap-3 py-3 border-b border-gray-100">
                <input
                  type="checkbox"
                  checked={selectedIds.has(book.bookId)}
                  onChange={() => toggleSelect(book.bookId)}
                  aria-label={`選取 ${book.title}`}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                />
                {book.coverUrl ? (
                  <img src={book.coverUrl} alt="" className="w-10 h-[54px] rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-[54px] rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <BookOpen size={18} className="text-gray-300" aria-hidden="true" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{book.title}</p>
                    {book.isArchived === BoolFlag.TRUE && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium flex-shrink-0">
                        封存
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{book.author}</p>
                </div>
                <button
                  onClick={() => handleToggle(book.bookId)}
                  aria-pressed={book.isShared === BoolFlag.TRUE}
                  aria-label={`${book.title} ${book.isShared === BoolFlag.TRUE ? "已開放分享" : "未開放分享"}`}
                  className={`px-3 py-1 text-xs rounded-full font-medium flex-shrink-0 ${
                    book.isShared === BoolFlag.TRUE
                      ? "bg-green-100 text-green-600"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {book.isShared === BoolFlag.TRUE ? "開放" : "未開放"}
                </button>
              </div>
            ))}
          </div>
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
    </div>
  );
}
