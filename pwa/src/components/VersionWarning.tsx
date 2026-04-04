import { useState, useEffect } from "react";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";

const MIN_API_VERSION = 1;

const DEPLOY_URL =
  "https://github.com/reginna-chao/moo-family-bookshelf/blob/main/worker/DEPLOY.md";

interface VersionWarningProps {
  apiClient: ApiClient;
}

export function VersionWarning({ apiClient }: VersionWarningProps) {
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (apiClient.getEndpoint() === DEFAULT_API_ENDPOINT) return;

    void apiClient.checkVersion().then((info) => {
      if (!info) {
        setWarning("無法取得自架伺服器版本資訊，部分功能可能無法正常使用。");
      } else if (info.apiVersion < MIN_API_VERSION) {
        setWarning(
          `自架伺服器版本過舊（v${info.serverVersion}），部分功能可能無法正常使用。`,
        );
      }
    });
  }, [apiClient]);

  if (!warning) return null;

  return (
    <div
      role="alert"
      className="mx-4 mt-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"
    >
      {warning}
      <a
        href={DEPLOY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-1 text-amber-600 underline"
      >
        更新指引
      </a>
    </div>
  );
}
