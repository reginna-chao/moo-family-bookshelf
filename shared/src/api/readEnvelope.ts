/** Envelope reader shared by both API clients: docs/architecture.md → API client 的回應處理. */

import type { ApiResponse } from "./types";

/** The one bodyless status this API answers (`DELETE /api/user/:id/public-shelf/:shelfId`); keep it
 *  to exactly this one (docs/architecture.md → API client 的回應處理). */
const NO_CONTENT_STATUS = 204;

/** Read the `{ data, error }` envelope; a 204 is an empty envelope (`response.json()` would throw
 *  on it), every other response still parses — or throws — as JSON. */
export async function readEnvelope<T>(
  response: Response,
): Promise<ApiResponse<T>> {
  if (response.status === NO_CONTENT_STATUS) return {};
  return (await response.json()) as ApiResponse<T>;
}
