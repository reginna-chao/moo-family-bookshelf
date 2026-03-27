import React, { useState } from "react";
import { ApiClient } from "../api/client";
import { generateKey, exportKey, importKey, sha256Hex } from "../crypto/encrypt";
import { encodeSyncCode, decodeSyncCode, SyncCodeError } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { LoadingOverlay } from "./LoadingOverlay";
import { useAutoSetup } from "./useAutoSetup";
import { WelcomeView, CreatedView, ErrorView, IdleView } from "./OnboardingViews";

type OnboardingState =
  | "welcome"
  | "idle"
  | "creating"
  | "created"
  | "joining"
  | "syncing-books"
  | "error";

export interface OnboardingProps {
  onFamilyJoined: (familyId: string, userId: string) => void;
  apiClient: ApiClient;
}

export function Onboarding({ onFamilyJoined, apiClient }: OnboardingProps) {
  const [state, setState] = useState<OnboardingState>("welcome");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [syncCodeInput, setSyncCodeInput] = useState("");
  const [generatedSyncCode, setGeneratedSyncCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [createdFamilyId, setCreatedFamilyId] = useState("");
  const [createdUserId, setCreatedUserId] = useState("");
  const [copied, setCopied] = useState(false);

  const autoSetup = useAutoSetup();

  const isAutoSetupActive = autoSetup.phase !== "idle" && autoSetup.phase !== "error";

  const handleStart = async () => {
    const result = await autoSetup.scrapeProfile();
    if (!result) return;

    setUserEmail(result.email);
    setState("idle");
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

  const handleContinueAfterCreate = async () => {
    setState("syncing-books");
    const success = await autoSetup.syncBooks({
      userId: createdUserId,
      apiClient,
    });

    if (success) {
      onFamilyJoined(createdFamilyId, createdUserId);
    } else {
      // Book sync failed but family was created — still allow proceeding
      onFamilyJoined(createdFamilyId, createdUserId);
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

      // Auto-sync books after joining
      setState("syncing-books");
      const success = await autoSetup.syncBooks({ userId, apiClient });
      if (success) {
        onFamilyJoined(decoded.familyId, userId);
      } else {
        // Sync failed but join succeeded — still proceed
        onFamilyJoined(decoded.familyId, userId);
      }
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
    autoSetup.reset();
    setState(userEmail ? "idle" : "welcome");
    setErrorMessage("");
  };

  const overlayMessage =
    autoSetup.phase !== "idle" && autoSetup.phase !== "error"
      ? autoSetup.phaseMessage
      : state === "syncing-books"
        ? "正在同步書單..."
        : "";

  const effectiveState = autoSetup.phase === "error" ? "error" : state;
  const effectiveError = autoSetup.phase === "error" ? autoSetup.errorMessage : errorMessage;
  const isProcessing = effectiveState === "creating" || effectiveState === "joining" || effectiveState === "syncing-books";

  const renderContent = () => {
    if (effectiveState === "welcome") return <WelcomeView onStart={handleStart} />;
    if (effectiveState === "error") return <ErrorView errorMessage={effectiveError} onRetry={handleRetry} />;
    if (effectiveState === "created") {
      return (
        <CreatedView
          generatedSyncCode={generatedSyncCode}
          copied={copied}
          onCopy={handleCopy}
          onContinue={handleContinueAfterCreate}
        />
      );
    }
    return (
      <IdleView
        state={effectiveState}
        syncCodeInput={syncCodeInput}
        isProcessing={isProcessing}
        onSetSyncCodeInput={setSyncCodeInput}
        onCreate={handleCreate}
        onJoin={handleJoin}
      />
    );
  };

  return (
    <div style={{ position: "relative", minHeight: 200 }}>
      {(isAutoSetupActive || state === "syncing-books") && overlayMessage && (
        <LoadingOverlay message={overlayMessage} />
      )}
      {renderContent()}
    </div>
  );
}
