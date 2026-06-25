import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { X, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { ApiClient } from "../api/client";
import type { PublicShelf } from "../api/types";
import { useIsMobile } from "../hooks/useIsMobile";

export interface PublicShareDialogProps {
  userId: string;
  apiClient: ApiClient;
  defaultDisplayName: string;
  /** Override default PWA origin (for self-hosters). Empty string is treated as unset. */
  pwaOrigin?: string;
  onClose: () => void;
}

type ViewState = "loading" | "empty" | "active" | "error";

const EXPIRES_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "60 天", value: 60 },
  { label: "90 天", value: 90 },
  { label: "永久", value: null },
];

export function PublicShareDialog({
  userId, apiClient, defaultDisplayName, pwaOrigin, onClose,
}: PublicShareDialogProps) {
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [shelf, setShelf] = useState<PublicShelf | null>(null);
  const [title, setTitle] = useState("");
  const [expiresDays, setExpiresDays] = useState<number | null>(30);
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadShelves = useCallback(async () => {
    setViewState("loading");
    try {
      const { shelves } = await apiClient.listPublicShelves(userId);
      if (shelves.length > 0) {
        setShelf(shelves[0]);
        setTitle(shelves[0].title);
        setExpiresDays(shelves[0].expiresDays);
        setViewState("active");
      } else {
        setTitle(`${defaultDisplayName} 的公開書櫃`);
        setViewState("empty");
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "載入失敗");
      setViewState("error");
    }
  }, [userId, apiClient, defaultDisplayName]);

  useEffect(() => { void loadShelves(); }, [loadShelves]);

  const handleCreate = async () => {
    setSaving(true);
    setErrorMsg("");
    try {
      const { shelf: created } = await apiClient.createPublicShelf(userId, { title, expiresDays });
      setShelf(created);
      setTitle(created.title);
      setExpiresDays(created.expiresDays);
      setViewState("active");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "建立失敗");
    } finally {
      setSaving(false);
    }
  };

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    if (!shelf) return;
    clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(async () => {
      try {
        const { shelf: updated } = await apiClient.updatePublicShelf(userId, shelf.shelfId, { title: newTitle });
        setShelf(updated);
      } catch { /* title sync failure is non-critical */ }
    }, 1000);
  };

  const handleExpiresDaysChange = async (value: number | null) => {
    setExpiresDays(value);
    if (!shelf) return;
    try {
      const { shelf: updated } = await apiClient.updatePublicShelf(userId, shelf.shelfId, { expiresDays: value });
      setShelf(updated);
    } catch { /* non-critical */ }
  };

  const handleResetToken = async () => {
    if (!shelf) return;
    setConfirm(null);
    setSaving(true);
    try {
      const { shelf: updated } = await apiClient.resetPublicShelfToken(userId, shelf.shelfId);
      setShelf(updated);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "重設失敗");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!shelf) return;
    setConfirm(null);
    setSaving(true);
    try {
      await apiClient.deletePublicShelf(userId, shelf.shelfId);
      setShelf(null);
      setTitle(`${defaultDisplayName} 的公開書櫃`);
      setExpiresDays(30);
      setViewState("empty");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "關閉失敗");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!shelf) return;
    const url = apiClient.getPublicShelfUrl(shelf.shareToken, pwaOrigin);
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const publicUrl = shelf ? apiClient.getPublicShelfUrl(shelf.shareToken, pwaOrigin) : "";

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>公開書櫃分享</h3>
          <button onClick={onClose} style={iconBtnStyle}><X size={16} /></button>
        </div>

        {errorMsg && <div role="alert" style={errorStyle}>{errorMsg}</div>}

        {viewState === "loading" && <p style={muted}>載入中...</p>}

        {viewState === "error" && !errorMsg && <p style={muted}>載入失敗</p>}

        {viewState === "empty" && (
          <CreateForm title={title} expiresDays={expiresDays} saving={saving}
            onTitleChange={setTitle} onExpiresDaysChange={setExpiresDays} onCreate={handleCreate} />
        )}

        {viewState === "active" && shelf && (
          <ActiveShelf title={title} expiresDays={expiresDays} publicUrl={publicUrl}
            copied={copied} saving={saving} confirm={confirm}
            onTitleChange={handleTitleChange} onExpiresDaysChange={handleExpiresDaysChange}
            onCopy={handleCopy} onResetToken={() => setConfirm("reset")} onDelete={() => setConfirm("delete")}
            onConfirmAction={confirm === "reset" ? handleResetToken : handleDelete}
            onCancelConfirm={() => setConfirm(null)} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

interface CreateFormProps {
  title: string; expiresDays: number | null; saving: boolean;
  onTitleChange: (v: string) => void; onExpiresDaysChange: (v: number | null) => void;
  onCreate: () => void;
}

function CreateForm({ title, expiresDays, saving, onTitleChange, onExpiresDaysChange, onCreate }: CreateFormProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={labelStyle}>
        標題
        <input value={title} onChange={(e) => onTitleChange(e.target.value)} maxLength={60} style={inputStyle} />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <button onClick={onCreate} disabled={saving || !title.trim()} style={primaryBtnStyle}>
        {saving ? "建立中..." : "啟用公開書櫃"}
      </button>
    </div>
  );
}

interface ActiveShelfProps {
  title: string; expiresDays: number | null; publicUrl: string;
  copied: boolean; saving: boolean; confirm: "reset" | "delete" | null;
  onTitleChange: (v: string) => void; onExpiresDaysChange: (v: number | null) => void;
  onCopy: () => void; onResetToken: () => void; onDelete: () => void;
  onConfirmAction: () => void; onCancelConfirm: () => void;
}

function ActiveShelf({
  title, expiresDays, publicUrl, copied, saving, confirm,
  onTitleChange, onExpiresDaysChange, onCopy, onResetToken, onDelete,
  onConfirmAction, onCancelConfirm,
}: ActiveShelfProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={labelStyle}>
        標題
        <input value={title} onChange={(e) => onTitleChange(e.target.value)} maxLength={60} style={inputStyle} />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <div>
        <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 4px" }}>公開連結</p>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={publicUrl} readOnly style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
          <button onClick={onCopy} style={iconBtnStyle} title="複製連結">
            <Copy size={14} />
          </button>
        </div>
        {copied && <span style={{ fontSize: 11, color: "#16a34a" }}>已複製</span>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onResetToken} disabled={saving} style={secondaryBtnStyle}>
          <RefreshCw size={12} /> 重設網址
        </button>
        <button onClick={onDelete} disabled={saving} style={dangerBtnStyle}>
          <Trash2 size={12} /> 關閉公開分享
        </button>
      </div>
      {confirm && (
        <div style={confirmBoxStyle}>
          <p style={{ margin: 0, fontSize: 13 }}>
            {confirm === "reset" ? "重設網址後，舊連結將立即失效。確定繼續？" : "確定關閉公開分享？公開連結將立即失效。"}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={onConfirmAction} style={primaryBtnStyle}>確定</button>
            <button onClick={onCancelConfirm} style={secondaryBtnStyle}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpiresSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const isMobile = useIsMobile();
  return (
    <label style={labelStyle}>
      過期時間
      <select value={value === null ? "null" : String(value)}
        onChange={(e) => onChange(e.target.value === "null" ? null : Number(e.target.value))}
        className="moo-form-select"
        style={{ ...inputStyle, paddingRight: "2.25rem", ...(isMobile ? { padding: "4px 10px", paddingRight: "2.25rem" } : {}) }}>
        {EXPIRES_OPTIONS.map((opt) => (
          <option key={String(opt.value)} value={opt.value === null ? "null" : String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── Styles ────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
};
const dialogStyle: CSSProperties = {
  background: "#fff", borderRadius: 12, padding: 20, width: 360,
  maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
};
const headerStyle: CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16,
};
const labelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 500 };
const inputStyle: CSSProperties = {
  padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, outline: "none",
};
const iconBtnStyle: CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 4, color: "#475569", display: "flex",
};
const primaryBtnStyle: CSSProperties = {
  padding: "8px 14px", background: "#2563eb", color: "#fff", border: "none",
  borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer",
};
const secondaryBtnStyle: CSSProperties = {
  padding: "6px 12px", background: "transparent", border: "1px solid #cbd5e1",
  borderRadius: 6, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
};
const dangerBtnStyle: CSSProperties = {
  padding: "6px 12px", background: "transparent", border: "1px solid #fca5a5", color: "#dc2626",
  borderRadius: 6, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
};
const errorStyle: CSSProperties = {
  background: "#fef2f2", color: "#dc2626", padding: "8px 12px", borderRadius: 6, fontSize: 13, marginBottom: 12,
};
const muted: CSSProperties = { color: "#94a3b8", textAlign: "center", padding: 16 };
const confirmBoxStyle: CSSProperties = {
  background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 8, padding: 12,
};
