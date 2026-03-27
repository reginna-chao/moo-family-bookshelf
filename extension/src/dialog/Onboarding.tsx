import React, { useState, useEffect } from "react";
import { ApiClient } from "../api/client";
import { generateKey, exportKey, importKey, sha256Hex } from "../crypto/encrypt";
import { encodeSyncCode, decodeSyncCode, SyncCodeError } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";

type OnboardingState =
  | "need-email"
  | "idle"
  | "creating"
  | "created"
  | "joining"
  | "error";

export interface OnboardingProps {
  onFamilyJoined: (familyId: string, userId: string) => void;
  apiClient: ApiClient;
}

export function Onboarding({ onFamilyJoined, apiClient }: OnboardingProps) {
  const [state, setState] = useState<OnboardingState>("need-email");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [syncCodeInput, setSyncCodeInput] = useState("");
  const [generatedSyncCode, setGeneratedSyncCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [createdFamilyId, setCreatedFamilyId] = useState("");
  const [createdUserId, setCreatedUserId] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Check if email is already cached
    chrome.storage.local.get(["userEmail"], (result) => {
      if (result.userEmail) {
        setUserEmail(result.userEmail as string);
        setState("idle");
      } else {
        setState("need-email");
      }
    });
  }, []);

  const handleRefreshEmail = () => {
    chrome.storage.local.get(["userEmail"], (result) => {
      if (result.userEmail) {
        setUserEmail(result.userEmail as string);
        setState("idle");
      }
    });
  };

  const handleCreate = async () => {
    if (!userEmail) return;
    setState("creating");
    setErrorMessage("");

    try {
      const userId = await sha256Hex(userEmail);
      const response = await apiClient.createFamily(userId);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }

      if (!response.data) {
        setErrorMessage("伺服器未回傳資料");
        setState("error");
        return;
      }
      const familyId = response.data.familyId;
      const key = await generateKey();
      const keyString = await exportKey(key);

      const isCustomEndpoint = apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
      const syncCode = encodeSyncCode({
        familyId,
        encryptionKey: keyString,
        apiHost: isCustomEndpoint ? apiClient.getEndpoint() : undefined,
      });

      chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId });
      await chrome.storage.local.set({ userId, encryptionKey: keyString });

      setGeneratedSyncCode(syncCode);
      setCreatedFamilyId(familyId);
      setCreatedUserId(userId);
      setState("created");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      setState("error");
    }
  };

  const handleJoin = async () => {
    if (!userEmail) return;
    setState("joining");
    setErrorMessage("");

    try {
      const decoded = decodeSyncCode(syncCodeInput);

      if (decoded.apiHost) {
        apiClient.setEndpoint(decoded.apiHost);
        chrome.runtime.sendMessage({
          type: "SET_API_ENDPOINT",
          apiEndpoint: decoded.apiHost,
        });
      }

      await importKey(decoded.encryptionKey);
      const userId = await sha256Hex(userEmail);

      const response = await apiClient.joinFamily(decoded.familyId, userId);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }

      chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: decoded.familyId });
      await chrome.storage.local.set({
        userId,
        encryptionKey: decoded.encryptionKey,
      });

      onFamilyJoined(decoded.familyId, userId);
    } catch (err) {
      if (err instanceof SyncCodeError) {
        setErrorMessage(`同步碼格式錯誤：${err.message}`);
      } else {
        setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      }
      setState("error");
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedSyncCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRetry = () => {
    setState(userEmail ? "idle" : "need-email");
    setErrorMessage("");
  };

  if (state === "need-email") {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
          歡迎使用家庭書櫃
        </h2>
        <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14 }}>
          首次使用需要先確認你的讀墨帳號。請先前往「個人帳戶」頁面，再回來點擊下方按鈕。
        </p>
        <a
          href="https://read.readmoo.com/#/me"
          target="_self"
          style={{
            display: "block",
            width: "100%",
            padding: 12,
            marginBottom: 12,
            border: "none",
            borderRadius: 8,
            background: "#2563eb",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
            textAlign: "center",
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          前往個人帳戶頁面
        </a>
        <button
          onClick={handleRefreshEmail}
          style={{
            width: "100%",
            padding: 12,
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          已前往，重新偵測
        </button>
        <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 12 }}>
          我們僅讀取你的帳號信箱用於生成匿名識別碼，信箱不會上傳至伺服器。
        </p>
      </div>
    );
  }

  if (state === "created") {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
          家庭公開書櫃已建立
        </h2>
        <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14 }}>
          將以下同步碼分享給家人，他們可以用此代碼加入你的公開書櫃。
        </p>
        <div
          style={{
            padding: 12,
            background: "#f8fafc",
            borderRadius: 8,
            marginBottom: 12,
            wordBreak: "break-all",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        >
          {generatedSyncCode}
        </div>
        <button
          onClick={handleCopy}
          style={{
            width: "100%",
            padding: 12,
            marginBottom: 12,
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: copied ? "#eff6ff" : "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {copied ? "已複製" : "複製同步碼"}
        </button>
        <button
          onClick={() => onFamilyJoined(createdFamilyId, createdUserId)}
          style={{
            width: "100%",
            padding: 12,
            border: "none",
            borderRadius: 8,
            background: "#2563eb",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          繼續
        </button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: "#ef4444" }}>
          發生錯誤
        </h2>
        <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
          {errorMessage}
        </p>
        <button
          onClick={handleRetry}
          style={{
            width: "100%",
            padding: 12,
            border: "none",
            borderRadius: 8,
            background: "#2563eb",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          重試
        </button>
      </div>
    );
  }

  const isProcessing = state === "creating" || state === "joining";

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        歡迎使用家庭書櫃
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        建立或加入家庭公開書櫃，與家人分享你的藏書。
      </p>
      <button
        onClick={handleCreate}
        disabled={isProcessing}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "none",
          borderRadius: 8,
          background: isProcessing ? "#93c5fd" : "#2563eb",
          color: "white",
          fontWeight: 600,
          cursor: isProcessing ? "not-allowed" : "pointer",
        }}
      >
        {state === "creating" ? "建立中..." : "建立家庭公開書櫃"}
      </button>
      <div style={{ textAlign: "center", margin: "12px 0", color: "#94a3b8" }}>
        或
      </div>
      <input
        type="text"
        placeholder="輸入家庭同步碼"
        value={syncCodeInput}
        onChange={(e) => setSyncCodeInput(e.target.value)}
        disabled={isProcessing}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          marginBottom: 12,
          boxSizing: "border-box",
          fontSize: 14,
        }}
      />
      <button
        onClick={handleJoin}
        disabled={!syncCodeInput.trim() || isProcessing}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #2563eb",
          borderRadius: 8,
          background: "transparent",
          color: "#2563eb",
          fontWeight: 600,
          cursor: !syncCodeInput.trim() || isProcessing ? "not-allowed" : "pointer",
          opacity: !syncCodeInput.trim() || isProcessing ? 0.5 : 1,
        }}
      >
        {state === "joining" ? "加入中..." : "加入家庭公開書櫃"}
      </button>
      <p style={{ color: "#94a3b8", fontSize: 11, marginTop: 16, textAlign: "center" }}>
        {"🔒 本工具採端對端加密，伺服器無法讀取你的資料。"}
      </p>
    </div>
  );
}
