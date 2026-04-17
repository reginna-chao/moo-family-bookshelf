import React from "react";
import { PRIMARY_BLUE } from "./OnboardingViews";

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
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        發現您的家庭書架帳號
      </h2>
      {userEmail && (
        <p style={{ color: "#64748b", marginBottom: 8, fontSize: 14 }}>
          帳號：{userEmail}
        </p>
      )}
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14, lineHeight: 1.6 }}>
        自動恢復未成功。若您有家庭同步碼，可輸入同步碼重新加入。
        或直接略過，系統會重新同步您的書籍資料。
      </p>
      <button
        type="button"
        onClick={onUseSyncCode}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "none",
          borderRadius: 8,
          background: PRIMARY_BLUE,
          color: "white",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        輸入同步碼重新加入
      </button>
      <button
        type="button"
        onClick={onSkip}
        disabled={isLoading}
        style={{
          width: "100%",
          padding: 12,
          border: `1px solid ${PRIMARY_BLUE}`,
          borderRadius: 8,
          background: "transparent",
          color: PRIMARY_BLUE,
          fontWeight: 600,
          fontSize: 14,
          cursor: isLoading ? "not-allowed" : "pointer",
          opacity: isLoading ? 0.6 : 1,
        }}
      >
        {isLoading ? "處理中..." : "略過，重新同步書籍資料"}
      </button>
    </div>
  );
}
