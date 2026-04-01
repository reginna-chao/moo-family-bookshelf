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
} from "@/api/client";
import type {
  ApiClient,
  BookEntry,
  FamilyMember,
  RawFamilyBookshelf,
} from "@/api/client";
import { importKey, decrypt } from "@/crypto/encrypt";

/** Decrypted member bookshelf for family shelf display */
export interface MemberBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
}

type LoadState = "loading" | "ready" | "error";

interface FamilyDataState {
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

  /** Refresh functions for child components */
  refreshMembers: () => Promise<void>;
  refreshBookshelf: () => Promise<void>;
  /** Update a member's display name locally (optimistic) */
  updateMemberDisplayName: (userId: string, displayName: string) => void;
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
  encryptionKey: string;
  children: React.ReactNode;
}

async function decryptPayload(
  payload: string,
  encKey: string,
): Promise<{ displayName: string; books: BookEntry[] }> {
  const key = await importKey(encKey);
  const decrypted = await decrypt(payload, key);
  const parsed: unknown = JSON.parse(decrypted);
  if (typeof parsed !== "object" || parsed === null) {
    return { displayName: "", books: [] };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    displayName: typeof obj.displayName === "string" ? obj.displayName : "",
    books: Array.isArray(obj.books) ? (obj.books as BookEntry[]) : [],
  };
}

export function FamilyDataProvider({
  familyId,
  userId,
  apiClient,
  encryptionKey,
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

      const data: RawFamilyBookshelf | undefined = response.data;
      if (!data) {
        setBookshelfState("ready");
        return;
      }

      // Build name map from current members state (S1-orig: no extra API call)
      const memberNameMap = new Map<string, string>();
      for (const m of membersRef.current) {
        if (m.displayName) memberNameMap.set(m.userId, m.displayName);
      }

      const decryptedMembers: MemberBooks[] = [];
      for (const member of data.members) {
        const familyDisplayName =
          memberNameMap.get(member.userId) || member.userId.slice(0, 8);

        if (!member.payload || !encryptionKey) {
          decryptedMembers.push({
            userId: member.userId,
            displayName: familyDisplayName,
            books: [],
          });
          continue;
        }

        try {
          const { books } = await decryptPayload(member.payload, encryptionKey);
          decryptedMembers.push({
            userId: member.userId,
            displayName: familyDisplayName,
            books: books.filter((b) => b.isShared === BoolFlag.TRUE),
          });
        } catch {
          decryptedMembers.push({
            userId: member.userId,
            displayName: familyDisplayName,
            books: [],
          });
        }
      }

      if (!mountedRef.current) return;
      setBookshelfMembers(decryptedMembers);
      setBookshelfState("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      setBookshelfError(err instanceof Error ? err.message : "載入失敗");
      setBookshelfState("error");
    }
  }, [familyId, apiClient, encryptionKey]);

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

  // Fetch on mount: members first, then bookshelf (sequential to avoid redundant API call)
  useEffect(() => {
    void (async () => {
      await refreshMembers();
      void refreshBookshelf();
    })();
  }, [refreshMembers, refreshBookshelf]);

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
      members,
      ownerId,
      membersState,
      membersError,
      familyEndpoint,
      bookshelfMembers,
      bookshelfState,
      bookshelfError,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
    }),
    [
      members,
      ownerId,
      membersState,
      membersError,
      familyEndpoint,
      bookshelfMembers,
      bookshelfState,
      bookshelfError,
      refreshMembers,
      refreshBookshelf,
      updateMemberDisplayName,
    ],
  );

  return (
    <FamilyDataContext.Provider value={value}>
      {children}
    </FamilyDataContext.Provider>
  );
}
