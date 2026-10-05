import type { ApiClient } from "../api/client";

/**
 * Point the client at the endpoint the user has accepted, if any. Used by
 * App's boot read (moved out of App.tsx unchanged).
 *
 * A stored value the client refuses (hand-edited storage, or written by an
 * older build with looser rules) must not derail the whole boot read into its
 * catch — that would drop a member with a family into onboarding. Degrade to
 * the default endpoint instead.
 */
export function applyStoredEndpoint(
  client: ApiClient,
  endpoint: string | null,
): void {
  if (endpoint === null) return;
  try {
    client.setEndpoint(endpoint);
  } catch (err) {
    console.warn("[App] Ignoring unusable stored API endpoint", err);
  }
}
