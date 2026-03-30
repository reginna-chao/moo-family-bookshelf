import React, { useState } from "react";
import { ApiClient, FamilyGroup, BookEntry } from "../api/client";
import { generateKey, exportKey, importKey, encrypt } from "../crypto/encrypt";
import { encodeSyncCode, decodeSyncCode, SyncCodeError } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT, PERSONAL_BOOKS_CACHE_KEY } from "../constants";
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

/**
 * Re-encrypt cached personal books with the new family's encryption key.
 * Best-effort: failures do not block family create/join.
 */
async function migratePersonalBooksCache(
  encKeyString: string,
  userId: string,
  apiClient: ApiClient,
): Promise<void> {
  try {
    const result = await chrome.storage.local.get([PERSONAL_BOOKS_CACHE_KEY, "displayName"]);
    const raw = result[PERSONAL_BOOKS_CACHE_KEY] as string | undefined;
    if (!raw) return;

    const storedDisplayName = (result.displayName as string | undefined) ?? "";
    const books = JSON.parse(raw) as BookEntry[];
    const key = await importKey(encKeyString);
    const payload = JSON.stringify({
      userId,
      displayName: storedDisplayName,
      books,
      lastUpdated: new Date().toISOString(),
    });
    const encrypted = await encrypt(payload, key);
    await apiClient.updatePersonalBooks(userId, encrypted);
    await chrome.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  } catch {
    // Cache migration is best-effort; don't block family join/create
    console.warn("[Onboarding] Failed to migrate personal books cache");
    await chrome.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  }
}

export interface OnboardingProps {
  onFamilyJoined: (familyId: string, userId: string) => void;
  apiClient: ApiClient;
}

export function Onboarding({ onFamilyJoined, apiClient }: OnboardingProps) {
  const [state, setState] = useState<OnboardingState>("welcome");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userDisplayName, setUserDisplayName] = useState("");
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
    setUserDisplayName(result.displayName);
    setState("idle");
  };

  const handleCreate = async () => {
    if (!userEmail) return;
    setState("creating");
    setErrorMessage("");

    try {
      console.log("[MooFamily] handleCreate: endpoint =", apiClient.getEndpoint(), "email =", userEmail);
      const hashRes = await apiClient.hashEmail(userEmail);
      if (hashRes.error) {
        setErrorMessage("無法驗證帳號，請重試。");
        setState("error");
        return;
      }
      const userId = hashRes.data?.userId ?? "";
      const response = await apiClient.createFamily(userId, userDisplayName);
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
      const data = response.data as FamilyGroup & { authToken?: string; expiresAt?: number };
      const familyId = data.familyId;
      const key = await generateKey();
      const keyString = await exportKey(key);

      const isCustomEndpoint = apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
      const syncCode = encodeSyncCode({
        familyId,
        encryptionKey: keyString,
        apiHost: isCustomEndpoint ? apiClient.getEndpoint() : undefined,
      });

      chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId });
      const storageData: Record<string, unknown> = { userId, encryptionKey: keyString, authToken: data.authToken };
      if (data.expiresAt) {
        storageData.tokenExpiresAt = data.expiresAt;
      }
      await chrome.storage.local.set(storageData);
      await migratePersonalBooksCache(keyString, userId, apiClient);

      if (data.authToken) {
        apiClient.setAuthToken(data.authToken);
      }

      // Store custom endpoint on the server so FamilySettings endpoint sync
      // does not reset it to the default. Fire-and-forget: failure is non-fatal
      // because the sync code already encodes the @host for invited members.
      if (isCustomEndpoint) {
        apiClient.updateFamilyEndpoint(familyId, apiClient.getEndpoint()).catch(() => {});
      }

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
      const hashRes = await apiClient.hashEmail(userEmail);
      if (hashRes.error) {
        setErrorMessage("無法驗證帳號，請重試。");
        setState("error");
        return;
      }
      const userId = hashRes.data?.userId ?? "";

      const response = await apiClient.joinFamily(decoded.familyId, userId, userDisplayName);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }

      const joinData = response.data as (FamilyGroup & { authToken?: string; expiresAt?: number }) | undefined;

      chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: decoded.familyId });
      const joinStorageData: Record<string, unknown> = {
        userId,
        encryptionKey: decoded.encryptionKey,
        authToken: joinData?.authToken,
      };
      if (joinData?.expiresAt) {
        joinStorageData.tokenExpiresAt = joinData.expiresAt;
      }
      await chrome.storage.local.set(joinStorageData);
      await migratePersonalBooksCache(decoded.encryptionKey, userId, apiClient);

      if (joinData?.authToken) {
        apiClient.setAuthToken(joinData.authToken);
      }

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
