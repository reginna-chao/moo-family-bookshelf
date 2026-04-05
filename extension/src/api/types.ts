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
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
}

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

/** Raw server response — members have encrypted payloads */
export interface RawFamilyBookshelf {
  familyId: string;
  members: Array<{
    userId: string;
    payload: string | null;
    lastUpdated: string | null;
  }>;
}
