import { useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { namespacedKey } from "@/hooks/useAuth";

interface ApiEndpointEditorProps {
  apiClient: ApiClient;
  userId: string;
}

function isValidEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

export function ApiEndpointEditor({ apiClient, userId }: ApiEndpointEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputUrl, setInputUrl] = useState("");
  const [currentEndpoint, setCurrentEndpoint] = useState(apiClient.getEndpoint());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const isDefault = currentEndpoint === DEFAULT_API_ENDPOINT;

  const handleSave = () => {
    setError("");
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    if (!isValidEndpoint(trimmed)) {
      setError("請輸入有效的 HTTPS 網址（或 localhost）");
      return;
    }
    const normalized = trimmed.replace(/\/+$/, "");
    localStorage.setItem(namespacedKey(userId, "apiHost"), normalized);
    apiClient.setEndpoint(normalized);
    setCurrentEndpoint(normalized);
    setInputUrl("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    localStorage.removeItem(namespacedKey(userId, "apiHost"));
    apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
    setCurrentEndpoint(DEFAULT_API_ENDPOINT);
    setInputUrl("");
    setError("");
  };

  return (
    <section className="mb-6">
      <div
        onClick={() => setExpanded(!expanded)}
        className="cursor-pointer select-none text-sm font-medium text-gray-500"
      >
        {expanded ? <ChevronDown size={14} className="inline align-middle" /> : <ChevronRight size={14} className="inline align-middle" />} 進階設定
      </div>
      {expanded && (
        <div className="mt-2">
          <p className="text-xs text-gray-500 mb-1">
            目前 API 端點
            <a
              href="https://github.com/reginna-chao/moo-family-bookshelf/blob/main/worker/DEPLOY.md"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="自架部署說明"
              className="text-gray-400 ml-1 align-middle inline-block"
            >
              <HelpCircle size={12} className="inline align-middle" />
            </a>
          </p>
          <div className="bg-gray-50 rounded-lg p-2 font-mono text-xs break-all mb-3">
            {currentEndpoint}
          </div>
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => { setInputUrl(e.target.value); setError(""); }}
            placeholder="https://your-worker.example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-1.5"
          />
          {error && (
            <p className="text-red-500 text-xs mb-1.5">{error}</p>
          )}
          <div className="flex gap-2 mb-2">
            <button
              onClick={handleSave}
              disabled={!inputUrl.trim()}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saved ? "已儲存" : "儲存"}
            </button>
            <button
              onClick={handleReset}
              disabled={isDefault}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              重設為預設
            </button>
          </div>
          <p className="text-amber-500 text-xs">
            變更 API 端點後，所有家庭成員都必須使用相同的端點
          </p>
        </div>
      )}
    </section>
  );
}
