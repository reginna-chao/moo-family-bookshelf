/**
 * API client for communicating with Cloudflare Worker backend.
 * Supports configurable endpoint for self-hosted backends.
 */

import { DEFAULT_API_ENDPOINT } from "../constants";

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
  isShared: boolean;
  isArchived?: 0 | 1;  // 0 = active (default), 1 = archived
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
}

export interface FamilyBookshelf {
  members: Array<{
    userId: string;
    displayName: string;
    books: BookEntry[];
  }>;
}

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;
  /** Guard: true while a token refresh is in flight */
  private refreshInProgress: Promise<boolean> | null = null;

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

  // --- Auth ---

  async hashEmail(email: string): Promise<ApiResponse<{ userId: string }>> {
    return this.request("/api/auth/hash", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  // --- Personal Settings ---

  async getPersonalBooks(
    userId: string,
  ): Promise<ApiResponse<PersonalBooks>> {
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

  async createFamily(userId: string, displayName?: string): Promise<ApiResponse<FamilyGroup>> {
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
    return this.request(`/api/family/${familyId}/member/${userId}/displayName`, {
      method: "PUT",
      body: JSON.stringify({ displayName }),
    });
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
    return this.request(
      `/api/family/${familyId}/member/${targetUserId}`,
      { method: "DELETE" },
    );
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/family/${familyId}/transfer`, {
      method: "PUT",
      body: JSON.stringify({ userId, newOwnerId }),
    });
  }

  async getFamilyMembers(
    familyId: string,
  ): Promise<ApiResponse<FamilyGroup>> {
    return this.request(`/api/family/${familyId}/members`);
  }

  // --- Family Bookshelf ---

  async getFamilyBookshelf(
    familyId: string,
  ): Promise<ApiResponse<FamilyBookshelf>> {
    return this.request(`/api/family/${familyId}/bookshelf`);
  }

  // --- Internal ---

  private async request<T>(
    path: string,
    init?: RequestInit,
    /** When true, skip 401 interception to prevent infinite loops */
    skipRefresh = false,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
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
        const refreshed = await this.refreshToken();
        if (refreshed) {
          // Retry original request with the new token (skip refresh to avoid loop)
          return this.request<T>(path, init, true);
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

      const result = await this.request<{ token: string }>(
        "/api/auth/refresh",
        {
          method: "POST",
          body: JSON.stringify({ userId, familyId }),
        },
        true, // skip refresh interception — this IS the refresh call
      );

      if (result.data?.token) {
        this.authToken = result.data.token;
        await chrome.storage.local.set({ authToken: result.data.token });
        return true;
      }

      // Handle refresh failure — user may have been removed from family
      if (result.error?.code === "REFRESH_FAILED") {
        await chrome.storage.local.remove([
          "familyId",
          "encryptionKey",
          "authToken",
        ]);
        try {
          await chrome.storage.sync.remove(["familyId"]);
        } catch {
          // sync storage may not be available in all contexts
        }
        // Notify content script / dialog to reset to onboarding
        try {
          chrome.runtime.sendMessage({ type: "FAMILY_REMOVED" });
        } catch {
          // Message may fail if no listener is active
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}
