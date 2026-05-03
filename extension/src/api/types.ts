/**
 * Shared types, interfaces, and enums for the API layer.
 */

export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

export interface ApiResponse<T> {
  data?: T;
  error?: { code: string; message: string };
}

export interface BookEntry {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isShared: BoolFlag;
  isArchived?: BoolFlag; // FALSE = active (default), TRUE = archived
}

export interface PersonalBooks {
  schemaVersion: number;
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
  /** Preserve unknown fields from future schema versions */
  [key: string]: unknown;
}

/** Current schema version for PersonalBooks personal books data */
export const PERSONAL_BOOKS_SCHEMA_VERSION = 1;

export interface FamilyMember {
  userId: string;
  displayName: string;
  /** Optional for backward compat with old API responses; treat missing/undefined as TRUE. */
  canLend?: BoolFlag;
  /** Readmoo display name for lending automation (v1.1.0). */
  readmooName?: string;
}

export interface FamilyGroup {
  familyId: string;
  ownerId: string;
  members: FamilyMember[];
  maxMembers: number;
  createdAt: string;
  apiEndpoint?: string | null;
  /** Auth token issued alongside family create/join responses. */
  authToken?: string;
  /** Unix millis when authToken expires. */
  expiresAt?: number;
}

export interface VersionInfo {
  apiVersion: number;
  serverVersion: string;
}

export interface FamilyBookshelf {
  members: Array<{
    userId: string;
    displayName: string;
    books: BookEntry[];
  }>;
}

export type VerifyMethod = "pin" | "pattern" | "code" | "none";

export interface VerifyInfo {
  method: VerifyMethod;
  prompted: number;
}

export interface OtpInfo {
  code: string;
  expiresAt: number;
}

export enum BorrowStatus {
  PENDING = 0,
  LENT = 1,
  RETURNED = 2,
  REJECTED = 3,
  CANCELLED = 4,
}

export interface BorrowRequest {
  requestId: string;
  familyId: string;
  borrowerId: string;
  borrowerName: string;
  ownerId: string;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  bookCoverUrl: string;
  status: BorrowStatus;
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a borrow request. */
export interface CreateBorrowPayload {
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  bookCoverUrl: string;
  ownerId: string;
}

/** Settings updatable on a family member via PATCH /api/family/:id/member/:uid. */
export interface MemberSettingsPayload {
  canLend?: BoolFlag;
  readmooName?: string;
}

export type SelectionMode = "all-shared";

export interface PublicShelf {
  shelfId: string;
  shareToken: string;
  title: string;
  expiresDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  selectionMode: SelectionMode;
}

export interface PublicShelfData {
  title: string;
  books: BookEntry[];
  createdAt: number;
  expiresAt: number | null;
}
