import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import { FAMILY_ID_KEY } from "../constants";
import { migratePersonalBooksCache } from "./personalBooksCacheMigration";
import { persistJoinCredentials } from "./persistJoinCredentials";

/**
 * Record a family create / join the server accepted, tied to the server the
 * request was sent to. Storage always gets the issuer's pair. The token is bound
 * and the cache migrated only while the client is still on that server; after a
 * teardown moved it away, neither happens and the cache is kept.
 * Binding comes before the migration, so its first GET carries the token.
 * A rejected credential write propagates. See docs/architecture.md → 認證更新與冷卻.
 */
export async function settleJoinedSession(opts: {
  userId: string;
  familyId: string;
  authToken?: string;
  expiresAt?: number;
  /** The server this create / join was sent to, read before the request. */
  issuer: string;
  apiClient: ApiClient;
}): Promise<void> {
  const { userId, familyId, authToken, expiresAt, issuer, apiClient } = opts;

  void Promise.resolve(
    browser.runtime.sendMessage({ type: "SET_FAMILY_ID", familyId }),
  ).catch(() => {});
  await persistJoinCredentials({
    userId,
    familyId,
    authToken,
    expiresAt,
    endpoint: issuer,
  });
  // Overwrite stale familyId in sync storage so background reads stay consistent
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: familyId });
  } catch {
    // sync storage may be unavailable in some contexts
  }

  // No `await` between this compare and the bind: the client must not move in between.
  if (apiClient.getEndpoint() !== issuer) return;
  if (authToken) apiClient.setAuthToken(authToken);

  await migratePersonalBooksCache(userId, apiClient);
}
