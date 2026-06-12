export function FamilyShelfLoading() {
  return (
    <div className="p-4 text-center" role="status" aria-label="載入中">
      <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
      <p className="text-gray-500 text-sm mt-3">載入家庭書櫃中...</p>
    </div>
  );
}

export interface FamilyShelfErrorProps {
  message: string;
  onRetry: () => void;
}

export function FamilyShelfError({ message, onRetry }: FamilyShelfErrorProps) {
  return (
    <div className="p-4">
      <p className="text-red-500 text-sm mb-3">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-600 rounded-lg"
      >
        重試
      </button>
    </div>
  );
}

export function FamilyShelfEmpty() {
  return (
    <div className="p-4 text-center">
      <p className="text-gray-400 mt-4">尚無家人分享書籍</p>
      <p className="text-gray-300 text-sm mt-2">
        家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
      </p>
    </div>
  );
}
