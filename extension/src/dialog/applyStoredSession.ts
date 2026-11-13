import type { ApiClient } from "../api/client";
import { resolveStoredEndpoint, storedTokenFor } from "../api/tokenBinding";
import { API_ENDPOINT_KEY } from "../constants";
import { persistSwitchedFamilyEndpoint } from "../storage/familyEndpointChoice";

/**
 * Put the stored endpoint and its token on the client, or neither when the
 * endpoint is unusable (hand-edited storage, or written by an older build with
 * looser rules). Used by App's boot read; `stored` is one storage read that
 * includes every key in `STORED_SESSION_KEYS`, so the token and the endpoint it
 * is paired with cannot disagree. A token stored with another server than the
 * stored endpoint is not set (`storedTokenFor`): the client gets the endpoint only.
 *
 * An unusable endpoint must not derail the boot read into its catch, which would
 * drop a member with a family into onboarding. The pair is removed instead (token
 * first), and the client stays on the official default with no token, so the
 * token never reaches a server that did not issue it. See docs/architecture.md →
 * 認證更新與冷卻.
 */
export function applyStoredSession(
  client: ApiClient,
  stored: Record<string, unknown>,
): void {
  const raw = stored[API_ENDPOINT_KEY];
  const endpoint = resolveStoredEndpoint(raw);
  if (endpoint === null) {
    console.warn("[App] Ignoring unusable stored API endpoint");
    void persistSwitchedFamilyEndpoint(null).catch((err) => {
      console.warn("[App] Could not remove the unusable endpoint", err);
    });
    return;
  }

  if (raw !== undefined) client.setEndpoint(endpoint);

  const token = storedTokenFor(stored);
  if (token !== null) client.setAuthToken(token);
}
