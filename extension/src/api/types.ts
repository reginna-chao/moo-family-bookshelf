/**
 * Shared types, interfaces, and enums for the API layer.
 */

import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import type { BookEntry } from "moo-family-bookshelf-shared/api/types";

/**
 * The wire contract itself — the `{ data, error }` envelope, `BoolFlag`, the
 * family / bookshelf / borrow records, the `POST /api/auth/lookup` payload and
 * the thrown `ApiError` — lives in `shared/` so the Extension and the PWA
 * cannot describe the same payload differently. Re-exported here because every
 * existing importer reaches for these names through the API layer — new code
 * outside `api/` should import the shared modules directly rather than routing
 * through this file. `BoolFlag` and `BookEntry` are also imported above as
 * real bindings, because the app-local types below are declared in terms of
 * them; `ApiError` is not used here, so it is a plain re-export.
 */
export { BoolFlag };
export { ApiError } from "moo-family-bookshelf-shared/api/types";
export type {
  ApiErrorPayload,
  ApiResponse,
  BookEntry,
  FamilyBookshelf,
  FamilyBookshelfMember,
  FamilyGroup,
  FamilyMember,
  LookupResult,
} from "moo-family-bookshelf-shared/api/types";
export { BorrowStatus } from "moo-family-bookshelf-shared/borrow/types";
export type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";

/**
 * Client-synthesized code for a 401 whose silent token recovery was itself
 * rate-limited. Distinct from the server's `RATE_LIMITED` on purpose: its
 * message is bespoke 繁體中文 guidance («請重新開啟書櫃») that the generic
 * back-off copy cannot reconstruct, so the UI passes it through verbatim.
 *
 * The code alone is NOT sufficient authority for that passthrough — any backend
 * can put this string in an envelope. `ApiError.synthesized` is the check.
 */
export const AUTH_REFRESH_RATE_LIMITED = "AUTH_REFRESH_RATE_LIMITED";

export interface PersonalBooks {
  schemaVersion: number;
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
  /** Viewer-private family-shelf preferences (v1.5.0). */
  familyShelfPrefs?: { hidden: string[]; favorites: string[] };
  /** Preserve unknown fields from future schema versions */
  [key: string]: unknown;
}

/** Current schema version for PersonalBooks personal books data */
export const PERSONAL_BOOKS_SCHEMA_VERSION = 1;

export interface VersionInfo {
  apiVersion: number;
  serverVersion: string;
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

/**
 * `DELETE /api/family/:id/kicked/:uid` payload — the removal's rejoin block was
 * lifted.
 *
 * `cleared` is a `BoolFlag`, not a `boolean`: it travels on the wire (AGENTS.md
 * → Boolean Convention). Callers must NOT branch on its value — the endpoint is
 * idempotent, so a userId whose tombstone had already expired is still a 200 and
 * the user-visible outcome ("the sync code works for them again") is identical
 * either way. Any 200 is success.
 */
export interface UnkickResult {
  cleared: BoolFlag;
}

/** Settings updatable on a family member via PATCH /api/family/:id/member/:uid. */
export interface MemberSettingsPayload {
  canLend?: BoolFlag;
  /**
   * Readmoo display name for lending automation.
   *  - `string`: set the value
   *  - `null`: delete the field server-side (NOT `""` — empty string is rejected by the API)
   *  - omitted: no change
   */
  readmooName?: string | null;
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
