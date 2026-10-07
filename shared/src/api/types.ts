/** Wire types both apps re-export (envelope + records): a divergent copy is a contract break. Declarations
 *  only — a `string` is what the backend CLAIMS; see docs/architecture.md → 伺服器回傳資料的檢查. */

/**
 * The project's Boolean Convention (AGENTS.md): every boolean-like field that
 * travels on the wire or into KV is this enum — never `boolean`, never a raw
 * `0` / `1` literal. `true === 1` is `false` under strict equality, so a
 * `boolean` on one end and a number on the other is a silent cross-platform bug
 * between Extension, PWA and Worker.
 *
 * Previously declared separately in `extension/src/api/types.ts` and
 * `pwa/src/api/client.ts`; single-sourced here so the two enums cannot drift.
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

/** One book as it travels in `user:{id}.books` and in the family bookshelf. */
export interface BookEntry {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isShared: BoolFlag;
  /** FALSE = active (default when absent), TRUE = archived. */
  isArchived?: BoolFlag;
}

/**
 * One member of a `GET /api/family/:id/bookshelf` response.
 *
 * `lastUpdated` is the member's `user:{id}.lastUpdated` — the timestamp of
 * their last personal-shelf save — or `null` when they have never synced. It is
 * a meaningful tri-state for update tracking: `null` means "nothing to diff
 * against", not "unchanged".
 */
export interface FamilyBookshelfMember {
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string | null;
}

/**
 * `GET /api/family/:id/bookshelf` payload — the aggregated family bookshelf.
 * `familyId` echoes the `:id` path parameter.
 */
export interface FamilyBookshelf {
  familyId: string;
  members: FamilyBookshelfMember[];
}

/**
 * Resolved `POST /api/auth/lookup` payload.
 *
 * `userId` is derived from a publicly guessable email, so an account that has
 * PWA login verification configured only gets its family data back when the
 * request carries the matching secret. Until then the server answers HTTP 200
 * with `requiresVerification: TRUE` and withholds the data
 * (`existingFamilyId: null`, `memberCount: 0`) — informational, not an error.
 */
export interface LookupResult {
  existingFamilyId: string | null;
  memberCount: number;
  /** Optional: pre-gate Workers never send it and BYO backends can lag any number of releases.
   *  Absent means "no verification gate on this account". */
  requiresVerification?: BoolFlag;
}

/**
 * Thrown by each client's `unwrap` helpers when an envelope carries `error`.
 *
 * Keeps the machine-readable `code` and the rate-limit wait reachable by
 * callers — a plain `Error` forced the UI to show (or string-parse) the raw
 * `"CODE: message"` text, which is how `retryAfter` used to get dropped on the
 * floor. `message` keeps that exact shape for backward compatibility.
 */
export class ApiError extends Error {
  readonly code: string;
  /** The envelope's message without the `"CODE: "` prefix `message` adds; codes whose server copy
   *  is already user-facing render this instead of string-parsing `message`. */
  readonly rawMessage: string;
  /** Seconds to wait before retrying; only sent on 429 responses. */
  readonly retryAfter?: number;
  /** True only for a client-built envelope; any UI rendering `rawMessage` verbatim MUST require it. A
   *  plain `boolean` on purpose (never on the wire). See docs/architecture.md → 伺服器回傳資料的檢查. */
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
    // A BYO backend can send anything; an unusable wait would read「NaN 秒」, so it is dropped
    // (the UI falls back to static wording) and a fractional one is floored.
    this.retryAfter =
      typeof retryAfter === "number" &&
      Number.isFinite(retryAfter) &&
      retryAfter >= 0
        ? Math.floor(retryAfter)
        : undefined;
  }
}

/** Personal-books record — the `user:{id}` payload of
 *  `GET` / `PUT` / `PATCH /api/user/:id/books`. */

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

/** `GET /api/version` payload. */

export interface VersionInfo {
  apiVersion: number;
  serverVersion: string;
}

/** PWA login verification shapes — `GET` / `PUT /api/user/:id/verify` and
 *  `POST /api/user/:id/verify/otp`. */

export type VerifyMethod = "pin" | "pattern" | "code" | "none";

export interface VerifyInfo {
  method: VerifyMethod;
  prompted: number;
}

export interface SetVerifyBody {
  method: VerifyMethod;
  secret?: string;
  prompted?: number;
}

export interface OtpInfo {
  code: string;
  expiresAt: number;
}

/** Member settings — `PATCH /api/family/:id/member/:uid`. */

/** Settings updatable on a family member via PATCH /api/family/:id/member/:uid. */
export interface MemberSettingsPayload {
  canLend?: BoolFlag;
  /** Readmoo display name for lending automation: a string sets it, `null` deletes it server-side
   *  (NOT `""` — the API rejects an empty string), omitted means no change. */
  readmooName?: string | null;
}

/** Un-kick result — `DELETE /api/family/:id/kicked/:uid`. */

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

/** Public-shelf records — `/api/user/:id/public-shelf*` (owner side) and the
 *  `GET /api/public/:shareToken` snapshot a link viewer reads. */

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
