/** API client for the Cloudflare Worker backend, with a configurable endpoint for self-hosted ones.
 *  Response-handling rationale: docs/architecture.md → API client 的回應處理. */

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
  LookupResult,
  MemberSettingsPayload,
  OtpInfo,
  PersonalBooks,
  PublicShelf,
  SetVerifyBody,
  UnkickResult,
  VerifyInfo,
  VersionInfo,
} from "./types";
import {
  ApiError,
  AUTH_REFRESH_RATE_LIMITED,
  BorrowStatus,
  type BoolFlag,
} from "./types";
import {
  doRefreshToken,
  type FamilyRemovedInfo,
  type ReauthInfo,
  type RefreshOutcome,
} from "./auth-refresh";
import { sanitizeBorrowRequests } from "moo-family-bookshelf-shared/borrow/validation";
import {
  sanitizeFamilyMember,
  sanitizeFamilyMembersResponse,
} from "moo-family-bookshelf-shared/api/memberValidation";
import { sanitizeFamilyBookshelfResponse } from "moo-family-bookshelf-shared/api/bookshelfValidation";

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
  FamilyBookshelfMember,
  FamilyGroup,
  FamilyMember,
  LookupResult,
  MemberSettingsPayload,
  OtpInfo,
  PersonalBooks,
  PublicShelf,
  PublicShelfData,
  SelectionMode,
  SetVerifyBody,
  UnkickResult,
  VerifyInfo,
  VerifyMethod,
  VersionInfo,
} from "./types";

import { DEFAULT_PWA_URL } from "../constants";

/** Proactive refresh buffer: 5 minutes before expiry */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** The one bodyless status this API answers (`DELETE /api/user/:id/public-shelf/:shelfId`); keep it
 *  to exactly this one (docs/architecture.md → API client 的回應處理). */
const NO_CONTENT_STATUS = 204;

/** Read the `{ data, error }` envelope; a 204 is an empty envelope (`response.json()` would throw
 *  on it), every other response still parses — or throws — as JSON. */
async function readEnvelope<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.status === NO_CONTENT_STATUS) return {};
  return (await response.json()) as ApiResponse<T>;
}

/** Provenance marker for a client-built error envelope: `JSON.parse` never yields a symbol key, so no
 *  backend can forge it. See docs/architecture.md → 伺服器回傳資料的檢查 (`synthesized`). */
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

/** User-facing copy for a rate-limited auto-recovery; appends the wait, rounded up to whole minutes,
 *  when the cooldown deadline is known and still ahead. */
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
  /** Latch set once a re-verification prompt is raised; cleared by a non-null token or
   *  `clearReauthPending`. See docs/architecture.md → 認證更新與冷卻. */
  private reauthPending = false;
  /** Called when refresh finds the family genuinely gone (the caller clears family data), with the
   *  family-gone code so the UI can explain WHY the dialog fell back to onboarding. */
  onFamilyRemoved: ((info: FamilyRemovedInfo) => void) | null = null;
  /** Called when recovery needs the PWA-login secret, so the caller re-verifies instead of dropping
   *  data; gets the blocking code (+ `retryAfter`) so the prompt can open already locked. */
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

  /** Refresh the token when it is about to expire (`REFRESH_BUFFER_MS`); true when it is still valid
   *  or was refreshed. */
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

  /** `unwrap` for bodyless (204) successes: only `error` throws — demanding `data` would turn every
   *  successful 204 into a bogus EMPTY_RESPONSE. */
  private unwrapVoid(res: ApiResponse<unknown>): void {
    this.throwOnError(res);
  }

  /** Coerce a success payload's backend TEXT fields so no consumer holds a non-string `string` field
   *  (`shared/src/api/safeText.ts`); error envelopes and bodyless successes pass untouched. */
  private sanitizeEnvelope<T>(
    res: ApiResponse<T>,
    sanitize: (data: T) => T,
  ): ApiResponse<T> {
    if (res.data === undefined) return res;
    return { ...res, data: sanitizeRecord(res.data, sanitize) };
  }

  /** Single chokepoint for every thrown `ApiError`: sanitizes `code` / `message`, while provenance is
   *  read off the ORIGINAL payload (docs/architecture.md → API client 的回應處理). */
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

  /** Family lookup by pre-hashed userId (server never sees the email); `verifySecret`, its
   *  `requiresVerification` answer and error codes: docs/architecture.md → PWA 登入驗證機制. */
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
    data: PersonalBooks & { expectedLastUpdated?: string },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.put(`/api/user/${userId}/books`, data);
  }

  /** Partial save of only the changed books (manual save), cutting upload vs the full PUT. Unknown
   *  bookIds are skipped server-side without error; new (un-synced) books must go via PUT. */
  async patchPersonalBooks(
    userId: string,
    changes: Array<{ bookId: string; isShared: BoolFlag }>,
  ): Promise<ApiResponse<{ ok: boolean; applied: number }>> {
    return this.patch(`/api/user/${userId}/books`, { changes });
  }

  /** Viewer-private family-shelf prefs (v1.5.0), server-side for Extension/PWA parity. A sent list
   *  (`hidden` / `favorites`) full-replaces its counterpart, an absent one is kept; refs: `{ownerId}:{bookId}`. */
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

  /** Create a family; accounts with PWA login verification must send `verifySecret`, else 403
   *  `VERIFICATION_REQUIRED` / `VERIFICATION_FAILED`, or 429 `VERIFICATION_LOCKED` + `retryAfter`. */
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
    // `recovery` is sent only by the re-verification join in dialog/useReauth.ts.
    opts?: { verifySecret?: string; recovery?: BoolFlag },
  ): Promise<ApiResponse<FamilyGroup>> {
    const body: Record<string, string | BoolFlag> = {
      userId,
      displayName: displayName ?? "",
    };
    if (opts?.verifySecret !== undefined) body.verifySecret = opts.verifySecret;
    if (opts?.recovery !== undefined) body.recovery = opts.recovery;
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

  /** Lift `removeMember`'s kicked tombstone early. Does NOT re-add anyone (UnkickNotice's copy must
   *  keep saying so). Owner-only (403 `NOT_OWNER`); idempotent: no live tombstone still answers 200. */
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

  /** Read as `unknown` until `sanitizeFamilyMembersResponse` checks it; the whole envelope is checked
   *  so an `error` one reaches the caller unchanged. See docs/architecture.md → API client 的回應處理. */
  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    const res = await this.get<unknown>(`/api/family/${familyId}/members`);
    // Structure layer first (rebuilds `data.members`, normalizes `apiEndpoint`), then the text layer
    // (`familyId` / `ownerId` / `createdAt`): docs/architecture.md → 伺服器回傳資料的檢查.
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

  /** Read as `unknown`; structure layer (drops unusable `userId` / `bookId`) then text layer, on the
   *  whole envelope. See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<FamilyBookshelf>> {
    const res = await this.get<unknown>(`/api/family/${familyId}/bookshelf`);
    return this.sanitizeEnvelope(
      sanitizeFamilyBookshelfResponse<FamilyBookshelf>(res),
      sanitizeFamilyBookshelfText,
    );
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

  /** Read as `unknown` until `sanitizeBorrowRequests` checks it; `unwrap` runs first, owning the
   *  envelope contract (`ApiError` on `error`, `EMPTY_RESPONSE` on missing data). */
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

  /** Read as `unknown` until `sanitizeFamilyMember` checks it (`unwrap` first); an unusable payload
   *  throws, which every caller catches. See docs/architecture.md → API client 的回應處理. */
  async updateMemberSettings(
    familyId: string,
    uid: string,
    settings: MemberSettingsPayload,
  ): Promise<FamilyMember> {
    const res = await this.patch<unknown>(
      `/api/family/${familyId}/member/${uid}`,
      settings,
    );
    const member = sanitizeFamilyMember(this.unwrap(res));
    if (member === null) {
      throw new ApiError(
        "INVALID_RESPONSE",
        "response is not a valid family member",
      );
    }
    // Same two layers, same order as `getFamilyMembers`: the structural rebuild above, then the text
    // layer on the surviving record's declared-string fields.
    return sanitizeRecord(member, sanitizeMemberText);
  }

  // --- Verification ---

  async getVerifyMethod(userId: string): Promise<ApiResponse<VerifyInfo>> {
    return this.get(`/api/user/${userId}/verify`);
  }

  async setVerifyMethod(
    userId: string,
    body: SetVerifyBody,
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

  /** Revoke a public shelf; throws `ApiError` on refusal, and the caller MUST NOT then report the link
   *  closed (the snapshot stays readable until this succeeds). */
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
        // Rate-limited recovery: a client-synthesized localized error, not the raw English 401 — its
        // own code + marker let the UI show it verbatim. docs/architecture.md → 認證更新與冷卻.
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

  /** Refresh the auth token, returning the structured outcome; concurrent callers share a single
   *  in-flight refresh. */
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
