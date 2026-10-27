/** API client for the Cloudflare Worker backend, with a configurable endpoint for self-hosted ones.
 *  Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import {
  sanitizeBorrowRequestText,
  sanitizeFamilyBookshelfText,
  sanitizeFamilyGroupText,
  sanitizeMemberText,
  sanitizePersonalBooksText,
  sanitizePublicShelfListText,
  sanitizePublicShelfResultText,
} from "moo-family-bookshelf-shared/api/entityText";
import {
  sanitizeIssuedCredentials,
  sanitizeIssuedFamilyGroup,
} from "moo-family-bookshelf-shared/api/issuedCredentials";
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
  VerifyPromptedInfo,
  VersionInfo,
} from "moo-family-bookshelf-shared/api/types";
import { BorrowStatus } from "moo-family-bookshelf-shared/borrow/types";
import type {
  BorrowRequest,
  CreateBorrowPayload,
} from "moo-family-bookshelf-shared/borrow/types";
import { sanitizeBorrowRequests } from "moo-family-bookshelf-shared/borrow/validation";
import {
  sanitizeFamilyMember,
  sanitizeFamilyMembersResponse,
} from "moo-family-bookshelf-shared/api/memberValidation";
import { sanitizeFamilyBookshelfResponse } from "moo-family-bookshelf-shared/api/bookshelfValidation";
import { sanitizePersonalBooksResponse } from "moo-family-bookshelf-shared/api/personalBooksValidation";
import { sanitizeVerifyInfoResponse } from "moo-family-bookshelf-shared/api/verifyValidation";
import { adoptRotatedVerifyToken } from "moo-family-bookshelf-shared/api/verifyTokenRotation";
import { assertHexId } from "moo-family-bookshelf-shared/api/hexId";
import { readEnvelope } from "moo-family-bookshelf-shared/api/readEnvelope";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { sanitizeEnvelope, unwrap, unwrapVoid } from "./envelopeHelpers";
import { fetchPublicShelf } from "./publicShelfFetch";
import { fetchVersion } from "./versionFetch";

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
  checkVersion(): Promise<VersionInfo | null> {
    return fetchVersion(this.baseUrl);
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

  // --- Auth ---

  /** Family lookup by pre-hashed userId (server never sees the email). Unused by the PWA today, kept
   *  in sync with the Extension client; `verifySecret`: docs/architecture.md → PWA 登入驗證機制. */
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

  /** Read as `unknown`; structure layer (coerces each book's `BoolFlag` fields) then text layer, on
   *  the whole envelope. See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getPersonalBooks(userId: string): Promise<ApiResponse<PersonalBooks>> {
    assertHexId(userId, "userId");
    const res = await this.get<unknown>(`/api/user/${userId}/books`);
    return sanitizeEnvelope(
      sanitizePersonalBooksResponse<PersonalBooks>(res),
      sanitizePersonalBooksText,
    );
  }

  async updatePersonalBooks(
    userId: string,
    data: PersonalBooks & { expectedLastUpdated?: string },
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    return this.put(`/api/user/${userId}/books`, data);
  }

  /** Partial save of only the changed books, cutting upload vs the full PUT. Unknown bookIds are
   *  skipped server-side without error; new (un-synced) books must go via PUT. */
  async patchPersonalBooks(
    userId: string,
    changes: Array<{ bookId: BookEntry["bookId"]; isShared: BoolFlag }>,
  ): Promise<ApiResponse<{ ok: boolean; applied: number }>> {
    assertHexId(userId, "userId");
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
    assertHexId(userId, "userId");
    return this.put(`/api/user/${userId}/family-prefs`, prefs);
  }

  // --- Family Group ---

  /** Create a new family. NOTE: the PWA MUST NOT call this — it can only join families
   *  (Phase 1 Q2). */
  async createFamily(
    userId: string,
    displayName?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    assertHexId(userId, "userId");
    const body: Record<string, string> = {
      userId,
      displayName: displayName ?? "",
    };
    const res = await this.post<FamilyGroup>("/api/family", body);
    return sanitizeEnvelope(res, sanitizeIssuedFamilyGroup);
  }

  async joinFamily(
    familyId: string,
    userId: string,
    // `recovery`: silent recovery join (App.tsx) + forced re-login (completeJoin, #266).
    opts?: { verifySecret?: string; qrToken?: string; recovery?: BoolFlag },
  ): Promise<
    ApiResponse<{ ok: boolean; authToken?: string; expiresAt?: number }>
  > {
    assertHexId(userId, "userId");
    const body: Record<string, string | BoolFlag> = { userId };
    if (opts?.verifySecret !== undefined) body.verifySecret = opts.verifySecret;
    if (opts?.qrToken !== undefined) body.qrToken = opts.qrToken;
    if (opts?.recovery !== undefined) body.recovery = opts.recovery;
    return sanitizeEnvelope(
      await this.post(`/api/family/${familyId}/join`, body),
      sanitizeIssuedCredentials,
    );
  }

  async leaveFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    return this.del(`/api/family/${familyId}/member/${userId}`);
  }

  async removeMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(targetUserId, "targetUserId");
    return this.del(`/api/family/${familyId}/member/${targetUserId}`);
  }

  /** Lift `removeMember`'s kicked tombstone early. Does NOT re-add anyone (UnkickNotice's copy must
   *  keep saying so). Owner-only (403 `NOT_OWNER`); idempotent: no live tombstone still answers 200. */
  async unkickMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<UnkickResult>> {
    assertHexId(targetUserId, "targetUserId");
    return this.del(`/api/family/${familyId}/kicked/${targetUserId}`);
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    assertHexId(newOwnerId, "newOwnerId");
    return this.put(`/api/family/${familyId}/transfer`, { userId, newOwnerId });
  }

  /** Read as `unknown` until `sanitizeFamilyMembersResponse` checks it; the whole envelope is checked
   *  so an `error` one reaches the caller unchanged. See docs/architecture.md → API client 的回應處理. */
  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    const res = await this.get<unknown>(`/api/family/${familyId}/members`);
    // Structure layer first (rebuilds `data.members`, normalizes `apiEndpoint`), then the text layer
    // (`familyId` / `ownerId` / `createdAt`): docs/architecture.md → 伺服器回傳資料的檢查.
    return sanitizeEnvelope(
      sanitizeFamilyMembersResponse(res),
      sanitizeFamilyGroupText,
    );
  }

  async updateDisplayName(
    familyId: string,
    userId: string,
    displayName: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    return this.put(`/api/family/${familyId}/member/${userId}/displayName`, {
      displayName,
    });
  }

  // --- Account ---

  async deleteAccount(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    return this.del(`/api/user/${userId}`);
  }

  // --- Family Bookshelf ---

  /** Read as `unknown`; structure layer (drops unusable `userId` / `bookId`) then text layer, on the
   *  whole envelope. See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<FamilyBookshelf>> {
    const res = await this.get<unknown>(`/api/family/${familyId}/bookshelf`);
    return sanitizeEnvelope(
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
    return sanitizeRecord(unwrap(res), sanitizeBorrowRequestText);
  }

  /** Read as `unknown` until `sanitizeBorrowRequests` checks it; `unwrap` runs first, owning the
   *  envelope contract (`ApiError` on `error`, `EMPTY_RESPONSE` on missing data). */
  async listBorrowRequests(familyId: string): Promise<BorrowRequest[]> {
    const res = await this.get<unknown>(`/api/family/${familyId}/borrow`);
    return sanitizeBorrowRequests(unwrap(res));
  }

  async updateBorrowStatus(
    requestId: string,
    status: BorrowStatus,
  ): Promise<BorrowRequest> {
    const res = await this.patch<BorrowRequest>(`/api/borrow/${requestId}`, {
      status,
    });
    return sanitizeRecord(unwrap(res), sanitizeBorrowRequestText);
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
    const member = sanitizeFamilyMember(unwrap(res));
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

  /** No auth needed. Read as `unknown`; an unknown `method` becomes an `INVALID_RESPONSE` error
   *  envelope, not a throw. See docs/architecture.md → 伺服器回傳資料的檢查 and → API client 的回應處理. */
  async getVerifyMethod(userId: string): Promise<ApiResponse<VerifyInfo>> {
    assertHexId(userId, "userId");
    const res = await this.get<unknown>(`/api/user/${userId}/verify`);
    return sanitizeVerifyInfoResponse<VerifyInfo>(res);
  }

  /** Get whether the setup prompt was already shown (requires auth token). */
  async getVerifyPrompted(
    userId: string,
  ): Promise<ApiResponse<VerifyPromptedInfo>> {
    assertHexId(userId, "userId");
    return this.get(`/api/user/${userId}/verify/prompted`);
  }

  /** A new pin / pattern revokes the old token (#378): its replacement is on this client on return. */
  async setVerifyMethod(userId: string, body: SetVerifyBody) {
    assertHexId(userId, "userId");
    const res = await this.put<unknown>(`/api/user/${userId}/verify`, body);
    return adoptRotatedVerifyToken(res, (token) => this.setAuthToken(token));
  }

  /** Mark verification as prompted (requires auth token). */
  async markVerifyPrompted(
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    assertHexId(userId, "userId");
    return this.post(`/api/user/${userId}/verify/prompted`);
  }

  // --- Public Shelf (v1.2.0) ---

  async listPublicShelves(userId: string): Promise<{ shelves: PublicShelf[] }> {
    assertHexId(userId, "userId");
    const res = await this.get<{ shelves: PublicShelf[] }>(
      `/api/user/${userId}/public-shelf`,
    );
    return sanitizeRecord(unwrap(res), sanitizePublicShelfListText);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    assertHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf`,
      body,
    );
    return sanitizeRecord(unwrap(res), sanitizePublicShelfResultText);
  }

  async updatePublicShelf(
    userId: string,
    shelfId: string,
    body: { title?: string; expiresDays?: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    assertHexId(userId, "userId");
    const res = await this.put<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}`,
      body,
    );
    return sanitizeRecord(unwrap(res), sanitizePublicShelfResultText);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    assertHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(
      `/api/user/${userId}/public-shelf/${shelfId}/reset-token`,
    );
    return sanitizeRecord(unwrap(res), sanitizePublicShelfResultText);
  }

  /** Revoke a public shelf; throws `ApiError` on refusal, and the caller MUST NOT then report the link
   *  closed (the snapshot stays readable until this succeeds). */
  async deletePublicShelf(userId: string, shelfId: string): Promise<void> {
    assertHexId(userId, "userId");
    const res = await this.del(`/api/user/${userId}/public-shelf/${shelfId}`);
    unwrapVoid(res);
  }

  /** Bypasses `request()` (no auth, no dedup): the whole read lives in `fetchPublicShelf`. */
  getPublicShelf(shareToken: string): Promise<PublicShelfData> {
    return fetchPublicShelf(this.baseUrl, shareToken);
  }

  // --- Internal ---

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
