import React, { useState, useEffect, useRef, useCallback } from "react";
import { buildPwaUrl } from "../constants";
import type { ApiClient } from "../api/client";

/** Default refresh interval: 4 minutes (token typically expires at 5 min). */
const TOKEN_REFRESH_INTERVAL_MS = 240_000;

interface QrCodeLinkProps {
  syncCode: string;
  userId: string;
  apiClient: ApiClient;
}

export function QrCodeLink({ syncCode, userId, apiClient }: QrCodeLinkProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [qrToken, setQrToken] = useState<string | undefined>(undefined);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const pwaUrl = buildPwaUrl(syncCode, userId, qrToken);

  const fetchQrToken = useCallback(async () => {
    try {
      const res = await apiClient.createQrToken(userId);
      if (!mountedRef.current) return;
      if (res.data?.token) {
        setQrToken(res.data.token);
        // Schedule next refresh before expiry (use server expiresIn or default 4 min)
        const refreshMs = res.data.expiresIn
          ? Math.max((res.data.expiresIn - 60) * 1000, 30_000)
          : TOKEN_REFRESH_INTERVAL_MS;
        refreshTimerRef.current = setTimeout(() => {
          void fetchQrToken();
        }, refreshMs);
      }
      // If token fetch fails, qrToken stays undefined — fallback to URL without token
    } catch {
      // Graceful degradation: QR code still works without token
    }
  }, [apiClient, userId]);

  // Fetch QR token on mount and clean up timer on unmount
  useEffect(() => {
    mountedRef.current = true;
    void fetchQrToken();
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [fetchQrToken]);

  useEffect(() => {
    let cancelled = false;

    async function generate() {
      setLoading(true);
      setError("");
      try {
        const QRCode = await import("qrcode");
        const dataUrl = await QRCode.default.toDataURL(pwaUrl, { width: 200, margin: 2 });
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "QR Code 產生失敗");
          setLoading(false);
        }
      }
    }

    void generate();

    return () => {
      cancelled = true;
    };
  }, [pwaUrl]);

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(pwaUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: "#64748b", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>連結手機</div>

      {loading && (
        <div style={{ color: "#94a3b8", fontSize: 14, textAlign: "center", padding: 12 }}>
          產生 QR Code 中...
        </div>
      )}

      {!loading && error && (
        <div style={{ color: "#ef4444", fontSize: 13, textAlign: "center", padding: 12 }}>
          {error}
        </div>
      )}

      {!loading && !error && qrDataUrl && (
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
          <img
            src={qrDataUrl}
            alt="掃描此 QR Code 以在手機上開啟墨家書櫃"
            width={200}
            height={200}
          />
        </div>
      )}

      <button
        onClick={() => void handleCopyLink()}
        style={{
          width: "100%", padding: 10, border: "1px solid #2563eb", borderRadius: 8,
          background: copied ? "#eff6ff" : "transparent", color: "#2563eb",
          fontWeight: 600, cursor: "pointer", fontSize: 14, marginTop: 8,
        }}
      >
        {copied ? "已複製" : "複製連結"}
      </button>

      <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6, textAlign: "center" }}>
        用手機掃描 QR Code 或複製連結，即可在行動裝置上使用墨家書櫃
      </div>
    </div>
  );
}
