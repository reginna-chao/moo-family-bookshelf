import { type CSSProperties, useEffect } from "react";
import { X } from "lucide-react";
import type { ReadmooMember } from "../content/readmoo-lend";

export interface ReadmooMemberPickerProps {
  /** Display name of the MooFamily borrower whose readmooName we are picking. */
  borrowerName: string;
  /** Member options scraped from the Readmoo 「借出書籍」 dialog. */
  options: ReadmooMember[];
  /** True while the PATCH that persists the chosen readmooName is in flight. */
  saving: boolean;
  /** Last PATCH error (null when no error to surface). */
  errorMessage: string | null;
  onPick: (member: ReadmooMember) => void;
  onCancel: () => void;
}

/**
 * Modal asking the owner to associate the MooFamily borrower with one of the
 * Readmoo lending dialog's options. Stays open across the PATCH so retry is
 * possible if the network call fails.
 *
 * Renders inline (not via portal) so it is hosted inside the same Shadow DOM
 * as the rest of the dialog UI.
 */
export function ReadmooMemberPicker({
  borrowerName,
  options,
  saving,
  errorMessage,
  onPick,
  onCancel,
}: ReadmooMemberPickerProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [onCancel, saving]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="選擇讀墨家庭成員"
      style={overlayStyle}
    >
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <h3 style={titleStyle}>
            請選擇「{borrowerName}」對應的讀墨家庭成員
          </h3>
          <button
            type="button"
            aria-label="關閉"
            onClick={onCancel}
            disabled={saving}
            style={closeBtnStyle}
          >
            <X size={16} />
          </button>
        </div>
        <p style={helpStyle}>
          選擇後將自動記錄此對應關係，下次借出時不再詢問。
        </p>
        {errorMessage && (
          <div role="alert" style={errorStyle}>
            {errorMessage}
          </div>
        )}
        {options.length === 0 ? (
          <div style={emptyStyle}>讀墨清單中沒有可選的家庭成員。</div>
        ) : (
          <ul style={listStyle}>
            {options.map((member) => (
              <li key={member.name}>
                <button
                  type="button"
                  onClick={() => onPick(member)}
                  disabled={saving}
                  style={itemBtnStyle}
                >
                  {member.avatar && (
                    <img
                      src={member.avatar}
                      alt=""
                      width={32}
                      height={32}
                      style={avatarStyle}
                    />
                  )}
                  <span style={nameStyle}>{member.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div style={footerStyle}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={cancelBtnStyle}
          >
            {saving ? "處理中..." : "取消"}
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
const helpStyle: CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  margin: "0 0 12px",
  lineHeight: 1.5,
};
const errorStyle: CSSProperties = {
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 12,
  marginBottom: 12,
};
const emptyStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 13,
  textAlign: "center",
  padding: 12,
};
const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const itemBtnStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  cursor: "pointer",
  fontSize: 14,
  textAlign: "left",
};
const avatarStyle: CSSProperties = {
  borderRadius: "50%",
  flexShrink: 0,
  objectFit: "cover",
};
const nameStyle: CSSProperties = {
  fontWeight: 600,
  color: "#1e293b",
};
const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: 14,
};
const cancelBtnStyle: CSSProperties = {
  padding: "6px 14px",
  background: "transparent",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
};
