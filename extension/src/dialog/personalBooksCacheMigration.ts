import browser from "webextension-polyfill";
import {
  ApiClient,
  PersonalBooks,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import { PERSONAL_BOOKS_CACHE_KEY, DISPLAY_NAME_KEY } from "../constants";
import { readOwnedCachedBooks } from "./personalBooksCache";

type ServerRecordState = "present" | "absent" | "unknown";

/** Whether the server already holds a personal-books record for `userId`. */
async function readServerRecordState(
  userId: string,
  apiClient: ApiClient,
): Promise<ServerRecordState> {
  try {
    const response = await apiClient.getPersonalBooks(userId);
    if (response.error) return "unknown";
    return response.data ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Upload cached personal books as plaintext JSON — ONLY when the server has no
 * record yet. An existing record is authoritative: the cache is display-only
 * and may hold ids the server has since replaced, so it is discarded instead
 * of overwriting the record. When the server cannot be checked, nothing is
 * uploaded and the cache is kept for a later attempt.
 * A cache not owned by `userId` (or in the legacy format) is deleted, never uploaded.
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
    const cachedBooks = readOwnedCachedBooks(raw, userId);
    if (cachedBooks === null) {
      await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
      return;
    }

    const serverRecord = await readServerRecordState(userId, apiClient);
    if (serverRecord === "unknown") {
      console.warn(
        "[Onboarding] Could not check the server's personal books; keeping the cache, not uploading it",
      );
      return;
    }
    if (serverRecord === "absent") {
      const storedDisplayName =
        (result[DISPLAY_NAME_KEY] as string | undefined) ?? "";
      const personalBooks: PersonalBooks = {
        schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
        userId,
        displayName: storedDisplayName,
        books: cachedBooks,
        lastUpdated: new Date().toISOString(),
      };
      await apiClient.updatePersonalBooks(userId, personalBooks);
    }
    await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  } catch {
    // Cache migration is best-effort; don't block family join/create
    console.warn("[Onboarding] Failed to migrate personal books cache");
    await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  }
}
