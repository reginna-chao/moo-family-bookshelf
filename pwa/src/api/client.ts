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

/** Decrypted view (used by UI after decryption) */
export interface PersonalBooks {
  schemaVersion: number;
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
  /** Preserve unknown fields from future schema versions */
  [key: string]: unknown;
}

/** Current schema version for PersonalBooks encrypted payload */
export const PERSONAL_BOOKS_SCHEMA_VERSION = 1;

/** Raw server response — encrypted payload */
export interface RawPersonalBooks {
  payload: string | null;
}

export interface FamilyMember {
  userId: string;
  displayName: string;
}

export interface FamilyGroup {
  familyId: string;
  ownerId: string;
  members: FamilyMember[];
  maxMembers: number;
  createdAt: string;
  apiEndpoint?: string | null;
}

export interface VersionInfo {
  apiVersion: number;
  serverVersion: string;
}

/** Decrypted view (used by UI after decryption) */
export interface FamilyBookshelf {
  members: Array<{
    userId: string;
    displayName: string;
    books: BookEntry[];
  }>;
}

/** Raw server response — members have encrypted payloads */
export interface RawFamilyBookshelf {
  familyId: string;
  members: Array<{
    userId: string;
    payload: string | null;
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

  // --- Auth ---

  /** Look up family membership for a pre-hashed userId. Server never sees the email. */
  async lookupUser(userId: string): Promise<ApiResponse<{ existingFamilyId: string | null; memberCount: number }>> {
    this.validateHexId(userId, "userId");
    return this.post("/api/auth/lookup", { userId });
  }

  // --- Personal Settings ---

  async getPersonalBooks(
    userId: string,
  ): Promise<ApiResponse<RawPersonalBooks>> {
    this.validateHexId(userId, "userId");
    return this.get(`/api/user/${userId}/books`);
  }

  async updatePersonalBooks(
    userId: string,
    payload: string, // encrypted
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.put(`/api/user/${userId}/books`, { payload });
  }

  // --- Family Group ---

  async createFamily(userId: string): Promise<ApiResponse<FamilyGroup>> {
    this.validateHexId(userId, "userId");
    return this.post("/api/family", { userId });
  }

  async joinFamily(
    familyId: string,
    userId: string,
    verifySecret?: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    const body: Record<string, string> = { userId };
    if (verifySecret !== undefined) {
      body.verifySecret = verifySecret;
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
  ): Promise<ApiResponse<RawFamilyBookshelf>> {
    return this.get(`/api/family/${familyId}/bookshelf`);
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
