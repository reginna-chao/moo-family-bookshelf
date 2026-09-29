import { useState, useCallback, type RefObject } from "react";
import browser from "webextension-polyfill";
import {
  ApiClient,
  BoolFlag,
  FamilyMember,
  FamilyBookshelf,
} from "../api/client";
import { seenKey, chipsKey } from "../constants";
import {
  computeFreshBookIds,
  loadValidChipBookIds,
  buildSeenBaseline,
  type BookshelfSeenRecord,
  type BookshelfChipsRecord,
} from "moo-family-bookshelf-shared/familyShelf/updateTracking";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type {
  LoadState,
  MemberBooks,
  MountedRef,
  RawMembersData,
  StateSetter,
} from "./familyDataTypes";

/** The bookshelf fields the provider exposes on its context value. */
export interface FamilyDataBookshelfView {
  bookshelfMembers: MemberBooks[];
  bookshelfState: LoadState;
  bookshelfError: string;
}

/** Every bookshelf setter — all of them are written by `refreshBookshelf`. */
export interface FamilyDataBookshelfSetters {
  setBookshelfMembers: StateSetter<MemberBooks[]>;
  setBookshelfState: StateSetter<LoadState>;
  setBookshelfError: StateSetter<string>;
}

export function useFamilyDataBookshelfState(): [
  FamilyDataBookshelfView,
  FamilyDataBookshelfSetters,
] {
  // --- Bookshelf state ---
  const [bookshelfMembers, setBookshelfMembers] = useState<MemberBooks[]>([]);
  const [bookshelfState, setBookshelfState] = useState<LoadState>("loading");
  const [bookshelfError, setBookshelfError] = useState("");
  return [
    { bookshelfMembers, bookshelfState, bookshelfError },
    { setBookshelfMembers, setBookshelfState, setBookshelfError },
  ];
}

interface RefreshBookshelfOptions {
  familyId: string;
  apiClient: ApiClient;
  userId: string;
  mountedRef: MountedRef;
  membersRef: RefObject<FamilyMember[]>;
  setters: FamilyDataBookshelfSetters;
  rawMembersDataRef: RefObject<RawMembersData | null>;
  setFreshUpdateBookIds: StateSetter<Set<string>>;
  setChipBookIds: StateSetter<Set<string>>;
}

export function useFamilyDataRefreshBookshelf({
  familyId,
  apiClient,
  userId,
  mountedRef,
  membersRef,
  setters,
  rawMembersDataRef,
  setFreshUpdateBookIds,
  setChipBookIds,
}: RefreshBookshelfOptions): () => Promise<void> {
  const { setBookshelfMembers, setBookshelfState, setBookshelfError } = setters;
  return useCallback(async () => {
    setBookshelfState((prev) => (prev === "ready" ? prev : "loading"));
    setBookshelfError("");
    try {
      const response = await apiClient.getFamilyBookshelf(familyId);
      if (!mountedRef.current) return;

      if (response.error) {
        setBookshelfError(
          safeErrorText(response.error.message, "載入失敗，請稍後再試"),
        );
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
        displayName:
          memberNameMap.get(member.userId) ||
          member.displayName ||
          member.userId.slice(0, 8),
        books: (member.books ?? []).filter((b) => b.isShared === BoolFlag.TRUE),
      }));

      // --- Update tracking ---
      // `data.members` carries each member's `lastUpdated` straight from the
      // wire; the tracker compares it against the seen baseline, so a
      // synthesized `null` here would read every existing member as unchanged.
      const sk = seenKey(userId);
      const ck = chipsKey(userId);
      let storageData: Record<string, unknown> = {};
      try {
        storageData = await browser.storage.local.get([sk, ck]);
      } catch {
        // Extension context invalidated
      }
      const seenData = (storageData[sk] ?? {}) as BookshelfSeenRecord;
      const chipsData = (storageData[ck] ??
        null) as BookshelfChipsRecord | null;

      const freshIds = computeFreshBookIds(
        parsedMembers,
        data.members,
        userId,
        seenData,
      );

      const allCurrentBookIds = new Set(
        parsedMembers.flatMap((m) => m.books.map((b) => b.bookId)),
      );
      const chipIds = loadValidChipBookIds(chipsData, allCurrentBookIds);

      // First use: silently initialize baseline
      if (Object.keys(seenData).length === 0) {
        const baseline = buildSeenBaseline(parsedMembers, data.members);
        try {
          void browser.storage.local.set({ [sk]: baseline });
        } catch {
          // Extension context invalidated
        }
      }

      rawMembersDataRef.current = {
        members: parsedMembers,
        raw: data.members,
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
  }, [
    familyId,
    apiClient,
    userId,
    mountedRef,
    membersRef,
    rawMembersDataRef,
    setBookshelfMembers,
    setBookshelfState,
    setBookshelfError,
    setFreshUpdateBookIds,
    setChipBookIds,
  ]);
}
