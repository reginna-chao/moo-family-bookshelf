import { useState, useCallback, useRef } from "react";
import {
  scrapeUserEmail,
  scrapeDisplayName,
  scrapeBooks,
  formatScrapeProgress,
} from "../content/scraper";
import { mergeBooks } from "./mergeBooks";
import { ApiClient, BookEntry, PersonalBooks, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import { USER_EMAIL_KEY, DISPLAY_NAME_KEY } from "../constants";

export type AutoSetupPhase =
  | "idle"
  | "scraping-profile"
  | "scraping-books"
  | "done"
  | "error";

const STATIC_PHASE_MESSAGES: Record<AutoSetupPhase, string> = {
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
 * Parses the API response as plain JSON — returns BookEntry[] directly.
 */
function extractSavedBooks(
  data: unknown,
): BookEntry[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
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
  /** Step 2: after family setup, auto-navigate to #/library, scrape + upload */
  syncBooks: (params: AutoBookSyncParams) => Promise<boolean>;
  /** Reset to idle */
  reset: () => void;
}

export function useAutoSetup(): UseAutoSetupReturn {
  const [phase, setPhase] = useState<AutoSetupPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [progressMessage, setProgressMessage] = useState("");
  const originalHashRef = useRef(window.location.hash);

  const restoreHash = useCallback(() => {
    window.location.hash = originalHashRef.current || "#/";
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setErrorMessage("");
    setProgressMessage("");
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
        [USER_EMAIL_KEY]: result.email,
        [DISPLAY_NAME_KEY]: result.displayName,
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
      setProgressMessage("");

      try {
        const scrapedBooks = await navigateAndRun("#/library", () =>
          scrapeBooks({
            onProgress: (page, count) =>
              setProgressMessage(formatScrapeProgress(page, count)),
          }),
        );

        // Fetch existing saved books for merging (plain JSON)
        const apiResponse = await apiClient.getPersonalBooks(userId);
        const savedBooks = extractSavedBooks(apiResponse.data);

        const merged = mergeBooks(scrapedBooks, savedBooks);

        const personalBooks: PersonalBooks = {
          schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
          userId,
          displayName: "",
          books: merged,
          lastUpdated: new Date().toISOString(),
        };
        const uploadResponse = await apiClient.updatePersonalBooks(userId, personalBooks);

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

  const phaseMessage =
    phase === "scraping-books" && progressMessage
      ? progressMessage
      : STATIC_PHASE_MESSAGES[phase];

  return {
    phase,
    phaseMessage,
    errorMessage,
    scrapeProfile,
    syncBooks,
    reset,
  };
}
