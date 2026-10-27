/** Presentational steps of VerifySetupPrompt; the step machine and the saves stay there. */

interface KeepOrChangeViewProps {
  onChange: () => void;
  onKeep: () => void;
  saving: boolean;
}

/** First step for an account that already has a PIN / pattern (#396). */
export function KeepOrChangeView({
  onChange,
  onKeep,
  saving,
}: KeepOrChangeViewProps) {
  return (
    <>
      <h2 className="text-lg font-bold text-gray-900 mb-6">
        你已設定登入驗證（PIN 碼／圖形），要改成別的嗎？
      </h2>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => void onKeep()}
          disabled={saving}
          className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2.5 font-medium hover:bg-gray-50 transition-colors"
        >
          保持現狀
        </button>
        <button
          type="button"
          onClick={onChange}
          disabled={saving}
          className="flex-1 bg-blue-600 text-white rounded-lg py-2.5 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          改
        </button>
      </div>
    </>
  );
}

interface ChooseMethodViewProps {
  onSelectPin: () => void;
  onSelectPattern: () => void;
  onSelectCode: () => void;
  onSelectNone: () => void;
  onDismiss: () => void;
  saving: boolean;
}

export function ChooseMethodView({
  onSelectPin,
  onSelectPattern,
  onSelectCode,
  onSelectNone,
  onDismiss,
  saving,
}: ChooseMethodViewProps) {
  return (
    <>
      <h2 className="text-lg font-bold text-gray-900 mb-2">設定登入驗證</h2>
      <p className="text-sm text-gray-500 mb-3">
        保護你的帳號，防止他人在手機版未經授權登入。
      </p>
      <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-5 leading-relaxed">
        提示：用手機版（PWA）登入，或電腦上的擴充功能需要重新登入時，都要通過這個驗證。要改成別的方式，得先輸入目前的
        PIN 碼或圖形；忘記的話，自架伺服器請找管理者協助。
      </p>
      <div className="space-y-3">
        <button
          type="button"
          onClick={onSelectPin}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">PIN 碼</span>
          <span className="block text-xs text-gray-500 mt-0.5">
            6-12 位數字
          </span>
        </button>
        <button
          type="button"
          onClick={onSelectPattern}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">圖形驗證</span>
          <span className="block text-xs text-gray-500 mt-0.5">九宮格</span>
        </button>
        <button
          type="button"
          onClick={() => void onSelectCode()}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">隨機驗證碼</span>
          <span className="block text-xs text-gray-500 mt-0.5">需要電腦</span>
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
        >
          <span className="font-medium text-gray-500">不設定驗證</span>
        </button>
      </div>
      <button
        type="button"
        onClick={() => void onDismiss()}
        disabled={saving}
        className="mt-4 w-full text-center text-sm text-gray-400 hover:text-gray-600 transition-colors"
      >
        之後再說
      </button>
    </>
  );
}

interface ConfirmSkipViewProps {
  onConfirm: () => void;
  onBack: () => void;
  saving: boolean;
}

export function ConfirmSkipView({
  onConfirm,
  onBack,
  saving,
}: ConfirmSkipViewProps) {
  return (
    <>
      <h2 className="text-lg font-bold text-gray-900 mb-3">確定不設定驗證？</h2>
      <p className="text-sm text-gray-600 leading-relaxed mb-6">
        家庭成員若知道你的 Email，可能在手機版登入你的帳號。確定不設定驗證嗎？
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2.5 font-medium hover:bg-gray-50 transition-colors"
        >
          返回
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={saving}
          className="flex-1 bg-red-500 text-white rounded-lg py-2.5 font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
        >
          {saving ? "儲存中..." : "確定不設定"}
        </button>
      </div>
    </>
  );
}
