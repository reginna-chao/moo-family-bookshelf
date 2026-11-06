import type { ApiClient } from "../api/client";

/**
 * Put the client back on `endpoint` after a join attempt ended without a join.
 *
 * Storage is deliberately untouched: performJoin persists a sync code's `@host`
 * only once the backend has accepted the join, so an abandoned attempt has
 * nothing durable to undo — only the in-memory client to hand back.
 */
export function restoreApiEndpoint(
  apiClient: ApiClient,
  endpoint: string,
): void {
  try {
    apiClient.setEndpoint(endpoint);
  } catch (err) {
    // Already validated (from getEndpoint()), but guarded: on an error path a throw would replace
    // the failure the caller is reporting.
    console.warn("[Onboarding] Failed to restore previous API endpoint", err);
  }
}
