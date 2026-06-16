import { useEffect, useRef } from "react";
import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import { isExtensionContextValid } from "../utils/extensionContext";
import { TOKEN_EXPIRES_AT_KEY } from "../constants";

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * Proactive token refresh hook — "三位一體" strategy:
 * 1. setTimeout — schedule refresh before token expires
 * 2. visibilitychange — recalibrate when user returns to page
 * 3. 401 interceptor — already handled in ApiClient
 */
export function useTokenRefresh(apiClient: ApiClient): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function scheduleRefresh() {
      // Guard: after extension reload, chrome.* APIs are unavailable
      if (!isExtensionContextValid()) return;

      let tokenExpiresAt: number | undefined;
      try {
        const result = await browser.storage.local.get(TOKEN_EXPIRES_AT_KEY);
        tokenExpiresAt = result[TOKEN_EXPIRES_AT_KEY] as number | undefined;
      } catch {
        // Extension context may have been invalidated between the check and the call
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (!tokenExpiresAt) return; // No token info, skip

      const delay = (tokenExpiresAt as number) - Date.now() - REFRESH_BUFFER_MS;

      if (delay <= 0) {
        // Already expired or about to expire — refresh immediately
        const success = await apiClient.proactiveRefresh();
        if (success) {
          // Re-read tokenExpiresAt to see if it was updated by the refresh
          try {
            const updated = await browser.storage.local.get(TOKEN_EXPIRES_AT_KEY);
            const newExpiry = updated[TOKEN_EXPIRES_AT_KEY] as number | undefined;
            const newDelay = newExpiry
              ? newExpiry - Date.now() - REFRESH_BUFFER_MS
              : 0;
            if (newDelay > 0) {
              timerRef.current = setTimeout(scheduleRefresh, newDelay);
            }
            // If delay is still <= 0, stop — refresh already happened, nothing to schedule
          } catch {
            // Extension context invalidated
          }
        }
      } else {
        // Schedule future refresh
        timerRef.current = setTimeout(scheduleRefresh, delay);
      }
    }

    // Initial schedule on mount
    scheduleRefresh();

    // visibilitychange handler — recalibrate on page focus
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && isExtensionContextValid()) {
        scheduleRefresh();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [apiClient]);
}
