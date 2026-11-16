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
} from "moo-family-bookshelf-shared/api/entityText";
import { fetchVersion } from "moo-family-bookshelf-shared/api/versionFetch";
import { accountSettingsApi } from "moo-family-bookshelf-shared/api/accountSettings";
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
import { ApiError, BorrowStatus, type BoolFlag } from "./types";
import type { FamilyRemovedInfo, ReauthInfo } from "./auth-refresh";
import { ApiTransport } from "./transport";
import { sanitizeBorrowRequests } from "moo-family-bookshelf-shared/borrow/validation";
import {
  sanitizeFamilyMember,
  sanitizeFamilyMembersResponse,
} from "moo-family-bookshelf-shared/api/memberValidation";
import { sanitizeFamilyBookshelfResponse } from "moo-family-bookshelf-shared/api/bookshelfValidation";
import { sanitizePersonalBooksResponse } from "moo-family-bookshelf-shared/api/personalBooksValidation";
import { sanitizeVerifyInfoResponse } from "moo-family-bookshelf-shared/api/verifyValidation";
import { assertHexId } from "moo-family-bookshelf-shared/api/hexId";
import { sanitizeIssuedFamilyGroup } from "moo-family-bookshelf-shared/api/issuedCredentials";
import { adoptRotatedVerifyToken } from "moo-family-bookshelf-shared/api/verifyTokenRotation";
import { currentSecretBody } from "moo-family-bookshelf-shared/api/currentSecretBody";
import { isClientSynthesized } from "./synthesizedError";
import { withoutIssuedToken } from "./withoutIssuedToken";

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

function jsonInit(method: string, body?: unknown): RequestInit {
  return { method, body: body != null ? JSON.stringify(body) : undefined };
}

export class ApiClient {
  private transport: ApiTransport;
  /** Called when refresh finds the family genuinely gone (the caller clears family data), with the
   *  family-gone code so the UI can explain WHY the dialog fell back to onboarding. */
  onFamilyRemoved: ((info: FamilyRemovedInfo) => void) | null = null;
  /** Called when recovery needs the PWA-login secret, so the caller re-verifies instead of dropping
   *  data; gets the blocking code (+ `retryAfter`) so the prompt can open already locked. */
  onReauthRequired: ((info?: ReauthInfo) => void) | null = null;

  constructor(apiUrl?: string) {
    this.transport = new ApiTransport(
      validateEndpointUrl(apiUrl ?? DEFAULT_API_ENDPOINT),
      {
        onFamilyRemoved: () => this.onFamilyRemoved,
        onReauthRequired: () => this.onReauthRequired,
      },
    );
  }

  setEndpoint(url: string): void {
    this.transport.setEndpoint(validateEndpointUrl(url));
  }

  getEndpoint(): string {
    return this.transport.getEndpoint();
  }

  setAuthToken(token: string | null): void {
    this.transport.setAuthToken(token);
  }

  /** Release the reauth latch so the next authenticated action can re-challenge. */
  clearReauthPending(): void {
    this.transport.clearReauthPending();
  }

  /** Check server API version. Returns null on network/parse errors. */
  checkVersion(): Promise<VersionInfo | null> {
    return fetchVersion(this.getEndpoint());
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
        const outcome = await this.transport.refreshToken();
        return outcome.refreshed;
      }
      return true; // Token still valid
    } catch {
      return false;
    }
  }

  // --- HTTP helpers ---

  private get<T>(path: string): Promise<ApiResponse<T>> {
    return this.transport.request(path);
  }

  private post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.transport.request(path, jsonInit("POST", body));
  }

  private put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.transport.request(path, jsonInit("PUT", body));
  }

  private del<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.transport.request(path, jsonInit("DELETE", body));
  }

  private patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.transport.request(path, jsonInit("PATCH", body));
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
    assertHexId(userId, "userId");
    const body: Record<string, string> = { userId };
    if (opts?.verifySecret !== undefined) {
      body.verifySecret = opts.verifySecret;
    }
    return this.post("/api/auth/lookup", body);
  }

  // --- Personal Settings ---

  /** Account settings (#460); `shared/api/accountSettings` validates both replies. */
  readonly accountSettings = accountSettingsApi({
    get: (path) => this.get<unknown>(path),
    patch: (path, body) => this.patch<unknown>(path, body),
  });

  /** Read as `unknown`; structure layer (coerces each book's `BoolFlag` fields) then text layer, on
   *  the whole envelope. See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getPersonalBooks(userId: string): Promise<ApiResponse<PersonalBooks>> {
    const res = await this.get<unknown>(`/api/user/${userId}/books`);
    return this.sanitizeEnvelope(
      sanitizePersonalBooksResponse<PersonalBooks>(res),
      sanitizePersonalBooksText,
    );
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

  /** The 新書預設開放 setting (#238); 404 `NOT_FOUND` = a server that predates this setting. */
  async updateNewBookDefault(
    userId: string,
    flag: BoolFlag,
  ): Promise<ApiResponse<{ ok: boolean; newBookDefaultShared: BoolFlag }>> {
    assertHexId(userId, "userId");
    return this.put(`/api/user/${userId}/new-book-default`, {
      newBookDefaultShared: flag,
    });
  }

  /** Viewer-private family-shelf prefs (v1.5.0), server-side for Extension/PWA parity. A sent list
   *  (`hidden` / `favorites`) full-replaces its counterpart, an absent one is kept; refs: `{ownerId}:{bookId}`. */
  async updateFamilyPrefs(
    userId: string,
    prefs: { hidden?: string[]; favorites?: string[] },
  ): Promise<
    ApiResponse<{ ok: boolean; hidden: string[]; favorites: string[] }>
  > {
    assertHexId(userId, "userId");
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
    return this.sanitizeEnvelope(res, sanitizeIssuedFamilyGroup);
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
    return this.sanitizeEnvelope(res, sanitizeIssuedFamilyGroup);
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

  /** `currentSecret` is required while the account's method is PIN / pattern. */
  async leaveFamily(
    familyId: string,
    userId: string,
    currentSecret?: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const body = currentSecretBody(currentSecret);
    return this.del(`/api/family/${familyId}/member/${userId}`, body);
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
    currentSecret?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    const res = await this.put<FamilyGroup>(
      `/api/family/${familyId}/transfer`,
      {
        userId,
        newOwnerId,
        ...(clearEndpoint !== undefined && { clearEndpoint }),
        ...currentSecretBody(currentSecret),
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

  /** `currentSecret` is required while the account's method is PIN / pattern (#396). */
  async deleteAccount(
    userId: string,
    currentSecret?: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    const body = currentSecret === undefined ? undefined : { currentSecret };
    return this.del(`/api/user/${userId}`, body);
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

  /** Read as `unknown`; an unknown `method` becomes an `INVALID_RESPONSE` error envelope, not a throw.
   *  See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getVerifyMethod(userId: string): Promise<ApiResponse<VerifyInfo>> {
    const res = await this.get<unknown>(`/api/user/${userId}/verify`);
    return sanitizeVerifyInfoResponse<VerifyInfo>(res);
  }

  /** A new pin / pattern revokes the old token (#378): its replacement is on this client on return,
   *  unless the client moved to another server meanwhile; that token then goes nowhere. */
  async setVerifyMethod(userId: string, body: SetVerifyBody) {
    const server = this.getEndpoint();
    const res = await this.put<unknown>(`/api/user/${userId}/verify`, body);
    const stale = this.getEndpoint() !== server;
    const checked = adoptRotatedVerifyToken(res, (token) => {
      if (!stale) this.setAuthToken(token);
    });
    return stale ? withoutIssuedToken(checked) : checked;
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
}
