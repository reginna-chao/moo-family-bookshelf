import { useState, useEffect, useRef, useCallback } from "react";
import type { ApiClient } from "@/api/client";
import { familyPrefRef } from "./familyShelfPrefs";

/** Debounce window before flushing family-pref changes to the server. */
const FLUSH_DEBOUNCE_MS = 600;

/** Independent viewer-private preference kinds sharing one KV record. */
export type FamilyPrefKind = "hidden" | "favorites";

export interface FamilyShelfPrefs {
  hiddenRefs: Set<string>;
  isHidden: (ownerId: string, bookId: string) => boolean;
  toggleHidden: (ownerId: string, bookId: string) => void;
  favoriteRefs: Set<string>;
  isFavorite: (ownerId: string, bookId: string) => boolean;
  toggleFavorite: (ownerId: string, bookId: string) => void;
  /** True when the latest debounced flush failed (network or `{ error }`). */
  syncFailed: boolean;
}

type RefsByKind = Record<FamilyPrefKind, Set<string>>;

/**
 * Viewer-private family-shelf preferences (v1.5.0).
 *
 * Manages BOTH the `hidden` and `favorites` ref sets (independent — a book may
 * be both) from a SINGLE personal-books load. Exposes optimistic toggling and
 * flushes the COMPLETE current arrays for every kind (full replace) to the
 * server on ONE shared debounced, user-action-triggered timer. No polling.
 *
 * Adding a future kind = extend `FamilyPrefKind` + one thin public wrapper trio
 * below.
 */
export function useFamilyShelfPrefs(
  userId: string,
  apiClient: ApiClient,
): FamilyShelfPrefs {
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(new Set());
  const [favoriteRefs, setFavoriteRefs] = useState<Set<string>>(new Set());
  const [syncFailed, setSyncFailed] = useState(false);
  const mountedRef = useRef(true);
  /** Guards the mount-load body so it runs exactly once (never re-clobbers pending edits). */
  const didLoadRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest desired arrays per kind — read by the debounced flush. */
  const pendingRef = useRef<RefsByKind>({
    hidden: new Set(),
    favorites: new Set(),
  });
  /**
   * Latest fire-and-forget flush, refreshed every render so unmount cleanup
   * reads the current userId/apiClient (not the values captured at mount).
   *
   * `updateFamilyPrefs` never throws for HTTP/network errors — it resolves with
   * an `{ error }` envelope — but we also catch defensively. Either signal marks
   * the sync as failed; a later successful flush clears it. `setSyncFailed` is
   * guarded by `mountedRef` so the unmount flush cannot setState after unmount.
   */
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    void apiClient
      .updateFamilyPrefs(userId, {
        hidden: [...pendingRef.current.hidden],
        favorites: [...pendingRef.current.favorites],
      })
      .then((response) => {
        if (!mountedRef.current) return;
        setSyncFailed(Boolean(response.error));
      })
      .catch(() => {
        // Optimistic local state is the session source of truth.
        if (!mountedRef.current) return;
        setSyncFailed(true);
      });
  };

  const setterFor = (kind: FamilyPrefKind) =>
    kind === "hidden" ? setHiddenRefs : setFavoriteRefs;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the viewer's own refs once on mount (single GET). Tolerate errors.
  // Guarded by `didLoadRef` so an `apiClient` identity change never re-runs the
  // load body and clobbers unsaved optimistic edits held in `pendingRef`/state.
  useEffect(() => {
    if (didLoadRef.current) return;
    void (async () => {
      try {
        const response = await apiClient.getPersonalBooks(userId);
        if (!mountedRef.current) return;
        const hidden = response.data?.familyShelfPrefs?.hidden ?? [];
        const favorites = response.data?.familyShelfPrefs?.favorites ?? [];
        pendingRef.current = {
          hidden: new Set(hidden),
          favorites: new Set(favorites),
        };
        setHiddenRefs(new Set(hidden));
        setFavoriteRefs(new Set(favorites));
        didLoadRef.current = true;
      } catch {
        // Non-critical preferences — start empty on failure.
      }
    })();
  }, [userId, apiClient]);

  // On unmount, flush any pending change before clearing the timer so a
  // toggle made inside the debounce window is not silently lost.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        flushRef.current();
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushRef.current();
    }, FLUSH_DEBOUNCE_MS);
  }, []);

  const toggle = useCallback(
    (kind: FamilyPrefKind, ownerId: string, bookId: string) => {
      const ref = familyPrefRef(ownerId, bookId);
      setterFor(kind)((prev) => {
        const next = new Set(prev);
        if (next.has(ref)) {
          next.delete(ref);
        } else {
          next.add(ref);
        }
        pendingRef.current[kind] = next;
        return next;
      });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const isHidden = useCallback(
    (ownerId: string, bookId: string): boolean =>
      hiddenRefs.has(familyPrefRef(ownerId, bookId)),
    [hiddenRefs],
  );
  const toggleHidden = useCallback(
    (ownerId: string, bookId: string) => toggle("hidden", ownerId, bookId),
    [toggle],
  );

  const isFavorite = useCallback(
    (ownerId: string, bookId: string): boolean =>
      favoriteRefs.has(familyPrefRef(ownerId, bookId)),
    [favoriteRefs],
  );
  const toggleFavorite = useCallback(
    (ownerId: string, bookId: string) => toggle("favorites", ownerId, bookId),
    [toggle],
  );

  return {
    hiddenRefs,
    isHidden,
    toggleHidden,
    favoriteRefs,
    isFavorite,
    toggleFavorite,
    syncFailed,
  };
}
