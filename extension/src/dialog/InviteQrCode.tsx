import React, { useState, useEffect } from "react";
import { buildInviteUrl } from "../constants";

interface InviteQrCodeProps {
  syncCode: string;
}

export function InviteQrCode({ syncCode }: InviteQrCodeProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const inviteUrl = buildInviteUrl(syncCode);

  useEffect(() => {
    let cancelled = false;

    async function generate() {
      setLoading(true);
      setError("");
      try {
        const QRCode = await import("qrcode");
        const dataUrl = await QRCode.default.toDataURL(inviteUrl, { width: 200, margin: 2 });
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
  }, [inviteUrl]);

  return (
    <div className="moo-invite-qr">
      <div className="moo-invite-qr__label">邀請 QR Code</div>

      {loading && <div className="moo-invite-qr__loading">產生 QR Code 中...</div>}

      {!loading && error && <div className="moo-invite-qr__error">{error}</div>}

      {!loading && !error && qrDataUrl && (
        <div className="moo-invite-qr__box">
          <img
            src={qrDataUrl}
            alt="掃描此 QR Code 邀請家人加入書櫃"
            width={200}
            height={200}
          />
        </div>
      )}

      <div className="moo-invite-qr__hint">讓家人掃描此 QR Code 即可在手機上加入書櫃</div>
    </div>
  );
}
