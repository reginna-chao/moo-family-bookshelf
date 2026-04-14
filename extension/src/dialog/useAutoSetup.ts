import { useState, useCallback, useRef } from "react";
import { scrapeUserEmail, scrapeDisplayName, scrapeBooks } from "../content/scraper";
import { importKey, encrypt, decrypt } from "../crypto/encrypt";
import { mergeBooks } from "./mergeBooks";
import { ApiClient, BookEntry } from "../api/client";

export type AutoSetupPhase =
  | "idle"
  | "scraping-profile"
  | "scraping-books"
  | "done"
  | "error";

const PHASE_MESSAGES: Record<AutoSetupPhase, string> = {
  idle: "",
  "scraping-profile": "正在取得帳號資訊...",
  "scraping-books": "正在同步書單...",
  done: "完成！",
  error: "",
};

/** Delay in ms to wait for page render after hash navigation */
const NAV_SETTLE_MS = 1500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract saved books from the personal books API response.
 * Handles the encrypted `{ payload }` shape and a legacy `{ books }` fallback.
 * Returns an empty list on decrypt failure (expected after solo recovery key
 * rotation) so the caller can continue with a fresh merge + upload.
 */
async function extractSavedBooks(
  data: unknown,
  key: CryptoKey,
): Promise<BookEntry[]> {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (typeof record.payload === "string") {
    try {
      const decrypted = await decrypt(record.payload, key);
      const parsed = JSON.parse(decrypted) as Record<string, unknown>;
      if (Array.isArray(parsed.books)) return parsed.books as BookEntry[];
      return [];
    } catch {
      // Key mismatch (e.g., after solo recovery fingerprint rotation).
      // Falling back to empty means the caller will upload a fresh list
      // encrypted under the current key — the old ciphertext is discarded.
      console.debug("[AutoSetup] Decrypt failed, continuing with empty saved books");
      return [];
    }
  }
  if (Array.isArray(record.books)) return record.books as BookEntry[];
  return [];
}

/**
 * Navigate the host SPA to a hash route, wait for render, then run a task.
 * Returns the result of the task function.
 */
async function navigateAndRun<T>(hash: string, task: () => T | Promise<T>): Promise<T> {
  window.location.hash = hash;
  await wait(NAV_SETTLE_MS);
  return task();
}

export interface AutoSetupResult {
  email: string;
  displayName: string;
}

export interface AutoBookSyncParams {
  userId: string;
  apiClient: ApiClient;
}

export interface UseAutoSetupReturn {
  phase: AutoSetupPhase;
  phaseMessage: string;
  errorMessage: string;
  /** Step 1: auto-navigate to #/me and scrape profile */
  scrapeProfile: () => Promise<AutoSetupResult | null>;
  /** Step 2: after family setup, auto-navigate to #/library, scrape + encrypt + upload */
  syncBooks: (params: AutoBookSyncParams) => Promise<boolean>;
  /** Reset to idle */
  reset: () => void;
}

export function useAutoSetup(): UseAutoSetupReturn {
  const [phase, setPhase] = useState<AutoSetupPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const originalHashRef = useRef(window.location.hash);

  const restoreHash = useCallback(() => {
    window.location.hash = originalHashRef.current || "#/";
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setErrorMessage("");
  }, []);

  const scrapeProfile = useCallback(async (): Promise<AutoSetupResult | null> => {
    originalHashRef.current = window.location.hash;
    setPhase("scraping-profile");
    setErrorMessage("");

    try {
      const result = await navigateAndRun("#/me", () => {
        const email = scrapeUserEmail();
        const displayName = scrapeDisplayName() ?? "";
        return { email, displayName };
      });

      if (!result.email) {
        setErrorMessage("無法取得帳號信箱，請確認已登入讀墨帳號。");
        setPhase("error");
        restoreHash();
        return null;
      }

      await chrome.storage.local.set({
        userEmail: result.email,
        displayName: result.displayName,
      });

      restoreHash();
      setPhase("idle");
      return { email: result.email, displayName: result.displayName };
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取得帳號資訊失敗");
      setPhase("error");
      restoreHash();
      return null;
    }
  }, [restoreHash]);

  const syncBooks = useCallback(
    async ({ userId, apiClient }: AutoBookSyncParams): Promise<boolean> => {
      originalHashRef.current = window.location.hash;
      setPhase("scraping-books");
      setErrorMessage("");

      try {
        const scrapedBooks = await navigateAndRun("#/library", () => scrapeBooks());

        const storageResult = await chrome.storage.local.get(["encryptionKey"]);
        const encKeyString = storageResult.encryptionKey as string | undefined;
        if (!encKeyString) throw new Error("找不到加密金鑰");

        // Import the key once and share it between decrypt (for existing saved
        // books) and encrypt (for the merged upload).
        const key = await importKey(encKeyString);

        // Fetch existing saved books for merging. The server stores data as
        // `{ payload: "<ciphertext>" }` — decrypt before merging so that
        // previously-set `isShared` flags are preserved.
        const apiResponse = await apiClient.getPersonalBooks(userId);
        const savedBooks = await extractSavedBooks(apiResponse.data, key);

        const merged = mergeBooks(scrapedBooks, savedBooks);

        const payload = JSON.stringify({
          userId,
          displayName: "",
          books: merged,
          lastUpdated: new Date().toISOString(),
        });
        const encrypted = await encrypt(payload, key);
        const uploadResponse = await apiClient.updatePersonalBooks(userId, encrypted);

        if (uploadResponse.error) {
          setErrorMessage(uploadResponse.error.message);
          setPhase("error");
          restoreHash();
          return false;
        }

        restoreHash();
        setPhase("done");
        return true;
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "同步書單失敗");
        setPhase("error");
        restoreHash();
        return false;
      }
    },
    [restoreHash],
  );

  return {
    phase,
    phaseMessage: PHASE_MESSAGES[phase],
    errorMessage,
    scrapeProfile,
    syncBooks,
    reset,
  };
}
