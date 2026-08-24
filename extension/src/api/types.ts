/**
 * Shared types, interfaces, and enums for the API layer.
 */

export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

/** The `error` half of the envelope, as it travels on the wire. */
export interface ApiErrorPayload {
  code: string;
  message: string;
  /** Seconds to wait before retrying, present on rate-limit (429) responses. */
  retryAfter?: number;
}

export interface ApiResponse<T> {
  data?: T;
  error?: ApiErrorPayload;
}

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

/**
 * Thrown by the client's `unwrap` helpers when an envelope carries `error`.
 *
 * Keeps the machine-readable `code` and the rate-limit wait reachable by
 * callers — a plain `Error` forced the UI to show (or string-parse) the raw
 * `"CODE: message"` text, which is how `retryAfter` used to get dropped on the
 * floor. `message` keeps that exact shape for backward compatibility.
 */
export class ApiError extends Error {
  readonly code: string;
  /**
   * The message exactly as the envelope carried it, without the `"CODE: "`
   * prefix `message` prepends. Codes whose server copy is already user-facing
   * render this instead of string-parsing `message`.
   */
  readonly rawMessage: string;
  /** Seconds to wait before retrying; only sent on 429 responses. */
  readonly retryAfter?: number;
  /**
   * True only when this client built the envelope itself, proven by the
   * symbol marker in `client.ts` that `JSON.parse` cannot produce. Any UI that
   * renders `rawMessage` verbatim MUST require this: without it, a self-hosted
   * (BYO) or hostile backend could return a client-only code and get arbitrary
   * text painted into the dialog.
   *
   * Deliberately a plain `boolean` rather than `BoolFlag` — this is in-memory
   * provenance, never an API payload or KV field, and keeping it outside the
   * wire-serializable vocabulary is the whole point.
   */
  readonly synthesized: boolean;

  constructor(
    code: string,
    message: string,
    retryAfter?: number,
    synthesized = false,
  ) {
    super(`${code}: ${message}`);
    this.name = "ApiError";
    this.code = code;
    this.rawMessage = message;
    this.synthesized = synthesized;
    // Validated at the boundary: a self-hosted (BYO) backend can send anything,
    // and a NaN / negative / fractional wait would surface as「NaN 秒」in the
    // back-off copy. Anything unusable is dropped so the UI falls back to its
    // static wording.
    this.retryAfter =
      typeof retryAfter === "number" &&
      Number.isFinite(retryAfter) &&
      retryAfter >= 0
        ? Math.floor(retryAfter)
        : undefined;
  }
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
  /** Viewer-private family-shelf preferences (v1.5.0). */
  familyShelfPrefs?: { hidden: string[]; favorites: string[] };
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
