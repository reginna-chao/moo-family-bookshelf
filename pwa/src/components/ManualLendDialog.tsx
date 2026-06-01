import { useEffect } from "react";

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
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
    >
      <div className="bg-white rounded-xl p-5 mx-4 w-full max-w-[340px] shadow-lg">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          手動借出提醒
        </h3>

        <p className="text-xs text-gray-600 leading-relaxed mb-2">
          此操作後將會通知對方已借出，但需要手動方式完成借書流程。
        </p>
        <p className="text-xs text-gray-600 leading-relaxed mb-4">
          請自行前往讀墨網頁或 APP，從『我的書櫃』找到此書並手動借出給對方。
        </p>

        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={dontRemindChecked}
            onChange={(e) => onDontRemindChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-xs text-gray-500">不再顯示此通知</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            className="px-3 py-1.5 rounded text-xs font-semibold border border-slate-300 text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="px-3 py-1.5 rounded text-xs font-semibold border border-blue-600 bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirming ? "處理中..." : "確認借出"}
          </button>
        </div>
      </div>
    </div>
  );
}
