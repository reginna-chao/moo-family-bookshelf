/** API client for the Cloudflare Worker backend, with a configurable endpoint for self-hosted ones.
 *  Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import {
  sanitizeBorrowRequestText,
  sanitizeFamilyBookshelfText,
  sanitizeFamilyGroupText,
  sanitizeMemberText,
  sanitizePersonalBooksText,
  sanitizePublicShelfDataText,
  sanitizePublicShelfListText,
  sanitizePublicShelfResultText,
  sanitizeVersionInfoText,
} from "moo-family-bookshelf-shared/api/entityText";
import { BoolFlag, ApiError } from "moo-family-bookshelf-shared/api/types";
import type {
  ApiResponse,
  BookEntry,
  FamilyBookshelf,
  FamilyGroup,
  FamilyMember,
  LookupResult,
  MemberSettingsPayload,
  PersonalBooks,
  PublicShelf,
  PublicShelfData,
  SetVerifyBody,
  UnkickResult,
  VerifyInfo,
  VersionInfo,
} from "moo-family-bookshelf-shared/api/types";
import { BorrowStatus } from "moo-family-bookshelf-shared/borrow/types";
import type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";
import { sanitizeBorrowRequests } from "moo-family-bookshelf-shared/borrow/validation";
import { sanitizeFamilyMembersResponse } from "moo-family-bookshelf-shared/api/memberValidation";
import { sanitizeFamilyBookshelfResponse } from "moo-family-bookshelf-shared/api/bookshelfValidation";
import { DEFAULT_API_ENDPOINT } from "../constants";

/**
 * Endpoint validation lives in `shared/` so Extension and PWA enforce
 * byte-identical rules — the PWA adopts a sync code's `@host` too, so a weaker
 * copy here would be the whole point of the check undone. Re-exported because
 * existing importers reach for it via the API client.
 */
export { validateEndpointUrl };

/**
 * The wire contract itself — the `{ data, error }` envelope, `BoolFlag`, the
 * family / bookshelf / borrow records, the `POST /api/auth/lookup` payload,
 * the thrown `ApiError`, the personal-books record, the `/api/version` and
 * `/api/user/:id/verify*` shapes, the member-settings payload, the un-kick
 * result and the public-shelf records — lives in `shared/` for the same
 * reason, so the two apps cannot describe the same payload differently.
 * Re-exported here because every existing importer reaches for these names
 * through the API client — new code outside `api/` should import the shared
 * modules directly rather than routing through this file. `BoolFlag`,
 * `ApiError` and the `import type` list above are imported as real bindings
 * because this file's methods use them; the rest are plain re-exports.
 */
export { BoolFlag, BorrowStatus, ApiError };
export { PERSONAL_BOOKS_SCHEMA_VERSION } from "moo-family-bookshelf-shared/api/types";
export type {
  ApiErrorPayload,
  ApiResponse,
  BookEntry,
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
} from "moo-family-bookshelf-shared/api/types";
export type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";

/** The one bodyless status this API answers (`DELETE /api/user/:id/public-shelf/:shelfId`); keep it
 *  to exactly this one (docs/architecture.md → API client 的回應處理). */
const NO_CONTENT_STATUS = 204;

/** Read the `{ data, error }` envelope; a 204 is an empty envelope (`response.json()` would throw
 *  on it), every other response still parses — or throws — as JSON. */
async function readEnvelope<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.status === NO_CONTENT_STATUS) return {};
  return (await response.json()) as ApiResponse<T>;
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
      const data = json.data ?? null;
      if (data === null) return null;
      return sanitizeRecord(data, sanitizeVersionInfoText);
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

  /** Single chokepoint for every thrown `ApiError`: sanitizes `code` / `message` so a hostile value
   *  cannot make the constructor itself throw (docs/architecture.md → API client 的回應處理). */
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

  /** Family lookup by pre-hashed userId (server never sees the email). Unused by the PWA today, kept
   *  in sync with the Extension client; `verifySecret`: docs/architecture.md → PWA 登入驗證機制. */
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
    const res = await this.get<PersonalBooks>(`/api/user/${userId}/books`);
    return this.sanitizeEnvelope(res, sanitizePersonalBooksText);
  }

  async updatePersonalBooks(
    userId: string,
    data: PersonalBooks & { expectedLastUpdated?: string },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/user/${userId}/books`, data);
  }

  /** Partial save of only the changed books, cutting upload vs the full PUT. Unknown bookIds are
   *  skipped server-side without error; new (un-synced) books must go via PUT. */
  async patchPersonalBooks(
    userId: string,
    changes: Array<{ bookId: BookEntry["bookId"]; isShared: BoolFlag }>,
  ): Promise<ApiResponse<{ ok: boolean; applied: number }>> {
    this.validateHexId(userId, "userId");
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

  /** Create a new family. NOTE: the PWA MUST NOT call this — it can only join families
   *  (Phase 1 Q2). */
  async createFamily(
    userId: string,
    displayName?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    this.validateHexId(userId, "userId");
    const body: Record<string, string> = {
      userId,
      displayName: displayName ?? "",
    };
    const res = await this.post<FamilyGroup>("/api/family", body);
    return this.sanitizeEnvelope(res, sanitizeFamilyGroupText);
  }

  async joinFamily(
    familyId: string,
    userId: string,
    // `recovery`: silent recovery join (App.tsx) + forced re-login (completeJoin, #266).
    opts?: { verifySecret?: string; qrToken?: string; recovery?: BoolFlag },
  ): Promise<
    ApiResponse<{ ok: boolean; authToken?: string; expiresAt?: number }>
  > {
    this.validateHexId(userId, "userId");
    const body: Record<string, string | BoolFlag> = { userId };
    if (opts?.verifySecret !== undefined) body.verifySecret = opts.verifySecret;
    if (opts?.qrToken !== undefined) body.qrToken = opts.qrToken;
    if (opts?.recovery !== undefined) body.recovery = opts.recovery;
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

  /** Lift `removeMember`'s kicked tombstone early. Does NOT re-add anyone (UnkickNotice's copy must
   *  keep saying so). Owner-only (403 `NOT_OWNER`); idempotent: no live tombstone still answers 200. */
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
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfListText);
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
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
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
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}/reset-token`,
    );
    return sanitizeRecord(this.unwrap(res), sanitizePublicShelfResultText);
  }

  /** Revoke a public shelf; throws `ApiError` on refusal, and the caller MUST NOT then report the link
   *  closed (the snapshot stays readable until this succeeds). */
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
      // Sanitize before interpolation, or a hostile field throws before `status` is attached and a
      // 404 loses its own screen (docs/architecture.md → API client 的回應處理).
      const code = safeErrorText(json.error.code, "UNKNOWN_ERROR");
      const message = safeErrorText(json.error.message, "請稍後再試");
      const err = new Error(`${code}: ${message}`);
      (err as Error & { status: number }).status = response.status;
      throw err;
    }
    if (!json.data) {
      throw new Error("EMPTY_RESPONSE: response body missing data");
    }
    // Own bare cast above, so this sanitizer is the ONLY guard before `PublicShelfPage` renders and
    // `.toLowerCase()`s these fields (docs/architecture.md → API client 的回應處理).
    return sanitizeRecord(json.data, sanitizePublicShelfDataText);
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
