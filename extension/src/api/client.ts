/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import { DEFAULT_API_ENDPOINT } from "../constants";

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
  isShared: BoolFlag;
  isArchived?: BoolFlag; // FALSE = active (default), TRUE = archived
}

export interface PersonalBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
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
    this.baseUrl = (apiUrl ?? DEFAULT_API_ENDPOINT).replace(/\/+$/, "");
  }

  setEndpoint(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
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

  // --- Auth ---

  async hashEmail(email: string): Promise<ApiResponse<{ userId: string }>> {
    return this.request("/api/auth/hash", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  // --- Personal Settings ---

  async getPersonalBooks(userId: string): Promise<ApiResponse<PersonalBooks>> {
    return this.request(`/api/user/${userId}/books`);
  }

  async updatePersonalBooks(
    userId: string,
    payload: string, // encrypted
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/user/${userId}/books`, {
      method: "PUT",
      body: JSON.stringify({ payload }),
    });
  }

  // --- Family Group ---

  async createFamily(
    userId: string,
    displayName?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.request("/api/family", {
      method: "POST",
      body: JSON.stringify({ userId, displayName: displayName ?? "" }),
    });
  }

  async joinFamily(
    familyId: string,
    userId: string,
    displayName?: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.request(`/api/family/${familyId}/join`, {
      method: "POST",
      body: JSON.stringify({ userId, displayName: displayName ?? "" }),
    });
  }

  async updateDisplayName(
    familyId: string,
    userId: string,
    displayName: string,
  ): Promise<ApiResponse<{ userId: string; displayName: string }>> {
    return this.request(
      `/api/family/${familyId}/member/${userId}/displayName`,
      {
        method: "PUT",
        body: JSON.stringify({ displayName }),
      },
    );
  }

  async leaveFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/family/${familyId}/member/${userId}`, {
      method: "DELETE",
    });
  }

  async removeMember(
    familyId: string,
    targetUserId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/family/${familyId}/member/${targetUserId}`, {
      method: "DELETE",
    });
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
    clearEndpoint?: 1,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.request(`/api/family/${familyId}/transfer`, {
      method: "PUT",
      body: JSON.stringify({
        userId,
        newOwnerId,
        ...(clearEndpoint !== undefined && { clearEndpoint }),
      }),
    });
  }

  async updateFamilyEndpoint(
    familyId: string,
    apiEndpoint: string | null,
  ): Promise<ApiResponse<{ familyId: string; apiEndpoint: string | null }>> {
    return this.request(`/api/family/${familyId}/endpoint`, {
      method: "PUT",
      body: JSON.stringify({ apiEndpoint }),
    });
  }

  async getFamilyMembers(familyId: string): Promise<ApiResponse<FamilyGroup>> {
    return this.request(`/api/family/${familyId}/members`);
  }

  // --- Account ---

  async deleteAccount(userId: string): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/user/${userId}`, { method: "DELETE" });
  }

  // --- Family Bookshelf ---

  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<RawFamilyBookshelf>> {
    return this.request(`/api/family/${familyId}/bookshelf`);
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
    try {
      const storage = await chrome.storage.local.get(["userId", "familyId"]);
      const userId = storage.userId as string | undefined;
      const familyId = storage.familyId as string | undefined;
      if (!userId || !familyId) return false;

      const result = await this.request<{ token: string; expiresAt: number }>(
        "/api/auth/refresh",
        {
          method: "POST",
          body: JSON.stringify({ userId, familyId }),
        },
        true, // skip refresh interception — this IS the refresh call
      );

      if (result.data?.token) {
        this.authToken = result.data.token;
        const storageUpdate: Record<string, unknown> = {
          authToken: result.data.token,
        };
        if (result.data.expiresAt) {
          storageUpdate.tokenExpiresAt = result.data.expiresAt;
        }
        await chrome.storage.local.set(storageUpdate);
        return true;
      }

      // Refresh failed (REFRESH_FAILED, rate limit, network error, etc.)
      // Attempt staged recovery via joinFamily (public endpoint, no token needed)
      this.authToken = null;
      await chrome.storage.local.remove(["authToken", "tokenExpiresAt"]);

      const recoveryStorage = await chrome.storage.local.get([
        "familyId",
        "userId",
        "displayName",
      ]);
      const recFamilyId = recoveryStorage.familyId as string | undefined;
      const recUserId = recoveryStorage.userId as string | undefined;
      const recDisplayName =
        (recoveryStorage.displayName as string | undefined) ?? "";

      if (recFamilyId && recUserId) {
        const joinResult = await this.request<{
          familyId: string;
          ownerId: string;
          members: Array<{ userId: string; displayName: string }>;
          maxMembers: number;
          createdAt: string;
          authToken?: string;
          expiresAt?: number;
        }>(
          `/api/family/${recFamilyId}/join`,
          {
            method: "POST",
            body: JSON.stringify({
              userId: recUserId,
              displayName: recDisplayName,
            }),
          },
          true, // skipRefresh to avoid infinite loops
        );

        if (joinResult.data?.authToken) {
          // Recovery succeeded — store new token and continue seamlessly
          this.authToken = joinResult.data.authToken;
          const recoveryUpdate: Record<string, unknown> = {
            authToken: joinResult.data.authToken,
          };
          if (joinResult.data.expiresAt) {
            recoveryUpdate.tokenExpiresAt = joinResult.data.expiresAt;
          }
          await chrome.storage.local.set(recoveryUpdate);
          return true;
        }
      }

      // Recovery also failed — truly cannot access this family, clear all data
      await chrome.storage.local.remove(["familyId", "encryptionKey"]);
      try {
        await chrome.storage.sync.remove(["familyId"]);
      } catch {
        // sync storage may not be available in all contexts
      }
      try {
        chrome.runtime.sendMessage({ type: "FAMILY_REMOVED" });
      } catch {
        // Message may fail if no listener is active
      }
      this.onFamilyRemoved?.();

      return false;
    } catch {
      return false;
    }
  }
}
