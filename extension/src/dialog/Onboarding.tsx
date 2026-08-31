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

/** States `renderContent` answers with a view of their OWN. Every other state
 *  falls through to its final `<IdleView>` branch — including a future state
 *  added without a branch, which is why this is the complement rather than a
 *  list of the fallback states. Keep in step with `renderContent` below. */
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

/**
 * Whether the container's adopted-endpoint note would merely repeat the note
 * the view below is already showing: same screen, same address. Two amber lines
 * about one fact is what teaches a user to skim past the whole note family —
 * guaranteed in the sync-remnant prefill path, where the prefilled code's
 * `@host` IS the adopted endpoint (useOnboardingFlow.ts).
 *
 * Suppression fires ONLY on byte-equality of two ALREADY-VALIDATED canonical
 * endpoints — `kind: "valid"` means the string came out of `validateEndpointUrl`
 * on both sides. That is the one direction in which typed text cannot vouch for
 * anything: it may HIDE a note whose content it exactly reproduces, never change
 * what a note says nor make one appear, so adoptedEndpoint.ts invariant 1 stays
 * intact. An `invalid` or absent `@host` never suppresses — there the spoof
 * warning and the status note answer different questions and must coexist, as
 * must two DIFFERENT addresses.
 *
 * No blind window: `displayedSyncCodeApiHost` (shared/api/syncCodeHost.ts)
 * delays only the `invalid` verdict, so the view's note for a `valid` host is in
 * the same commit that suppresses this one. That is load-bearing — were the
 * shared display policy ever to delay `valid` too, this would leave the settle
 * delay showing no note at all (same address only, but still a gap).
 */
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

  // One verdict per render, shared by the container note and the challenge's
  // own note, so the two can never disclose different servers. Deliberately NOT
  // memoized on `apiClient`: a join adopts a sync code's `@host` in place, which
  // changes the endpoint without changing the client's identity, and a stale
  // disclosure is the exact failure this note exists to prevent.
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
      // The challenge replaces the join screen, taking its host disclosure with
      // it — exactly when the user is asked to hand a PIN/pattern to a server.
      // By this point a sync-code join has already applied its `@host` to the
      // client (performJoin leaves it applied so the challenge talks to that
      // server), while a create/lookup challenge is still on the official
      // default — so the adopted endpoint is the accurate answer for both. See
      // adoptedEndpoint.ts for why the typed sync code is never the source.
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
      {/* A self-hoster's create / join / recovery actions all hit the ADOPTED
          endpoint, so say which server that is before any of them happen. On
          the official default classifyAdoptedEndpoint returns `none` and the
          note renders nothing (adoptedEndpoint.ts invariant 2) — that silence
          is the point, not a missing case. verify-prompt is excluded because it
          renders the same note itself, with its own `verify` lead-in. The join
          screens are excluded only when their typed-code note already names the
          very same address — see isAdoptedNoteRedundant above for why matching
          typed text may hide this note without ever shaping it. */}
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
