/** Store-page chip storage (#313), read/written DIRECTLY in storage.local: the switch, the background's
 *  permission mirror and the index. See docs/architecture.md → 購買頁家人開放提示. */

import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  buildStorePageIndex,
  parseStorePageIndex,
  type StoreIndexMember,
  type StorePageIndex,
} from "moo-family-bookshelf-shared/storePage/index";
import {
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
} from "../constants";

/** Only an exact BoolFlag.TRUE reads as TRUE; anything else (absent, legacy) as FALSE. */
export function toBoolFlag(value: unknown): BoolFlag {
  return value === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE;
}

async function readFlag(key: string): Promise<BoolFlag> {
  const result = await browser.storage.local.get([key]);
  return toBoolFlag(result[key]);
}

export function readStorePageChipEnabled(): Promise<BoolFlag> {
  return readFlag(STORE_PAGE_CHIP_ENABLED_KEY);
}

export async function writeStorePageChipEnabled(flag: BoolFlag): Promise<void> {
  await browser.storage.local.set({ [STORE_PAGE_CHIP_ENABLED_KEY]: flag });
}

export function readStorePageHostGranted(): Promise<BoolFlag> {
  return readFlag(STORE_PAGE_HOST_GRANTED_KEY);
}

/** Background only: the mirror of `permissions.contains`, for the Dialog (no permissions API there). */
export async function writeStorePageHostGranted(flag: BoolFlag): Promise<void> {
  await browser.storage.local.set({ [STORE_PAGE_HOST_GRANTED_KEY]: flag });
}

export async function readStorePageIndex(): Promise<StorePageIndex | null> {
  const result = await browser.storage.local.get([STORE_PAGE_INDEX_KEY]);
  return parseStorePageIndex(result[STORE_PAGE_INDEX_KEY]);
}

export async function writeStorePageIndex(
  index: StorePageIndex,
): Promise<void> {
  await browser.storage.local.set({ [STORE_PAGE_INDEX_KEY]: index });
}

export async function clearStorePageIndex(): Promise<void> {
  await browser.storage.local.remove(STORE_PAGE_INDEX_KEY);
}

/**
 * After a successful family-shelf load: rebuild the index from `members`, but
 * only while the switch is on — the index never exists with the switch off.
 * Never rejects; a failure only logs.
 */
export async function updateStorePageIndexIfEnabled(
  members: readonly StoreIndexMember[],
  viewerUserId: string,
): Promise<void> {
  try {
    if ((await readStorePageChipEnabled()) !== BoolFlag.TRUE) return;
    await writeStorePageIndex(
      buildStorePageIndex(members, viewerUserId, new Date()),
    );
  } catch (err) {
    console.warn("[storePageChip] index update failed", err);
  }
}
