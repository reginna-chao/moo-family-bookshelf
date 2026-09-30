import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  ApiClient,
  BookEntry,
  BorrowRequest,
  BorrowStatus,
  FamilyMember,
  FamilyBookshelf,
} from "../api/client";

/** Member bookshelf for family shelf display */
export interface MemberBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
}

export type LoadState = "loading" | "ready" | "error";
export type BorrowLoadState = "idle" | "loading" | "loaded" | "error";

/** A `useState` setter, as handed from a state hook to the hooks that write it. */
export type StateSetter<T> = Dispatch<SetStateAction<T>>;

/** The last bookshelf load, kept so `markBookshelfSeen` can rebuild the baseline. */
export interface RawMembersData {
  members: MemberBooks[];
  raw: FamilyBookshelf["members"];
}

/** Ref type shared by the provider's `mountedRef` and its readers. */
export type MountedRef = RefObject<boolean>;

export interface FamilyDataState {
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
