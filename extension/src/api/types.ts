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

/** Current schema version for PersonalBooks encrypted payload */
export const PERSONAL_BOOKS_SCHEMA_VERSION = 1;

export interface FamilyMember {
  userId: string;
  displayName: string;
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

/** Raw server response — members have encrypted payloads */
export interface RawFamilyBookshelf {
  familyId: string;
  members: Array<{
    userId: string;
    payload: string | null;
    lastUpdated: string | null;
  }>;
}
