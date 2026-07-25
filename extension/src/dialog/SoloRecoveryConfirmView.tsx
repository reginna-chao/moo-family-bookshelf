import React from "react";

export interface SoloRecoveryConfirmViewProps {
  onConfirm: () => void;
  onBack: () => void;
  isLoading?: boolean;
}

export function SoloRecoveryConfirmView({
  onConfirm,
  onBack,
  isLoading = false,
}: SoloRecoveryConfirmViewProps): React.JSX.Element {
  const confirmClass = isLoading
    ? "moo-button moo-button--block moo-solo-recovery__confirm moo-solo-recovery__confirm--loading"
    : "moo-button moo-button--block moo-solo-recovery__confirm";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">確認重新同步書籍資料？</h2>
      <div className="moo-solo-recovery__info">
        將以目前的讀墨帳號重新同步書籍資料。
        您先前的分享設定（哪些書公開）會自動保留。
      </div>
      <p className="moo-solo-recovery__body">同步完成後即可查看家庭書架。</p>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isLoading}
        className={confirmClass}
      >
        {isLoading ? "處理中..." : "確認重新同步"}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="moo-button moo-button--outline moo-button--block moo-solo-recovery__back"
      >
        返回
      </button>
    </div>
  );
}
