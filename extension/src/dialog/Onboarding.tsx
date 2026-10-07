import React, { useState, useEffect } from "react";
import { ApiClient } from "../api/client";
import { DISPLAY_NAME_KEY } from "../constants";
import {
  parseSyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "../crypto/syncCode";
import { useTimedFlag } from "../hooks/useTimedFlag";
import { safeStorageGet } from "../storage/safeStorage";
import { classifyAdoptedEndpoint } from "./adoptedEndpoint";
import { LoadingOverlay } from "./LoadingOverlay";
import { SyncCodeHostNote } from "./SyncCodeHostNote";
import { useAutoSetup } from "./useAutoSetup";
import {
  WelcomeView,
  CreatedView,
  ErrorView,
  IdleView,
} from "./OnboardingViews";
import type { ErrorAction } from "./OnboardingViews";
import {
  RecoveryChoiceView,
  RecoveryJoinView,
  SoloRecoveryConfirmView,
} from "./OnboardingRecoveryViews";
import { VerificationPrompt } from "./VerificationPrompt";
import { useOnboardingFlow, type OnboardingState } from "./useOnboardingFlow";

export interface OnboardingProps {
  onFamilyJoined: (familyId: string, userId: string) => void;
  apiClient: ApiClient;
}

/** States `renderContent` gives a view of their OWN; every other one (a future state too) falls
 *  through to `<IdleView>`, hence a complement. Keep in step with `renderContent` below. */
const DEDICATED_VIEW_STATES = new Set<OnboardingState>([
  "welcome",
  "error",
  "created",
  "recovery-choice",
  "recovery-join",
  "solo-recovery-confirm",
  "verify-prompt",
]);

/** Whether the view on screen renders the TYPED sync code's own host note.
 *  Exactly two do: `RecoveryJoinView` and `IdleView` (the fallback branch). */
function rendersTypedSyncCodeNote(state: OnboardingState): boolean {
  return state === "recovery-join" || !DEDICATED_VIEW_STATES.has(state);
}

/** Whether the container note would repeat the view's note (same validated address); hides only on
 *  equal `valid` endpoints. See docs/architecture.md → 揭露採用中的伺服器位址. */
function isAdoptedNoteRedundant(
  state: OnboardingState,
  syncCodeInput: string,
  adopted: SyncCodeApiHostResult,
): boolean {
  if (adopted.kind !== "valid") return false;
  if (!rendersTypedSyncCodeNote(state)) return false;
  const typed = parseSyncCodeApiHost(syncCodeInput);
  return typed.kind === "valid" && typed.endpoint === adopted.endpoint;
}

export function Onboarding({ onFamilyJoined, apiClient }: OnboardingProps) {
  const autoSetup = useAutoSetup();
  const flow = useOnboardingFlow({ apiClient, onFamilyJoined, autoSetup });

  const [copied, markCopied] = useTimedFlag(2000);
  const [hasUsedBefore, setHasUsedBefore] = useState(false);

  // Check if user has previously used the extension (has displayName stored)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await safeStorageGet([DISPLAY_NAME_KEY]);
      if (cancelled) return;
      if (result[DISPLAY_NAME_KEY]) {
        setHasUsedBefore(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(flow.generatedSyncCode);
    markCopied();
  };

  const isAutoSetupActive =
    autoSetup.phase !== "idle" && autoSetup.phase !== "error";

  const overlayMessage =
    autoSetup.phase !== "idle" && autoSetup.phase !== "error"
      ? autoSetup.phaseMessage
      : flow.state === "syncing-books"
        ? "正在同步書單..."
        : flow.state === "recovering"
          ? "正在恢復家庭資料..."
          : flow.state === "joining"
            ? "正在加入家庭..."
            : "";

  const effectiveState = autoSetup.phase === "error" ? "error" : flow.state;
  const effectiveError =
    autoSetup.phase === "error" ? autoSetup.errorMessage : flow.errorMessage;
  const isProcessing =
    effectiveState === "creating" ||
    effectiveState === "joining" ||
    effectiveState === "syncing-books" ||
    effectiveState === "recovering";

  // One verdict per render for both notes; NOT memoized on `apiClient` (a join adopts `@host` in
  // place). See docs/architecture.md → 揭露採用中的伺服器位址.
  const adoptedHost = classifyAdoptedEndpoint(apiClient);

  // When autoSetup owns the error state, provide an explicit retry action
  // instead of relying on the fallback branch in renderContent.
  const effectiveErrorActions: ErrorAction[] =
    autoSetup.phase === "error"
      ? [{ label: "重試", variant: "primary", onClick: flow.handleRetry }]
      : flow.errorActions;

  const renderContent = () => {
    if (effectiveState === "welcome") {
      return (
        <WelcomeView onStart={flow.handleStart} hasUsedBefore={hasUsedBefore} />
      );
    }
    if (effectiveState === "error") {
      const actions =
        effectiveErrorActions.length > 0
          ? effectiveErrorActions
          : [
              {
                label: "重試",
                variant: "primary" as const,
                onClick: flow.handleRetry,
              },
            ];
      return <ErrorView errorMessage={effectiveError} actions={actions} />;
    }
    if (effectiveState === "created") {
      return (
        <CreatedView
          generatedSyncCode={flow.generatedSyncCode}
          copied={copied}
          onCopy={handleCopy}
          onContinue={flow.handleContinueAfterCreate}
        />
      );
    }
    if (effectiveState === "recovery-choice") {
      return (
        <RecoveryChoiceView
          userEmail={flow.userEmail ?? ""}
          onUseSyncCode={flow.handleRecoveryChoiceUseSyncCode}
          onSkip={flow.handleRecoveryChoiceSkip}
          isLoading={isProcessing}
        />
      );
    }
    if (effectiveState === "recovery-join") {
      return (
        <RecoveryJoinView
          syncCodeInput={flow.syncCodeInput}
          isProcessing={isProcessing}
          onSetSyncCodeInput={flow.setSyncCodeInput}
          onJoin={flow.handleJoin}
          onBack={flow.handleRecoveryJoinBack}
        />
      );
    }
    if (effectiveState === "solo-recovery-confirm") {
      return (
        <SoloRecoveryConfirmView
          onConfirm={flow.handleSoloRecoveryConfirm}
          onBack={flow.handleSoloRecoveryBack}
          isLoading={isProcessing}
        />
      );
    }
    if (effectiveState === "verify-prompt") {
      // The challenge replaces the join screen's disclosure, so it names the ADOPTED endpoint (right
      // for join and create/lookup alike). See docs/architecture.md → 揭露採用中的伺服器位址.
      return (
        <>
          <SyncCodeHostNote
            result={adoptedHost}
            variant="verify"
            className="moo-sync-host-note--verify"
          />
          <VerificationPrompt
            method={flow.verify.method}
            methodError={flow.verify.methodError}
            error={flow.verify.error}
            locked={flow.verify.locked}
            submitting={flow.verify.submitting}
            countdownSeconds={flow.verify.countdownSeconds}
            onSubmit={(secret) => void flow.verify.submit(secret)}
            onCancel={flow.verify.cancel}
          />
        </>
      );
    }
    return (
      <IdleView
        state={effectiveState}
        syncCodeInput={flow.syncCodeInput}
        isProcessing={isProcessing}
        onSetSyncCodeInput={flow.setSyncCodeInput}
        onCreate={flow.handleCreate}
        onJoin={flow.handleJoin}
      />
    );
  };

  return (
    <div className="moo-onboarding">
      {(isAutoSetupActive ||
        flow.state === "syncing-books" ||
        flow.state === "recovering" ||
        flow.state === "joining") &&
        overlayMessage && <LoadingOverlay message={overlayMessage} />}
      {/* Names the ADOPTED server before any create/join/recovery (silent on the default); skipped on
          verify-prompt and when redundant. See docs/architecture.md → 揭露採用中的伺服器位址. */}
      {effectiveState !== "verify-prompt" &&
        !isAdoptedNoteRedundant(
          effectiveState,
          flow.syncCodeInput,
          adoptedHost,
        ) && (
          <SyncCodeHostNote
            result={adoptedHost}
            variant="onboarding"
            className="moo-sync-host-note--onboarding"
          />
        )}
      {renderContent()}
    </div>
  );
}
