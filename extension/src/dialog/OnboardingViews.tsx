import React, { useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { decodeSyncCode } from "../crypto/syncCode";

// --- WelcomeView ---

export interface WelcomeViewProps {
  onStart: () => void;
  hasUsedBefore?: boolean;
}

export function WelcomeView({ onStart, hasUsedBefore }: WelcomeViewProps) {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        歡迎使用家庭書櫃
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        {hasUsedBefore
          ? "偵測到你曾使用過家庭書櫃，請重新設定以繼續。"
          : "一鍵開始，自動同步你的讀墨帳號與書單。"}
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
        {hasUsedBefore ? "繼續使用" : "開始使用"}
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
  const [showCode, setShowCode] = useState(false);

  let displayFamilyId = "";
  let displayKey = "";
  let displayHostSuffix = "";
  let decodeFailed = false;
  try {
    const decoded = decodeSyncCode(generatedSyncCode);
    displayFamilyId = decoded.familyId;
    displayKey = decoded.encryptionKey;
    if (decoded.apiHost) {
      displayHostSuffix = `@${decoded.apiHost}`;
    }
  } catch {
    decodeFailed = true;
  }

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
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span data-testid="sync-code" style={{ flex: 1, wordBreak: "break-all", fontSize: 13, fontFamily: "monospace" }}>
          {decodeFailed
            ? generatedSyncCode
            : `moo-${displayFamilyId}-${showCode ? displayKey : "••••••••••••"}${displayHostSuffix}`}
        </span>
        {!decodeFailed && (
          <button
            onClick={() => setShowCode(!showCode)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 4, flexShrink: 0 }}
            aria-label={showCode ? "隱藏同步碼" : "顯示同步碼"}
          >
            {showCode ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
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
  const [showInput, setShowInput] = useState(false);

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
      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          type={showInput ? "text" : "password"}
          autoComplete="off"
          placeholder="輸入家庭同步碼"
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
          style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 4 }}
          aria-label={showInput ? "隱藏同步碼" : "顯示同步碼"}
        >
          {showInput ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
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
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 16, textAlign: "center" }}>
        <Lock size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
        本工具採端對端加密，伺服器無法讀取你的資料。
      </p>
    </div>
  );
}
