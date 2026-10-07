import { useState, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import { scrapeBooks, formatScrapeProgress } from "../content/scraper";
import { navigateAndRun, readMePageProfile } from "../content/hashNavigation";
import { resetScrapeWarnings } from "../content/readmoo-dom";
import { ApiClient } from "../api/client";
import { uploadOnboardingBooks } from "./onboardingBooksUpload";
import { verifyAccountIdentity } from "./accountIdentityCheck";
import { ACCOUNT_UNCONFIRMED_SYNC_MESSAGE } from "./AccountCheckContext";
import {
  USER_EMAIL_KEY,
  DISPLAY_NAME_KEY,
  LAST_SYNC_AT_KEY,
} from "../constants";
import { booksSaveErrorText } from "moo-family-bookshelf-shared/personal/saveErrors";

export type AutoSetupPhase =
  "idle" | "scraping-profile" | "scraping-books" | "done" | "error";

const STATIC_PHASE_MESSAGES: Record<AutoSetupPhase, string> = {
  idle: "",
  "scraping-profile": "正在取得帳號資訊...",
  "scraping-books": "正在同步書單...",
  done: "完成！",
  error: "",
};

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

  // readMePageProfile restores the hash itself, on every path.
  const scrapeProfile =
    useCallback(async (): Promise<AutoSetupResult | null> => {
      setPhase("scraping-profile");
      setErrorMessage("");

      try {
        const result = await readMePageProfile();

        if (!result.email) {
          setErrorMessage("無法取得帳號信箱，請確認已登入讀墨帳號。");
          setPhase("error");
          return null;
        }

        await browser.storage.local.set({
          [USER_EMAIL_KEY]: result.email,
          [DISPLAY_NAME_KEY]: result.displayName,
        });

        setPhase("idle");
        return { email: result.email, displayName: result.displayName };
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "取得帳號資訊失敗",
        );
        setPhase("error");
        return null;
      }
    }, []);

  const syncBooks = useCallback(
    async ({ userId, apiClient }: AutoBookSyncParams): Promise<boolean> => {
      originalHashRef.current = window.location.hash;
      setPhase("scraping-books");
      setErrorMessage("");
      setProgressMessage("");

      // A scrape ENTRY POINT owns the warn-once reset (content/readmoo-dom.ts): otherwise a path an
      // earlier sync this page session already warned about stays silent in onboarding.
      resetScrapeWarnings();

      try {
        const scrapedBooks = await navigateAndRun("#/library", () =>
          scrapeBooks({
            onProgress: (page, count) =>
              setProgressMessage(formatScrapeProgress(page, count)),
          }),
        );

        // A failed read or a redesign-shaped scrape throws → catch below
        // (error phase, no upload).

        // Re-check AFTER the scrape (issue #281): another tab may have switched
        // accounts since #/me was read at the start of onboarding, or mid-scrape.
        if ((await verifyAccountIdentity(userId)) !== "match") {
          setErrorMessage(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE);
          setPhase("error");
          restoreHash();
          return false;
        }

        const uploadError = await uploadOnboardingBooks({
          apiClient,
          userId,
          scrapedBooks,
        });

        if (uploadError) {
          setErrorMessage(
            booksSaveErrorText(uploadError, "同步書單失敗，請稍後再試"),
          );
          setPhase("error");
          restoreHash();
          return false;
        }

        // Record the sync time so the mount auto-sync (canAutoSync() via LAST_SYNC_AT_KEY) does not
        // treat a freshly onboarded user as never-synced and sync twice.
        await browser.storage.local.set({ [LAST_SYNC_AT_KEY]: Date.now() });

        restoreHash();
        setPhase("done");
        return true;
      } catch (err) {
        // A scrape failure must not leave the account unconfirmed: a still-
        // matching account refreshes the cache so the mount auto-sync retries.
        await verifyAccountIdentity(userId);
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
