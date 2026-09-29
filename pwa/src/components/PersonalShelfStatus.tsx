export function PersonalShelfLoading() {
  return (
    <div className="p-4 text-center" role="status" aria-label="載入中">
      <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
      <p className="text-gray-500 text-sm mt-3">載入個人書櫃中...</p>
    </div>
  );
}

export interface PersonalShelfErrorProps {
  message: string;
  onRetry: () => Promise<void>;
}

export function PersonalShelfError({
  message,
  onRetry,
}: PersonalShelfErrorProps) {
  return (
    <div className="p-4">
      <p className="text-red-500 text-sm mb-3">{message}</p>
      <button
        onClick={() => void onRetry()}
        className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-600 rounded-lg"
      >
        重試
      </button>
    </div>
  );
}

export function PersonalShelfEmpty() {
  return (
    <div className="p-4 text-center">
      <p className="text-gray-400 mt-4">尚無已同步的書籍</p>
      <p className="text-gray-300 text-sm mt-2">
        請先在桌面版 Chrome 擴充功能中同步書單
      </p>
    </div>
  );
}
