import { useState, useCallback, type RefObject } from "react";
import type { ApiClient, FamilyMember, FamilyGroup } from "../api/client";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type {
  LoadState,
  MemberBooks,
  MountedRef,
  StateSetter,
} from "./familyDataTypes";

/** The members fields the provider exposes on its context value. */
export interface FamilyDataMembersView {
  members: FamilyMember[];
  ownerId: string;
  membersState: LoadState;
  membersError: string;
  familyEndpoint: string | undefined;
}

/** Every members setter — all of them are written by `refreshMembers`. */
export interface FamilyDataMembersSetters {
  setMembers: StateSetter<FamilyMember[]>;
  setOwnerId: StateSetter<string>;
  setMembersState: StateSetter<LoadState>;
  setMembersError: StateSetter<string>;
  setFamilyEndpoint: StateSetter<string | undefined>;
}

export function useFamilyDataMembersState(): [
  FamilyDataMembersView,
  FamilyDataMembersSetters,
] {
  // --- Members state ---
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [membersState, setMembersState] = useState<LoadState>("loading");
  const [membersError, setMembersError] = useState("");
  const [familyEndpoint, setFamilyEndpoint] = useState<string | undefined>(
    undefined,
  );
  return [
    { members, ownerId, membersState, membersError, familyEndpoint },
    {
      setMembers,
      setOwnerId,
      setMembersState,
      setMembersError,
      setFamilyEndpoint,
    },
  ];
}

interface RefreshMembersOptions {
  familyId: string;
  apiClient: ApiClient;
  mountedRef: MountedRef;
  membersRef: RefObject<FamilyMember[]>;
  setters: FamilyDataMembersSetters;
}

export function useFamilyDataRefreshMembers({
  familyId,
  apiClient,
  mountedRef,
  membersRef,
  setters,
}: RefreshMembersOptions): () => Promise<void> {
  const {
    setMembers,
    setOwnerId,
    setMembersState,
    setMembersError,
    setFamilyEndpoint,
  } = setters;
  return useCallback(async () => {
    setMembersState((prev) => (prev === "ready" ? prev : "loading"));
    setMembersError("");
    try {
      const response = await apiClient.getFamilyMembers(familyId);
      if (!mountedRef.current) return;
      if (response.error) {
        setMembersError(
          safeErrorText(response.error.message, "載入失敗，請稍後再試"),
        );
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
  }, [
    familyId,
    apiClient,
    mountedRef,
    membersRef,
    setMembers,
    setOwnerId,
    setMembersState,
    setMembersError,
    setFamilyEndpoint,
  ]);
}

export function useFamilyDataMemberEdits(
  setMembers: StateSetter<FamilyMember[]>,
  setBookshelfMembers: StateSetter<MemberBooks[]>,
): {
  updateMemberDisplayName: (targetUserId: string, displayName: string) => void;
  updateMember: (next: FamilyMember) => void;
} {
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
    [setMembers, setBookshelfMembers],
  );

  /** Replace one member from a PATCH response (picker write-back, readmooName delete) without a
   *  refetch; an unknown userId (race) leaves state alone — `refreshMembers` is the truth. */
  const updateMember = useCallback(
    (next: FamilyMember) => {
      setMembers((prev) => {
        let changed = false;
        const updated = prev.map((m) => {
          if (m.userId !== next.userId) return m;
          changed = true;
          return next;
        });
        return changed ? updated : prev;
      });
    },
    [setMembers],
  );

  return { updateMemberDisplayName, updateMember };
}
