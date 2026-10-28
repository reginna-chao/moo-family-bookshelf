/** The HTTP layer of `ApiClient`: auth header, GET dedup and the one 401 → token-refresher retry.
 *  Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { readEnvelope } from "moo-family-bookshelf-shared/api/readEnvelope";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

export class ApiTransport {
  private readonly getBaseUrl: () => string;
  private authToken: string | null = null;
  private tokenRefresher: (() => Promise<string | null>) | null = null;
  private refreshing: Promise<string | null> | null = null;
  /** In-flight GET request deduplication map: URL -> Promise */
  private inflightGets = new Map<string, Promise<ApiResponse<unknown>>>();

  /** A getter, not a snapshot: `ApiClient.setEndpoint` can change the base URL later. */
  constructor(getBaseUrl: () => string) {
    this.getBaseUrl = getBaseUrl;
  }

  /** Register a callback that re-acquires a token on 401. */
  setTokenRefresher(fn: () => Promise<string | null>): void {
    this.tokenRefresher = fn;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  async request<T>(
    path: string,
    init?: RequestInit,
    isRetry = false,
  ): Promise<ApiResponse<T>> {
    const method = init?.method?.toUpperCase() ?? "GET";
    const url = `${this.getBaseUrl()}${path}`;

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
