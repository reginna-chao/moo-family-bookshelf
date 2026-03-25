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
}

export interface PersonalBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
}

export interface FamilyGroup {
  familyId: string;
  members: string[];
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

  constructor(apiUrl?: string) {
    this.baseUrl = (apiUrl ?? DEFAULT_API_ENDPOINT).replace(/\/+$/, "");
  }

  setEndpoint(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getEndpoint(): string {
    return this.baseUrl;
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

  async createFamily(userId: string): Promise<ApiResponse<FamilyGroup>> {
    return this.request("/api/family", {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  async joinFamily(
    familyId: string,
    userId: string,
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request(`/api/family/${familyId}/join`, {
      method: "POST",
      body: JSON.stringify({ userId }),
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
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };

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
