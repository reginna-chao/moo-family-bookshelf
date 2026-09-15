/**
 * Wire types both apps must agree on: the `{ data, error }` envelope, the
 * family-group and family-bookshelf records, the `POST /api/auth/lookup`
 * payload, and the `ApiError` each client throws when an envelope carries
 * `error`.
 *
 * Every response of this API travels in the same envelope, and the family
 * endpoints answer the Extension and the PWA with the same records — so a
 * divergent copy of these declarations on one end is a contract break, not a
 * local style choice. They used to be written once per app
 * (`extension/src/api/types.ts` and `pwa/src/api/client.ts`); both now re-export
 * from here, so existing importers are unaffected.
 *
 * Declarations only (plus the one thrown class) — a declared `string` is what
 * the backend CLAIMS, not what it sent. The endpoint is user-configurable (BYO /
 * a sync code's `@host`), so the runtime checks live at each app's API boundary
 * (`./memberValidation`, `./bookshelfValidation`, `./safeText`).
 */

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
  /**
   * Optional on the wire: Workers predating the verification gate never send
   * this field, and self-hosted (BYO) backends can lag the client by any
   * number of releases. Absent means "no verification gate on this account".
   */
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
  /**
   * The message exactly as the envelope carried it, without the `"CODE: "`
   * prefix `message` prepends. Codes whose server copy is already user-facing
   * render this instead of string-parsing `message`.
   */
  readonly rawMessage: string;
  /** Seconds to wait before retrying; only sent on 429 responses. */
  readonly retryAfter?: number;
  /**
   * True only when the client built the envelope itself instead of parsing it
   * out of a response — proven in the Extension by the symbol marker in
   * `extension/src/api/client.ts` that `JSON.parse` cannot produce. Any UI that
   * renders `rawMessage` verbatim MUST require this: without it, a self-hosted
   * (BYO) or hostile backend could return a client-only code and get arbitrary
   * text painted into the dialog.
   *
   * Always `false` in the PWA today: it has no envelope-synthesizing path (the
   * Extension's auth-recovery throttle is the only one). A future PWA synthesis
   * site inherits the check instead of re-inventing it.
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
