import React from "react";
import { PRIMARY_BLUE } from "./OnboardingViews";

const WARNING_AMBER = "#b45309";
const WARNING_BG = "#fef3c7";

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
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        確認重新同步書籍資料？
      </h2>
      <div
        style={{
          padding: 12,
          marginBottom: 16,
          borderRadius: 8,
          background: WARNING_BG,
          color: WARNING_AMBER,
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        ⚠️ 繼續後，先前設定的個人書架分享設定（哪些書公開）將無法還原。
        書籍列表會根據目前讀墨帳號重新同步。
      </div>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        若你另一台裝置仍可使用，建議按「返回」後改用同步碼來保留書架設定。
      </p>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isLoading}
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
          cursor: isLoading ? "not-allowed" : "pointer",
          opacity: isLoading ? 0.6 : 1,
        }}
      >
        {isLoading ? "處理中..." : "確認重新同步"}
      </button>
      <button
        type="button"
        onClick={onBack}
        style={{
          width: "100%",
          padding: 12,
          border: `1px solid ${PRIMARY_BLUE}`,
          borderRadius: 8,
          background: "transparent",
          color: PRIMARY_BLUE,
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        返回，輸入同步碼
      </button>
    </div>
  );
}
