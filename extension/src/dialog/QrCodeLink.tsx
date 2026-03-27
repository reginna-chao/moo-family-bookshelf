import React, { useState, useEffect } from "react";
import { buildPwaUrl } from "../constants";

interface QrCodeLinkProps {
  syncCode: string;
  userId: string;
}

export function QrCodeLink({ syncCode, userId }: QrCodeLinkProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const pwaUrl = buildPwaUrl(syncCode, userId);

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
    <div style={{ marginBottom: 20, borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
      <div style={{ color: "#64748b", fontSize: 13, marginBottom: 6 }}>連結手機</div>

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
            alt="掃描此 QR Code 以在手機上開啟牧家書櫃"
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
        用手機掃描 QR Code 或複製連結，即可在行動裝置上使用牧家書櫃
      </div>
    </div>
  );
}
