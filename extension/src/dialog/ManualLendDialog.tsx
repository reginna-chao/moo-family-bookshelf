import { type CSSProperties, useEffect } from "react";
import { X } from "lucide-react";

export interface ManualLendDialogProps {
  dontRemindChecked: boolean;
  onDontRemindChange: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}

export function ManualLendDialog({
  dontRemindChecked,
  onDontRemindChange,
  onConfirm,
  onCancel,
  confirming = false,
}: ManualLendDialogProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirming) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [onCancel, confirming]);

  return (
    <div role="dialog" aria-modal="true" aria-label="手動借出提醒" style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <h3 style={titleStyle}>手動借出提醒</h3>
          <button
            type="button"
            aria-label="關閉"
            onClick={onCancel}
            disabled={confirming}
            style={closeBtnStyle}
          >
            <X size={16} />
          </button>
        </div>

        <p style={bodyStyle}>
          此操作後將會通知對方已借出，但需要手動方式完成借書流程。
        </p>
        <p style={bodyStyle}>
          請自行前往讀墨網頁或 APP，從『我的書櫃』找到此書並手動借出給對方。
        </p>

        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={dontRemindChecked}
            onChange={(e) => onDontRemindChange(e.target.checked)}
            style={checkboxStyle}
          />
          <span style={checkboxTextStyle}>不再顯示此通知</span>
        </label>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            style={cancelBtnStyle}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            style={{
              ...confirmBtnStyle,
              opacity: confirming ? 0.5 : 1,
              cursor: confirming ? "not-allowed" : "pointer",
            }}
          >
            {confirming ? "處理中..." : "確認借出"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
};

const dialogStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 20,
  width: 320,
  maxHeight: "80vh",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 8,
  marginBottom: 12,
};

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  lineHeight: 1.4,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 4,
  color: "#475569",
  flexShrink: 0,
};

const bodyStyle: CSSProperties = {
  fontSize: 12,
  color: "#475569",
  margin: "0 0 8px",
  lineHeight: 1.6,
};

const checkboxLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "12px 0 16px",
  cursor: "pointer",
};

const checkboxStyle: CSSProperties = {
  width: 16,
  height: 16,
  margin: 0,
  flexShrink: 0,
};

const checkboxTextStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const cancelBtnStyle: CSSProperties = {
  padding: "6px 14px",
  background: "transparent",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  color: "#475569",
};

const confirmBtnStyle: CSSProperties = {
  padding: "6px 14px",
  background: "#2563eb",
  border: "1px solid #2563eb",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "white",
  cursor: "pointer",
};
