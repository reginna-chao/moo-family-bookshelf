import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { PRIMARY_BLUE } from "./OnboardingViews";

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

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        輸入同步碼
      </h2>
      <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14, lineHeight: 1.6 }}>
        請貼上另一台裝置的家庭同步碼，以還原個人書架設定。
      </p>
      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          type={showInput ? "text" : "password"}
          autoComplete="off"
          placeholder="輸入家庭同步碼"
          aria-label="家庭同步碼"
          value={syncCodeInput}
          onChange={(e) => onSetSyncCodeInput(e.target.value)}
          disabled={isProcessing}
          style={{
            width: "100%",
            padding: 12,
            paddingRight: 40,
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            boxSizing: "border-box",
            fontSize: 14,
          }}
        />
        <button
          type="button"
          onClick={() => setShowInput(!showInput)}
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#94a3b8",
            padding: 4,
          }}
          aria-label={showInput ? "隱藏同步碼" : "顯示同步碼"}
        >
          {showInput ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <button
        type="button"
        onClick={onJoin}
        disabled={disableJoin}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "none",
          borderRadius: 8,
          background: disableJoin ? "#93c5fd" : PRIMARY_BLUE,
          color: "white",
          fontWeight: 600,
          fontSize: 14,
          cursor: disableJoin ? "not-allowed" : "pointer",
          opacity: disableJoin ? 0.6 : 1,
        }}
      >
        {isProcessing ? "加入中..." : "加入並還原書架"}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={isProcessing}
        style={{
          width: "100%",
          padding: 8,
          border: "none",
          background: "transparent",
          color: "#64748b",
          fontWeight: 500,
          fontSize: 13,
          cursor: isProcessing ? "not-allowed" : "pointer",
          textDecoration: "underline",
        }}
      >
        返回
      </button>
    </div>
  );
}
