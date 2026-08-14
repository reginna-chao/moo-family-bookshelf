/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import browser from "webextension-polyfill";
import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { DEFAULT_API_ENDPOINT, TOKEN_EXPIRES_AT_KEY } from "../constants";

/**
 * Endpoint validation lives in `shared/` so the PWA enforces byte-identical
 * rules. Re-exported here because every existing importer reaches for it via
 * the API client — new code outside `api/` should import the shared module
 * directly rather than routing through this file.
 */
export { validateEndpointUrl };

import type {
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
  VerifyInfo,
  VersionInfo,
} from "./types";
import { BorrowStatus, type VerifyMethod, type BoolFlag } from "./types";
import {
  doRefreshToken,
  type ReauthInfo,
  type RefreshOutcome,
} from "./auth-refresh";

// Re-export all types so existing imports from "./client" continue to work
export { BoolFlag, BorrowStatus, PERSONAL_BOOKS_SCHEMA_VERSION } from "./types";
export type {
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
   * join-recovery so a single dialog open burns at most one join-quota unit and
   * the in-progress verification prompt is never re-initialized. Cleared when a
   * non-null token is set, or explicitly via `clearReauthPending`.
   */
  private reauthPending = false;
  /** Callback invoked when token refresh fails because the family is genuinely
   *  gone (deleted / user no longer a member) — the caller clears family data. */
  onFamilyRemoved: (() => void) | null = null;
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
      return json.data ?? null;
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

  /** Unwrap an envelope response or throw an Error built from `error`. */
  private unwrap<T>(res: ApiResponse<T>): T {
    if (res.error) {
      throw new Error(`${res.error.code}: ${res.error.message}`);
    }
    if (res.data === undefined) {
      throw new Error("EMPTY_RESPONSE: response body missing data");
    }
    return res.data;
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
    return this.get(`/api/user/${userId}/books`);
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
    return this.post("/api/family", body);
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
    return this.post(`/api/family/${familyId}/join`, body);
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

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
    clearEndpoint?: 1,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.put(`/api/family/${familyId}/transfer`, {
      userId,
      newOwnerId,
      ...(clearEndpoint !== undefined && { clearEndpoint }),
    });
  }

  async updateFamilyEndpoint(
    familyId: string,
    apiEndpoint: string | null,
  ): Promise<ApiResponse<{ familyId: string; apiEndpoint: string | null }>> {
    return this.put(`/api/family/${familyId}/endpoint`, { apiEndpoint });
  }

  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    return this.get(`/api/family/${familyId}/members`);
  }

  // --- Account ---

  async deleteAccount(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
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
    return this.post(`/api/user/${userId}/verify/otp`);
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
    return this.unwrap(res);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
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
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}/reset-token`,
    );
    return this.unwrap(res);
  }

  async deletePublicShelf(userId: string, shelfId: string): Promise<void> {
    await this.del(`/api/user/${userId}/public-shelf/${shelfId}`);
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
      const json = (await response.json()) as ApiResponse<T>;

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
        // friendly localized message instead of the raw English 401.
        if (outcome.rateLimited) {
          return {
            error: {
              code: "RATE_LIMITED",
              message: buildRateLimitMessage(outcome.cooldownUntil),
            },
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
