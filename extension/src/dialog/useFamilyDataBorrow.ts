import { useState, useCallback } from "react";
import type { ApiClient, BorrowRequest, BorrowStatus } from "../api/client";
import type {
  BorrowLoadState,
  MountedRef,
  StateSetter,
} from "./familyDataTypes";

/** The borrow-request fields the provider exposes on its context value. */
export interface FamilyDataBorrowView {
  borrowRequests: BorrowRequest[];
  borrowRequestsState: BorrowLoadState;
  borrowRequestsError: string | null;
}

/** Every borrow-request setter — all of them are written by the borrow actions. */
export interface FamilyDataBorrowSetters {
  setBorrowRequests: StateSetter<BorrowRequest[]>;
  setBorrowRequestsState: StateSetter<BorrowLoadState>;
  setBorrowRequestsError: StateSetter<string | null>;
}

export function useFamilyDataBorrowState(): [
  FamilyDataBorrowView,
  FamilyDataBorrowSetters,
] {
  // --- Borrow requests state ---
  const [borrowRequests, setBorrowRequests] = useState<BorrowRequest[]>([]);
  const [borrowRequestsState, setBorrowRequestsState] =
    useState<BorrowLoadState>("idle");
  const [borrowRequestsError, setBorrowRequestsError] = useState<string | null>(
    null,
  );
  return [
    { borrowRequests, borrowRequestsState, borrowRequestsError },
    { setBorrowRequests, setBorrowRequestsState, setBorrowRequestsError },
  ];
}

interface BorrowActionsOptions {
  familyId: string;
  apiClient: ApiClient;
  mountedRef: MountedRef;
  setters: FamilyDataBorrowSetters;
}

export function useFamilyDataBorrowActions({
  familyId,
  apiClient,
  mountedRef,
  setters,
}: BorrowActionsOptions): {
  refreshBorrowRequests: () => Promise<void>;
  applyBorrowStatus: (requestId: string, status: BorrowStatus) => void;
} {
  const { setBorrowRequests, setBorrowRequestsState, setBorrowRequestsError } =
    setters;

  const refreshBorrowRequests = useCallback(async () => {
    setBorrowRequestsState((prev) =>
      prev === "loaded" ? "loaded" : "loading",
    );
    setBorrowRequestsError(null);
    try {
      const requests = await apiClient.listBorrowRequests(familyId);
      if (!mountedRef.current) return;
      setBorrowRequests(requests);
      setBorrowRequestsState("loaded");
    } catch (err) {
      if (!mountedRef.current) return;
      setBorrowRequestsError(err instanceof Error ? err.message : "載入失敗");
      setBorrowRequestsState("error");
    }
  }, [
    familyId,
    apiClient,
    mountedRef,
    setBorrowRequests,
    setBorrowRequestsState,
    setBorrowRequestsError,
  ]);

  const applyBorrowStatus = useCallback(
    (requestId: string, status: BorrowStatus) => {
      setBorrowRequests((prev) =>
        prev.map((r) => (r.requestId === requestId ? { ...r, status } : r)),
      );
    },
    [setBorrowRequests],
  );

  return { refreshBorrowRequests, applyBorrowStatus };
}
