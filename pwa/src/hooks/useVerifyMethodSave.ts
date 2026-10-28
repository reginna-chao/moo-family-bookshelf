import { useState, useCallback } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import type { SetVerifyBody } from "moo-family-bookshelf-shared/api/verifyTypes";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { stepUpBackoffMessage } from "@/hooks/stepUp";

interface UseVerifyMethodSaveOptions {
  userId: string;
  apiClient: ApiClient;
  /** Gets the token a new pin / pattern rotated (#378), before anything else is sent. */
  onTokenRotated?: (authToken: string) => void;
}

export type VerifySaveResult = { ok: true } | { ok: false; code?: string };

/** Codes whose copy the caller owns: it re-asks for the current secret instead (#396). */
const STEP_UP_CODES: ReadonlySet<string> = new Set([
  "VERIFICATION_FAILED",
  "VERIFICATION_REQUIRED",
]);

/**
 * The setup prompt's save: stores the chosen method and the prompt-shown mark
 * in ONE write (#399). A PIN / pattern account also sends `currentSecret` (#396).
 */
export function useVerifyMethodSave({
  userId,
  apiClient,
  onTokenRotated,
}: UseVerifyMethodSaveOptions) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const saveMethod = useCallback(
    async (
      method: VerifyMethod,
      secret?: string,
      currentSecret?: string,
    ): Promise<VerifySaveResult> => {
      setSaving(true);
      setSaveError("");
      // No follow-up POST /verify/prompted: its stale read could overwrite the fresh method with
      // `none` (#399, docs/architecture.md → PWA 登入驗證機制).
      const body: SetVerifyBody = { method, prompted: BoolFlag.TRUE };
      if (secret) body.secret = secret;
      if (currentSecret !== undefined) body.currentSecret = currentSecret;
      const res = await apiClient.setVerifyMethod(userId, body);
      if (res.error) {
        if (!STEP_UP_CODES.has(res.error.code)) {
          setSaveError(
            stepUpBackoffMessage(res.error) ??
              safeErrorText(res.error.message, "儲存失敗，請重試。"),
          );
        }
        setSaving(false);
        return { ok: false, code: res.error.code };
      }
      // The old token is revoked: persist the new one into the session, or the next reload or
      // recovery join starts from the dead token and logs the user out.
      if (res.data?.authToken !== undefined) {
        onTokenRotated?.(res.data.authToken);
      }
      setSaving(false);
      return { ok: true };
    },
    [userId, apiClient, onTokenRotated],
  );

  return { saving, saveError, setSaveError, saveMethod };
}
