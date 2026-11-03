/** What the store page shows for a book: every stored condition first, the login-cookie check (it
 *  hashes) last, gating both the names and the stale hint. See docs/architecture.md → 購買頁家人開放提示. */

import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  isStoreIndexFresh,
  lookupStoreChipNames,
  parseStorePageIndex,
} from "moo-family-bookshelf-shared/storePage/index";
import {
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "../../constants";
import { safeStorageGet } from "../../storage/safeStorage";
import { cookieConfirmsAccount } from "../pageAccountCookie";

export type StoreChipState =
  { kind: "names"; names: string[] } | { kind: "stale" } | { kind: "none" };

const NONE: StoreChipState = { kind: "none" };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The stored user and the candidate state, or `null` when any stored condition fails. No hashing. */
function candidateFromStorage(
  stored: Record<string, unknown>,
  bookId: string,
  now: number,
): { userId: string; state: StoreChipState } | null {
  const userId = stored[USER_ID_KEY];
  const familyId = stored[FAMILY_ID_KEY];
  if (!isNonEmptyString(userId) || !isNonEmptyString(familyId)) return null;
  if (stored[STORE_PAGE_CHIP_ENABLED_KEY] !== BoolFlag.TRUE) return null;
  // A revoked permission leaves this script running (unregistering removes no injected script).
  if (stored[STORE_PAGE_HOST_GRANTED_KEY] !== BoolFlag.TRUE) return null;
  const index = parseStorePageIndex(stored[STORE_PAGE_INDEX_KEY]);
  if (index === null || index.viewerUserId !== userId) return null;
  if (index.familyId !== familyId) return null;
  // Stale regardless of this book: the hint must not reveal what an old index says about it.
  if (!isStoreIndexFresh(index, now)) {
    return { userId, state: { kind: "stale" } };
  }
  const names = lookupStoreChipNames(index, bookId);
  if (names.length === 0) return null;
  return { userId, state: { kind: "names", names } };
}

/**
 * What to show for `bookId`: the sharing members' names, the stale hint (the
 * index is older than `STORE_INDEX_MAX_AGE_DAYS`), or nothing — no family,
 * switch off, host permission not granted (the background's mirror), no usable
 * index, an index built for another user or another family, nobody sharing
 * the book, or a login cookie that does not confirm the stored account (that
 * last check gates the names and the stale hint alike). Never rejects.
 */
export async function resolveStoreChip(
  bookId: string,
  now: number = Date.now(),
): Promise<StoreChipState> {
  try {
    const stored = await safeStorageGet([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      STORE_PAGE_CHIP_ENABLED_KEY,
      STORE_PAGE_HOST_GRANTED_KEY,
      STORE_PAGE_INDEX_KEY,
    ]);
    const found = candidateFromStorage(stored, bookId, now);
    if (found === null) return NONE;
    return (await cookieConfirmsAccount(found.userId)) ? found.state : NONE;
  } catch {
    return NONE;
  }
}
