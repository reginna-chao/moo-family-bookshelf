import { useState } from "react";
import { X, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { useTimedFlag } from "@/hooks/useTimedFlag";
import { usePublicShelfActions } from "@/hooks/usePublicShelfActions";
import { UNSAVED_NOTICE } from "@/utils/publicShareMessages";

export interface PublicShareDialogProps {
  userId: string;
  apiClient: ApiClient;
  defaultDisplayName: string;
  onClose: () => void;
}

const EXPIRES_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "60 天", value: 60 },
  { label: "90 天", value: 90 },
  { label: "永久", value: null },
];

export function PublicShareDialog({
  userId,
  apiClient,
  defaultDisplayName,
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

  /** Dismiss the confirm box first, then run the action it was guarding. */
  const handleConfirmAction = () => {
    const action = confirm === "reset" ? handleResetToken : handleDelete;
    setConfirm(null);
    void action();
  };

  const handleCopy = async () => {
    if (!shelf) return;
    await navigator.clipboard.writeText(
      `${window.location.origin}/public/${shelf.shareToken}`,
    );
    markCopied();
  };

  const publicUrl = shelf
    ? `${window.location.origin}/public/${shelf.shareToken}`
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl w-full max-w-sm mx-4 max-h-[80vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 className="text-base font-semibold">公開書櫃分享</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {/* A failed title / expiry write leaves the field diverged from the
              server, so the notice stays until a retry reconciles it. */}
          {(errorMsg || hasUnsavedChanges) && (
            <div
              role="alert"
              className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg flex items-center justify-between gap-2"
            >
              <span>{errorMsg || UNSAVED_NOTICE}</span>
              {hasUnsavedChanges && (
                <button
                  type="button"
                  onClick={() => void handleRetrySave()}
                  disabled={saving}
                  className="shrink-0 px-2 py-1 border border-red-300 rounded-md text-xs font-medium disabled:opacity-50"
                >
                  重試儲存
                </button>
              )}
            </div>
          )}

          {viewState === "loading" && (
            <p className="text-center text-gray-400 py-4">載入中...</p>
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
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
      過期時間
      <select
        value={value === null ? "null" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "null" ? null : Number(e.target.value))
        }
        className="moo-form-select rounded-lg border border-gray-300 pl-3 pr-9 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
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
  return (
    <>
      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        標題
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          maxLength={60}
          className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />
      <button
        onClick={onCreate}
        disabled={saving || !title.trim()}
        className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "建立中..." : "啟用公開書櫃"}
      </button>
    </>
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
  return (
    <>
      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        標題
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          maxLength={60}
          className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />
      </label>
      <ExpiresSelect value={expiresDays} onChange={onExpiresDaysChange} />

      <div>
        <p className="text-xs text-gray-500 mb-1">公開連結</p>
        <div className="flex gap-2 items-center">
          <input
            value={publicUrl}
            readOnly
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 bg-gray-50 outline-none"
          />
          <button
            onClick={onCopy}
            className="p-2 text-gray-500 hover:text-blue-600"
            title="複製連結"
          >
            <Copy size={16} />
          </button>
        </div>
        {copied && (
          <span className="text-xs text-green-600 mt-0.5">已複製</span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onResetToken}
          disabled={saving}
          className="flex-1 flex items-center justify-center gap-1 py-2 text-xs border border-gray-300 rounded-lg text-gray-600 disabled:opacity-50"
        >
          <RefreshCw size={12} /> 重設網址
        </button>
        <button
          onClick={onDelete}
          disabled={saving}
          className="flex-1 flex items-center justify-center gap-1 py-2 text-xs border border-red-200 rounded-lg text-red-500 disabled:opacity-50"
        >
          <Trash2 size={12} /> 關閉公開分享
        </button>
      </div>

      {confirm && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
          <p className="text-sm text-gray-700">
            {confirm === "reset"
              ? "重設網址後，舊連結將立即失效。確定繼續？"
              : "確定關閉公開分享？公開連結將立即失效。"}
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={onConfirmAction}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium"
            >
              確定
            </button>
            <button
              onClick={onCancelConfirm}
              className="px-4 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-600"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
}
