import { Smartphone, Loader2, RefreshCw } from "lucide-react";
import type { ApiClient } from "../api/client";
import { useQrLinkState, QR_BOX_SIZE, type QrState } from "./useQrLinkState";

interface QrCodeLinkProps {
  syncCode: string;
  userId: string;
  apiClient: ApiClient;
}

const PATTERN_SIZE = 13;

function BlurQrPlaceholder({ variant }: { variant?: "default" | "error" }) {
  const fillColor = variant === "error" ? "#fca5a5" : "#1e293b";
  const cells = Array.from({ length: PATTERN_SIZE * PATTERN_SIZE }, (_, i) => {
    const filled = ((i * 17 + (i >> 2) * 13) & 3) < 2;
    return (
      <div key={i} style={{ background: filled ? fillColor : "#f1f5f9" }} />
    );
  });
  return (
    <div
      aria-hidden="true"
      className="moo-qr-link__placeholder"
      style={{
        width: QR_BOX_SIZE,
        height: QR_BOX_SIZE,
        gridTemplateColumns: `repeat(${PATTERN_SIZE}, 1fr)`,
        gridTemplateRows: `repeat(${PATTERN_SIZE}, 1fr)`,
      }}
    >
      {cells}
    </div>
  );
}

function QrBoxOverlay({
  state,
}: {
  state: Exclude<QrState, { kind: "active" }>;
}) {
  if (state.kind === "idle") {
    return (
      <>
        <Smartphone size={28} style={{ color: "#1e293b" }} />
        <div className="moo-qr-link__cta">點擊產生 QR Code</div>
      </>
    );
  }
  if (state.kind === "loading") {
    return (
      <>
        <Loader2
          size={28}
          style={{
            color: "#64748b",
            animation: "qrLinkSpin 1s linear infinite",
          }}
        />
        <div className="moo-qr-link__cta">產生中…</div>
      </>
    );
  }
  if (state.kind === "expired") {
    return (
      <>
        <div className="moo-qr-link__cta moo-qr-link__cta--spaced">
          QR Code 已過期
        </div>
        <div className="moo-button moo-button--outline moo-button--sm moo-qr-link__regen">
          <RefreshCw size={14} />
          重新產生
        </div>
      </>
    );
  }
  return (
    <>
      <div className="moo-qr-link__cta moo-qr-link__cta--error">
        {state.message}
      </div>
      <div className="moo-button moo-button--outline moo-button--sm moo-qr-link__regen">
        <RefreshCw size={14} />
        重試
      </div>
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
  const className = isLoading
    ? "moo-qr-link__button moo-qr-link__button--loading"
    : "moo-qr-link__button";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      aria-disabled={isLoading}
      aria-label={ariaLabelForState(state)}
      className={className}
      style={{ width: QR_BOX_SIZE, height: QR_BOX_SIZE }}
    >
      <BlurQrPlaceholder
        variant={state.kind === "error" ? "error" : "default"}
      />
      <div className="moo-qr-link__overlay">
        <QrBoxOverlay state={state} />
      </div>
    </button>
  );
}

export function QrCodeLink({ syncCode, userId, apiClient }: QrCodeLinkProps) {
  const { state, copied, onRevealClick, onCopyClick } = useQrLinkState({
    syncCode,
    userId,
    apiClient,
  });
  const isLoading = state.kind === "loading";

  const copyClassName = copied
    ? "moo-button moo-button--outline moo-qr-link__copy-btn moo-qr-link__copy-btn--copied"
    : "moo-button moo-button--outline moo-qr-link__copy-btn";

  return (
    <div className="moo-qr-link">
      {/* Keyframes rendered in-tree so they resolve inside the shadow root
          (CSS @keyframes are tree-scoped; head-injected ones don't apply). */}
      <style>{"@keyframes qrLinkSpin{to{transform:rotate(360deg)}}"}</style>
      <div className="moo-qr-link__label">連結手機</div>

      <div className="moo-qr-link__box">
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
        className={copyClassName}
      >
        {copied ? "已複製" : "複製連結"}
      </button>

      <div className="moo-qr-link__hint">
        用手機掃描 QR Code 或複製連結，即可在行動裝置上使用墨家書櫃
      </div>
      <div className="moo-qr-link__hint moo-qr-link__hint--small">
        QR Code 5 分鐘後將自動過期，過期後可重新產生
      </div>
    </div>
  );
}
