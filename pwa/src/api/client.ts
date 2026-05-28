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

export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

export interface ApiResponse<T> {
  data?: T;
  error?: { code: string; message: string };
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
      const json = await res.json() as ApiResponse<VersionInfo>;
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

  async getPersonalBooks(
    userId: string,
  ): Promise<ApiResponse<PersonalBooks>> {
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
    const body: Record<string, string> = { userId, displayName: displayName ?? "" };
    return this.post("/api/family", body);
  }

  async joinFamily(
    familyId: string,
    userId: string,
    opts?: { verifySecret?: string; qrToken?: string },
  ): Promise<ApiResponse<{ ok: boolean; authToken?: string; expiresAt?: number }>> {
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

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    this.validateHexId(newOwnerId, "newOwnerId");
    return this.put(`/api/family/${familyId}/transfer`, { userId, newOwnerId });
  }

  async getFamilyMembers(
    familyId: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.get(`/api/family/${familyId}/members`);
  }

  async updateDisplayName(
    familyId: string,
    userId: string,
    displayName: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/family/${familyId}/member/${userId}/displayName`, { displayName });
  }

  // --- Account ---

  async deleteAccount(
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
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
  async markVerifyPrompted(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.post(`/api/user/${userId}/verify/prompted`);
  }

  // --- Public Shelf (v1.2.0) ---

  async listPublicShelves(userId: string): Promise<{ shelves: PublicShelf[] }> {
    this.validateHexId(userId, "userId");
    const res = await this.get<{ shelves: PublicShelf[] }>(`/api/user/${userId}/public-shelf`);
    return this.unwrap(res);
  }

  async createPublicShelf(
    userId: string,
    body: { title: string; expiresDays: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf`, body);
    return this.unwrap(res);
  }

  async updatePublicShelf(
    userId: string,
    shelfId: string,
    body: { title?: string; expiresDays?: number | null },
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.put<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf/${shelfId}`, body);
    return this.unwrap(res);
  }

  async resetPublicShelfToken(
    userId: string,
    shelfId: string,
  ): Promise<{ shelf: PublicShelf }> {
    this.validateHexId(userId, "userId");
    const res = await this.post<{ shelf: PublicShelf }>(`/api/user/${userId}/public-shelf/${shelfId}/reset-token`);
    return this.unwrap(res);
  }

  async deletePublicShelf(userId: string, shelfId: string): Promise<void> {
    this.validateHexId(userId, "userId");
    await this.del(`/api/user/${userId}/public-shelf/${shelfId}`);
  }

  async getPublicShelf(shareToken: string): Promise<PublicShelfData> {
    const url = `${this.baseUrl}/api/public/${shareToken}`;
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
    });
    const json = (await response.json()) as ApiResponse<PublicShelfData>;
    if (json.error) {
      const err = new Error(`${json.error.code}: ${json.error.message}`);
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
      const json = (await response.json()) as ApiResponse<T>;

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
