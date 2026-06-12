import { useState, useEffect, useRef, useCallback } from "react";
import type { ApiClient } from "@/api/client";
import { familyPrefRef } from "./familyShelfPrefs";

/** Debounce window before flushing hidden-pref changes to the server. */
const FLUSH_DEBOUNCE_MS = 600;

export interface FamilyShelfPrefs {
  hiddenRefs: Set<string>;
  isHidden: (ownerId: string, bookId: string) => boolean;
  toggleHidden: (ownerId: string, bookId: string) => void;
}

/**
 * Viewer-private family-shelf hidden preferences (v1.5.0).
 *
 * Loads the viewer's own hidden refs once on mount, exposes optimistic
 * toggling, and flushes the COMPLETE current hidden array (full replace) to
 * the server on a debounced, user-action-triggered timer. No polling.
 */
export function useFamilyShelfPrefs(
  userId: string,
  apiClient: ApiClient,
): FamilyShelfPrefs {
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest desired hidden array — read by the debounced flush. */
  const pendingRef = useRef<string[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the viewer's own hidden refs once on mount. Tolerate errors silently.
  useEffect(() => {
    void (async () => {
      try {
        const response = await apiClient.getPersonalBooks(userId);
        if (!mountedRef.current) return;
        const hidden = response.data?.familyShelfPrefs?.hidden ?? [];
        setHiddenRefs(new Set(hidden));
      } catch {
        // Hidden is a non-critical preference — start empty on failure.
      }
    })();
  }, [userId, apiClient]);

  // Clear any pending flush timer on unmount.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  const isHidden = useCallback(
    (ownerId: string, bookId: string): boolean =>
      hiddenRefs.has(familyPrefRef(ownerId, bookId)),
    [hiddenRefs],
  );

  const toggleHidden = useCallback(
    (ownerId: string, bookId: string) => {
      const ref = familyPrefRef(ownerId, bookId);
      setHiddenRefs((prev) => {
        const next = new Set(prev);
        if (next.has(ref)) {
          next.delete(ref);
        } else {
          next.add(ref);
        }
        pendingRef.current = [...next];
        return next;
      });

      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        void apiClient
          .updateFamilyPrefs(userId, pendingRef.current)
          .catch(() => {
            // Optimistic local state is the session source of truth.
          });
      }, FLUSH_DEBOUNCE_MS);
    },
    [userId, apiClient],
  );

  return { hiddenRefs, isHidden, toggleHidden };
}
