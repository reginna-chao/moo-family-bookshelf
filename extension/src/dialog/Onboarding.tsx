import React, { useState, useEffect } from "react";
import { ApiClient, FamilyGroup, BookEntry, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import { generateKey, exportKey, importKey, encrypt, deriveUserId } from "../crypto/encrypt";
import { encodeSyncCode, decodeSyncCode, SyncCodeError } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT, PERSONAL_BOOKS_CACHE_KEY } from "../constants";
import { LoadingOverlay } from "./LoadingOverlay";
import { useAutoSetup } from "./useAutoSetup";
import { WelcomeView, CreatedView, ErrorView, IdleView } from "./OnboardingViews";

type OnboardingState =
  | "welcome"
  | "idle"
  | "creating"
  | "recovering"
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
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
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

/** Retrieve the encryption key from sync storage (falls back to local). */
function getSyncedEncryptionKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_ENCRYPTION_KEY" },
      (res: { encryptionKey?: unknown } | undefined) => {
        const key = res?.encryptionKey;
        resolve(typeof key === "string" ? key : null);
      },
    );
  });
}

interface RecoveryResult {
  recovered: boolean;
}

/**
 * Attempt to rejoin an existing family using the synced encryption key.
 * Returns { recovered: true } on success, { recovered: false } if the key
 * is unavailable or the join request fails.
 */
async function tryAutoRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
}): Promise<RecoveryResult> {
  const encryptionKey = await getSyncedEncryptionKey();
  if (!encryptionKey) return { recovered: false };

  const joinRes = await opts.apiClient.joinFamily(opts.familyId, opts.userId, opts.displayName);
  if (joinRes.error) return { recovered: false };

  const joinData = joinRes.data as (FamilyGroup & { authToken?: string; expiresAt?: number }) | undefined;

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: opts.familyId });
  chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey });
  const storageData: Record<string, unknown> = {
    userId: opts.userId,
    encryptionKey,
    authToken: joinData?.authToken,
  };
  if (joinData?.expiresAt) {
    storageData.tokenExpiresAt = joinData.expiresAt;
  }
  await chrome.storage.local.set(storageData);
  await migratePersonalBooksCache(encryptionKey, opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  await opts.autoSetup.syncBooks({ userId: opts.userId, apiClient: opts.apiClient });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true };
}

interface CreateFamilyResult {
  familyId: string;
  userId: string;
  syncCode: string;
  authToken?: string;
}

/**
 * Create a new family on the backend and persist all credentials locally.
 * Backend auto-cleans any solo-member old family for this userId.
 */
async function createNewFamily(opts: {
  userId: string;
  displayName: string;
  apiClient: ApiClient;
}): Promise<CreateFamilyResult> {
  const response = await opts.apiClient.createFamily(opts.userId, opts.displayName);
  if (response.error) throw new Error(response.error.message);
  if (!response.data) throw new Error("伺服器未回傳資料");

  const data = response.data as FamilyGroup & { authToken?: string; expiresAt?: number };
  const familyId = data.familyId;
  const key = await generateKey();
  const keyString = await exportKey(key);

  const isCustomEndpoint = opts.apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
  const syncCode = encodeSyncCode({
    familyId,
    encryptionKey: keyString,
    apiHost: isCustomEndpoint ? opts.apiClient.getEndpoint() : undefined,
  });

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId });
  chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: keyString });
  const storageData: Record<string, unknown> = {
    userId: opts.userId,
    encryptionKey: keyString,
    authToken: data.authToken,
  };
  if (data.expiresAt) {
    storageData.tokenExpiresAt = data.expiresAt;
  }
  await chrome.storage.local.set(storageData);
  await migratePersonalBooksCache(keyString, opts.userId, opts.apiClient);

  if (data.authToken) {
    opts.apiClient.setAuthToken(data.authToken);
  }

  if (isCustomEndpoint) {
    opts.apiClient.updateFamilyEndpoint(familyId, opts.apiClient.getEndpoint()).catch(() => {});
  }

  return { familyId, userId: opts.userId, syncCode, authToken: data.authToken };
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
  const [hasUsedBefore, setHasUsedBefore] = useState(false);

  const autoSetup = useAutoSetup();

  // Check if user has previously used the extension (has displayName stored)
  useEffect(() => {
    chrome.storage.local.get(["displayName"], (result) => {
      if (result.displayName) {
        setHasUsedBefore(true);
      }
    });
  }, []);

  const isAutoSetupActive = autoSetup.phase !== "idle" && autoSetup.phase !== "error";

  const handleStart = async () => {
    const result = await autoSetup.scrapeProfile();
    if (!result) return;

    setUserEmail(result.email);
    setUserDisplayName(result.displayName);

    // Attempt auto-recovery or auto-create for returning users
    try {
      const userId = await deriveUserId(result.email);
      const lookupRes = await apiClient.lookupUser(userId);
      if (!lookupRes.error && lookupRes.data) {
        const { existingFamilyId, memberCount } = lookupRes.data;
        if (existingFamilyId && memberCount > 0) {
          // Try sync-key recovery first
          setState("recovering");
          const { recovered } = await tryAutoRecovery({
            familyId: existingFamilyId,
            userId,
            displayName: result.displayName,
            apiClient,
            autoSetup,
            onFamilyJoined,
          });
          if (recovered) return;

          // No sync key — decide based on member count
          if (memberCount === 1) {
            // Solo member: rejoin existing family with a fresh encryption key
            const joinRes = await apiClient.joinFamily(existingFamilyId, userId, result.displayName);
            if (!joinRes.error) {
              const joinData = joinRes.data as (FamilyGroup & { authToken?: string; expiresAt?: number }) | undefined;
              const newKey = await generateKey();
              const newKeyString = await exportKey(newKey);

              chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: existingFamilyId });
              chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: newKeyString });
              const storageData: Record<string, unknown> = {
                userId,
                encryptionKey: newKeyString,
                authToken: joinData?.authToken,
              };
              if (joinData?.expiresAt) {
                storageData.tokenExpiresAt = joinData.expiresAt;
              }
              await chrome.storage.local.set(storageData);

              if (joinData?.authToken) {
                apiClient.setAuthToken(joinData.authToken);
              }

              setState("syncing-books");
              await autoSetup.syncBooks({ userId, apiClient });
              onFamilyJoined(existingFamilyId, userId);
              return;
            }
          }
          // Multi-member: need sync code — fall through to idle view
        }
      }
    } catch {
      // Recovery/auto-create failed — fall through to normal onboarding
    }

    setState("idle");
  };

  const handleCreate = async () => {
    if (!userEmail) return;
    setState("creating");
    setErrorMessage("");

    try {
      const userId = await deriveUserId(userEmail);
      const lookupRes = await apiClient.lookupUser(userId);
      if (lookupRes.error) {
        setErrorMessage("無法驗證帳號，請重試。");
        setState("error");
        return;
      }
      const existingFamilyId = lookupRes.data?.existingFamilyId ?? null;
      const memberCount = lookupRes.data?.memberCount ?? 0;

      // Auto-recovery: user already belongs to a family
      if (existingFamilyId && memberCount > 0) {
        setState("recovering");
        const { recovered } = await tryAutoRecovery({
          familyId: existingFamilyId,
          userId,
          displayName: userDisplayName,
          apiClient,
          autoSetup,
          onFamilyJoined,
        });
        if (recovered) return;

        // Recovery failed (no sync key) — decide based on member count
        if (memberCount > 1) {
          setErrorMessage("你已有家庭群組，請向家人索取同步碼重新加入，或輸入同步碼加入。");
          setState("error");
          return;
        }
        // Solo member, no key — rejoin existing family with fresh key
        const joinRes = await apiClient.joinFamily(existingFamilyId, userId, userDisplayName);
        if (!joinRes.error) {
          const joinData = joinRes.data as (FamilyGroup & { authToken?: string; expiresAt?: number }) | undefined;
          const newKey = await generateKey();
          const newKeyString = await exportKey(newKey);

          chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: existingFamilyId });
          chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: newKeyString });
          const storageData: Record<string, unknown> = {
            userId,
            encryptionKey: newKeyString,
            authToken: joinData?.authToken,
          };
          if (joinData?.expiresAt) {
            storageData.tokenExpiresAt = joinData.expiresAt;
          }
          await chrome.storage.local.set(storageData);

          if (joinData?.authToken) {
            apiClient.setAuthToken(joinData.authToken);
          }

          setState("syncing-books");
          await autoSetup.syncBooks({ userId, apiClient });
          onFamilyJoined(existingFamilyId, userId);
          return;
        }
        // Join failed — fall through to create new family
        setState("creating");
      }

      const created = await createNewFamily({
        userId,
        displayName: userDisplayName,
        apiClient,
      });

      setGeneratedSyncCode(created.syncCode);
      setCreatedFamilyId(created.familyId);
      setCreatedUserId(created.userId);
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
      const userId = await deriveUserId(userEmail);

      const response = await apiClient.joinFamily(decoded.familyId, userId, userDisplayName);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }

      const joinData = response.data as (FamilyGroup & { authToken?: string; expiresAt?: number }) | undefined;

      chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: decoded.familyId });
      chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: decoded.encryptionKey });
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
        : state === "recovering"
          ? "正在恢復家庭資料..."
          : "";

  const effectiveState = autoSetup.phase === "error" ? "error" : state;
  const effectiveError = autoSetup.phase === "error" ? autoSetup.errorMessage : errorMessage;
  const isProcessing = effectiveState === "creating" || effectiveState === "joining" || effectiveState === "syncing-books" || effectiveState === "recovering";

  const renderContent = () => {
    if (effectiveState === "welcome") return <WelcomeView onStart={handleStart} hasUsedBefore={hasUsedBefore} />;
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
      {(isAutoSetupActive || state === "syncing-books" || state === "recovering") && overlayMessage && (
        <LoadingOverlay message={overlayMessage} />
      )}
      {renderContent()}
    </div>
  );
}
