import React from "react";
import { SyncCodeHostNote } from "./SyncCodeHostNote";
import { useSyncCodeHostVerdict } from "./useSyncCodeHostVerdict";

type OnboardingState = string;

export interface IdleViewProps {
  state: OnboardingState;
  syncCodeInput: string;
  isProcessing: boolean;
  onSetSyncCodeInput: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}

export function IdleView({
  state,
  syncCodeInput,
  isProcessing,
  onSetSyncCodeInput,
  onCreate,
  onJoin,
}: IdleViewProps) {
  const hostVerdict = useSyncCodeHostVerdict(syncCodeInput);
  const handleJoin = () => {
    // Pressing join ends the editing session, so the warning must not wait.
    hostVerdict.settleNow();
    onJoin();
  };
  const createClass = isProcessing
    ? "moo-button moo-button--block moo-onboarding-view__create moo-onboarding-view__create--busy"
    : "moo-button moo-button--block moo-onboarding-view__create";
  const joinDisabled = !syncCodeInput.trim() || isProcessing;
  const joinClass = joinDisabled
    ? "moo-button moo-button--outline moo-button--block moo-onboarding-view__join moo-onboarding-view__join--disabled"
    : "moo-button moo-button--outline moo-button--block moo-onboarding-view__join";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">歡迎使用家庭書櫃</h2>
      <p className="moo-onboarding-view__body">
        建立或加入家庭公開書櫃，與家人分享你的藏書。
      </p>
      <button
        onClick={onCreate}
        disabled={isProcessing}
        className={createClass}
      >
        {state === "creating" ? "建立中..." : "建立家庭公開書櫃"}
      </button>
      <div className="moo-onboarding-view__divider">或</div>
      <div className="moo-onboarding-view__input-wrap">
        <input
          type="text"
          autoComplete="off"
          placeholder="輸入家庭同步碼"
          value={syncCodeInput}
          onChange={(e) => onSetSyncCodeInput(e.target.value)}
          onPaste={hostVerdict.settleOnNextChange}
          onBlur={hostVerdict.settleNow}
          disabled={isProcessing}
          className="moo-form-input moo-form-input--block moo-onboarding-view__input"
        />
      </div>
      <SyncCodeHostNote result={hostVerdict.result} />
      <button
        onClick={handleJoin}
        disabled={joinDisabled}
        className={joinClass}
      >
        {state === "joining" ? "加入中..." : "加入家庭公開書櫃"}
      </button>
      <p className="moo-onboarding-view__note moo-onboarding-view__note--lh">
        將同步碼分享給家人即可加入書櫃。
      </p>
    </div>
  );
}
