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
        在此瀏覽器找不到加密金鑰，無法自動還原個人分享設定（哪些書公開／不公開）。
        若您有另一台裝置可存取，建議先複製同步碼再繼續。
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
        輸入同步碼，保留書架設定
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
