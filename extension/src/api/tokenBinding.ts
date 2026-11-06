/** Pairs a token with its issuing server: in memory (`TokenSession`) and in storage (`moo:apiEndpoint`,
 *  or the official default when absent). See docs/architecture.md → 認證更新與冷卻. */

import browser from "webextension-polyfill";
import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import {
  API_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
} from "../constants";
import type { RefreshOutcome } from "./auth-refresh";

export interface RefreshSession {
  endpoint: string;
  isLive(): boolean;
}

/** The in-memory token, the server that issued it, and the session they belong to. A refresh started
 *  under a session that has since ended is discarded. */
export class TokenSession {
  private token: string | null = null;
  /** The server that issued `token`; the token goes to no other. */
  private issuer: string | null = null;
  /** Bumped when a session ends. */
  private generation = 0;
  /** Guard: holds the in-flight token refresh outcome while one is running */
  private refreshInProgress: Promise<RefreshOutcome> | null = null;
  /** Latch set once a re-verification prompt is raised; cleared by a non-null token or
   *  `clearReauthPending`. See docs/architecture.md → 認證更新與冷卻. */
  private reauthPending = false;

  /** The token to send to `server`: `null` unless that server issued it. */
  tokenFor(server: string): string | null {
    return this.issuer === server ? this.token : null;
  }

  /** Record `token` as issued by `server`, leaving the session running. */
  bind(token: string | null, server: string): void {
    this.token = token;
    this.issuer = token === null ? null : server;
    // A fresh (non-null) token means auth succeeded — release the reauth latch.
    // A null token (set mid-failure by doRefreshToken) must NOT clear it.
    if (token !== null) {
      this.reauthPending = false;
    }
  }

  raiseReauth(): void {
    this.reauthPending = true;
  }

  isReauthPending(): boolean {
    return this.reauthPending;
  }

  clearReauthPending(): void {
    this.reauthPending = false;
  }

  /** End the session; a refresh hung forever no longer blocks the ones that follow. */
  end(): void {
    this.generation++;
    this.refreshInProgress = null;
  }

  /** Capture the current session, for a refresh about to run against `endpoint`. */
  begin(endpoint: string): RefreshSession {
    const generation = this.generation;
    return { endpoint, isLive: () => generation === this.generation };
  }

  /** Run `start`, or wait for the refresh already in flight: concurrent callers share one. */
  async shareRefresh(
    start: () => Promise<RefreshOutcome>,
  ): Promise<RefreshOutcome> {
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    const promise = start();
    this.refreshInProgress = promise;
    try {
      return await promise;
    } finally {
      // A switch may have dropped this promise and started another; that one is not ours to clear.
      if (this.refreshInProgress === promise) {
        this.refreshInProgress = null;
      }
    }
  }
}

/** Server the stored token belongs to: the accepted endpoint, or the official default when none
 *  is stored; `null` when the stored value is unusable, which matches no server. */
export function resolveStoredEndpoint(raw: unknown): string | null {
  if (raw === undefined) return validateEndpointUrl(DEFAULT_API_ENDPOINT);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return validateEndpointUrl(trimmed);
  } catch {
    return null;
  }
}

/** True while storage pairs this client's server (and family, when given) with the stored token. */
export async function storageMatches(
  endpoint: string,
  familyId?: string,
): Promise<boolean> {
  const stored = await browser.storage.local.get([
    FAMILY_ID_KEY,
    API_ENDPOINT_KEY,
  ]);
  return (
    resolveStoredEndpoint(stored[API_ENDPOINT_KEY]) === endpoint &&
    (familyId === undefined || stored[FAMILY_ID_KEY] === familyId)
  );
}

/** True while this client session and storage still describe the same family on the same server. */
export async function sessionStillOwnsStorage(
  session: RefreshSession,
  familyId: string,
): Promise<boolean> {
  if (!session.isLive()) return false;
  const matches = await storageMatches(session.endpoint, familyId);
  return session.isLive() && matches;
}
