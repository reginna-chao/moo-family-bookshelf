import { useState, useEffect, useRef, useCallback } from "react";
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
    <div className="moo-public-share__overlay" onClick={onClose}>
      <div className="moo-public-share" onClick={(e) => e.stopPropagation()}>
        <div className="moo-public-share__header">
          <h3 className="moo-public-share__title">公開書櫃分享</h3>
          <button onClick={onClose} className="moo-public-share__icon-btn"><X size={16} /></button>
        </div>

        {errorMsg && <div role="alert" className="moo-public-share__error">{errorMsg}</div>}

        {viewState === "loading" && <p className="moo-public-share__muted">載入中...</p>}

        {viewState === "error" && !errorMsg && <p className="moo-public-share__muted">載入失敗</p>}

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

/** Shared input chrome; adds the 32px-height mobile modifier when applicable. */
function useInputClass(): string {
  const isMobile = useIsMobile();
  return isMobile
    ? "moo-public-share__input moo-public-share__input--mobile"
    : "moo-public-share__input";
}

interface CreateFormProps {
  title: string; expiresDays: number | null; saving: boolean;
  onTitleChange: (v: string) => void; onExpiresDaysChange: (v: number | null) => void;
  onCreate: () => void;
}

function CreateForm({ title, expiresDays, saving, onTitleChange, onExpiresDaysChange, onCreate }: CreateFormProps) {
  const inputClass = useInputClass();
  return (
    <div className="moo-public-share__form">
      <label className="moo-public-share__field">
        標題
        <input value={title} onChange={(e) => onTitleChange(e.target.value)} maxLength={60} className={inputClass} />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <button onClick={onCreate} disabled={saving || !title.trim()} className="moo-public-share__primary-btn">
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
  const inputClass = useInputClass();
  return (
    <div className="moo-public-share__form">
      <label className="moo-public-share__field">
        標題
        <input value={title} onChange={(e) => onTitleChange(e.target.value)} maxLength={60} className={inputClass} />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <div>
        <p className="moo-public-share__link-label">公開連結</p>
        <div className="moo-public-share__url-row">
          <input value={publicUrl} readOnly className={`${inputClass} moo-public-share__url-input`} />
          <button onClick={onCopy} className="moo-public-share__icon-btn" title="複製連結">
            <Copy size={14} />
          </button>
        </div>
        {copied && <span className="moo-public-share__copied">已複製</span>}
      </div>
      <div className="moo-public-share__actions">
        <button onClick={onResetToken} disabled={saving} className="moo-public-share__secondary-btn">
          <RefreshCw size={12} /> 重設網址
        </button>
        <button onClick={onDelete} disabled={saving} className="moo-public-share__danger-btn">
          <Trash2 size={12} /> 關閉公開分享
        </button>
      </div>
      {confirm && (
        <div className="moo-public-share__confirm">
          <p className="moo-public-share__confirm-text">
            {confirm === "reset" ? "重設網址後，舊連結將立即失效。確定繼續？" : "確定關閉公開分享？公開連結將立即失效。"}
          </p>
          <div className="moo-public-share__confirm-row">
            <button onClick={onConfirmAction} className="moo-public-share__primary-btn">確定</button>
            <button onClick={onCancelConfirm} className="moo-public-share__secondary-btn">取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpiresSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const isMobile = useIsMobile();
  const className = isMobile
    ? "moo-public-share__input moo-public-share__select moo-public-share__select--mobile"
    : "moo-public-share__input moo-public-share__select";
  return (
    <label className="moo-public-share__field">
      過期時間
      <select value={value === null ? "null" : String(value)}
        onChange={(e) => onChange(e.target.value === "null" ? null : Number(e.target.value))}
        className={className}>
        {EXPIRES_OPTIONS.map((opt) => (
          <option key={String(opt.value)} value={opt.value === null ? "null" : String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
