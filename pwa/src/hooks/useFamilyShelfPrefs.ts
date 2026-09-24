import { useState, useEffect, useRef, useCallback } from "react";
import type { ApiClient } from "@/api/client";
import { familyPrefRef } from "moo-family-bookshelf-shared/familyShelf/prefRefs";
import {
  FamilyPrefsSync,
  type FamilyPrefKind,
  type FamilyPrefsIo,
  type FamilyShelfPrefs,
} from "moo-family-bookshelf-shared/familyShelf/prefsSync";

export type { FamilyShelfPrefs };

/**
 * Viewer-private family-shelf preferences (v1.5.0) — React adapter.
 *
 * The load-once / debounce / flush-on-unmount lifecycle lives in the shared
 * `FamilyPrefsSync` controller (the Extension uses the same one); this hook
 * only owns the React state and wires the controller to mount / unmount and to
 * the `[userId, apiClient]` load trigger.
 */
export function useFamilyShelfPrefs(
  userId: string,
  apiClient: ApiClient,
): FamilyShelfPrefs {
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(new Set());
  const [favoriteRefs, setFavoriteRefs] = useState<Set<string>>(new Set());
  const [syncFailed, setSyncFailed] = useState(false);
  /**
   * Latest userId/apiClient, refreshed every render so any flush — including
   * the unmount one — reads current values, not those captured at mount.
   */
  const ioRef = useRef<FamilyPrefsIo>({ userId, api: apiClient });
  ioRef.current = { userId, api: apiClient };
  const [sync] = useState(
    () =>
      new FamilyPrefsSync({
        getIo: () => ioRef.current,
        onRefs: (kind, refs) =>
          kind === "hidden" ? setHiddenRefs(refs) : setFavoriteRefs(refs),
        onSyncFailed: setSyncFailed,
      }),
  );

  // detach() flushes a change still inside the debounce window, then clears
  // the timer. StrictMode's dev remount re-attaches the SAME controller.
  useEffect(() => {
    sync.attach();
    return () => sync.detach();
  }, [sync]);

  // `[userId, apiClient]` is the retry trigger: until a load succeeds a change
  // re-attempts it; afterwards the controller skips the body, so an identity
  // change never clobbers unsaved optimistic edits.
  useEffect(() => {
    sync.load();
  }, [sync, userId, apiClient]);

  const toggle = useCallback(
    (kind: FamilyPrefKind, ownerId: string, bookId: string) =>
      sync.toggle(kind, familyPrefRef(ownerId, bookId)),
    [sync],
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
