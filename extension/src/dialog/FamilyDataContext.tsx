import React, { createContext, useContext } from "react";
import type { ApiClient } from "../api/client";
import { useFamilyShelfPrefs } from "./useFamilyShelfPrefs";
import type { FamilyDataState } from "./familyDataTypes";
import {
  useFamilyDataMembersState,
  useFamilyDataRefreshMembers,
  useFamilyDataMemberEdits,
} from "./useFamilyDataMembers";
import {
  useFamilyDataBookshelfState,
  useFamilyDataRefreshBookshelf,
} from "./useFamilyDataBookshelf";
import {
  useFamilyDataBorrowState,
  useFamilyDataBorrowActions,
} from "./useFamilyDataBorrow";
import {
  useFamilyDataTrackingState,
  useFamilyDataMarkSeen,
} from "./useFamilyDataTracking";
import {
  useFamilyDataMountedRefs,
  useFamilyDataInitialLoad,
  useFamilyDataStorageSync,
} from "./useFamilyDataEffects";
import { useFamilyDataValue } from "./useFamilyDataValue";

export type { MemberBooks } from "./familyDataTypes";

const FamilyDataContext = createContext<FamilyDataState | null>(null);

export function useFamilyData(): FamilyDataState {
  const ctx = useContext(FamilyDataContext);
  if (!ctx) {
    throw new Error("useFamilyData must be used within FamilyDataProvider");
  }
  return ctx;
}

interface FamilyDataProviderProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  /**
   * Monotonic counter; each change re-runs the initial load (members →
   * bookshelf → borrow) in place, preserving mounted component state. App bumps
   * it after a successful re-verification so a stale 401 view reloads itself.
   */
  reloadSignal?: number;
  children: React.ReactNode;
}

/**
 * The call order below mirrors the order these hooks had when they were all
 * declared inline here (state → shelf prefs → liveness refs → callbacks →
 * load / sync effects → value). Keep it: effects run and clean up in it.
 */
export function FamilyDataProvider({
  familyId,
  userId,
  apiClient,
  reloadSignal,
  children,
}: FamilyDataProviderProps) {
  const [membersView, membersSetters] = useFamilyDataMembersState();
  const [bookshelfView, bookshelfSetters] = useFamilyDataBookshelfState();
  const [borrowView, borrowSetters] = useFamilyDataBorrowState();
  const [trackingView, trackingHandles] = useFamilyDataTrackingState();

  // --- Viewer-private family-shelf prefs (hidden + favorites) (v1.5.0) ---
  const {
    hiddenRefs,
    isHidden,
    toggleHidden,
    favoriteRefs,
    isFavorite,
    toggleFavorite,
    syncFailed: prefsSyncFailed,
  } = useFamilyShelfPrefs(userId, apiClient);

  const { mountedRef, membersRef } = useFamilyDataMountedRefs(
    membersView.members,
  );

  const refreshMembers = useFamilyDataRefreshMembers({
    familyId,
    apiClient,
    mountedRef,
    membersRef,
    setters: membersSetters,
  });

  const refreshBookshelf = useFamilyDataRefreshBookshelf({
    familyId,
    apiClient,
    userId,
    mountedRef,
    membersRef,
    setters: bookshelfSetters,
    rawMembersDataRef: trackingHandles.rawMembersDataRef,
    setFreshUpdateBookIds: trackingHandles.setFreshUpdateBookIds,
    setChipBookIds: trackingHandles.setChipBookIds,
  });

  const { refreshBorrowRequests, applyBorrowStatus } =
    useFamilyDataBorrowActions({
      familyId,
      apiClient,
      mountedRef,
      setters: borrowSetters,
    });

  const { updateMemberDisplayName, updateMember } = useFamilyDataMemberEdits(
    membersSetters.setMembers,
    bookshelfSetters.setBookshelfMembers,
  );

  const markBookshelfSeen = useFamilyDataMarkSeen(userId, trackingHandles);

  useFamilyDataInitialLoad(
    refreshMembers,
    refreshBookshelf,
    refreshBorrowRequests,
    reloadSignal,
  );
  useFamilyDataStorageSync(userId, refreshBookshelf, updateMemberDisplayName);

  const value = useFamilyDataValue({
    familyId,
    userId,
    apiClient,
    ...membersView,
    ...bookshelfView,
    ...borrowView,
    refreshBorrowRequests,
    applyBorrowStatus,
    refreshMembers,
    refreshBookshelf,
    updateMemberDisplayName,
    updateMember,
    ...trackingView,
    markBookshelfSeen,
    hiddenRefs,
    isHidden,
    toggleHidden,
    favoriteRefs,
    isFavorite,
    toggleFavorite,
    prefsSyncFailed,
  });

  return (
    <FamilyDataContext.Provider value={value}>
      {children}
    </FamilyDataContext.Provider>
  );
}
