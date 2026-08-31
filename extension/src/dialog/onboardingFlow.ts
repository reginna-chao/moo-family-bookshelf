/**
 * Onboarding business flow helpers — pure logic extracted from Onboarding.tsx
 * so the component stays focused on UI state and rendering.
 *
 * Each exported function is a single side-effectful operation against the
 * API client, chrome storage, and (best-effort) the in-page cache.
 * Callers are expected to map errors into UI state.
 */

import browser from "webextension-polyfill";
import {
  ApiClient,
  FamilyGroup,
  BookEntry,
  PersonalBooks,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
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
import { persistAcceptedFamilyEndpoint } from "../storage/familyEndpointChoice";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
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
    const result = await browser.storage.local.get([
      PERSONAL_BOOKS_CACHE_KEY,
      DISPLAY_NAME_KEY,
    ]);
    const raw = result[PERSONAL_BOOKS_CACHE_KEY] as string | undefined;
    if (!raw) return;

    const storedDisplayName =
      (result[DISPLAY_NAME_KEY] as string | undefined) ?? "";
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

/**
 * Persist auth/family credentials to chrome.storage.local.
 *
 * familyId is written DIRECTLY to local here (not only via the background
 * SET_FAMILY_ID message) so persistence survives Firefox's sleeping background
 * event page, where the message round-trip can fail.
 */
async function persistJoinCredentials(opts: {
  userId: string;
  familyId?: string;
  authToken?: string;
  expiresAt?: number;
}): Promise<void> {
  const storageData: Record<string, unknown> = {
    [USER_ID_KEY]: opts.userId,
  };
  if (opts.familyId !== undefined) {
    storageData[FAMILY_ID_KEY] = opts.familyId;
  }
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
  /** Backend error code when recovery failed (e.g. VERIFICATION_REQUIRED). */
  errorCode?: string;
  /** Seconds to wait before retrying, present on rate-limit (429) failures. */
  retryAfter?: number;
}

/**
 * Attempt to rejoin an existing family.
 * Returns { recovered: true } on success, or { recovered: false, errorCode }
 * if the join request fails — the code lets callers distinguish a
 * verification-required/failed/locked error from a generic failure.
 */
export async function tryAutoRecovery(opts: {
  familyId: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  autoSetup: ReturnType<typeof useAutoSetup>;
  onFamilyJoined: (familyId: string, userId: string) => void;
  /** PWA login verification secret (PIN/pattern) for verification-enabled users. */
  verifySecret?: string;
}): Promise<RecoveryResult> {
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
    opts.verifySecret !== undefined
      ? { verifySecret: opts.verifySecret }
      : undefined,
  );
  if (joinRes.error) {
    return {
      recovered: false,
      errorCode: joinRes.error.code,
      retryAfter: joinRes.error.retryAfter,
    };
  }

  const joinData = joinRes.data;

  void Promise.resolve(
    browser.runtime.sendMessage({
      type: "SET_FAMILY_ID",
      familyId: opts.familyId,
    }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    familyId: opts.familyId,
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

  await opts.autoSetup.syncBooks({
    userId: opts.userId,
    apiClient: opts.apiClient,
  });
  opts.onFamilyJoined(opts.familyId, opts.userId);
  return { recovered: true };
}

export interface SoloRecoveryResult {
  recovered: boolean;
  /** Backend error code when recovery failed (e.g. VERIFICATION_REQUIRED). */
  errorCode?: string;
  /** Seconds to wait before retrying, present on rate-limit (429) failures. */
  retryAfter?: number;
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
  /** PWA login verification secret (PIN/pattern) for verification-enabled users. */
  verifySecret?: string;
}): Promise<SoloRecoveryResult> {
  const joinRes = await opts.apiClient.joinFamily(
    opts.familyId,
    opts.userId,
    opts.displayName,
    opts.verifySecret !== undefined
      ? { verifySecret: opts.verifySecret }
      : undefined,
  );
  if (joinRes.error) {
    return {
      recovered: false,
      errorCode: joinRes.error.code,
      retryAfter: joinRes.error.retryAfter,
    };
  }

  const joinData = joinRes.data;

  void Promise.resolve(
    browser.runtime.sendMessage({
      type: "SET_FAMILY_ID",
      familyId: opts.familyId,
    }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    familyId: opts.familyId,
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

  await opts.autoSetup.syncBooks({
    userId: opts.userId,
    apiClient: opts.apiClient,
  });
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
 * Thrown when the backend refuses to create the family. Carries the
 * machine-readable code (and the rate-limit wait, when sent) so callers can
 * bridge a verification challenge instead of dead-ending on the message.
 */
export class CreateFamilyError extends Error {
  readonly code: string;
  readonly retryAfter?: number;

  constructor(message: string, code: string, retryAfter?: number) {
    super(message);
    this.name = "CreateFamilyError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Create a new family on the backend and persist all credentials locally.
 * Backend auto-cleans any solo-member old family for this userId.
 *
 * Throws `CreateFamilyError` when the backend refuses — including the
 * verification codes raised for accounts with PWA login verification
 * configured (`VERIFICATION_REQUIRED` / `VERIFICATION_FAILED` /
 * `VERIFICATION_LOCKED`).
 */
export async function createNewFamily(opts: {
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  /** PWA login verification secret (PIN/pattern) for verification-enabled users. */
  verifySecret?: string;
}): Promise<CreateFamilyResult> {
  const response = await opts.apiClient.createFamily(
    opts.userId,
    opts.displayName,
    opts.verifySecret !== undefined
      ? { verifySecret: opts.verifySecret }
      : undefined,
  );
  if (response.error) {
    throw new CreateFamilyError(
      safeErrorText(response.error.message, "建立家庭失敗，請稍後再試"),
      response.error.code,
      response.error.retryAfter,
    );
  }
  if (!response.data) {
    throw new CreateFamilyError("伺服器未回傳資料", "EMPTY_RESPONSE");
  }

  const data: FamilyGroup = response.data;
  const familyId = data.familyId;

  const isCustomEndpoint =
    opts.apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
  const syncCode = encodeSyncCode({
    familyId,
    apiHost: isCustomEndpoint ? opts.apiClient.getEndpoint() : undefined,
  });

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    familyId,
    authToken: data.authToken,
    expiresAt: data.expiresAt,
  });
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

  if (data.authToken) {
    opts.apiClient.setAuthToken(data.authToken);
  }

  if (isCustomEndpoint) {
    opts.apiClient
      .updateFamilyEndpoint(familyId, opts.apiClient.getEndpoint())
      .catch(() => {});
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
  /** Seconds to wait before retrying, present on rate-limit (429) failures. */
  retryAfter?: number;
}

export type PerformJoinResult = PerformJoinSuccess | PerformJoinFailure;

/**
 * Put the client back on `endpoint` after a join attempt ended without a join.
 *
 * Storage is deliberately untouched: performJoin persists a sync code's `@host`
 * only once the backend has accepted the join, so an abandoned attempt has
 * nothing durable to undo — only the in-memory client to hand back.
 */
export function restoreApiEndpoint(
  apiClient: ApiClient,
  endpoint: string,
): void {
  try {
    apiClient.setEndpoint(endpoint);
  } catch (err) {
    // `endpoint` came from getEndpoint(), so it already passed validation.
    // Guarded anyway: this runs on error paths, where a throw would replace the
    // failure the caller is in the middle of reporting.
    console.warn("[Onboarding] Failed to restore previous API endpoint", err);
  }
}

/**
 * Decode a sync code, join the family on the backend, and persist the
 * resulting credentials. Returns a discriminated result so the caller can
 * map failures to UI state without catching exceptions for known errors.
 *
 * ENDPOINT LIFETIME. The sync code's `@host` is applied to the in-memory client
 * (the join request has to go there) but is PERSISTED only after the backend
 * accepts the join. A host whose server refuses has proven nothing, and a
 * persisted endpoint outlives the attempt: it would still be in force when the
 * user gives up and presses 建立家庭, shipping the userId, display name, the
 * token that create issues and the entire personal book list — unshared books
 * included — to that same server, which would then be baked into the sync code
 * handed to the rest of the family.
 *
 * On failure the `@host` stays applied IN MEMORY, because a verification
 * challenge is a continuation of this attempt, not its end: the prompt asks
 * that same server for the account's verification method and then retries the
 * join against it. Releasing it is therefore the caller's job — see
 * `restoreApiEndpoint` in useOnboardingFlow.handleJoin, which hands the
 * endpoint back on every exit that ends the attempt without a join. Nothing is
 * written to storage until a join succeeds, so an abandoned attempt cannot
 * survive a reload either way.
 */
export async function performJoin(opts: {
  syncCodeInput: string;
  userId: string;
  displayName: string;
  apiClient: ApiClient;
  /** PWA login verification secret (PIN/pattern) for verification-enabled users. */
  verifySecret?: string;
}): Promise<PerformJoinResult> {
  const decoded = decodeSyncCode(opts.syncCodeInput);
  /** The validated/normalised `@host`, or null when the code carries none. */
  let adoptedEndpoint: string | null = null;

  if (decoded.apiHost) {
    // setEndpoint validates the @host with the same rules the settings/confirm
    // paths use — it now rejects embedded credentials and unsafe schemes, so a
    // sync code carrying `https://real.example@evil.com` throws here. Abort the
    // join with a clear message rather than letting it bubble up as a raw
    // English error; nothing is persisted and no join is attempted, and the
    // client stays on its previous endpoint (setEndpoint throws before it
    // assigns).
    try {
      opts.apiClient.setEndpoint(decoded.apiHost);
    } catch (err) {
      // Log the reason: the UI copy is deliberately generic, so without this
      // the only record of WHY a join was refused is gone.
      console.warn("[Onboarding] Sync code endpoint rejected", err);
      return {
        ok: false,
        errorCode: "INVALID_ENDPOINT",
        errorMessage: "此同步碼的伺服器位址無效或不安全，無法加入",
      };
    }
    adoptedEndpoint = opts.apiClient.getEndpoint();
  }

  const response = await opts.apiClient.joinFamily(
    decoded.familyId,
    opts.userId,
    opts.displayName,
    opts.verifySecret !== undefined
      ? { verifySecret: opts.verifySecret }
      : undefined,
  );
  if (response.error) {
    return {
      ok: false,
      errorCode: response.error.code,
      errorMessage: safeErrorText(
        response.error.message,
        "加入家庭失敗，請稍後再試",
      ),
      retryAfter: response.error.retryAfter,
    };
  }

  // Joined: only now has this endpoint earned the right to stick. Persisted
  // through the same helper the settings path uses — a direct storage.local
  // write (authoritative) plus a best-effort SET_API_ENDPOINT message, because
  // on Firefox's sleeping background event page the message alone can be
  // dropped, which used to leave the member silently back on the default
  // endpoint. The helper also clears any stale "declined family endpoint"
  // marker, which is right here: joining through an @host sync code IS an
  // explicit choice of that endpoint.
  if (adoptedEndpoint !== null) {
    await persistAcceptedFamilyEndpoint(adoptedEndpoint);
  }

  const joinData = response.data;

  void Promise.resolve(
    browser.runtime.sendMessage({
      type: "SET_FAMILY_ID",
      familyId: decoded.familyId,
    }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId: opts.userId,
    familyId: decoded.familyId,
    authToken: joinData?.authToken,
    expiresAt: joinData?.expiresAt,
  });
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: decoded.familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }
  await migratePersonalBooksCache(opts.userId, opts.apiClient);

  if (joinData?.authToken) {
    opts.apiClient.setAuthToken(joinData.authToken);
  }

  return { ok: true, familyId: decoded.familyId, userId: opts.userId };
}
