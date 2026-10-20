import browser from "webextension-polyfill";
import {
  ApiClient,
  BookEntry,
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

/** PUT the cached books as the user's first server record; true when the server accepted it. */
async function uploadCachedBooks(
  userId: string,
  displayName: string,
  books: BookEntry[],
  apiClient: ApiClient,
): Promise<boolean> {
  const personalBooks: PersonalBooks = {
    schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
    userId,
    displayName,
    books,
    lastUpdated: new Date().toISOString(),
  };
  const response = await apiClient.updatePersonalBooks(userId, personalBooks);
  return !response.error;
}

/**
 * Upload cached personal books as plaintext JSON — ONLY when the server has no
 * record yet. An existing record is authoritative: the cache is display-only
 * and may hold ids the server has since replaced, so it is discarded instead
 * of overwriting the record.
 * The cache is removed only after a successful upload or when the server record
 * exists. It is kept when the server cannot be checked or the upload fails
 * (error response or thrown request), so a later attempt can retry it.
 * A cache not owned by `userId` (or in the legacy format) is deleted, never uploaded.
 * Best-effort and never throws: failures do not block family create/join.
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
      const uploaded = await uploadCachedBooks(
        userId,
        storedDisplayName,
        cachedBooks,
        apiClient,
      );
      if (!uploaded) {
        console.warn(
          "[Onboarding] The server rejected the personal books cache upload; keeping the cache for a later retry",
        );
        return;
      }
    }
    await browser.storage.local.remove([PERSONAL_BOOKS_CACHE_KEY]);
  } catch {
    // Best-effort: keep the cache for a later retry and never block family join/create.
    console.warn("[Onboarding] Failed to migrate personal books cache");
  }
}
