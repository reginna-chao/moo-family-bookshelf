/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import { DEFAULT_API_ENDPOINT } from "../constants";

/** Hostname patterns allowed over plain HTTP (dev / LAN self-hosting). */
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|.*\.local)$/;

/** Validate API endpoint URL: must be HTTPS, or HTTP on a private/LAN host. */
export function validateEndpointUrl(raw: string): string {
  const url = raw.replace(/\/+$/, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return url;
    if (parsed.protocol === "http:" && PRIVATE_HOST_RE.test(parsed.hostname)) {
      return url;
    }
  } catch {
    throw new Error(`Invalid API endpoint URL: ${raw}`);
  }
  throw new Error(`Unsafe API endpoint scheme — only HTTPS or private-network HTTP is allowed: ${raw}`);
}

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
import { BorrowStatus, type VerifyMethod } from "./types";
import { doRefreshToken } from "./auth-refresh";

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

/** Proactive refresh buffer: 5 minutes before expiry */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;
  /** Guard: true while a token refresh is in flight */
  private refreshInProgress: Promise<boolean> | null = null;
  /** Callback invoked when token refresh fails with REFRESH_FAILED (family removed) */
  onFamilyRemoved: (() => void) | null = null;
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
  }

  /** Check server API version. Returns null on network/parse errors. */
  async checkVersion(): Promise<VersionInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`);
      if (!res.ok) return null;
      const json = await res.json() as ApiResponse<VersionInfo>;
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
      const { tokenExpiresAt } =
        await chrome.storage.local.get("tokenExpiresAt");
      if (!tokenExpiresAt) return true; // No expiry info — assume valid

      if (Date.now() > (tokenExpiresAt as number) - REFRESH_BUFFER_MS) {
        return this.refreshToken();
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

  /** Look up family membership for a pre-hashed userId. Server never sees the email. */
  async lookupUser(userId: string): Promise<ApiResponse<{ existingFamilyId: string | null; memberCount: number }>> {
    this.validateHexId(userId, "userId");
    return this.post("/api/auth/lookup", { userId });
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

  // --- Family Group ---

  async createFamily(
    userId: string,
    displayName: string | undefined,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.post("/api/family", { userId, displayName: displayName ?? "" });
  }

  async joinFamily(
    familyId: string,
    userId: string,
    displayName?: string,
    opts?: { verifySecret?: string },
  ): Promise<ApiResponse<FamilyGroup>> {
    const body: Record<string, string> = { userId, displayName: displayName ?? "" };
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
    return this.put(`/api/family/${familyId}/member/${userId}/displayName`, { displayName });
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
    const res = await this.patch<BorrowRequest>(
      `/api/borrow/${requestId}`,
      { status },
    );
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
  async createQrToken(userId: string): Promise<ApiResponse<{ token: string; expiresIn: number }>> {
    return this.post(`/api/user/${userId}/qr-token`);
  }

  // --- Public Shelf (v1.2.0) ---

  getPublicShelfUrl(shareToken: string, pwaOriginOverride?: string): string {
    const origin = pwaOriginOverride && pwaOriginOverride.length > 0
      ? pwaOriginOverride
      : DEFAULT_PWA_URL;
    return `${origin}/public/${shareToken}`;
  }

  async listPublicShelves(userId: string): Promise<{ shelves: PublicShelf[] }> {
    const res = await this.get<{ shelves: PublicShelf[] }>(`/api/user/${userId}/public-shelf`);
    return this.unwrap(res);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.post<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf`, body);
    return this.unwrap(res);
  }

  async updatePublicShelf(
    userId: string,
    shelfId: string,
    body: { title?: string; expiresDays?: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.put<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf/${shelfId}`, body);
    return this.unwrap(res);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    const res = await this.post<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf/${shelfId}/reset-token`);
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
        const refreshed = await this.refreshToken();
        if (refreshed) {
          // Retry original request with the new token (skip refresh to avoid loop)
          return this.doRequest<T>(url, init, true);
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
  private async refreshToken(): Promise<boolean> {
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

  private async doRefreshToken(): Promise<boolean> {
    return doRefreshToken({
      request: this.request.bind(this),
      setAuthToken: (token) => { this.authToken = token; },
      onFamilyRemoved: this.onFamilyRemoved,
    });
  }

  private validateHexId(id: string, label: string): void {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`Invalid ${label}: expected 64-char hex string`);
    }
  }
}
