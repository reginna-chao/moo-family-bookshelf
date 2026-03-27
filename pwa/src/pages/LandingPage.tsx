export function LandingPage({ onAuth }: { onAuth: () => void }) {
  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">牧家書櫃</h1>
      <p className="text-gray-500 mb-8 text-center">
        家庭共享書櫃 — 與家人分享你的讀墨藏書
      </p>
      <button
        onClick={onAuth}
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors"
      >
        開始使用
      </button>
      <p className="text-xs text-gray-400 mt-4 text-center">
        請先在桌面版 Chrome 擴充功能完成設定，再使用行動版瀏覽書櫃。
      </p>
    </div>
  );
}
