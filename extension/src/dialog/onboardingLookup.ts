/**
 * Auth-lookup helper for the onboarding flow.
 *
 * `POST /api/auth/lookup` answers HTTP 200 with `requiresVerification: TRUE`
 * and withheld family data when the account has PWA login verification
 * configured and the request carried no secret. That is informational rather
 * than an error — but every onboarding caller must react to it exactly as it
 * reacts to the join-side `VERIFICATION_REQUIRED`. This module normalizes both
 * into one outcome so callers can hand the code straight to the verification
 * prompt, and so a withheld payload can never be misread as "no family found".
 */

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
    // A secret was sent and the server still withholds the data: report it as a
    // failed attempt so the user is told why, instead of reading the withheld
    // payload as "this account has no family".
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
