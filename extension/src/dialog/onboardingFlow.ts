/**
 * Onboarding business flow helpers — pure logic extracted from Onboarding.tsx
 * so the component stays focused on UI state and rendering.
 *
 * Each exported function is a single side-effectful operation against the
 * API client, chrome storage, and (best-effort) the in-page encryption
 * cache. Callers are expected to map errors into UI state.
 */

import { ApiClient, FamilyGroup, BookEntry, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import {
  generateKey,
  exportKey,
  importKey,
  encrypt,
  decrypt,
  computeKeyFingerprint,
} from "../crypto/encrypt";
import { decodeSyncCode, encodeSyncCode } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT, PERSONAL_BOOKS_CACHE_KEY } from "../constants";
import type { useAutoSetup } from "./useAutoSetup";

/**
 * Re-encrypt cached personal books with the new family's encryption key.
 * Best-effort: failures do not block family create/join.
 */
export async function migratePersonalBooksCache(
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

/**
 * Retrieve the encryption key from sync storage (falls back to local).
 * Exported so `useOnboardingFlow` can pre-check key availability before
 * deciding whether to auto-recover or prompt the user for a sync code.
 */
export function getSyncedEncryptionKey(): Promise<string | null> {
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

/** Persist auth/family credentials to chrome.storage.local. */
async function persistJoinCredentials(opts: {
  userId: string;
  encryptionKey: string;
  authToken?: string;
  expiresAt?: number;
}): Promise<void> {
  const storageData: Record<string, unknown> = {
    userId: opts.userId,
    encryptionKey: opts.encryptionKey,
  };
  if (opts.authToken !== undefined) {
    storageData.authToken = opts.authToken;
  }
  if (opts.expiresAt) {
    storageData.tokenExpiresAt = opts.expiresAt;
  }
  await chrome.storage.local.set(storageData);
}

export interface RecoveryResult {
  recovered: boolean;
}

/**
 * Attempt to rejoin an existing family using the synced encryption key.
 * Returns { recovered: true } on success, { recovered: false } if the key
 * is unavailable or the join request fails.
 */
export async function tryAutoRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
}): Promise<RecoveryResult> {
  const encryptionKey = await getSyncedEncryptionKey();
  if (!encryptionKey) return { recovered: false };

  const keyFingerprint = await computeKeyFingerprint(encryptionKey);
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
    { keyFingerprint },
  );
  if (joinRes.error) return { recovered: false };

  const joinData = joinRes.data;

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: opts.familyId });
  chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey });
  await persistJoinCredentials({
    userId: opts.userId,
    encryptionKey,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  // Overwrite stale familyId in sync storage so background reads stay consistent
  try {
    await chrome.storage.sync.set({ familyId: opts.familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(encryptionKey, opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  await opts.autoSetup.syncBooks({ userId: opts.userId, apiClient: opts.apiClient });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true };
}

export interface ExistingKeyCheckResult {
  canReuse: boolean;
  encryptionKey?: string;
}

/**
 * Check whether the existing local encryption key can still decrypt
 * the server payload. If so, there is no need to rotate the key.
 */
export async function tryExistingKeyRecovery(
  userId: string,
  apiClient: ApiClient,
): Promise<ExistingKeyCheckResult> {
  try {
    const storage = await chrome.storage.local.get(["encryptionKey"]);
    const existingKey = storage.encryptionKey as string | undefined;
    if (!existingKey) return { canReuse: false };

    const response = await apiClient.getPersonalBooks(userId);
    const data = response.data as Record<string, unknown> | null | undefined;

    // No server data — existing key is fine (nothing to conflict with)
    if (!data || typeof data.payload !== "string") {
      return { canReuse: true, encryptionKey: existingKey };
    }

    // Attempt decrypt with existing key
    const key = await importKey(existingKey);
    await decrypt(data.payload, key);
    return { canReuse: true, encryptionKey: existingKey };
  } catch {
    return { canReuse: false };
  }
}

export interface SoloRecoveryResult {
  recovered: boolean;
  /** True when a new key was generated (existing key could not be reused) */
  keyRotated?: boolean;
}

/**
 * INVARIANT: This is the ONLY allowed encryption key rotation entry point.
 * Key rotation MUST require explicit user confirmation because it invalidates
 * all previously issued sync codes and breaks PWA sessions.
 *
 * Rejoin an existing solo family. First attempts to reuse the existing local
 * encryption key; only generates a fresh key when the existing one cannot
 * decrypt the server payload (or no local key exists).
 */
export async function performSoloRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
  /** Pre-computed result from tryExistingKeyRecovery to avoid redundant API call */
  existingKeyCheck?: ExistingKeyCheckResult;
}): Promise<SoloRecoveryResult> {
  const existingCheck =
    opts.existingKeyCheck ??
    (await tryExistingKeyRecovery(opts.userId, opts.apiClient));

  let keyString: string;
  let keyRotated = false;

  if (existingCheck.canReuse && existingCheck.encryptionKey) {
    keyString = existingCheck.encryptionKey;
  } else {
    const key = await generateKey();
    keyString = await exportKey(key);
    keyRotated = true;
  }

  const keyFingerprint = await computeKeyFingerprint(keyString);

  // Solo recovery: fresh key + fingerprint rotation.
  // Users with no PWA verification (method: "none") pass automatically.
  // Users with PIN/pattern will receive VERIFICATION_REQUIRED.
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
    { keyFingerprint },
  );
  if (joinRes.error) return { recovered: false };

  const joinData = joinRes.data;

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: opts.familyId });
  chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: keyString });
  await persistJoinCredentials({
    userId: opts.userId,
    encryptionKey: keyString,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  try {
    await chrome.storage.sync.set({ familyId: opts.familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(keyString, opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  await opts.autoSetup.syncBooks({ userId: opts.userId, apiClient: opts.apiClient });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true, keyRotated };
}

export interface CreateFamilyResult {
  familyId: string;
  userId: string;
  syncCode: string;
  authToken?: string;
}

/**
 * Create a new family on the backend and persist all credentials locally.
 * Backend auto-cleans any solo-member old family for this userId.
 */
export async function createNewFamily(opts: {
  userId: string;
  displayName: string;
  apiClient: ApiClient;
}): Promise<CreateFamilyResult> {
  // Generate key first so the fingerprint can be sent with the create request
  const key = await generateKey();
  const keyString = await exportKey(key);
  const keyFingerprint = await computeKeyFingerprint(keyString);

  const response = await opts.apiClient.createFamily(opts.userId, opts.displayName, keyFingerprint);
  if (response.error) throw new Error(response.error.message);
  if (!response.data) throw new Error("伺服器未回傳資料");

  const data: FamilyGroup = response.data;
  const familyId = data.familyId;

  const isCustomEndpoint = opts.apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
  const syncCode = encodeSyncCode({
    familyId,
    encryptionKey: keyString,
    apiHost: isCustomEndpoint ? opts.apiClient.getEndpoint() : undefined,
  });

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId });
  chrome.runtime.sendMessage({ type: "SET_ENCRYPTION_KEY", encryptionKey: keyString });
  await persistJoinCredentials({
    userId: opts.userId,
    encryptionKey: keyString,
    authToken: data.authToken,
    expiresAt: data.expiresAt,
  });
  await migratePersonalBooksCache(keyString, opts.userId, opts.apiClient);

  if (data.authToken) {
    opts.apiClient.setAuthToken(data.authToken);
  }

  if (isCustomEndpoint) {
    opts.apiClient.updateFamilyEndpoint(familyId, opts.apiClient.getEndpoint()).catch(() => {});
  }

  return { familyId, userId: opts.userId, syncCode, authToken: data.authToken };
}

export interface PerformJoinSuccess {
  ok: true;
  familyId: string;
  userId: string;
}

export interface PerformJoinFailure {
  ok: false;
  errorCode?: string;
  errorMessage: string;
}

export type PerformJoinResult = PerformJoinSuccess | PerformJoinFailure;

/**
 * Decode a sync code, join the family on the backend, and persist the
 * resulting credentials. Returns a discriminated result so the caller can
 * map failures to UI state without catching exceptions for known errors.
 */
export async function performJoin(opts: {
  syncCodeInput: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
}): Promise<PerformJoinResult> {
  const decoded = decodeSyncCode(opts.syncCodeInput);

  if (decoded.apiHost) {
    opts.apiClient.setEndpoint(decoded.apiHost);
    chrome.runtime.sendMessage({
      type: "SET_API_ENDPOINT",
      apiEndpoint: decoded.apiHost,
    });
  }

  await importKey(decoded.encryptionKey);
  const keyFingerprint = await computeKeyFingerprint(decoded.encryptionKey);

  const response = await opts.apiClient.joinFamily(
    decoded.familyId,
    opts.userId,
    opts.displayName,
    { keyFingerprint },
  );
  if (response.error) {
    return {
      ok: false,
      errorCode: response.error.code,
      errorMessage: response.error.message,
    };
  }

  const joinData = response.data;

  chrome.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: decoded.familyId });
  chrome.runtime.sendMessage({
    type: "SET_ENCRYPTION_KEY",
    encryptionKey: decoded.encryptionKey,
  });
  await persistJoinCredentials({
    userId: opts.userId,
    encryptionKey: decoded.encryptionKey,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  await migratePersonalBooksCache(decoded.encryptionKey, opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  return { ok: true, familyId: decoded.familyId, userId: opts.userId };
}
