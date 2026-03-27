import { useState, useEffect, useCallback, useMemo } from "react";
import type { ApiClient, BookEntry } from "@/api/client";
import { importKey, encrypt, decrypt } from "@/crypto/encrypt";
import { useSearch } from "@/hooks/useSearch";

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

      const raw = response.data as unknown as { payload?: string };
      if (!raw?.payload) {
        setBooks([]);
        setState("ready");
        return;
      }

      const key = await importKey(encryptionKey);
      const decrypted = await decrypt(raw.payload, key);
      const parsed: unknown = JSON.parse(decrypted);

      if (typeof parsed !== "object" || parsed === null) {
        setBooks([]);
        setState("ready");
        return;
      }

      const obj = parsed as Record<string, unknown>;
      setDisplayName(typeof obj.displayName === "string" ? obj.displayName : "");
      const rawBooks = Array.isArray(obj.books) ? (obj.books as BookEntry[]) : [];
      // Normalize isShared: Extension stores boolean, PWA uses 0|1
      setBooks(rawBooks.map((b) => ({ ...b, isShared: b.isShared ? (1 as const) : (0 as const) })));
      setIsDirty(false);
      setState("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "載入失敗");
      setState("error");
    }
  }, [userId, apiClient, encryptionKey]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.bookId === bookId ? { ...b, isShared: b.isShared === 1 ? (0 as const) : (1 as const) } : b,
      ),
    );
    setIsDirty(true);
    setState("ready");
  }, []);

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
      setIsDirty(false);
      setState("saved");
      setTimeout(() => setState("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setState("error");
    }
  }, [encryptionKey, userId, displayName, books, apiClient]);

  const statusFilteredBooks = useMemo(() => {
    if (statusFilter === "shared") return books.filter((b) => b.isShared === 1);
    if (statusFilter === "not-shared") return books.filter((b) => b.isShared === 0);
    return books;
  }, [books, statusFilter]);

  const {
    searchTerm,
    setSearchTerm,
    filteredItems: visibleBooks,
    isFiltering,
  } = useSearch(statusFilteredBooks);

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
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-3">
        個人書櫃
        <span className="text-gray-400 text-sm font-normal ml-2">({books.length} 本)</span>
      </h2>

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

      {isFiltering && (
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
              {book.coverUrl ? (
                <img src={book.coverUrl} alt="" className="w-10 h-[54px] rounded object-cover flex-shrink-0" />
              ) : (
                <div className="w-10 h-[54px] rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-gray-300 text-lg" aria-hidden="true">📖</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{book.title}</p>
                <p className="text-xs text-gray-500 truncate">{book.author}</p>
              </div>
              <button
                onClick={() => handleToggle(book.bookId)}
                aria-pressed={book.isShared === 1}
                aria-label={`${book.title} ${book.isShared === 1 ? "已開放分享" : "未開放分享"}`}
                className={`px-3 py-1 text-xs rounded-full font-medium flex-shrink-0 ${
                  book.isShared === 1
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {book.isShared === 1 ? "開放" : "未開放"}
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => void handleSave()}
        disabled={!isDirty || state === "saving"}
        className={`w-full mt-4 py-3 rounded-lg font-semibold text-sm transition-colors ${
          !isDirty
            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
            : state === "saving"
              ? "bg-blue-400 text-white cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700"
        }`}
      >
        {state === "saving" ? "儲存中..." : state === "saved" ? "已儲存" : "儲存變更"}
      </button>
    </div>
  );
}
