import { useState, useCallback } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient, VerifyMethod } from "@/api/client";

interface UseVerifyMethodSaveOptions {
  userId: string;
  apiClient: ApiClient;
  /** Gets the token a new pin / pattern rotated (#378), before anything else is sent. */
  onTokenRotated?: (authToken: string) => void;
}

/** The setup prompt's save: store the chosen method, then mark the prompt as shown. */
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
      const body: { method: VerifyMethod; secret?: string } = { method };
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
      // Mark as prompted
      await apiClient.markVerifyPrompted(userId);
      setSaving(false);
      return true;
    },
    [userId, apiClient, onTokenRotated],
  );

  return { saving, saveError, setSaveError, saveMethod };
}
