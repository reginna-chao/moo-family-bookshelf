import React from "react";
import { Lock } from "lucide-react";

// --- WelcomeView ---

export interface WelcomeViewProps {
  onStart: () => void;
}

export function WelcomeView({ onStart }: WelcomeViewProps) {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        歡迎使用家庭書櫃
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        一鍵開始，自動同步你的讀墨帳號與書單。
      </p>
      <button
        onClick={onStart}
        style={{
          width: "100%",
          padding: 14,
          border: "none",
          borderRadius: 8,
          background: "#2563eb",
          color: "white",
          fontWeight: 600,
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        開始使用
      </button>
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 16, textAlign: "center" }}>
        我們僅讀取你的帳號信箱用於生成匿名識別碼，信箱不會上傳至伺服器。
      </p>
    </div>
  );
}

// --- CreatedView ---

export interface CreatedViewProps {
  generatedSyncCode: string;
  copied: boolean;
  onCopy: () => void;
  onContinue: () => void;
}

export function CreatedView({ generatedSyncCode, copied, onCopy, onContinue }: CreatedViewProps) {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        家庭公開書櫃已建立
      </h2>
      <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14 }}>
        將以下同步碼分享給家人，他們可以用此代碼加入你的公開書櫃。
      </p>
      <div
        style={{
          padding: 12,
          background: "#f8fafc",
          borderRadius: 8,
          marginBottom: 12,
          wordBreak: "break-all",
          fontSize: 13,
          fontFamily: "monospace",
        }}
      >
        {generatedSyncCode}
      </div>
      <button
        onClick={onCopy}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "1px solid #2563eb",
          borderRadius: 8,
          background: copied ? "#eff6ff" : "transparent",
          color: "#2563eb",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {copied ? "已複製" : "複製同步碼"}
      </button>
      <button
        onClick={onContinue}
        style={{
          width: "100%",
          padding: 12,
          border: "none",
          borderRadius: 8,
          background: "#2563eb",
          color: "white",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        繼續
      </button>
    </div>
  );
}

// --- ErrorView ---

export interface ErrorViewProps {
  errorMessage: string;
  onRetry: () => void;
}

export function ErrorView({ errorMessage, onRetry }: ErrorViewProps) {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: "#ef4444" }}>
        發生錯誤
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        {errorMessage}
      </p>
      <button
        onClick={onRetry}
        style={{
          width: "100%",
          padding: 12,
          border: "none",
          borderRadius: 8,
          background: "#2563eb",
          color: "white",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        重試
      </button>
    </div>
  );
}

// --- IdleView ---

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
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        歡迎使用家庭書櫃
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        建立或加入家庭公開書櫃，與家人分享你的藏書。
      </p>
      <button
        onClick={onCreate}
        disabled={isProcessing}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "none",
          borderRadius: 8,
          background: isProcessing ? "#93c5fd" : "#2563eb",
          color: "white",
          fontWeight: 600,
          cursor: isProcessing ? "not-allowed" : "pointer",
        }}
      >
        {state === "creating" ? "建立中..." : "建立家庭公開書櫃"}
      </button>
      <div style={{ textAlign: "center", margin: "12px 0", color: "#94a3b8" }}>
        或
      </div>
      <input
        type="text"
        placeholder="輸入家庭同步碼"
        value={syncCodeInput}
        onChange={(e) => onSetSyncCodeInput(e.target.value)}
        disabled={isProcessing}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          marginBottom: 12,
          boxSizing: "border-box",
          fontSize: 14,
        }}
      />
      <button
        onClick={onJoin}
        disabled={!syncCodeInput.trim() || isProcessing}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #2563eb",
          borderRadius: 8,
          background: "transparent",
          color: "#2563eb",
          fontWeight: 600,
          cursor: !syncCodeInput.trim() || isProcessing ? "not-allowed" : "pointer",
          opacity: !syncCodeInput.trim() || isProcessing ? 0.5 : 1,
        }}
      >
        {state === "joining" ? "加入中..." : "加入家庭公開書櫃"}
      </button>
      <p style={{ color: "#94a3b8", fontSize: 11, marginTop: 16, textAlign: "center" }}>
        <Lock size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
        本工具採端對端加密，伺服器無法讀取你的資料。
      </p>
    </div>
  );
}
