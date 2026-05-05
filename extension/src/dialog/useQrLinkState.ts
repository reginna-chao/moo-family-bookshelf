import { useCallback, useEffect, useRef, useState } from "react";
import { buildPwaUrl } from "../constants";
import type { ApiClient } from "../api/client";

export type QrState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "active"; token: string; dataUrl: string; expiresAt: number }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export interface UseQrLinkStateProps {
  syncCode: string;
  userId: string;
  apiClient: ApiClient;
}

export interface UseQrLinkStateResult {
  state: QrState;
  copied: boolean;
  onRevealClick: () => void;
  onCopyClick: () => void;
}

export const QR_BOX_SIZE = 200;
const DEFAULT_EXPIRES_IN_SECONDS = 300;

export function useQrLinkState({
  syncCode,
  userId,
  apiClient,
}: UseQrLinkStateProps): UseQrLinkStateResult {
  const [state, setState] = useState<QrState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const fetchInFlightRef = useRef(false);
  // Bumped on identity change so any in-flight fetch can detect it became stale.
  const generationRef = useRef(0);

  // Reset state when identity changes (clear pending expire timer + invalidate in-flight fetch).
  useEffect(() => {
    generationRef.current += 1;
    setState({ kind: "idle" });
    if (expireTimerRef.current !== null) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
  }, [syncCode, userId]);

  // Mount/unmount cleanup.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (expireTimerRef.current !== null) clearTimeout(expireTimerRef.current);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const fetchAndActivate = useCallback(async (): Promise<{ url: string } | null> => {
    if (fetchInFlightRef.current) return null;
    fetchInFlightRef.current = true;
    const gen = generationRef.current;
    setState({ kind: "loading" });
    try {
      const res = await apiClient.createQrToken(userId);
      if (!mountedRef.current || gen !== generationRef.current) return null;
      const token = res.data?.token;
      if (!token) {
        setState({ kind: "error", message: "無法產生 QR Code，請稍後再試" });
        return null;
      }
      const expiresIn = res.data?.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
      const url = buildPwaUrl(syncCode, userId, token);
      const QRCode = await import("qrcode");
      const dataUrl = await QRCode.default.toDataURL(url, { width: QR_BOX_SIZE, margin: 2 });
      if (!mountedRef.current || gen !== generationRef.current) return null;
      if (expireTimerRef.current !== null) clearTimeout(expireTimerRef.current);
      expireTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setState({ kind: "expired" });
      }, expiresIn * 1000);
      setState({ kind: "active", token, dataUrl, expiresAt: Date.now() + expiresIn * 1000 });
      return { url };
    } catch (err) {
      if (!mountedRef.current || gen !== generationRef.current) return null;
      setState({ kind: "error", message: err instanceof Error ? err.message : "QR Code 產生失敗" });
      return null;
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [apiClient, syncCode, userId]);

  const handleReveal = useCallback(async () => {
    if (state.kind === "loading" || state.kind === "active") return;
    await fetchAndActivate();
  }, [state.kind, fetchAndActivate]);

  const handleCopy = useCallback(async () => {
    if (state.kind === "loading") return;
    let url: string;
    if (state.kind === "active") {
      url = buildPwaUrl(syncCode, userId, state.token);
    } else {
      const result = await fetchAndActivate();
      if (!result) return;
      url = result.url;
    }
    await navigator.clipboard.writeText(url);
    if (!mountedRef.current) return;
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopied(false);
    }, 2000);
  }, [state, syncCode, userId, fetchAndActivate]);

  const onRevealClick = useCallback(() => {
    void handleReveal();
  }, [handleReveal]);

  const onCopyClick = useCallback(() => {
    void handleCopy();
  }, [handleCopy]);

  return { state, copied, onRevealClick, onCopyClick };
}
