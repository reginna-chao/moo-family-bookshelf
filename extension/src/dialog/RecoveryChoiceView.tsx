import React from "react";

export interface RecoveryChoiceViewProps {
  userEmail: string;
  onUseSyncCode: () => void;
  onSkip: () => void;
  isLoading?: boolean;
}

export function RecoveryChoiceView({
  userEmail,
  onUseSyncCode,
  onSkip,
  isLoading = false,
}: RecoveryChoiceViewProps): React.JSX.Element {
  const secondaryClass = isLoading
    ? "moo-recovery-choice__secondary moo-recovery-choice__secondary--loading"
    : "moo-recovery-choice__secondary";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">發現您的家庭書架帳號</h2>
      {userEmail && <p className="moo-recovery-choice__account">帳號：{userEmail}</p>}
      <p className="moo-recovery-choice__body">
        自動恢復未成功。若您有家庭同步碼，可輸入同步碼重新加入。
        或直接略過，系統會重新同步您的書籍資料。
      </p>
      <button type="button" onClick={onUseSyncCode} className="moo-recovery-choice__primary">
        輸入同步碼重新加入
      </button>
      <button type="button" onClick={onSkip} disabled={isLoading} className={secondaryClass}>
        {isLoading ? "處理中..." : "略過，重新同步書籍資料"}
      </button>
    </div>
  );
}
