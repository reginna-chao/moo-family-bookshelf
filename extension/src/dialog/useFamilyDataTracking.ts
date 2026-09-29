import { useState, useCallback, useRef, useMemo, type RefObject } from "react";
import browser from "webextension-polyfill";
import { seenKey, chipsKey } from "../constants";
import { buildSeenBaseline } from "moo-family-bookshelf-shared/familyShelf/updateTracking";
import type { RawMembersData, StateSetter } from "./familyDataTypes";

/** The update-tracking fields the provider exposes on its context value. */
export interface FamilyDataTrackingView {
  updatedBookIds: Set<string>;
  hasBookshelfUpdates: boolean;
}

/** Every tracking setter and ref — all of them are used by `markBookshelfSeen`. */
export interface FamilyDataTrackingHandles {
  setFreshUpdateBookIds: StateSetter<Set<string>>;
  setChipBookIds: StateSetter<Set<string>>;
  freshUpdateBookIdsRef: RefObject<Set<string>>;
  chipBookIdsRef: RefObject<Set<string>>;
  rawMembersDataRef: RefObject<RawMembersData | null>;
}

export function useFamilyDataTrackingState(): [
  FamilyDataTrackingView,
  FamilyDataTrackingHandles,
] {
  // --- Update tracking state ---
  const [freshUpdateBookIds, setFreshUpdateBookIds] = useState<Set<string>>(
    new Set(),
  );
  const [chipBookIds, setChipBookIds] = useState<Set<string>>(new Set());
  const freshUpdateBookIdsRef = useRef<Set<string>>(new Set());
  freshUpdateBookIdsRef.current = freshUpdateBookIds;
  const chipBookIdsRef = useRef<Set<string>>(new Set());
  chipBookIdsRef.current = chipBookIds;
  const rawMembersDataRef = useRef<RawMembersData | null>(null);

  const updatedBookIds = useMemo(() => {
    const combined = new Set(freshUpdateBookIds);
    for (const id of chipBookIds) combined.add(id);
    return combined;
  }, [freshUpdateBookIds, chipBookIds]);

  const hasBookshelfUpdates = freshUpdateBookIds.size > 0;

  return [
    { updatedBookIds, hasBookshelfUpdates },
    {
      setFreshUpdateBookIds,
      setChipBookIds,
      freshUpdateBookIdsRef,
      chipBookIdsRef,
      rawMembersDataRef,
    },
  ];
}

export function useFamilyDataMarkSeen(
  userId: string,
  handles: FamilyDataTrackingHandles,
): () => void {
  const {
    setFreshUpdateBookIds,
    setChipBookIds,
    freshUpdateBookIdsRef,
    chipBookIdsRef,
    rawMembersDataRef,
  } = handles;
  return useCallback(() => {
    if (freshUpdateBookIdsRef.current.size === 0) return;

    const raw = rawMembersDataRef.current;
    if (!raw) return;

    // Update baseline from the wire members so each entry records the
    // `lastUpdated` the next load will be diffed against.
    const baseline = buildSeenBaseline(raw.members, raw.raw);

    // Merge fresh IDs into chips with 24h expiry
    const mergedChips = new Set(chipBookIdsRef.current);
    for (const id of freshUpdateBookIdsRef.current) mergedChips.add(id);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      void browser.storage.local.set({
        [seenKey(userId)]: baseline,
        [chipsKey(userId)]: { bookIds: [...mergedChips], expiresAt },
      });
    } catch {
      // Extension context invalidated
    }

    setChipBookIds(mergedChips);
    setFreshUpdateBookIds(new Set());
  }, [
    userId,
    setFreshUpdateBookIds,
    setChipBookIds,
    freshUpdateBookIdsRef,
    chipBookIdsRef,
    rawMembersDataRef,
  ]);
}
