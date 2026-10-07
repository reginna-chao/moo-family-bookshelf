// The single source of the endpoint-disclosure rule: classify the ADOPTED endpoint (never input
// text); the official default discloses nothing. See docs/architecture.md → 揭露採用中的伺服器位址.

import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import type { ApiClient } from "../api/client";
import type { SyncCodeApiHostResult } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";

/**
 * Verdict for the endpoint the client has adopted — the only source a
 * secret-collecting screen may disclose. Returns `none` (render nothing) for the
 * official default endpoint.
 */
export function classifyAdoptedEndpoint(
  apiClient: ApiClient,
): SyncCodeApiHostResult {
  const adopted = apiClient.getEndpoint();
  return classifySyncCodeApiHost(
    adopted === DEFAULT_API_ENDPOINT ? undefined : adopted,
  );
}
