import type { ApiClient } from "../api/client";
import { resolveStoredEndpoint } from "../api/tokenBinding";
import { API_ENDPOINT_KEY, AUTH_TOKEN_KEY } from "../constants";
import { persistSwitchedFamilyEndpoint } from "../storage/familyEndpointChoice";

/**
 * Put the stored endpoint and its token on the client, or neither when the
 * endpoint is unusable (hand-edited storage, or written by an older build with
 * looser rules). Used by App's boot read; `stored` is one storage read, so the
 * token and the endpoint it is paired with cannot disagree.
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

  const token = stored[AUTH_TOKEN_KEY];
  if (typeof token === "string" && token !== "") client.setAuthToken(token);
}
