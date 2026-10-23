/** `GET /api/public/:shareToken` for `ApiClient.getPublicShelf`, split out of `client.ts` to keep it
 *  under its line ceiling. Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import { sanitizePublicShelfDataText } from "moo-family-bookshelf-shared/api/entityText";
import type {
  ApiResponse,
  PublicShelfData,
} from "moo-family-bookshelf-shared/api/types";

/**
 * Read a public shelf by its share token. A direct `fetch` that deliberately
 * bypasses `ApiClient`'s `request()` — no auth header, no GET dedup, no 401
 * refresh — because the reader holds only the link. An `error` envelope throws
 * a plain `Error` carrying the HTTP `status`, so the page can tell a 404 apart.
 */
export async function fetchPublicShelf(
  baseUrl: string,
  shareToken: string,
): Promise<PublicShelfData> {
  const url = `${baseUrl}/api/public/${shareToken}`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });
  const json = (await response.json()) as ApiResponse<PublicShelfData>;
  if (json.error) {
    // Sanitize before interpolation, or a hostile field throws before `status` is attached and a
    // 404 loses its own screen (docs/architecture.md → API client 的回應處理).
    const code = safeErrorText(json.error.code, "UNKNOWN_ERROR");
    const message = safeErrorText(json.error.message, "請稍後再試");
    const err = new Error(`${code}: ${message}`);
    (err as Error & { status: number }).status = response.status;
    throw err;
  }
  if (!json.data) {
    throw new Error("EMPTY_RESPONSE: response body missing data");
  }
  // Own bare cast above, so this sanitizer is the ONLY guard before `PublicShelfPage` renders and
  // `.toLowerCase()`s these fields (docs/architecture.md → API client 的回應處理).
  return sanitizeRecord(json.data, sanitizePublicShelfDataText);
}
