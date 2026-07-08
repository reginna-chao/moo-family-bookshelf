import React, { useState, useEffect } from "react";
import browser from "webextension-polyfill";
import { ApiClient } from "../api/client";
import { DISPLAY_NAME_KEY } from "../constants";
import { LoadingOverlay } from "./LoadingOverlay";
import { useAutoSetup } from "./useAutoSetup";
import { WelcomeView, CreatedView, ErrorView, IdleView } from "./OnboardingViews";
import type { ErrorAction } from "./OnboardingViews";
import {
  RecoveryChoiceView,
  RecoveryJoinView,
  SoloRecoveryConfirmView,
} from "./OnboardingRecoveryViews";
import { VerificationPrompt } from "./VerificationPrompt";
import { useOnboardingFlow } from "./useOnboardingFlow";

export interface OnboardingProps {
  onFamilyJoined: (familyId: string, userId: string) => void;
  apiClient: ApiClient;
}

export function Onboarding({ onFamilyJoined, apiClient }: OnboardingProps) {
  const autoSetup = useAutoSetup();
  const flow = useOnboardingFlow({ apiClient, onFamilyJoined, autoSetup });

  const [copied, setCopied] = useState(false);
  const [hasUsedBefore, setHasUsedBefore] = useState(false);

  // Check if user has previously used the extension (has displayName stored)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await browser.storage.local.get([DISPLAY_NAME_KEY]);
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isAutoSetupActive = autoSetup.phase !== "idle" && autoSetup.phase !== "error";

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
  const effectiveError = autoSetup.phase === "error" ? autoSetup.errorMessage : flow.errorMessage;
  const isProcessing =
    effectiveState === "creating" ||
    effectiveState === "joining" ||
    effectiveState === "syncing-books" ||
    effectiveState === "recovering";

  // When autoSetup owns the error state, provide an explicit retry action
  // instead of relying on the fallback branch in renderContent.
  const effectiveErrorActions: ErrorAction[] =
    autoSetup.phase === "error"
      ? [{ label: "重試", variant: "primary", onClick: flow.handleRetry }]
      : flow.errorActions;

  const renderContent = () => {
    if (effectiveState === "welcome") {
      return <WelcomeView onStart={flow.handleStart} hasUsedBefore={hasUsedBefore} />;
    }
    if (effectiveState === "error") {
      const actions =
        effectiveErrorActions.length > 0
          ? effectiveErrorActions
          : [{ label: "重試", variant: "primary" as const, onClick: flow.handleRetry }];
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
      return (
        <VerificationPrompt
          method={flow.verify.method}
          methodError={flow.verify.methodError}
          error={flow.verify.error}
          locked={flow.verify.locked}
          submitting={flow.verify.submitting}
          onSubmit={(secret) => void flow.verify.submit(secret)}
          onCancel={flow.verify.cancel}
        />
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
      {renderContent()}
    </div>
  );
}
