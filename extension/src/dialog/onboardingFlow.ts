/**
 * Onboarding business flow helpers — pure logic extracted from Onboarding.tsx
 * so the component stays focused on UI state and rendering.
 *
 * Each exported function is a single side-effectful operation against the
 * API client, chrome storage, and (best-effort) the in-page cache.
 * Callers are expected to map errors into UI state.
 */

import browser from "webextension-polyfill";
import { ApiClient, FamilyGroup, BookEntry, PersonalBooks, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import { decodeSyncCode, encodeSyncCode } from "../crypto/syncCode";
import {
  DEFAULT_API_ENDPOINT,
  PERSONAL_BOOKS_CACHE_KEY,
  DISPLAY_NAME_KEY,
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
} from "../constants";
import type { useAutoSetup } from "./useAutoSetup";

/**
 * Upload cached personal books as plaintext JSON.
 * Best-effort: failures do not block family create/join.
 */
export async function migratePersonalBooksCache(
  userId: string,
  apiClient: ApiClient,
): Promise<void> {
  try {
    const result = await browser.storage.local.get([PERSONAL_BOOKS_CACHE_KEY, DISPLAY_NAME_KEY]);
    const raw = result[PERSONAL_BOOKS_CACHE_KEY] as string | undefined;
    if (!raw) return;

    const storedDisplayName = (result[DISPLAY_NAME_KEY] as string | undefined) ?? "";
    const books = JSON.parse(raw) as BookEntry[];
    const personalBooks: PersonalBooks = {
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
      userId,
      displayName: storedDisplayName,
      books,
      lastUpdated: new Date().toISOString(),
    };
    await apiClient.updatePersonalBooks(userId, personalBooks);
    await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  } catch {
    // Cache migration is best-effort; don't block family join/create
    console.warn("[Onboarding] Failed to migrate personal books cache");
    await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  }
}

/** Persist auth/family credentials to chrome.storage.local. */
async function persistJoinCredentials(opts: {
  userId: string;
  authToken?: string;
  expiresAt?: number;
}): Promise<void> {
  const storageData: Record<string, unknown> = {
    [USER_ID_KEY]: opts.userId,
  };
  if (opts.authToken !== undefined) {
    storageData[AUTH_TOKEN_KEY] = opts.authToken;
  }
  if (opts.expiresAt) {
    storageData[TOKEN_EXPIRES_AT_KEY] = opts.expiresAt;
  }
  await browser.storage.local.set(storageData);
}

export interface RecoveryResult {
  recovered: boolean;
}

/**
 * Attempt to rejoin an existing family.
 * Returns { recovered: true } on success, { recovered: false } if the
 * join request fails.
 */
export async function tryAutoRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
}): Promise<RecoveryResult> {
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
  );
  if (joinRes.error) return { recovered: false };

  const joinData = joinRes.data;

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: opts.familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  // Overwrite stale familyId in sync storage so background reads stay consistent
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: opts.familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  await opts.autoSetup.syncBooks({ userId: opts.userId, apiClient: opts.apiClient });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true };
}

export interface SoloRecoveryResult {
  recovered: boolean;
}

/**
 * Rejoin an existing solo family.
 */
export async function performSoloRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
}): Promise<SoloRecoveryResult> {
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
  );
  if (joinRes.error) return { recovered: false };

  const joinData = joinRes.data;

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: opts.familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: opts.familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  await opts.autoSetup.syncBooks({ userId: opts.userId, apiClient: opts.apiClient });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true };
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
  const response = await opts.apiClient.createFamily(opts.userId, opts.displayName);
  if (response.error) throw new Error(response.error.message);
  if (!response.data) throw new Error("伺服器未回傳資料");

  const data: FamilyGroup = response.data;
  const familyId = data.familyId;

  const isCustomEndpoint = opts.apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
  const syncCode = encodeSyncCode({
    familyId,
    apiHost: isCustomEndpoint ? opts.apiClient.getEndpoint() : undefined,
  });

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    authToken: data.authToken,
    expiresAt: data.expiresAt,
  });
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

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
    void Promise.resolve(
      browser.runtime.sendMessage({
        type: "SET_API_ENDPOINT",
        apiEndpoint: decoded.apiHost,
      }),
    ).catch(() => {});
  }

  const response = await opts.apiClient.joinFamily(
    decoded.familyId,
    opts.userId,
    opts.displayName,
  );
  if (response.error) {
    return {
      ok: false,
      errorCode: response.error.code,
      errorMessage: response.error.message,
    };
  }

  const joinData = response.data;

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId: decoded.familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  return { ok: true, familyId: decoded.familyId, userId: opts.userId };
}
