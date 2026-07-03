import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export interface RecoveryJoinViewProps {
  syncCodeInput: string;
  isProcessing: boolean;
  onSetSyncCodeInput: (value: string) => void;
  onJoin: () => void;
  onBack: () => void;
}

export function RecoveryJoinView({
  syncCodeInput,
  isProcessing,
  onSetSyncCodeInput,
  onJoin,
  onBack,
}: RecoveryJoinViewProps): React.JSX.Element {
  const [showInput, setShowInput] = useState(false);
  const disableJoin = !syncCodeInput.trim() || isProcessing;
  const submitClass = disableJoin
    ? "moo-recovery-join__submit moo-recovery-join__submit--disabled"
    : "moo-recovery-join__submit";
  const backClass = isProcessing
    ? "moo-recovery-join__back moo-recovery-join__back--disabled"
    : "moo-recovery-join__back";

  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">輸入同步碼</h2>
      <p className="moo-recovery-join__body">請輸入家庭同步碼以重新加入家庭。</p>
      <div className="moo-recovery-join__field">
        <input
          type={showInput ? "text" : "password"}
          autoComplete="off"
          placeholder="輸入家庭同步碼"
          aria-label="家庭同步碼"
          value={syncCodeInput}
          onChange={(e) => onSetSyncCodeInput(e.target.value)}
          disabled={isProcessing}
          className="moo-recovery-join__input"
        />
        <button
          type="button"
          onClick={() => setShowInput(!showInput)}
          className="moo-recovery-join__reveal"
          aria-label={showInput ? "隱藏同步碼" : "顯示同步碼"}
        >
          {showInput ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <button type="button" onClick={onJoin} disabled={disableJoin} className={submitClass}>
        {isProcessing ? "加入中..." : "加入並還原書架"}
      </button>
      <button type="button" onClick={onBack} disabled={isProcessing} className={backClass}>
        返回
      </button>
    </div>
  );
}
