/** `GET /api/version` for both apps' `ApiClient.checkVersion`; in `shared/` because it needs nothing
 *  app-specific. Response-handling rationale: docs/architecture.md → API client 的回應處理. */

import { sanitizeRecord } from "./safeText";
import { sanitizeVersionInfoText } from "./entityText";
import type { ApiResponse, VersionInfo } from "./types";

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
