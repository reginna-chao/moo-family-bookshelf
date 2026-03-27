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
  isShared: 0 | 1;
}

/** Decrypted view (used by UI after decryption) */
export interface PersonalBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
}

/** Raw server response — encrypted payload */
export interface RawPersonalBooks {
  payload: string | null;
}

export interface FamilyGroup {
  familyId: string;
  ownerId: string;
  members: string[];
  maxMembers: number;
  createdAt: string;
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

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null = null;

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

  // --- Personal Settings ---

  async getPersonalBooks(
    userId: string,
  ): Promise<ApiResponse<RawPersonalBooks>> {
    this.validateHexId(userId, "userId");
    return this.request(`/api/user/${userId}/books`);
  }

  async updatePersonalBooks(
    userId: string,
    payload: string, // encrypted
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.request(`/api/user/${userId}/books`, {
      method: "PUT",
      body: JSON.stringify({ payload }),
    });
  }

  // --- Family Group ---

  async createFamily(userId: string): Promise<ApiResponse<FamilyGroup>> {
    this.validateHexId(userId, "userId");
    return this.request("/api/family", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  async joinFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.request(`/api/family/${familyId}/join`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  async leaveFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    return this.request(`/api/family/${familyId}/member/${userId}`, {
      method: "DELETE",
    });
  }

  async removeMember(
    familyId: string,
    targetUserId: string,
    callerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(targetUserId, "targetUserId");
    this.validateHexId(callerId, "callerId");
    return this.request(
      `/api/family/${familyId}/member/${targetUserId}?userId=${encodeURIComponent(callerId)}`,
      { method: "DELETE" },
    );
  }

  async transferOwnership(
    familyId: string,
    userId: string,
    newOwnerId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    this.validateHexId(userId, "userId");
    this.validateHexId(newOwnerId, "newOwnerId");
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
  ): Promise<ApiResponse<RawFamilyBookshelf>> {
    return this.request(`/api/family/${familyId}/bookshelf`);
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
