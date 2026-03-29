import { useEffect, useRef } from "react";
import type { ApiClient } from "../api/client";

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
      const { tokenExpiresAt } = await chrome.storage.local.get("tokenExpiresAt");

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
          scheduleRefresh();
        }
      } else {
        // Schedule future refresh
        timerRef.current = setTimeout(async () => {
          const success = await apiClient.proactiveRefresh();
          if (success) {
            scheduleRefresh();
          }
        }, delay);
      }
    }

    // Initial schedule on mount
    scheduleRefresh();

    // visibilitychange handler — recalibrate on page focus
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
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
