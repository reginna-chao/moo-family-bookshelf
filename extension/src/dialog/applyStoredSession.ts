import type { ApiClient } from "../api/client";
import {
  resolveStoredEndpoint,
  STORED_SESSION_KEYS,
  storedTokenFor,
} from "../api/tokenBinding";
import {
  API_ENDPOINT_KEY,
  MANUAL_API_ENDPOINT_KEY,
  USER_ID_KEY,
} from "../constants";
import { persistSwitchedFamilyEndpoint } from "../storage/familyEndpointChoice";

/** The keys App's boot read fetches in one storage read. */
export const BOOT_SESSION_KEYS: readonly string[] = [
  USER_ID_KEY,
  ...STORED_SESSION_KEYS,
  MANUAL_API_ENDPOINT_KEY,
];

/**
 * Put the stored endpoint and its token on the client, or neither when the
 * endpoint is unusable (hand-edited storage, or written by an older build with
 * looser rules). `stored` is one storage read that includes every key in
 * `STORED_SESSION_KEYS`, so the token and the endpoint it is paired with cannot
 * disagree. A token stored with another server than the stored endpoint is not
 * set (`storedTokenFor`): the client gets the endpoint only.
 *
 * App's boot read calls it only when a family is bound (familyId and userId both
 * stored). With no family it calls `applyManualEndpoint` instead, so a leftover
 * endpoint cannot carry the next create / join to a former family's server (#501).
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

/**
 * App's boot step: `applyStoredSession` when a family is bound (familyId and
 * userId both stored), `applyManualEndpoint` otherwise. `stored` holds every key
 * in `BOOT_SESSION_KEYS`.
 */
export function applyBootSession(
  client: ApiClient,
  stored: Record<string, unknown>,
  familyBound: boolean,
): void {
  if (familyBound) applyStoredSession(client, stored);
  else applyManualEndpoint(client, stored);
}

/**
 * Point the client at the operator-set endpoint, if one is stored and usable.
 * App's boot read calls it only when no family is bound. The key is written by
 * hand in DevTools only — no sync code, family setting or family flow can write
 * it — so it never carries a former family's server.
 *
 * It sets no token and reads neither the family endpoint nor the token. An
 * unusable value is warned about and left in storage for the operator to fix;
 * the client stays on the official default. See docs/architecture.md →
 * 認證更新與冷卻.
 */
export function applyManualEndpoint(
  client: ApiClient,
  stored: Record<string, unknown>,
): void {
  const raw = stored[MANUAL_API_ENDPOINT_KEY];
  // resolveStoredEndpoint(undefined) answers the official default; nothing to apply.
  if (raw === undefined) return;
  const endpoint = resolveStoredEndpoint(raw);
  if (endpoint === null) {
    console.warn("[App] Ignoring unusable manual API endpoint");
    return;
  }
  client.setEndpoint(endpoint);
}
