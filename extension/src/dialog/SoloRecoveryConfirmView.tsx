import React from "react";
import { PRIMARY_BLUE } from "./OnboardingViews";

const INFO_BLUE = "#1e40af";
const INFO_BG = "#dbeafe";

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
          background: INFO_BG,
          color: INFO_BLUE,
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        將以目前的讀墨帳號重新同步書籍資料。
        您先前的分享設定（哪些書公開）會自動保留。
      </div>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 13, lineHeight: 1.6 }}>
        同步完成後即可查看家庭書架。
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
        返回
      </button>
    </div>
  );
}
