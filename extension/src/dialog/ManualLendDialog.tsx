import { useEffect } from "react";
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="手動借出提醒"
      className="moo-modal-overlay"
    >
      <div className="moo-modal">
        <div className="moo-modal__header">
          <h3 className="moo-modal__title">手動借出提醒</h3>
          <button
            type="button"
            aria-label="關閉"
            onClick={onCancel}
            disabled={confirming}
            className="moo-button moo-button--ghost-icon moo-modal__close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="moo-manual-lend__body">
          此操作後將會通知對方已借出，但需要手動方式完成借書流程。
        </p>
        <p className="moo-manual-lend__body">
          請自行前往讀墨網頁或 APP，從『我的書櫃』找到此書並手動借出給對方。
        </p>

        <label className="moo-manual-lend__checkbox-label">
          <input
            type="checkbox"
            checked={dontRemindChecked}
            onChange={(e) => onDontRemindChange(e.target.checked)}
            className="moo-manual-lend__checkbox"
          />
          <span className="moo-manual-lend__checkbox-text">不再顯示此通知</span>
        </label>

        <div className="moo-manual-lend__footer">
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            className="moo-button moo-button--ghost moo-button--sm moo-modal__cancel"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="moo-button moo-button--sm moo-manual-lend__confirm"
          >
            {confirming ? "處理中..." : "確認借出"}
          </button>
        </div>
      </div>
    </div>
  );
}
