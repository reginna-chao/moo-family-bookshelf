/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import browser from "webextension-polyfill";
import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import {
  sanitizeBorrowRequestText,
  sanitizeFamilyBookshelfText,
  sanitizeFamilyGroupText,
  sanitizeMemberText,
  sanitizeOtpInfoText,
  sanitizePersonalBooksText,
  sanitizePublicShelfListText,
  sanitizePublicShelfResultText,
  sanitizeVersionInfoText,
} from "moo-family-bookshelf-shared/api/entityText";
import { DEFAULT_API_ENDPOINT, TOKEN_EXPIRES_AT_KEY } from "../constants";

/**
 * Endpoint validation lives in `shared/` so the PWA enforces byte-identical
 * rules. Re-exported here because every existing importer reaches for it via
 * the API client — new code outside `api/` should import the shared module
 * directly rather than routing through this file.
 */
export { validateEndpointUrl };

import type {
  ApiErrorPayload,
  ApiResponse,
  BorrowRequest,
  CreateBorrowPayload,
  FamilyBookshelf,
  FamilyGroup,
  FamilyMember,
  MemberSettingsPayload,
  OtpInfo,
  PersonalBooks,
  PublicShelf,
  UnkickResult,
  VerifyInfo,
  VersionInfo,
} from "./types";
import {
  ApiError,
  AUTH_REFRESH_RATE_LIMITED,
  BorrowStatus,
  type VerifyMethod,
  type BoolFlag,
} from "./types";
import {
  doRefreshToken,
  type FamilyRemovedInfo,
  type ReauthInfo,
  type RefreshOutcome,
} from "./auth-refresh";
import { sanitizeBorrowRequests } from "./borrowValidation";
import { sanitizeFamilyMembersResponse } from "./memberValidation";

// Re-export all types so existing imports from "./client" continue to work
export {
  ApiError,
  AUTH_REFRESH_RATE_LIMITED,
  BoolFlag,
  BorrowStatus,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "./types";
export type {
  ApiErrorPayload,
  ApiResponse,
  BookEntry,
  BorrowRequest,
  CreateBorrowPayload,
  FamilyBookshelf,
  FamilyGroup,
  FamilyMember,
  MemberSettingsPayload,
  OtpInfo,
  PersonalBooks,
  PublicShelf,
  PublicShelfData,
  SelectionMode,
  UnkickResult,
  VerifyInfo,
  VerifyMethod,
  VersionInfo,
} from "./types";

import { DEFAULT_PWA_URL } from "../constants";

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
   * this field, and self-hosted (BYO) backends can lag the Extension by any
   * number of releases. Absent means "no verification gate on this account".
   */
  requiresVerification?: BoolFlag;
}

/** Proactive refresh buffer: 5 minutes before expiry */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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
 * Provenance marker for an error envelope this client built itself.
 *
 * `JSON.parse` can never produce a symbol-keyed property, so no response body —
 * not even from a self-hosted (BYO) or hostile backend — can forge it. That is
 * what turns "client-synthesized" from a comment into a checkable fact: the UI
 * renders an error's raw message verbatim only for a marked payload.
 */
const CLIENT_SYNTHESIZED = Symbol("client-synthesized error payload");

interface SynthesizedErrorPayload extends ApiErrorPayload {
  [CLIENT_SYNTHESIZED]: true;
}

/** Build an error payload that is provably not server-supplied. */
function synthesizeError(
  code: string,
  message: string,
): SynthesizedErrorPayload {
  return { code, message, [CLIENT_SYNTHESIZED]: true };
}

/** True only for payloads built by `synthesizeError` above. */
function isClientSynthesized(payload: ApiErrorPayload): boolean {
  const marked: Partial<SynthesizedErrorPayload> = payload;
  return marked[CLIENT_SYNTHESIZED] === true;
}

/**
 * Build the user-facing message shown when auto-recovery was rate-limited.
 * Appends an approximate wait (rounded up to whole minutes) when the cooldown
 * deadline is known.
 */
function buildRateLimitMessage(cooldownUntil?: number): string {
  const base = "嘗試次數過多，請稍後再重新開啟書櫃";
  if (cooldownUntil === undefined) return base;
  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) return base;
  const minutes = Math.ceil(remainingMs / (60 * 1000));
  return `${base}（約 ${minutes} 分鐘後）`;
}

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;
  /** Guard: holds the in-flight token refresh outcome while one is running */
  private refreshInProgress: Promise<RefreshOutcome> | null = null;
  /**
   * Latch: set true once a re-verification prompt has been raised (see
   * `doRefreshToken`). While latched, further 401 waves skip silent
   * join-recovery so a single dialog open spends at most one rate-limit unit and
   * the in-progress verification prompt is never re-initialized. Cleared when a
   * non-null token is set, or explicitly via `clearReauthPending`.
   */
  private reauthPending = false;
  /** Callback invoked when token refresh fails because the family is genuinely
   *  gone (deleted / user no longer a member) — the caller clears family data.
   *  Receives the family-gone code that triggered the teardown so the UI can
   *  explain WHY the dialog fell back to onboarding. */
  onFamilyRemoved: ((info: FamilyRemovedInfo) => void) | null = null;
  /** Callback invoked when recovery needs a PWA-login verification secret, so
   *  the caller can prompt re-verification instead of dropping the user's data.
   *  Receives the blocking error code (+ retryAfter when the backend sent one)
   *  so the prompt can open already locked with a countdown. */
  onReauthRequired: ((info?: ReauthInfo) => void) | null = null;
  /** In-flight GET request deduplication map: URL -> Promise */
  private inflightGets = new Map<string, Promise<ApiResponse<unknown>>>();

  constructor(apiUrl?: string) {
    this.baseUrl = validateEndpointUrl(apiUrl ?? DEFAULT_API_ENDPOINT);
  }

  setEndpoint(url: string): void {
    this.baseUrl = validateEndpointUrl(url);
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
    // A fresh (non-null) token means auth succeeded — release the reauth latch.
    // A null token (set mid-failure by doRefreshToken) must NOT clear it.
    if (token !== null) {
      this.reauthPending = false;
    }
  }

  /** Release the reauth latch so the next authenticated action can re-challenge. */
  clearReauthPending(): void {
    this.reauthPending = false;
  }

  /** Check server API version. Returns null on network/parse errors. */
  async checkVersion(): Promise<VersionInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`);
      if (!res.ok) return null;
      const json = (await res.json()) as ApiResponse<VersionInfo>;
      const data = json.data ?? null;
      if (data === null) return null;
      return sanitizeRecord(data, sanitizeVersionInfoText);
    } catch {
      return null;
    }
  }

  /**
   * Proactively refresh the token if it is about to expire.
   * Returns true if the token is still valid or was refreshed successfully.
   */
  async proactiveRefresh(): Promise<boolean> {
    try {
      const expiryResult =
        await browser.storage.local.get(TOKEN_EXPIRES_AT_KEY);
      const tokenExpiresAt = expiryResult[TOKEN_EXPIRES_AT_KEY];
      if (!tokenExpiresAt) return true; // No expiry info — assume valid

      if (Date.now() > (tokenExpiresAt as number) - REFRESH_BUFFER_MS) {
        const outcome = await this.refreshToken();
        return outcome.refreshed;
      }
      return true; // Token still valid
    } catch {
      return false;
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
   * Coerce a success payload's backend TEXT fields before it leaves the client,
   * so no consumer ever holds a `string`-typed field that is not one (see
   * `shared/src/api/safeText.ts`). Error envelopes and bodyless successes pass
   * through untouched.
   */
  private sanitizeEnvelope<T>(
    res: ApiResponse<T>,
    sanitize: (data: T) => T,
  ): ApiResponse<T> {
    if (res.data === undefined) return res;
    return { ...res, data: sanitizeRecord(res.data, sanitize) };
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
   * validates it — and `isClientSynthesized` deliberately reads the ORIGINAL
   * payload, since the symbol marker is the provenance proof and must not be
   * inferred from sanitized text.
   */
  private throwOnError(res: ApiResponse<unknown>): void {
    if (res.error) {
      throw new ApiError(
        safeErrorText(res.error.code, "UNKNOWN_ERROR"),
        safeErrorText(res.error.message, "請稍後再試"),
        res.error.retryAfter,
        isClientSynthesized(res.error),
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
    const res = await this.get<PersonalBooks>(`/api/user/${userId}/books`);
    return this.sanitizeEnvelope(res, sanitizePersonalBooksText);
  }

  async updatePersonalBooks(
    userId: string,
    data: PersonalBooks,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.put(`/api/user/${userId}/books`, data);
  }

  /**
   * Partial update — send only the changed books (diff). Used by the manual
   * "save" flow to cut upload traffic vs the full-payload PUT. Unknown bookIds
   * are silently skipped server-side; new (un-synced) books must go via PUT.
   */
  async patchPersonalBooks(
    userId: string,
    changes: Array<{ bookId: string; isShared: BoolFlag }>,
  ): Promise<ApiResponse<{ ok: boolean; applied: number }>> {
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
   * Create a new family. Accounts with PWA login verification configured must
   * supply `verifySecret`; otherwise the server replies 403
   * `VERIFICATION_REQUIRED` / `VERIFICATION_FAILED`, or 429
   * `VERIFICATION_LOCKED` with `error.retryAfter`.
   */
  async createFamily(
    userId: string,
    displayName: string | undefined,
    opts?: { verifySecret?: string },
  ): Promise<ApiResponse<FamilyGroup>> {
    const body: Record<string, string> = {
      userId,
      displayName: displayName ?? "",
    };
    if (opts?.verifySecret !== undefined) {
      body.verifySecret = opts.verifySecret;
    }
    const res = await this.post<FamilyGroup>("/api/family", body);
    return this.sanitizeEnvelope(res, sanitizeFamilyGroupText);
  }

  async joinFamily(
    familyId: string,
    userId: string,
    displayName?: string,
    opts?: { verifySecret?: string },
  ): Promise<ApiResponse<FamilyGroup>> {
    const body: Record<string, string> = {
      userId,
      displayName: displayName ?? "",
    };
    if (opts?.verifySecret !== undefined) {
      body.verifySecret = opts.verifySecret;
    }
    const res = await this.post<FamilyGroup>(
      `/api/family/${familyId}/join`,
      body,
    );
    return this.sanitizeEnvelope(res, sanitizeFamilyGroupText);
  }

  async updateDisplayName(
    familyId: string,
    userId: string,
    displayName: string,
  ): Promise<ApiResponse<{ userId: string; displayName: string }>> {
    return this.put(`/api/family/${familyId}/member/${userId}/displayName`, {
      displayName,
    });
  }

  async leaveFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.del(`/api/family/${familyId}/member/${userId}`);
  }

  async removeMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.del(`/api/family/${familyId}/member/${targetUserId}`);
  }

  /**
   * Lift the "kicked" tombstone `removeMember` leaves behind, so the removed
   * member can use the sync code again before it expires on its own.
   *
   * This does NOT put anyone back in the family: the member stays out and must
   * join again themselves — the copy in `dialog/UnkickNotice.tsx` says so, and
   * must keep saying so. Owner-only server-side (403 `NOT_OWNER` otherwise) and
   * idempotent: no live tombstone still answers 200.
   */
  async unkickMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<UnkickResult>> {
    return this.del(`/api/family/${familyId}/kicked/${targetUserId}`);
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
    clearEndpoint?: 1,
  ): Promise<ApiResponse<FamilyGroup>> {
    const res = await this.put<FamilyGroup>(
      `/api/family/${familyId}/transfer`,
      {
        userId,
        newOwnerId,
        ...(clearEndpoint !== undefined && { clearEndpoint }),
      },
    );
    return this.sanitizeEnvelope(res, sanitizeFamilyGroupText);
  }

  async updateFamilyEndpoint(
    familyId: string,
    apiEndpoint: string | null,
  ): Promise<ApiResponse<{ familyId: string; apiEndpoint: string | null }>> {
    return this.put(`/api/family/${familyId}/endpoint`, { apiEndpoint });
  }

  /**
   * `unknown`, not `FamilyGroup`: the wire shape is only a claim until
   * `sanitizeFamilyMembersResponse` has checked it. The envelope is sanitized
   * whole — callers of this method read `{ data, error }` themselves instead of
   * going through `unwrap`, so an `error` envelope must reach them unchanged
   * while `data.members` is rebuilt.
   */
  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    const res = await this.get<unknown>(`/api/family/${familyId}/members`);
    // Two deliberate layers, in this order: `memberValidation` rebuilds
    // `data.members` structurally (drops unaddressable elements, strips hostile
    // extras) and normalizes `apiEndpoint`; the shared text layer then coerces
    // the remaining declared-string fields (`familyId` / `ownerId` /
    // `createdAt`) that memberValidation documents as out of its scope.
    return this.sanitizeEnvelope(
      sanitizeFamilyMembersResponse(res),
      sanitizeFamilyGroupText,
    );
  }

  // --- Account ---

  async deleteAccount(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.del(`/api/user/${userId}`);
  }

  // --- Family Bookshelf ---

  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<FamilyBookshelf>> {
    const res = await this.get<FamilyBookshelf>(
      `/api/family/${familyId}/bookshelf`,
    );
    return this.sanitizeEnvelope(res, sanitizeFamilyBookshelfText);
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
    return sanitizeRecord(this.unwrap(res), sanitizeBorrowRequestText);
  }

  /**
   * `unknown`, not `BorrowRequest[]`: the wire shape is only a claim until
   * `sanitizeBorrowRequests` has checked it. `unwrap` still runs first — it owns
   * the `{ data, error }` envelope contract (throws `ApiError` on `error`,
   * `EMPTY_RESPONSE` on missing data).
   */
  async listBorrowRequests(familyId: string): Promise<BorrowRequest[]> {
    const res = await this.get<unknown>(`/api/family/${familyId}/borrow`);
    return sanitizeBorrowRequests(this.unwrap(res));
  }

  async updateBorrowStatus(
    requestId: string,
    status: BorrowStatus,
  ): Promise<BorrowRequest> {
    const res = await this.patch<BorrowRequest>(`/api/borrow/${requestId}`, {
      status,
    });
    return sanitizeRecord(this.unwrap(res), sanitizeBorrowRequestText);
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
    return sanitizeRecord(this.unwrap(res), sanitizeMemberText);
  }

  // --- Verification ---

  async getVerifyMethod(userId: string): Promise<ApiResponse<VerifyInfo>> {
    return this.get(`/api/user/${userId}/verify`);
  }

  async setVerifyMethod(
    userId: string,
    body: { method: VerifyMethod; secret?: string; prompted?: number },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.put(`/api/user/${userId}/verify`, body);
  }

  async generateOtp(userId: string): Promise<ApiResponse<OtpInfo>> {
    const res = await this.post<OtpInfo>(`/api/user/${userId}/verify/otp`);
    return this.sanitizeEnvelope(res, sanitizeOtpInfoText);
  }

  // --- QR Token ---

  /** Create a short-lived QR token for PWA auto-login (bypasses verification). */
  async createQrToken(
    userId: string,
  ): Promise<ApiResponse<{ token: string; expiresIn: number }>> {
    return this.post(`/api/user/${userId}/qr-token`);
  }

  // --- Public Shelf (v1.2.0) ---

  getPublicShelfUrl(shareToken: string, pwaOriginOverride?: string): string {
    const origin =
      pwaOriginOverride && pwaOriginOverride.length > 0
        ? pwaOriginOverride
        : DEFAULT_PWA_URL;
    return `${origin}/public/${shareToken}`;
  }

  async listPublicShelves(userId: string): Promise<{ shelves: PublicShelf[] }> {
    const res = await this.get<{ shelves: PublicShelf[] }>(
      `/api/user/${userId}/public-shelf`,
    );
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfListText);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf`,
      body,
    );
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
  }

  async updatePublicShelf(
    userId: string,
    shelfId: string,
    body: { title?: string; expiresDays?: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.put<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}`,
      body,
    );
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}/reset-token`,
    );
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
  }

  /**
   * Revoke a public shelf. Throws `ApiError` when the server refused — the
   * caller MUST NOT report the link as closed on a rejected request (the
   * snapshot stays readable until this succeeds).
   */
  async deletePublicShelf(userId: string, shelfId: string): Promise<void> {
    const res = await this.del(`/api/user/${userId}/public-shelf/${shelfId}`);
    this.unwrapVoid(res);
  }

  // --- Internal ---

  private async request<T>(
    path: string,
    init?: RequestInit,
    /** When true, skip 401 interception to prevent infinite loops */
    skipRefresh = false,
  ): Promise<ApiResponse<T>> {
    const method = init?.method?.toUpperCase() ?? "GET";
    const url = `${this.baseUrl}${path}`;

    // Deduplicate concurrent GET requests to the same URL
    if (method === "GET" && !skipRefresh) {
      const existing = this.inflightGets.get(url);
      if (existing) {
        return existing as Promise<ApiResponse<T>>;
      }
      const promise = this.doRequest<T>(url, init, skipRefresh);
      this.inflightGets.set(url, promise as Promise<ApiResponse<unknown>>);
      try {
        return await promise;
      } finally {
        this.inflightGets.delete(url);
      }
    }

    return this.doRequest<T>(url, init, skipRefresh);
  }

  private async doRequest<T>(
    url: string,
    init?: RequestInit,
    skipRefresh = false,
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

      // Intercept 401 — attempt automatic token refresh
      if (response.status === 401 && !skipRefresh) {
        // Clear stale dedup promises — token is about to change
        this.inflightGets.clear();
        const outcome = await this.refreshToken();
        if (outcome.refreshed) {
          // Retry original request with the new token (skip refresh to avoid loop)
          return this.doRequest<T>(url, init, true);
        }
        // Rate-limited recovery (fresh 429 or active cooldown) — surface a
        // friendly localized message instead of the raw English 401. The code is
        // distinct from the server's RATE_LIMITED so the UI can recognize this
        // bespoke copy and show it verbatim rather than replacing it with the
        // generic back-off sentence. `synthesizeError` stamps the unforgeable
        // marker that authorizes that verbatim rendering.
        if (outcome.rateLimited) {
          return {
            error: synthesizeError(
              AUTH_REFRESH_RATE_LIMITED,
              buildRateLimitMessage(outcome.cooldownUntil),
            ),
          };
        }
        // Refresh failed — return the original 401 error
        return {
          error: json.error ?? {
            code: "UNAUTHORIZED",
            message: "Authentication failed",
          },
        };
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

  /**
   * Attempt to refresh the auth token. Returns true on success.
   * Concurrent callers share a single in-flight refresh request.
   */
  private async refreshToken(): Promise<RefreshOutcome> {
    // Deduplicate: if a refresh is already in progress, wait for it
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = this.doRefreshToken();
    try {
      return await this.refreshInProgress;
    } finally {
      this.refreshInProgress = null;
    }
  }

  private async doRefreshToken(): Promise<RefreshOutcome> {
    return doRefreshToken({
      request: this.request.bind(this),
      // Route through setAuthToken so a recovered token also clears the latch.
      setAuthToken: (token) => {
        this.setAuthToken(token);
      },
      onFamilyRemoved: this.onFamilyRemoved,
      // Wrap the caller's callback so raising the prompt also sets the latch;
      // auth-refresh.ts stays latch-agnostic except for the isReauthPending skip.
      onReauthRequired: (info) => {
        this.reauthPending = true;
        this.onReauthRequired?.(info);
      },
      isReauthPending: () => this.reauthPending,
    });
  }

  private validateHexId(id: string, label: string): void {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`Invalid ${label}: expected 64-char hex string`);
    }
  }
}
