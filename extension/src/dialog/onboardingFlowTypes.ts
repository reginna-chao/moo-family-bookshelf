/** Public types of useOnboardingFlow: its view states, options and result. */

import type { ApiClient } from "../api/client";
import type { useAutoSetup } from "./useAutoSetup";
// Type-only, and must stay so: OnboardingViews re-exports IdleView, which
// type-imports OnboardingState from useOnboardingFlow. A value import here
// would close that loop into a runtime cycle.
import type { ErrorAction } from "./OnboardingViews";
import type { UseVerificationPromptResult } from "./useVerificationPrompt";

export type OnboardingState =
  | "welcome"
  | "idle"
  | "creating"
  | "recovering"
  | "created"
  | "joining"
  | "syncing-books"
  | "recovery-choice"
  | "recovery-join"
  | "solo-recovery-confirm"
  | "verify-prompt"
  | "error";

export interface UseOnboardingFlowOptions {
  apiClient: ApiClient;
  onFamilyJoined: (familyId: string, userId: string) => void;
  autoSetup: ReturnType<typeof useAutoSetup>;
}

export interface UseOnboardingFlowResult {
  state: OnboardingState;
  errorMessage: string;
  errorActions: ErrorAction[];
  userEmail: string | null;
  userDisplayName: string;
  syncCodeInput: string;
  setSyncCodeInput: (value: string) => void;
  generatedSyncCode: string;
  createdFamilyId: string;
  createdUserId: string;
  handleStart: () => Promise<void>;
  handleCreate: () => Promise<void>;
  handleJoin: () => Promise<void>;
  handleContinueAfterCreate: () => Promise<void>;
  handleRetry: () => void;
  /** From recovery-choice: user chose to enter a sync code → recovery-join */
  handleRecoveryChoiceUseSyncCode: () => void;
  /** From recovery-choice: user chose to skip → solo-recovery-confirm */
  handleRecoveryChoiceSkip: () => void;
  /** From recovery-join: user wants to go back to the choice screen */
  handleRecoveryJoinBack: () => void;
  /** From solo-recovery-confirm: user confirmed → runs performSoloRecovery */
  handleSoloRecoveryConfirm: () => Promise<void>;
  /** From solo-recovery-confirm: user wants to go back to the choice screen */
  handleSoloRecoveryBack: () => void;
  /** Verification challenge controller (shown when state === "verify-prompt"). */
  verify: UseVerificationPromptResult;
}
