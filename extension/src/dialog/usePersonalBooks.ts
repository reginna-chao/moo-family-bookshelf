import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BookEntry, BoolFlag, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import { importKey, encrypt, decrypt } from "../crypto/encrypt";
import { scrapeBooks, scrapeArchivedBooks } from "../content/scraper";
import { PERSONAL_BOOKS_CACHE_KEY } from "../constants";
import { mergeBooks, asDecryptedBooks } from "./mergeBooks";
import type { DecryptedBooks } from "./mergeBooks";
import { DecryptMismatchError } from "../errors";

export type PersonalBooksStatus = "scraping" | "ready" | "saving" | "saved" | "error";

export interface UsePersonalBooksParams {
  userId: string;
  apiClient: ApiClient;
  lastSyncBooks: BookEntry[];
}

interface LoadSavedResult {
  books: DecryptedBooks;
  /** Full decrypted payload — preserved so save can merge back unknown fields */
  raw: Record<string, unknown> | null;
}

async function loadSavedBooks(
  data: Record<string, unknown>,
  encKeyString: string,
): Promise<LoadSavedResult> {
  if (typeof data.payload === "string") {
    const key = await importKey(encKeyString);
    const decrypted = await decrypt(data.payload, key);
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    const books = Array.isArray(parsed.books) ? (parsed.books as BookEntry[]) : [];
    return { books: asDecryptedBooks(books), raw: parsed };
  }
  if (Array.isArray(data.books)) {
    return { books: asDecryptedBooks(data.books as BookEntry[]), raw: null };
  }
  return { books: asDecryptedBooks([]), raw: null };
}

export function usePersonalBooks({ userId, apiClient, lastSyncBooks }: UsePersonalBooksParams) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const originalBooks = useRef<BookEntry[]>([]);
  /** Raw decrypted payload — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<PersonalBooksStatus>("scraping");
  const [errorMessage, setErrorMessage] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  // Load books: scrape + fetch from API + merge
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const storageResult = await chrome.storage.local.get(["encryptionKey"]);
        const encKeyString = storageResult.encryptionKey as string | undefined;

        const scrapedBooks = await scrapeBooks();

        const archiveResult = await chrome.storage.local.get(["syncArchived"]);
        const syncArchivedSetting = (archiveResult.syncArchived as number | undefined) ?? BoolFlag.FALSE;
        let allScrapedBooks = [...scrapedBooks];
        if (syncArchivedSetting === BoolFlag.TRUE) {
          const archivedBooks = await scrapeArchivedBooks();
          allScrapedBooks = [...scrapedBooks, ...archivedBooks];
        }

        const apiResponse = await apiClient.getPersonalBooks(userId);

        if (cancelled) return;

        let savedBooks: DecryptedBooks = asDecryptedBooks([]);
        if (apiResponse.data && encKeyString) {
          try {
            const result = await loadSavedBooks(
              apiResponse.data as unknown as Record<string, unknown>,
              encKeyString,
            );
            savedBooks = result.books;
            savedRawPayload.current = result.raw;
          } catch {
            // Server has data we cannot decrypt — abort to prevent overwriting
            // valid ciphertext with data encrypted under a different key.
            throw new DecryptMismatchError();
          }
        }
        if (cancelled) return;

        const merged = mergeBooks(allScrapedBooks, savedBooks);
        chrome.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(merged) });
        originalBooks.current = merged;
        setBooks(merged);
        setStatus("ready");
      } catch (err) {
        console.error("[PersonalShelf] Error:", err);
        if (cancelled) return;
        if (err instanceof DecryptMismatchError) {
          setErrorMessage("偵測到加密金鑰不符，無法載入書籍設定。請確認同步代碼是否正確。");
        } else {
          setErrorMessage(err instanceof Error ? err.message : "載入失敗");
        }
        setStatus("error");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [userId, apiClient]);

  // Merge new books from auto-sync or manual sync
  useEffect(() => {
    if (lastSyncBooks.length > 0 && status === "ready") {
      setBooks((prev) => mergeBooks(
        lastSyncBooks.map((b) => ({
          bookId: b.bookId,
          title: b.title,
          author: b.author,
          coverUrl: b.coverUrl,
          readmooUrl: b.readmooUrl,
          category: b.category,
          isArchived: b.isArchived ?? BoolFlag.FALSE,
        })),
        asDecryptedBooks(prev),
      ));
    }
  }, [lastSyncBooks, status]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) => (b.bookId === bookId ? { ...b, isShared: b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE } : b)),
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
        ...savedRawPayload.current,
        schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
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
      chrome.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(books) });
      chrome.storage.local.set({ personalShelfSavedAt: Date.now() });
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
  }, []);

  return {
    books,
    setBooks,
    status,
    setStatus,
    errorMessage,
    isDirty,
    setIsDirty,
    originalBooks,
    handleToggle,
    handleSave,
    handleCancel,
  };
}
