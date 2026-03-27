import React, { useState, useEffect, useCallback } from "react";
import { ApiClient, BookEntry } from "../api/client";
import { importKey, encrypt, decrypt } from "../crypto/encrypt";
import { scrapeBooks } from "../content/scraper";
import { mergeBooks } from "./mergeBooks";
import { BookRow } from "./BookRow";
import { StatusFilterBar, StatusFilter } from "./StatusFilterBar";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";

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
  const [status, setStatus] = useState<Status>("scraping");
  const [errorMessage, setErrorMessage] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        console.log("[PersonalShelf] Starting load...");
        const storageResult = await chrome.storage.local.get(["encryptionKey"]);
        const encKeyString = storageResult.encryptionKey as string | undefined;
        console.log("[PersonalShelf] encryptionKey exists:", !!encKeyString);

        console.log("[PersonalShelf] Scraping books...");
        const scrapedBooks = await scrapeBooks();
        console.log("[PersonalShelf] Scraped books:", scrapedBooks.length, scrapedBooks);

        console.log("[PersonalShelf] Fetching saved books from API...");
        const apiResponse = await apiClient.getPersonalBooks(userId);
        console.log("[PersonalShelf] API response:", apiResponse);

        if (cancelled) return;

        let savedBooks: BookEntry[] = [];
        if (apiResponse.data && encKeyString) {
          console.log("[PersonalShelf] Decrypting saved books...");
          try {
            savedBooks = await loadSavedBooks(
              apiResponse.data as unknown as Record<string, unknown>,
              encKeyString,
            );
            console.log("[PersonalShelf] Saved books:", savedBooks.length);
          } catch (decryptErr) {
            // Decryption failed — likely key mismatch from reinstall.
            // Treat as no saved data; user can re-save with current key.
            console.warn("[PersonalShelf] Decrypt failed, ignoring saved data:", decryptErr);
            savedBooks = [];
          }
        }
        if (cancelled) return;

        const merged = mergeBooks(scrapedBooks, savedBooks);
        console.log("[PersonalShelf] Merged books:", merged.length);
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

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) => (b.bookId === bookId ? { ...b, isShared: !b.isShared } : b)),
    );
    setIsDirty(true);
  }, []);

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
      setIsDirty(false);
      setStatus("saved");
      setTimeout(() => setStatus("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setStatus("error");
    }
  }, [books, userId, apiClient]);

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

  const saveBackground = !isDirty ? "#e2e8f0" : status === "saving" ? "#93c5fd" : "#2563eb";
  const saveLabel = status === "saving" ? "儲存中..." : status === "saved" ? "已儲存" : "儲存變更";

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        個人書櫃管理
        <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: 13 }}>
          ({books.length} 本)
        </span>
      </h3>

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
        </>
      )}

      {books.length === 0 && (
        <p style={{ color: "#94a3b8", textAlign: "center", marginTop: 24 }}>尚無書籍</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {displayedBooks.map((book) => (
          <BookRow key={book.bookId} book={book} onToggle={handleToggle} />
        ))}
      </div>

      {books.length > 0 && (
        <button
          onClick={handleSave}
          disabled={!isDirty || status === "saving"}
          style={{
            width: "100%",
            marginTop: 16,
            padding: 12,
            border: "none",
            borderRadius: 8,
            background: saveBackground,
            color: !isDirty ? "#94a3b8" : "white",
            fontWeight: 600,
            cursor: !isDirty || status === "saving" ? "not-allowed" : "pointer",
          }}
        >
          {saveLabel}
        </button>
      )}
    </div>
  );
}
