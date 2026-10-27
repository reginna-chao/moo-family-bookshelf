// Twin: extension/src/dialog/stepUp.ts — same decisions; only the back-off copy helpers differ per app.
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import {
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretWrongMessage,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient, VerifyMethod } from "@/api/client";
import {
  buildRetryMessage,
  rateLimitedEnvelopeMessage,
} from "@/utils/retryMessage";

/** Next step after a refused change of verification or account deletion (#396): ask for the
 *  current secret of `method` again, or stay where the user is and show `error`. */
export type StepUpRecovery =
  | { kind: "ask"; method: VerifyMethod; error: string }
  | { kind: "message"; error: string };

interface StepUpError {
  code: string;
  retryAfter?: number;
}

/** The account's verify method as the server reads it now, or null when the read failed. */
export async function readVerifyMethod(
  apiClient: ApiClient,
  userId: string,
): Promise<VerifyMethod | null> {
  try {
    const res = await apiClient.getVerifyMethod(userId);
    return res.data?.method ?? null;
  } catch {
    return null;
  }
}

/** 429 copy of a step-up request, or null for any other code. */
export function stepUpBackoffMessage(error: StepUpError): string | null {
  if (error.code !== "VERIFICATION_LOCKED") {
    return rateLimitedEnvelopeMessage(error);
  }
  const { retryAfter } = error;
  const usable = typeof retryAfter === "number" && Number.isFinite(retryAfter);
  // An unusable wait reads as 0, which `buildRetryMessage` renders as the static copy.
  return buildRetryMessage("VERIFICATION_LOCKED", usable ? retryAfter : 0);
}

/**
 * Map a step-up error to its next step; null for any other code, which keeps
 * the caller's own handling. `askedMethod` is the method whose current secret
 * was sent, null when none was. `VERIFICATION_REQUIRED` re-reads the method
 * once: a PIN / pattern account is asked for its secret — without an error when
 * none was sent, with `CURRENT_SECRET_UNAVAILABLE_MESSAGE` when one was; any
 * other answer (or a failed read) shows that message without asking.
 * The server's own message is never shown for these codes.
 */
export async function recoverStepUp(
  apiClient: ApiClient,
  userId: string,
  error: StepUpError,
  askedMethod: VerifyMethod | null,
): Promise<StepUpRecovery | null> {
  if (
    error.code === "VERIFICATION_FAILED" &&
    askedMethod !== null &&
    requiresCurrentSecret(askedMethod)
  ) {
    const message = currentSecretWrongMessage(askedMethod);
    return { kind: "ask", method: askedMethod, error: message };
  }
  if (error.code === "VERIFICATION_REQUIRED") {
    const method = await readVerifyMethod(apiClient, userId);
    if (method !== null && requiresCurrentSecret(method)) {
      // A sent secret refused unread (a stale server copy): say so, or the input loops silently.
      const hint =
        askedMethod === null ? "" : CURRENT_SECRET_UNAVAILABLE_MESSAGE;
      return { kind: "ask", method, error: hint };
    }
    return { kind: "message", error: CURRENT_SECRET_UNAVAILABLE_MESSAGE };
  }
  const backoff = stepUpBackoffMessage(error);
  return backoff === null ? null : { kind: "message", error: backoff };
}
