import { useState, useCallback } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import type { SetVerifyBody } from "moo-family-bookshelf-shared/api/verifyTypes";
import type { ApiClient, VerifyMethod } from "@/api/client";

interface UseVerifyMethodSaveOptions {
  userId: string;
  apiClient: ApiClient;
  /** Gets the token a new pin / pattern rotated (#378), before anything else is sent. */
  onTokenRotated?: (authToken: string) => void;
}

/** The setup prompt's save: stores the chosen method and the prompt-shown mark in ONE write. */
export function useVerifyMethodSave({
  userId,
  apiClient,
  onTokenRotated,
}: UseVerifyMethodSaveOptions) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const saveMethod = useCallback(
    async (method: VerifyMethod, secret?: string) => {
      setSaving(true);
      setSaveError("");
      // No follow-up POST /verify/prompted: its stale read could overwrite the fresh method with
      // `none` (#399, docs/architecture.md → PWA 登入驗證機制).
      const body: SetVerifyBody = { method, prompted: BoolFlag.TRUE };
      if (secret) body.secret = secret;
      const res = await apiClient.setVerifyMethod(userId, body);
      if (res.error) {
        setSaveError(safeErrorText(res.error.message, "儲存失敗，請重試。"));
        setSaving(false);
        return false;
      }
      // The old token is revoked: persist the new one into the session, or the next reload or
      // recovery join starts from the dead token and logs the user out.
      if (res.data?.authToken !== undefined) {
        onTokenRotated?.(res.data.authToken);
      }
      setSaving(false);
      return true;
    },
    [userId, apiClient, onTokenRotated],
  );

  return { saving, saveError, setSaveError, saveMethod };
}
