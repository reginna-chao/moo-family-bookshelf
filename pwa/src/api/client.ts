/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { DEFAULT_API_ENDPOINT } from "../constants";

/**
 * Endpoint validation lives in `shared/` so Extension and PWA enforce
 * byte-identical rules — the PWA adopts a sync code's `@host` too, so a weaker
 * copy here would be the whole point of the check undone. Re-exported because
 * existing importers reach for it via the API client.
 */
export { validateEndpointUrl };

export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

export interface ApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    /** Seconds to wait before retrying, present on rate-limit (429) responses. */
    retryAfter?: number;
  };
}

/**
 * Thrown by the client's `unwrap` helpers when an envelope carries `error`.
 *
 * Kept in sync with `extension/src/api/types.ts`. Keeps the machine-readable
 * `code` and the rate-limit wait reachable by callers — a plain `Error` forced
 * the UI to show (or string-parse) the raw `"CODE: message"` text, which is how
 * `retryAfter` used to get dropped on the floor. `message` keeps that exact
 * shape for backward compatibility.
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
   * out of a response — the guard any UI must pass before rendering
   * `rawMessage` verbatim, so a self-hosted (BYO) or hostile backend cannot get
   * arbitrary text painted into the UI by claiming a client-only error code.
   *
   * Always `false` here today: the PWA has no envelope-synthesizing path (the
   * Extension's auth-recovery throttle is the only one). The field exists so
   * the two kept-in-sync classes cannot drift, and so a future PWA synthesis
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

/**
 * The one status this API answers with no body (RFC 9110 §15.3.5):
 * `DELETE /api/user/:id/public-shelf/:shelfId`.
 *
 * Kept to exactly this status. 205 is never returned by the API, and widening
 * the allowance only buys a rogue backend a way to have an empty body read as
 * a confirmed success; 304 is `!response.ok`, so it already belongs to the
 * error path rather than here.
 */
const NO_CONTENT_STATUS = 204;

/**
 * Read the `{ data, error }` envelope out of a response.
 *
 * A bodyless success is still a success: `response.json()` throws a SyntaxError
 * on an empty body, which the caller cannot tell apart from a genuine network
 * failure — that is how a refused revocation used to read as "deleted". A 204
 * resolves to an empty envelope instead; every other response is parsed exactly
 * as before (a malformed one still throws, as it should).
 */
async function readEnvelope<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.status === NO_CONTENT_STATUS) return {};
  return (await response.json()) as ApiResponse<T>;
}

/**
 * Resolved `POST /api/auth/lookup` payload.
 *
 * Kept in sync with `extension/src/api/client.ts` — `userId` is derived from a
 * publicly guessable email, so an account with PWA login verification
 * configured only gets its family data back when the request carries the
 * matching secret. Until then the server answers HTTP 200 with
 * `requiresVerification: TRUE` and withholds the data (`existingFamilyId:
 * null`, `memberCount: 0`) — informational, not an error.
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

export interface BookEntry {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isShared: BoolFlag;
  isArchived?: BoolFlag;
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

/** Current schema version for PersonalBooks */
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
  familyId: string;
  members: Array<{
    userId: string;
    displayName: string;
    books: BookEntry[];
    lastUpdated: string | null;
  }>;
}

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

/**
 * `DELETE /api/family/:id/kicked/:uid` payload — the removal's rejoin block was
 * lifted. Kept in sync with `extension/src/api/types.ts`.
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

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;
  private tokenRefresher: (() => Promise<string | null>) | null = null;
  private refreshing: Promise<string | null> | null = null;
  /** In-flight GET request deduplication map: URL -> Promise */
  private inflightGets = new Map<string, Promise<ApiResponse<unknown>>>();

  constructor(apiUrl?: string) {
    this.baseUrl = validateEndpointUrl(apiUrl || DEFAULT_API_ENDPOINT);
  }

  /** Register a callback that re-acquires a token on 401. */
  setTokenRefresher(fn: () => Promise<string | null>): void {
    this.tokenRefresher = fn;
  }

  setEndpoint(url: string): void {
    this.baseUrl = validateEndpointUrl(url);
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /** Check server API version. Returns null on network/parse errors. */
  async checkVersion(): Promise<VersionInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`);
      if (!res.ok) return null;
      const json = (await res.json()) as ApiResponse<VersionInfo>;
      return json.data ?? null;
    } catch {
      return null;
    }
  }

  // --- HTTP helpers ---

  private get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request(path);
  }

  private post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request(path, {
      method: "POST",
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  private put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request(path, {
      method: "PUT",
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  private del<T>(path: string): Promise<ApiResponse<T>> {
    return this.request(path, { method: "DELETE" });
  }

  private patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request(path, {
      method: "PATCH",
      body: body != null ? JSON.stringify(body) : undefined,
    });
  }

  /** Unwrap an envelope response or throw an `ApiError` built from `error`. */
  private unwrap<T>(res: ApiResponse<T>): T {
    this.throwOnError(res);
    if (res.data === undefined) {
      throw new ApiError("EMPTY_RESPONSE", "response body missing data");
    }
    return res.data;
  }

  /**
   * `unwrap` for endpoints whose success carries no payload (HTTP 204).
   * Only the `error` branch throws — demanding `data` here would turn every
   * successful 204 into a bogus EMPTY_RESPONSE failure.
   */
  private unwrapVoid(res: ApiResponse<unknown>): void {
    this.throwOnError(res);
  }

  /**
   * The single chokepoint through which every thrown `ApiError` passes, so the
   * envelope text is sanitized once here rather than at each call site.
   *
   * `code` / `message` are typed `string` but reach us through a bare cast of
   * `response.json()`, and the backend is self-hostable. A payload such as
   * `{"toString":null,"valueOf":null}` — which `JSON.parse` really can produce
   * — makes the constructor's `super(\`${code}: ${message}\`)` throw a
   * TypeError, so no `ApiError` is ever constructed: `err instanceof ApiError`
   * turns false and the localized 429 back-off branch (which needs `code` and
   * `retryAfter`) is skipped in favour of an English TypeError. Sanitizing the
   * two interpolated fields keeps the error's identity, not just its wording.
   *
   * `retryAfter` is passed through untouched — the constructor already
   * validates it.
   */
  private throwOnError(res: ApiResponse<unknown>): void {
    if (res.error) {
      throw new ApiError(
        safeErrorText(res.error.code, "UNKNOWN_ERROR"),
        safeErrorText(res.error.message, "請稍後再試"),
        res.error.retryAfter,
      );
    }
  }

  // --- Auth ---

  /**
   * Look up family membership for a pre-hashed userId. Server never sees the email.
   *
   * `verifySecret` unlocks the payload for accounts with PWA login verification
   * configured; without it the response carries `requiresVerification: TRUE`.
   * A wrong secret is a 403 `VERIFICATION_FAILED` (or 429 `VERIFICATION_LOCKED`
   * with `error.retryAfter`), never a silent empty result.
   *
   * NOTE: unused by the PWA today (login goes through the sync code) — kept in
   * sync with the Extension client so the two contracts cannot drift.
   */
  async lookupUser(
    userId: string,
    opts?: { verifySecret?: string },
  ): Promise<ApiResponse<LookupResult>> {
    this.validateHexId(userId, "userId");
    const body: Record<string, string> = { userId };
    if (opts?.verifySecret !== undefined) {
      body.verifySecret = opts.verifySecret;
    }
    return this.post("/api/auth/lookup", body);
  }

  // --- Personal Settings ---

  async getPersonalBooks(userId: string): Promise<ApiResponse<PersonalBooks>> {
    this.validateHexId(userId, "userId");
    return this.get(`/api/user/${userId}/books`);
  }

  async updatePersonalBooks(
    userId: string,
    data: PersonalBooks,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/user/${userId}/books`, data);
  }

  /**
   * Partial update — send only the changed books (diff). Used by the manual
   * "save" flow to cut upload traffic vs the full-payload PUT. Unknown bookIds
   * are silently skipped server-side; new (un-synced) books must go via PUT.
   */
  async patchPersonalBooks(
    userId: string,
    changes: Array<{ bookId: BookEntry["bookId"]; isShared: BoolFlag }>,
  ): Promise<ApiResponse<{ ok: boolean; applied: number }>> {
    this.validateHexId(userId, "userId");
    return this.patch(`/api/user/${userId}/books`, { changes });
  }

  /**
   * Update viewer-private family-shelf preferences (v1.5.0). Each provided list
   * (`hidden` / `favorites`) full-replaces its server-side counterpart; absent
   * lists are preserved. Refs are copy-scoped `{ownerId}:{bookId}`. Stored
   * server-side so the views stay consistent across Extension and PWA.
   */
  async updateFamilyPrefs(
    userId: string,
    prefs: { hidden?: string[]; favorites?: string[] },
  ): Promise<
    ApiResponse<{ ok: boolean; hidden: string[]; favorites: string[] }>
  > {
    this.validateHexId(userId, "userId");
    return this.put(`/api/user/${userId}/family-prefs`, prefs);
  }

  // --- Family Group ---

  /**
   * Create a new family.
   * NOTE: PWA MUST NOT call this — PWA can only join families (Phase 1 Q2).
   */
  async createFamily(
    userId: string,
    displayName?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    this.validateHexId(userId, "userId");
    const body: Record<string, string> = {
      userId,
      displayName: displayName ?? "",
    };
    return this.post("/api/family", body);
  }

  async joinFamily(
    familyId: string,
    userId: string,
    opts?: { verifySecret?: string; qrToken?: string },
  ): Promise<
    ApiResponse<{ ok: boolean; authToken?: string; expiresAt?: number }>
  > {
    this.validateHexId(userId, "userId");
    const body: Record<string, string> = { userId };
    if (opts?.verifySecret !== undefined) {
      body.verifySecret = opts.verifySecret;
    }
    if (opts?.qrToken !== undefined) {
      body.qrToken = opts.qrToken;
    }
    return this.post(`/api/family/${familyId}/join`, body);
  }

  async leaveFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.del(`/api/family/${familyId}/member/${userId}`);
  }

  async removeMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(targetUserId, "targetUserId");
    return this.del(`/api/family/${familyId}/member/${targetUserId}`);
  }

  /**
   * Lift the "kicked" tombstone `removeMember` leaves behind, so the removed
   * member can use the sync code again before it expires on its own.
   *
   * This does NOT put anyone back in the family: the member stays out and must
   * join again themselves — the copy in `components/UnkickNotice.tsx` says so,
   * and must keep saying so. Owner-only server-side (403 `NOT_OWNER` otherwise)
   * and idempotent: no live tombstone still answers 200.
   */
  async unkickMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<UnkickResult>> {
    this.validateHexId(targetUserId, "targetUserId");
    return this.del(`/api/family/${familyId}/kicked/${targetUserId}`);
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    this.validateHexId(newOwnerId, "newOwnerId");
    return this.put(`/api/family/${familyId}/transfer`, { userId, newOwnerId });
  }

  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    return this.get(`/api/family/${familyId}/members`);
  }

  async updateDisplayName(
    familyId: string,
    userId: string,
    displayName: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/family/${familyId}/member/${userId}/displayName`, {
      displayName,
    });
  }

  // --- Account ---

  async deleteAccount(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.del(`/api/user/${userId}`);
  }

  // --- Family Bookshelf ---

  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<FamilyBookshelf>> {
    return this.get(`/api/family/${familyId}/bookshelf`);
  }

  // --- Borrow Requests (v1.1.0) ---

  async createBorrowRequest(
    familyId: string,
    payload: CreateBorrowPayload,
  ): Promise<BorrowRequest> {
    const res = await this.post<BorrowRequest>(
      `/api/family/${familyId}/borrow`,
      payload,
    );
    return this.unwrap(res);
  }

  async listBorrowRequests(familyId: string): Promise<BorrowRequest[]> {
    const res = await this.get<BorrowRequest[]>(
      `/api/family/${familyId}/borrow`,
    );
    return this.unwrap(res);
  }

  async updateBorrowStatus(
    requestId: string,
    status: BorrowStatus,
  ): Promise<BorrowRequest> {
    const res = await this.patch<BorrowRequest>(`/api/borrow/${requestId}`, {
      status,
    });
    return this.unwrap(res);
  }

  async updateMemberSettings(
    familyId: string,
    uid: string,
    settings: MemberSettingsPayload,
  ): Promise<FamilyMember> {
    const res = await this.patch<FamilyMember>(
      `/api/family/${familyId}/member/${uid}`,
      settings,
    );
    return this.unwrap(res);
  }

  // --- Verification ---

  /** Get verification method for a user (no auth needed). */
  async getVerifyMethod(userId: string): Promise<ApiResponse<VerifyInfo>> {
    this.validateHexId(userId, "userId");
    return this.get(`/api/user/${userId}/verify`);
  }

  /** Set verification method for a user. */
  async setVerifyMethod(
    userId: string,
    body: SetVerifyBody,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/user/${userId}/verify`, body);
  }

  /** Mark verification as prompted (requires auth token). */
  async markVerifyPrompted(
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.post(`/api/user/${userId}/verify/prompted`);
  }

  // --- Public Shelf (v1.2.0) ---

  async listPublicShelves(userId: string): Promise<{ shelves: PublicShelf[] }> {
    this.validateHexId(userId, "userId");
    const res = await this.get<{ shelves: PublicShelf[] }>(
      `/api/user/${userId}/public-shelf`,
    );
    return this.unwrap(res);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf`,
      body,
    );
    return this.unwrap(res);
  }

  async updatePublicShelf(
    userId: string,
    shelfId: string,
    body: { title?: string; expiresDays?: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.put<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}`,
      body,
    );
    return this.unwrap(res);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}/reset-token`,
    );
    return this.unwrap(res);
  }

  /**
   * Revoke a public shelf. Throws `ApiError` when the server refused — the
   * caller MUST NOT report the link as closed on a rejected request (the
   * snapshot stays readable until this succeeds).
   */
  async deletePublicShelf(userId: string, shelfId: string): Promise<void> {
    this.validateHexId(userId, "userId");
    const res = await this.del(`/api/user/${userId}/public-shelf/${shelfId}`);
    this.unwrapVoid(res);
  }

  async getPublicShelf(shareToken: string): Promise<PublicShelfData> {
    const url = `${this.baseUrl}/api/public/${shareToken}`;
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
    });
    const json = (await response.json()) as ApiResponse<PublicShelfData>;
    if (json.error) {
      // Sanitize before interpolation: a hostile `{"toString":null}` field makes
      // `new Error(...)` throw before `status` is attached, and PublicShelfPage
      // switches on that `status` — a 404 would lose its「此公開書櫃不存在或已過期」
      // screen and fall back to the generic load error.
      const code = safeErrorText(json.error.code, "UNKNOWN_ERROR");
      const message = safeErrorText(json.error.message, "請稍後再試");
      const err = new Error(`${code}: ${message}`);
      (err as Error & { status: number }).status = response.status;
      throw err;
    }
    if (!json.data) {
      throw new Error("EMPTY_RESPONSE: response body missing data");
    }
    return json.data;
  }

  // --- Internal ---

  private validateHexId(id: string, label: string): void {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`Invalid ${label}: expected 64-char hex string`);
    }
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    isRetry = false,
  ): Promise<ApiResponse<T>> {
    const method = init?.method?.toUpperCase() ?? "GET";
    const url = `${this.baseUrl}${path}`;

    // Deduplicate concurrent GET requests to the same URL
    if (method === "GET" && !isRetry) {
      const existing = this.inflightGets.get(url);
      if (existing) {
        return existing as Promise<ApiResponse<T>>;
      }
      const promise = this.doRequest<T>(url, init, isRetry);
      this.inflightGets.set(url, promise as Promise<ApiResponse<unknown>>);
      try {
        return await promise;
      } finally {
        this.inflightGets.delete(url);
      }
    }

    return this.doRequest<T>(url, init, isRetry);
  }

  private async doRequest<T>(
    url: string,
    init?: RequestInit,
    isRetry = false,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, { ...init, headers });
      const json = await readEnvelope<T>(response);

      // On 401, try to refresh token once
      if (response.status === 401 && !isRetry && this.tokenRefresher) {
        // Clear stale dedup promises — token is about to change
        this.inflightGets.clear();
        // Deduplicate concurrent refresh calls (F3: prevents double-join)
        if (!this.refreshing) {
          this.refreshing = this.tokenRefresher().finally(() => {
            this.refreshing = null;
          });
        }
        const newToken = await this.refreshing;
        if (newToken) {
          this.authToken = newToken;
          return this.doRequest(url, init, true);
        }
      }

      if (!response.ok) {
        return {
          error: json.error ?? {
            code: "UNKNOWN_ERROR",
            message: `HTTP ${response.status}`,
          },
        };
      }

      return json;
    } catch (err) {
      return {
        error: {
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Network error",
        },
      };
    }
  }
}
