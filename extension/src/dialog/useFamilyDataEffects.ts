import { useEffect, useRef } from "react";
import browser from "webextension-polyfill";
import type { FamilyMember } from "../api/client";
import { PERSONAL_SHELF_SAVED_AT_KEY, DISPLAY_NAME_KEY } from "../constants";

/**
 * The provider's liveness flag plus a render-synced mirror of `members`
 * (read by `refreshBookshelf` to build its name map without depending on
 * `members`, and written by `refreshMembers` ahead of the next render).
 */
export function useFamilyDataMountedRefs(members: FamilyMember[]) {
  const mountedRef = useRef(true);
  const membersRef = useRef<FamilyMember[]>([]);
  membersRef.current = members;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { mountedRef, membersRef };
}

export function useFamilyDataInitialLoad(
  refreshMembers: () => Promise<void>,
  refreshBookshelf: () => Promise<void>,
  refreshBorrowRequests: () => Promise<void>,
  reloadSignal: number | undefined,
): void {
  // Fetch on mount (and again whenever reloadSignal changes): members first,
  // then bookshelf + borrow requests. refreshMembers/refreshBookshelf keep a
  // "ready" state instead of flashing "loading", so an in-place reload after
  // re-verification simply replaces the prior error/data.
  useEffect(() => {
    void (async () => {
      await refreshMembers();
      void refreshBookshelf();
      void refreshBorrowRequests();
    })();
  }, [refreshMembers, refreshBookshelf, refreshBorrowRequests, reloadSignal]);
}

export function useFamilyDataStorageSync(
  userId: string,
  refreshBookshelf: () => Promise<void>,
  updateMemberDisplayName: (userId: string, displayName: string) => void,
): void {
  // S4: single storage listener for cross-component sync
  useEffect(() => {
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes[PERSONAL_SHELF_SAVED_AT_KEY]) {
        void refreshBookshelf();
      }
      if (changes[DISPLAY_NAME_KEY]) {
        const newName = (changes[DISPLAY_NAME_KEY].newValue as string) ?? "";
        updateMemberDisplayName(userId, newName);
      }
    };
    try {
      browser.storage.onChanged.addListener(listener);
    } catch {
      // Extension context may be invalidated
    }
    return () => {
      try {
        browser.storage.onChanged.removeListener(listener);
      } catch {
        // Extension context may be invalidated
      }
    };
  }, [userId, refreshBookshelf, updateMemberDisplayName]);
}
