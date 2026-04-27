import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  BoolFlag,
  BorrowStatus,
} from "@/api/client";
import type {
  ApiClient,
  BookEntry,
  BorrowRequest,
  FamilyMember,
  FamilyBookshelf,
} from "@/api/client";
import {
  seenKey,
  chipsKey,
  readLocalJson,
  writeLocalJson,
  computeFreshBookIds,
  loadValidChipBookIds,
  buildSeenBaseline,
  type BookshelfSeenRecord,
  type BookshelfChipsRecord,
} from "./updateTracking";

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

  /** Decrypted bookshelf data from getFamilyBookshelf */
  bookshelfMembers: MemberBooks[];
  bookshelfState: LoadState;
  bookshelfError: string;

  /** Borrow requests list (v1.1.0) */
  borrowRequests: BorrowRequest[];
  borrowRequestsState: BorrowLoadState;
  borrowRequestsError: string | null;
  refreshBorrowRequests: () => Promise<void>;
  /** Count of incoming PENDING requests for the current user (drives borrow tab badge). */
  incomingPendingCount: number;

  /** Refresh functions for child components */
  refreshMembers: () => Promise<void>;
  refreshBookshelf: () => Promise<void>;
  /** Update a member's display name locally (optimistic) */
  updateMemberDisplayName: (userId: string, displayName: string) => void;
  /** Set of bookIds with "更新" chip (fresh + unexpired chips) */
  updatedBookIds: Set<string>;
  /** Whether there are unseen bookshelf updates (drives red dot) */
  hasBookshelfUpdates: boolean;
  /** Mark current bookshelf as seen: clears red dot, preserves chips for 24h */
  markBookshelfSeen: () => void;
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
  children: React.ReactNode;
}

export function FamilyDataProvider({
  familyId,
  userId,
  apiClient,
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
    raw: FamilyBookshelf["members"];
  } | null>(null);

  const updatedBookIds = useMemo(() => {
    const combined = new Set(freshUpdateBookIds);
    for (const id of chipBookIds) combined.add(id);
    return combined;
  }, [freshUpdateBookIds, chipBookIds]);

  const hasBookshelfUpdates = freshUpdateBookIds.size > 0;

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
        setFamilyEndpoint(response.data.apiEndpoint ?? undefined);
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

      // Server returns decoded books per member directly
      const memberBooks: MemberBooks[] = data.members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName || member.userId.slice(0, 8),
        books: (member.books ?? []).filter((b) => b.isShared === BoolFlag.TRUE),
      }));

      // --- Update tracking ---
      const seenData =
        readLocalJson<BookshelfSeenRecord>(seenKey(userId)) ?? {};
      const chipsData =
        readLocalJson<BookshelfChipsRecord>(chipsKey(userId));

      const freshIds = computeFreshBookIds(
        memberBooks,
        data.members,
        userId,
        seenData,
      );

      const allCurrentBookIds = new Set(
        memberBooks.flatMap((m) => m.books.map((b) => b.bookId)),
      );
      const chipIds = loadValidChipBookIds(chipsData, allCurrentBookIds);

      // First use: silently initialize baseline
      if (Object.keys(seenData).length === 0) {
        const baseline = buildSeenBaseline(memberBooks, data.members);
        writeLocalJson(seenKey(userId), baseline);
      }

      rawMembersDataRef.current = {
        members: memberBooks,
        raw: data.members,
      };

      if (!mountedRef.current) return;
      setBookshelfMembers(memberBooks);
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

  const incomingPendingCount = useMemo(() => {
    let count = 0;
    for (const r of borrowRequests) {
      if (r.ownerId === userId && r.status === BorrowStatus.PENDING) count++;
    }
    return count;
  }, [borrowRequests, userId]);

  const updateMemberDisplayName = useCallback(
    (targetUserId: string, displayName: string) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === targetUserId ? { ...m, displayName } : m,
        ),
      );
      setBookshelfMembers((prev) =>
        prev.map((m) =>
          m.userId === targetUserId ? { ...m, displayName } : m,
        ),
      );
    },
    [],
  );

  const markBookshelfSeen = useCallback(() => {
    if (freshUpdateBookIdsRef.current.size === 0) return;

    const raw = rawMembersDataRef.current;
    if (!raw) return;

    // Update baseline
    const baseline = buildSeenBaseline(raw.members, raw.raw);

    // Merge fresh IDs into chips with 24h expiry
    const mergedChips = new Set(chipBookIdsRef.current);
    for (const id of freshUpdateBookIdsRef.current) mergedChips.add(id);

    const expiresAt = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();

    writeLocalJson(seenKey(userId), baseline);
    writeLocalJson(chipsKey(userId), {
      bookIds: [...mergedChips],
      expiresAt,
    });

    setChipBookIds(mergedChips);
    setFreshUpdateBookIds(new Set());
  }, [userId]);

  // Fetch on mount: members first, then bookshelf + borrow requests
  useEffect(() => {
    void (async () => {
      await refreshMembers();
      void refreshBookshelf();
      void refreshBorrowRequests();
    })();
  }, [refreshMembers, refreshBookshelf, refreshBorrowRequests]);

  // Cross-component sync: re-fetch bookshelf when PersonalShelf saves
  useEffect(() => {
    const handler = () => {
      void refreshBookshelf();
    };
    window.addEventListener("personalShelfSaved", handler);
    return () => window.removeEventListener("personalShelfSaved", handler);
  }, [refreshBookshelf]);

  // Cross-component sync: update display name when changed in settings
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ displayName: string }>).detail;
      updateMemberDisplayName(userId, detail.displayName);
    };
    window.addEventListener("displayNameChanged", handler);
    return () => window.removeEventListener("displayNameChanged", handler);
  }, [userId, updateMemberDisplayName]);

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
      incomingPendingCount,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
      updatedBookIds,
      hasBookshelfUpdates,
      markBookshelfSeen,
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
      incomingPendingCount,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
      updatedBookIds,
      hasBookshelfUpdates,
      markBookshelfSeen,
    ],
  );

  return (
    <FamilyDataContext.Provider value={value}>
      {children}
    </FamilyDataContext.Provider>
  );
}
