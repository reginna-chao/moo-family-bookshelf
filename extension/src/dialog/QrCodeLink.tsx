import React from "react";
import { Smartphone, Loader2, RefreshCw } from "lucide-react";
import type { ApiClient } from "../api/client";
import { useQrLinkState, QR_BOX_SIZE, type QrState } from "./useQrLinkState";

interface QrCodeLinkProps {
  syncCode: string;
  userId: string;
  apiClient: ApiClient;
}

const PATTERN_SIZE = 13;
const SPIN_KEYFRAME_ID = "qr-link-spin-kf";

// Inject spinner keyframe once per module load (idempotent, SSR-safe).
if (typeof document !== "undefined" && !document.getElementById(SPIN_KEYFRAME_ID)) {
  const s = document.createElement("style");
  s.id = SPIN_KEYFRAME_ID;
  s.textContent = "@keyframes qrLinkSpin{to{transform:rotate(360deg)}}";
  document.head.appendChild(s);
}

const ctaTextStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.92)", padding: "4px 12px", borderRadius: 6,
  fontWeight: 600, fontSize: 14, color: "#1e293b",
};
const regenButtonStyle: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #2563eb", borderRadius: 6,
  background: "#fff", color: "#2563eb", fontWeight: 600, fontSize: 13,
  display: "flex", alignItems: "center", gap: 6,
};

function BlurQrPlaceholder({ variant }: { variant?: "default" | "error" }) {
  const fillColor = variant === "error" ? "#fca5a5" : "#1e293b";
  const cells = Array.from({ length: PATTERN_SIZE * PATTERN_SIZE }, (_, i) => {
    const filled = ((i * 17 + (i >> 2) * 13) & 3) < 2;
    return <div key={i} style={{ background: filled ? fillColor : "#f1f5f9" }} />;
  });
  return (
    <div
      aria-hidden="true"
      style={{
        width: QR_BOX_SIZE, height: QR_BOX_SIZE, display: "grid",
        gridTemplateColumns: `repeat(${PATTERN_SIZE}, 1fr)`,
        gridTemplateRows: `repeat(${PATTERN_SIZE}, 1fr)`,
        filter: "blur(8px)",
      }}
    >
      {cells}
    </div>
  );
}

function QrBoxOverlay({ state }: { state: Exclude<QrState, { kind: "active" }> }) {
  if (state.kind === "idle") {
    return (
      <>
        <Smartphone size={28} style={{ color: "#1e293b" }} />
        <div style={ctaTextStyle}>點擊產生 QR Code</div>
      </>
    );
  }
  if (state.kind === "loading") {
    return (
      <>
        <Loader2 size={28} style={{ color: "#64748b", animation: "qrLinkSpin 1s linear infinite" }} />
        <div style={ctaTextStyle}>產生中…</div>
      </>
    );
  }
  if (state.kind === "expired") {
    return (
      <>
        <div style={{ ...ctaTextStyle, marginBottom: 4 }}>QR Code 已過期</div>
        <div style={regenButtonStyle}><RefreshCw size={14} />重新產生</div>
      </>
    );
  }
  return (
    <>
      <div style={{ ...ctaTextStyle, color: "#b91c1c", maxWidth: 180, textAlign: "center" }}>
        {state.message}
      </div>
      <div style={regenButtonStyle}><RefreshCw size={14} />重試</div>
    </>
  );
}

function ariaLabelForState(state: QrState): string {
  if (state.kind === "loading") return "QR Code 產生中";
  if (state.kind === "expired") return "重新產生 QR Code";
  if (state.kind === "error") return "重試產生 QR Code";
  return "產生 QR Code";
}

interface QrBoxButtonProps {
  state: Exclude<QrState, { kind: "active" }>;
  onClick: () => void;
}

function QrBoxButton({ state, onClick }: QrBoxButtonProps) {
  const isLoading = state.kind === "loading";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      aria-disabled={isLoading}
      aria-label={ariaLabelForState(state)}
      style={{
        position: "relative", width: QR_BOX_SIZE, height: QR_BOX_SIZE,
        border: "none", padding: 0, background: "transparent",
        cursor: isLoading ? "wait" : "pointer",
      }}
    >
      <BlurQrPlaceholder variant={state.kind === "error" ? "error" : "default"} />
      <div
        style={{
          position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 8,
        }}
      >
        <QrBoxOverlay state={state} />
      </div>
    </button>
  );
}

export function QrCodeLink({ syncCode, userId, apiClient }: QrCodeLinkProps) {
  const { state, copied, onRevealClick, onCopyClick } = useQrLinkState({
    syncCode, userId, apiClient,
  });
  const isLoading = state.kind === "loading";

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: "#64748b", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>連結手機</div>

      <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
        {state.kind === "active" ? (
          <img
            src={state.dataUrl}
            alt="掃描此 QR Code 以在手機上開啟墨家書櫃"
            width={QR_BOX_SIZE}
            height={QR_BOX_SIZE}
          />
        ) : (
          <QrBoxButton state={state} onClick={onRevealClick} />
        )}
      </div>

      <button
        onClick={onCopyClick}
        disabled={isLoading}
        aria-disabled={isLoading}
        style={{
          width: "100%", padding: 10, border: "1px solid #2563eb", borderRadius: 8,
          background: copied ? "#eff6ff" : "transparent", color: "#2563eb",
          fontWeight: 600, cursor: isLoading ? "not-allowed" : "pointer",
          opacity: isLoading ? 0.6 : 1, fontSize: 14, marginTop: 8,
        }}
      >
        {copied ? "已複製" : "複製連結"}
      </button>

      <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6, textAlign: "center" }}>
        用手機掃描 QR Code 或複製連結，即可在行動裝置上使用墨家書櫃
      </div>
      <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2, textAlign: "center" }}>
        QR Code 5 分鐘後將自動過期，過期後可重新產生
      </div>
    </div>
  );
}
