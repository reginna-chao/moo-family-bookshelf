/** `GET /api/version` for `ApiClient.checkVersion`, split out of `client.ts` to keep it under its
 *  line ceiling. Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import { sanitizeVersionInfoText } from "moo-family-bookshelf-shared/api/entityText";
import type {
  ApiResponse,
  VersionInfo,
} from "moo-family-bookshelf-shared/api/types";

/** Check server API version. Returns null on network/parse errors. */
export async function fetchVersion(
  baseUrl: string,
): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/api/version`);
    if (!res.ok) return null;
    const json = (await res.json()) as ApiResponse<VersionInfo>;
    const data = json.data ?? null;
    if (data === null) return null;
    return sanitizeRecord(data, sanitizeVersionInfoText);
  } catch {
    return null;
  }
}
