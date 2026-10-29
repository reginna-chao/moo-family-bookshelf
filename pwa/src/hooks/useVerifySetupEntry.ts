import { useEffect } from "react";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { readVerifyMethod } from "@/hooks/stepUp";

/** The steps of `VerifySetupPrompt`'s one-shot post-login flow. */
export type Step =
  | "loading"
  | "keep-or-change"
  | "current-secret"
  | "choose"
  | "setup-pin"
  | "setup-pattern"
  | "confirm-skip"
  | "done";

interface UseVerifySetupEntryOptions {
  apiClient: ApiClient;
  userId: string;
  setStep: (step: Step) => void;
  setStepUpMethod: (method: VerifyMethod) => void;
}

/** Picks the prompt's first step from the prompted flag and the account's current method. */
export function useVerifySetupEntry({
  apiClient,
  userId,
  setStep,
  setStepUpMethod,
}: UseVerifySetupEntryOptions): void {
  useEffect(() => {
    void Promise.all([
      apiClient.getVerifyPrompted(userId),
      readVerifyMethod(apiClient, userId),
    ])
      .then(([res, method]) => {
        // Show only on an explicit "not yet prompted"; an error envelope (e.g. an old server's 404) skips it
        if (res.data?.prompted !== BoolFlag.FALSE) {
          setStep("done");
          return;
        }
        // A failed method read counts as "none": the server still asks for the secret if it must.
        if (method !== null && requiresCurrentSecret(method)) {
          setStepUpMethod(method);
          setStep("keep-or-change");
          return;
        }
        setStep("choose");
      })
      .catch(() => {
        // On error, skip prompt to avoid blocking the user
        setStep("done");
      });
  }, [userId, apiClient, setStep, setStepUpMethod]);
}
