import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import browser from "webextension-polyfill";
import {
  ApiClient,
  BookEntry,
  BoolFlag,
  BorrowRequest,
  BorrowStatus,
  FamilyMember,
  FamilyGroup,
  FamilyBookshelf,
} from "../api/client";
import {
  seenKey,
  chipsKey,
  PERSONAL_SHELF_SAVED_AT_KEY,
  DISPLAY_NAME_KEY,
} from "../constants";
import {
  computeFreshBookIds,
  loadValidChipBookIds,
  buildSeenBaseline,
  type BookshelfSeenRecord,
  type BookshelfChipsRecord,
} from "./updateTracking";
import { useFamilyShelfPrefs } from "./useFamilyShelfPrefs";

/** Member bookshelf for family shelf display */
export interface MemberBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
}

type LoadState = "loading" | "ready" | "error";
type BorrowLoadState = "idle" | "loading" | "loaded" | "error";

interface FamilyDataState {
  /** Identity / API access — exposed for borrow flow consumers. */
  familyId: string;
  userId: string;
  apiClient: ApiClient;

  /** Family members list from getFamilyMembers */
  members: FamilyMember[];
  ownerId: string;
  membersState: LoadState;
  membersError: string;
  familyEndpoint: string | undefined;

  /** Bookshelf data from getFamilyBookshelf */
  bookshelfMembers: MemberBooks[];
  bookshelfState: LoadState;
  bookshelfError: string;

  /** Borrow requests list (v1.1.0) */
  borrowRequests: BorrowRequest[];
  borrowRequestsState: BorrowLoadState;
  borrowRequestsError: string | null;
  refreshBorrowRequests: () => Promise<void>;
  /**
   * Optimistically set a borrow request's status locally after a successful
   * PATCH, without re-fetching. Avoids KV eventual-consistency read-after-write
   * clobbering the confirmed state back to stale data.
   */
  applyBorrowStatus: (requestId: string, status: BorrowStatus) => void;

  /** Refresh functions for child components */
  refreshMembers: () => Promise<void>;
  refreshBookshelf: () => Promise<void>;
  /** Update a member's display name locally (optimistic) */
  updateMemberDisplayName: (userId: string, displayName: string) => void;
  /** Replace a single member entry locally from a server PATCH response. */
  updateMember: (member: FamilyMember) => void;
  /** Set of bookIds with "更新" chip (fresh + unexpired chips) */
  updatedBookIds: Set<string>;
  /** Whether there are unseen bookshelf updates (drives red dot) */
  hasBookshelfUpdates: boolean;
  /** Mark current bookshelf as seen: clears red dot, preserves chips for 24h */
  markBookshelfSeen: () => void;

  /** Viewer-private family-shelf hidden refs (v1.5.0). */
  hiddenRefs: Set<string>;
  /** Whether a given copy-scoped card is hidden by the viewer. */
  isHidden: (ownerId: string, bookId: string) => boolean;
  /** Toggle a card's hidden state (optimistic + debounced server flush). */
  toggleHidden: (ownerId: string, bookId: string) => void;

  /** Viewer-private family-shelf favorite refs (v1.5.0). */
  favoriteRefs: Set<string>;
  /** Whether a given copy-scoped card is favorited by the viewer. */
  isFavorite: (ownerId: string, bookId: string) => boolean;
  /** Toggle a card's favorite state (optimistic + debounced server flush). */
  toggleFavorite: (ownerId: string, bookId: string) => void;
  /** True when the latest prefs flush failed; changes stay staged locally. */
  prefsSyncFailed: boolean;
}

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

export function FamilyDataProvider({
  familyId,
  userId,
  apiClient,
  reloadSignal,
  children,
}: FamilyDataProviderProps) {
  // --- Members state ---
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [membersState, setMembersState] = useState<LoadState>("loading");
  const [membersError, setMembersError] = useState("");
  const [familyEndpoint, setFamilyEndpoint] = useState<string | undefined>(
    undefined,
  );

  // --- Bookshelf state ---
  const [bookshelfMembers, setBookshelfMembers] = useState<MemberBooks[]>([]);
  const [bookshelfState, setBookshelfState] = useState<LoadState>("loading");
  const [bookshelfError, setBookshelfError] = useState("");

  // --- Borrow requests state ---
  const [borrowRequests, setBorrowRequests] = useState<BorrowRequest[]>([]);
  const [borrowRequestsState, setBorrowRequestsState] =
    useState<BorrowLoadState>("idle");
  const [borrowRequestsError, setBorrowRequestsError] = useState<string | null>(
    null,
  );

  // --- Update tracking state ---
  const [freshUpdateBookIds, setFreshUpdateBookIds] = useState<Set<string>>(
    new Set(),
  );
  const [chipBookIds, setChipBookIds] = useState<Set<string>>(new Set());
  const freshUpdateBookIdsRef = useRef<Set<string>>(new Set());
  freshUpdateBookIdsRef.current = freshUpdateBookIds;
  const chipBookIdsRef = useRef<Set<string>>(new Set());
  chipBookIdsRef.current = chipBookIds;
  const rawMembersDataRef = useRef<{
    members: MemberBooks[];
  } | null>(null);

  const updatedBookIds = useMemo(() => {
    const combined = new Set(freshUpdateBookIds);
    for (const id of chipBookIds) combined.add(id);
    return combined;
  }, [freshUpdateBookIds, chipBookIds]);

  const hasBookshelfUpdates = freshUpdateBookIds.size > 0;

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

  const mountedRef = useRef(true);
  const membersRef = useRef<FamilyMember[]>([]);
  membersRef.current = members;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshMembers = useCallback(async () => {
    setMembersState((prev) => (prev === "ready" ? prev : "loading"));
    setMembersError("");
    try {
      const response = await apiClient.getFamilyMembers(familyId);
      if (!mountedRef.current) return;
      if (response.error) {
        setMembersError(response.error.message);
        setMembersState("error");
        return;
      }
      if (response.data) {
        setMembers(response.data.members);
        membersRef.current = response.data.members;
        setOwnerId(response.data.ownerId);
        setFamilyEndpoint(
          (response.data as FamilyGroup & { apiEndpoint?: string | null })
            .apiEndpoint ?? undefined,
        );
      }
      setMembersState("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      setMembersError(err instanceof Error ? err.message : "載入失敗");
      setMembersState("error");
    }
  }, [familyId, apiClient]);

  const refreshBookshelf = useCallback(async () => {
    setBookshelfState((prev) => (prev === "ready" ? prev : "loading"));
    setBookshelfError("");
    try {
      const response = await apiClient.getFamilyBookshelf(familyId);
      if (!mountedRef.current) return;

      if (response.error) {
        setBookshelfError(response.error.message);
        setBookshelfState("error");
        return;
      }

      const data: FamilyBookshelf | undefined = response.data;
      if (!data) {
        setBookshelfState("ready");
        return;
      }

      // Build name map from current members state
      const memberNameMap = new Map<string, string>();
      for (const m of membersRef.current) {
        if (m.displayName) memberNameMap.set(m.userId, m.displayName);
      }

      // Server now returns decoded book data per member directly
      const parsedMembers: MemberBooks[] = data.members.map((member) => ({
        userId: member.userId,
        displayName: memberNameMap.get(member.userId) || member.displayName || member.userId.slice(0, 8),
        books: (member.books ?? []).filter((b) => b.isShared === BoolFlag.TRUE),
      }));

      // --- Update tracking ---
      // Build raw-like structure for update tracking compatibility
      const rawMembers = data.members.map((m) => ({
        userId: m.userId,
        payload: null as string | null,
        lastUpdated: null as string | null,
      }));

      const sk = seenKey(userId);
      const ck = chipsKey(userId);
      let storageData: Record<string, unknown> = {};
      try {
        storageData = await browser.storage.local.get([sk, ck]);
      } catch {
        // Extension context invalidated
      }
      const seenData = (storageData[sk] ?? {}) as BookshelfSeenRecord;
      const chipsData = (storageData[ck] ?? null) as BookshelfChipsRecord | null;

      const freshIds = computeFreshBookIds(
        parsedMembers,
        rawMembers,
        userId,
        seenData,
      );

      const allCurrentBookIds = new Set(
        parsedMembers.flatMap((m) => m.books.map((b) => b.bookId)),
      );
      const chipIds = loadValidChipBookIds(chipsData, allCurrentBookIds);

      // First use: silently initialize baseline
      if (Object.keys(seenData).length === 0) {
        const baseline = buildSeenBaseline(parsedMembers, rawMembers);
        try {
          void browser.storage.local.set({ [sk]: baseline });
        } catch {
          // Extension context invalidated
        }
      }

      rawMembersDataRef.current = {
        members: parsedMembers,
      };

      if (!mountedRef.current) return;
      setBookshelfMembers(parsedMembers);
      setFreshUpdateBookIds(freshIds);
      setChipBookIds(chipIds);
      setBookshelfState("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      setBookshelfError(err instanceof Error ? err.message : "載入失敗");
      setBookshelfState("error");
    }
  }, [familyId, apiClient, userId]);

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
      setBorrowRequestsError(
        err instanceof Error ? err.message : "載入失敗",
      );
      setBorrowRequestsState("error");
    }
  }, [familyId, apiClient]);

  const applyBorrowStatus = useCallback(
    (requestId: string, status: BorrowStatus) => {
      setBorrowRequests((prev) =>
        prev.map((r) => (r.requestId === requestId ? { ...r, status } : r)),
      );
    },
    [],
  );

  const updateMemberDisplayName = useCallback(
    (targetUserId: string, displayName: string) => {
      setMembers((prev) =>
        prev.map((m) => (m.userId === targetUserId ? { ...m, displayName } : m)),
      );
      setBookshelfMembers((prev) =>
        prev.map((m) =>
          m.userId === targetUserId ? { ...m, displayName } : m,
        ),
      );
    },
    [],
  );

  /**
   * Replace a single member entry from a server PATCH response.
   *
   * Used by flows that mutate a member via PATCH (e.g. picker write-back,
   * delete readmooName) so the UI updates immediately without refetching
   * the full member list. If the userId is unknown locally (race condition)
   * we leave state alone — `refreshMembers` is the source of truth.
   */
  const updateMember = useCallback((next: FamilyMember) => {
    setMembers((prev) => {
      let changed = false;
      const updated = prev.map((m) => {
        if (m.userId !== next.userId) return m;
        changed = true;
        return next;
      });
      return changed ? updated : prev;
    });
  }, []);

  const markBookshelfSeen = useCallback(() => {
    if (freshUpdateBookIdsRef.current.size === 0) return;

    const raw = rawMembersDataRef.current;
    if (!raw) return;

    // Update baseline — build raw-like structure
    const rawMembers = raw.members.map((m) => ({
      userId: m.userId,
      payload: null as string | null,
      lastUpdated: null as string | null,
    }));
    const baseline = buildSeenBaseline(raw.members, rawMembers);

    // Merge fresh IDs into chips with 24h expiry
    const mergedChips = new Set(chipBookIdsRef.current);
    for (const id of freshUpdateBookIdsRef.current) mergedChips.add(id);

    const expiresAt = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();
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
  }, [userId]);

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

  const value = useMemo<FamilyDataState>(
    () => ({
      familyId,
      userId,
      apiClient,
      members,
      ownerId,
      membersState,
      membersError,
      familyEndpoint,
      bookshelfMembers,
      bookshelfState,
      bookshelfError,
      borrowRequests,
      borrowRequestsState,
      borrowRequestsError,
      refreshBorrowRequests,
      applyBorrowStatus,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
      updateMember,
      updatedBookIds,
      hasBookshelfUpdates,
      markBookshelfSeen,
      hiddenRefs,
      isHidden,
      toggleHidden,
      favoriteRefs,
      isFavorite,
      toggleFavorite,
      prefsSyncFailed,
    }),
    [
      familyId,
      userId,
      apiClient,
      members,
      ownerId,
      membersState,
      membersError,
      familyEndpoint,
      bookshelfMembers,
      bookshelfState,
      bookshelfError,
      borrowRequests,
      borrowRequestsState,
      borrowRequestsError,
      refreshBorrowRequests,
      applyBorrowStatus,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
      updateMember,
      updatedBookIds,
      hasBookshelfUpdates,
      markBookshelfSeen,
      hiddenRefs,
      isHidden,
      toggleHidden,
      favoriteRefs,
      isFavorite,
      toggleFavorite,
      prefsSyncFailed,
    ],
  );

  return (
    <FamilyDataContext.Provider value={value}>
      {children}
    </FamilyDataContext.Provider>
  );
}
