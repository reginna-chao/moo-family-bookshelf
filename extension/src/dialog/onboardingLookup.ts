// Onboarding's auth lookup: maps lookup's 200 `requiresVerification: TRUE` onto the join-side
// verification codes, so a withheld payload never reads as "no family" (docs/architecture.md → 認證 API).

import { BoolFlag } from "../api/client";
import type { ApiClient, LookupResult } from "../api/client";

export type LookupOutcome =
  | { ok: true; data: LookupResult }
  | {
      ok: false;
      /** Machine-readable failure code; verification codes drive the prompt. */
      errorCode: string;
      /** Seconds to wait before retrying, present on rate-limit (429) failures. */
      retryAfter?: number;
    };

/**
 * Look up the caller's family, satisfying the verification gate when a secret
 * is supplied. Returns a trustworthy payload only when the gate is cleared.
 */
export async function lookupFamily(opts: {
  apiClient: ApiClient;
  userId: string;
  verifySecret?: string;
}): Promise<LookupOutcome> {
  const res = await opts.apiClient.lookupUser(
    opts.userId,
    opts.verifySecret !== undefined
      ? { verifySecret: opts.verifySecret }
      : undefined,
  );

  if (res.error) {
    return {
      ok: false,
      errorCode: res.error.code,
      retryAfter: res.error.retryAfter,
    };
  }
  if (!res.data) {
    return { ok: false, errorCode: "EMPTY_RESPONSE" };
  }
  if (res.data.requiresVerification === BoolFlag.TRUE) {
    // Withheld data is never "no family": REQUIRED without a secret; with one, a failed attempt
    // (VERIFICATION_FAILED) so the user is told why.
    return {
      ok: false,
      errorCode:
        opts.verifySecret === undefined
          ? "VERIFICATION_REQUIRED"
          : "VERIFICATION_FAILED",
    };
  }

  return { ok: true, data: res.data };
}
