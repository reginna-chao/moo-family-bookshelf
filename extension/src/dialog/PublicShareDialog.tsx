import { useState, useEffect, useRef, type RefObject } from "react";
import { X, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { ApiClient } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useTimedFlag } from "../hooks/useTimedFlag";
import { usePublicShelfActions } from "./usePublicShelfActions";
import { UNSAVED_NOTICE } from "./publicShareMessages";

export interface PublicShareDialogProps {
  userId: string;
  apiClient: ApiClient;
  defaultDisplayName: string;
  /** Override default PWA origin (for self-hosters). Empty string is treated as unset. */
  pwaOrigin?: string;
  onClose: () => void;
}

const EXPIRES_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "60 天", value: 60 },
  { label: "90 天", value: 90 },
  { label: "永久", value: null },
];

/** Focusable descendants, in DOM order, that Tab can reach. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Escape closes the modal (mirrors ManualLendDialog). */
function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);
}

/**
 * Wraps Tab / Shift+Tab inside the modal. `aria-modal="true"` is a hint for
 * assistive tech only — without this the keyboard walks the shelf controls
 * rendered behind the overlay.
 */
function useFocusTrap(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) return;
      const root = container.getRootNode() as Document | ShadowRoot;
      const active = root.activeElement;
      // Focus starts on the container itself (tabIndex=-1), i.e. outside items:
      // Shift+Tab from there must wrap to the last item, not escape the modal.
      const focusIsInside = items.some((el) => el === active);
      const atEdge = e.shiftKey
        ? active === items[0] || !focusIsInside
        : active === items[items.length - 1];
      if (!atEdge) return;
      e.preventDefault();
      const target = e.shiftKey ? items[items.length - 1] : items[0];
      target.focus();
    };
    container.addEventListener("keydown", handler);
    return () => {
      container.removeEventListener("keydown", handler);
    };
  }, [containerRef]);
}

export function PublicShareDialog({
  userId,
  apiClient,
  defaultDisplayName,
  pwaOrigin,
  onClose,
}: PublicShareDialogProps) {
  const {
    viewState,
    shelf,
    title,
    expiresDays,
    errorMsg,
    saving,
    hasUnsavedChanges,
    setTitle,
    setExpiresDays,
    handleCreate,
    handleTitleChange,
    handleExpiresDaysChange,
    handleResetToken,
    handleDelete,
    handleRetrySave,
  } = usePublicShelfActions({ userId, apiClient, defaultDisplayName });
  const [copied, markCopied] = useTimedFlag(2000);
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeToClose(onClose);
  useFocusTrap(dialogRef);

  // Move focus into the modal on open (it renders after the trigger in DOM order,
  // so Tab would otherwise walk the shelf controls first), and restore focus to
  // the opener (公開分享 button) on close. getRootNode() reaches the real focused
  // element inside the shadow tree, where document.activeElement is retargeted.
  useEffect(() => {
    const root = dialogRef.current?.getRootNode();
    const opener =
      root instanceof ShadowRoot || root instanceof Document
        ? root.activeElement
        : null;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  /** Dismiss the confirm box first, then run the action it was guarding. */
  const handleConfirmAction = () => {
    const action = confirm === "reset" ? handleResetToken : handleDelete;
    setConfirm(null);
    void action();
  };

  const handleCopy = async () => {
    if (!shelf) return;
    const url = apiClient.getPublicShelfUrl(shelf.shareToken, pwaOrigin);
    await navigator.clipboard.writeText(url);
    markCopied();
  };

  const publicUrl = shelf
    ? apiClient.getPublicShelfUrl(shelf.shareToken, pwaOrigin)
    : "";

  return (
    <div className="moo-public-share__overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="公開書櫃分享"
        tabIndex={-1}
        className="moo-public-share"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="moo-public-share__header">
          <h3 className="moo-public-share__title">公開書櫃分享</h3>
          <button
            type="button"
            aria-label="關閉"
            onClick={onClose}
            className="moo-button moo-button--ghost-icon moo-public-share__icon-btn"
          >
            <X size={16} />
          </button>
        </div>

        {/* A failed title / expiry write leaves the field diverged from the
            server, so the notice stays until a retry reconciles it. */}
        {(errorMsg || hasUnsavedChanges) && (
          <div role="alert" className="moo-public-share__error">
            {errorMsg || UNSAVED_NOTICE}
            {hasUnsavedChanges && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void handleRetrySave()}
                  disabled={saving}
                  className="moo-button moo-button--ghost moo-button--sm"
                >
                  重試儲存
                </button>
              </>
            )}
          </div>
        )}

        {viewState === "loading" && (
          <p className="moo-public-share__muted">載入中...</p>
        )}

        {viewState === "empty" && (
          <CreateForm
            title={title}
            expiresDays={expiresDays}
            saving={saving}
            onTitleChange={setTitle}
            onExpiresDaysChange={setExpiresDays}
            onCreate={handleCreate}
          />
        )}

        {viewState === "active" && shelf && (
          <ActiveShelf
            title={title}
            expiresDays={expiresDays}
            publicUrl={publicUrl}
            copied={copied}
            saving={saving}
            confirm={confirm}
            onTitleChange={handleTitleChange}
            onExpiresDaysChange={handleExpiresDaysChange}
            onCopy={handleCopy}
            onResetToken={() => setConfirm("reset")}
            onDelete={() => setConfirm("delete")}
            onConfirmAction={handleConfirmAction}
            onCancelConfirm={() => setConfirm(null)}
          />
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
    ? "moo-form-input moo-public-share__input moo-public-share__input--mobile"
    : "moo-form-input moo-public-share__input";
}

interface CreateFormProps {
  title: string;
  expiresDays: number | null;
  saving: boolean;
  onTitleChange: (v: string) => void;
  onExpiresDaysChange: (v: number | null) => void;
  onCreate: () => void;
}

function CreateForm({
  title,
  expiresDays,
  saving,
  onTitleChange,
  onExpiresDaysChange,
  onCreate,
}: CreateFormProps) {
  const inputClass = useInputClass();
  return (
    <div className="moo-public-share__form">
      <label className="moo-public-share__field">
        標題
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          maxLength={60}
          className={inputClass}
        />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <button
        onClick={onCreate}
        disabled={saving || !title.trim()}
        className="moo-button moo-button--sm moo-public-share__primary-btn"
      >
        {saving ? "建立中..." : "啟用公開書櫃"}
      </button>
    </div>
  );
}

interface ActiveShelfProps {
  title: string;
  expiresDays: number | null;
  publicUrl: string;
  copied: boolean;
  saving: boolean;
  confirm: "reset" | "delete" | null;
  onTitleChange: (v: string) => void;
  onExpiresDaysChange: (v: number | null) => void;
  onCopy: () => void;
  onResetToken: () => void;
  onDelete: () => void;
  onConfirmAction: () => void;
  onCancelConfirm: () => void;
}

function ActiveShelf({
  title,
  expiresDays,
  publicUrl,
  copied,
  saving,
  confirm,
  onTitleChange,
  onExpiresDaysChange,
  onCopy,
  onResetToken,
  onDelete,
  onConfirmAction,
  onCancelConfirm,
}: ActiveShelfProps) {
  const inputClass = useInputClass();
  return (
    <div className="moo-public-share__form">
      <label className="moo-public-share__field">
        標題
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          maxLength={60}
          className={inputClass}
        />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <div>
        <p className="moo-public-share__link-label">公開連結</p>
        <div className="moo-public-share__url-row">
          <input
            value={publicUrl}
            readOnly
            className={`${inputClass} moo-public-share__url-input`}
          />
          <button
            onClick={onCopy}
            className="moo-button moo-button--ghost-icon moo-public-share__icon-btn"
            title="複製連結"
          >
            <Copy size={14} />
          </button>
        </div>
        {copied && <span className="moo-public-share__copied">已複製</span>}
      </div>
      <div className="moo-public-share__actions">
        <button
          onClick={onResetToken}
          disabled={saving}
          className="moo-button moo-button--ghost moo-button--sm moo-public-share__secondary-btn"
        >
          <RefreshCw size={12} /> 重設網址
        </button>
        <button
          onClick={onDelete}
          disabled={saving}
          className="moo-button moo-button--outline-danger moo-button--sm moo-public-share__danger-btn"
        >
          <Trash2 size={12} /> 關閉公開分享
        </button>
      </div>
      {confirm && (
        <div className="moo-public-share__confirm">
          <p className="moo-public-share__confirm-text">
            {confirm === "reset"
              ? "重設網址後，舊連結將立即失效。確定繼續？"
              : "確定關閉公開分享？公開連結將立即失效。"}
          </p>
          <div className="moo-public-share__confirm-row">
            <button
              onClick={onConfirmAction}
              className="moo-button moo-button--sm moo-public-share__primary-btn"
            >
              確定
            </button>
            <button
              onClick={onCancelConfirm}
              className="moo-button moo-button--ghost moo-button--sm moo-public-share__secondary-btn"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpiresSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const isMobile = useIsMobile();
  const className = isMobile
    ? "moo-form-input moo-form-input--select moo-public-share__input moo-public-share__select moo-public-share__select--mobile"
    : "moo-form-input moo-form-input--select moo-public-share__input moo-public-share__select";
  return (
    <label className="moo-public-share__field">
      過期時間
      <select
        value={value === null ? "null" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "null" ? null : Number(e.target.value))
        }
        className={className}
      >
        {EXPIRES_OPTIONS.map((opt) => (
          <option
            key={String(opt.value)}
            value={opt.value === null ? "null" : String(opt.value)}
          >
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
