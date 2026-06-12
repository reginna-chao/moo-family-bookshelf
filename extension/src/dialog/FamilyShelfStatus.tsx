export interface FamilyShelfErrorProps {
  message: string;
  onRetry: () => void;
}

/** Error state for the family shelf, with a retry button. */
export function FamilyShelfError({ message, onRetry }: FamilyShelfErrorProps) {
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>
        {message}
      </p>
      <button
        onClick={onRetry}
        style={{
          padding: "8px 16px",
          border: "1px solid #2563eb",
          borderRadius: 8,
          background: "transparent",
          color: "#2563eb",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        重試
      </button>
    </div>
  );
}

/** Empty state shown when no family member has shared any book. */
export function FamilyShelfEmpty() {
  return (
    <div style={{ padding: 16, textAlign: "center" }}>
      <p style={{ color: "#94a3b8", marginTop: 16 }}>尚無家人分享書籍</p>
      <p style={{ color: "#cbd5e1", fontSize: 13, marginTop: 8 }}>
        家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
      </p>
    </div>
  );
}
