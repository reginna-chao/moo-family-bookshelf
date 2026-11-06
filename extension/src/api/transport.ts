/** HTTP layer of `ApiClient`: sends a token only to the server that issued it, and runs the staged
 *  refresh on a 401. See docs/architecture.md → 認證更新與冷卻 and → API client 的回應處理. */

import { readEnvelope } from "moo-family-bookshelf-shared/api/readEnvelope";
import {
  doRefreshToken,
  type FamilyRemovedInfo,
  type ReauthInfo,
  type RefreshOutcome,
} from "./auth-refresh";
import { TokenSession } from "./tokenBinding";
import type { ApiResponse } from "./types";
import {
  rateLimitedFailure,
  unauthorizedFailure,
} from "./unauthorizedResponse";

export interface TransportCallbacks {
  /** Read when a refresh starts. */
  onFamilyRemoved: () => ((info: FamilyRemovedInfo) => void) | null;
  /** Read when the prompt fires. */
  onReauthRequired: () => ((info?: ReauthInfo) => void) | null;
}

export class ApiTransport {
  private baseUrl: string;
  private callbacks: TransportCallbacks;
  private session = new TokenSession();
  /** In-flight GET request deduplication map: URL -> Promise */
  private inflightGets = new Map<string, Promise<ApiResponse<unknown>>>();

  constructor(baseUrl: string, callbacks: TransportCallbacks) {
    this.baseUrl = baseUrl;
    this.callbacks = callbacks;
  }

  /** `validatedUrl` has already passed `validateEndpointUrl`; the same value is not a session change. */
  setEndpoint(validatedUrl: string): void {
    if (validatedUrl === this.baseUrl) return;
    this.baseUrl = validatedUrl;
    this.session.end();
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  /** Re-setting the token this server already holds is not a session change, so it keeps a refresh
   *  that `useTokenRefresh` started at mount alive; `null` always ends the session. */
  setAuthToken(token: string | null): void {
    const unchanged =
      token !== null && token === this.session.tokenFor(this.baseUrl);
    this.session.bind(token, this.baseUrl);
    if (!unchanged) this.session.end();
  }

  /** Release the reauth latch so the next authenticated action can re-challenge. */
  clearReauthPending(): void {
    this.session.clearReauthPending();
  }

  async request<T>(
    path: string,
    init?: RequestInit,
    /** When true, skip 401 interception to prevent infinite loops */
    skipRefresh = false,
  ): Promise<ApiResponse<T>> {
    const method = init?.method?.toUpperCase() ?? "GET";
    const server = this.baseUrl;
    const url = `${server}${path}`;

    // Deduplicate concurrent GET requests to the same URL
    if (method === "GET" && !skipRefresh) {
      const existing = this.inflightGets.get(url);
      if (existing) {
        return existing as Promise<ApiResponse<T>>;
      }
      const promise = this.doRequest<T>(server, url, init, skipRefresh);
      this.inflightGets.set(url, promise as Promise<ApiResponse<unknown>>);
      try {
        return await promise;
      } finally {
        this.inflightGets.delete(url);
      }
    }

    return this.doRequest<T>(server, url, init, skipRefresh);
  }

  /** Refresh the auth token, returning the structured outcome; concurrent callers share a single
   *  in-flight refresh. */
  refreshToken(): Promise<RefreshOutcome> {
    return this.session.shareRefresh(() => this.startRefresh());
  }

  private async doRequest<T>(
    server: string,
    url: string,
    init?: RequestInit,
    skipRefresh = false,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };

    const token = this.session.tokenFor(server);
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, { ...init, headers });
      const json = await readEnvelope<T>(response);

      if (response.status === 401 && !skipRefresh) {
        return await this.recoverFromUnauthorized(
          server,
          url,
          init,
          json,
          token,
        );
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

  /** Attempt automatic token refresh after a 401; a request sent to a server this client has since
   *  left gets its 401 back, with nothing refreshed and nothing resent. */
  private async recoverFromUnauthorized<T>(
    server: string,
    url: string,
    init: RequestInit | undefined,
    json: ApiResponse<T>,
    sentToken: string | null,
  ): Promise<ApiResponse<T>> {
    const failed = unauthorizedFailure(json);
    if (server !== this.baseUrl) return failed;

    // Clear stale dedup promises — token is about to change
    this.inflightGets.clear();
    const outcome = await this.refreshToken();
    // A token rotated on this server (a PIN change) discards the refresh; this client still holds
    // a valid token, so returning the old 401 would fail a request that can succeed.
    const held = this.session.tokenFor(server);
    const replaced = held !== null && held !== sentToken;
    if (server === this.baseUrl && (outcome.refreshed || replaced)) {
      // Retry original request with the new token (skip refresh to avoid loop)
      return this.doRequest<T>(server, url, init, true);
    }
    if (outcome.rateLimited) {
      return rateLimitedFailure<T>(outcome.cooldownUntil);
    }
    // Refresh failed — return the original 401 error
    return failed;
  }

  private startRefresh(): Promise<RefreshOutcome> {
    return doRefreshToken({
      request: this.request.bind(this),
      // Binds without ending the session: the refresh's own token must not discard the refresh.
      setAuthToken: (token) => {
        this.session.bind(token, this.baseUrl);
      },
      beginSession: () => this.session.begin(this.baseUrl),
      onFamilyRemoved: this.callbacks.onFamilyRemoved(),
      // Wrap the caller's callback so raising the prompt also sets the latch;
      // auth-refresh.ts stays latch-agnostic except for the isReauthPending skip.
      onReauthRequired: (info) => {
        this.session.raiseReauth();
        this.callbacks.onReauthRequired()?.(info);
      },
      isReauthPending: () => this.session.isReauthPending(),
    });
  }
}
