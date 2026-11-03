/** Store-page chip (#313): registers the store-page content script only while the user has both turned
 *  the switch on and granted the optional host permission. See docs/architecture.md → 購買頁家人開放提示. */

import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import { parseStorePageIndex } from "moo-family-bookshelf-shared/storePage/index";
import {
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "../constants";
import {
  clearStorePageIndex,
  readStorePageChipEnabled,
  writeStorePageHostGranted,
} from "../storage/storePageChip";

export const STORE_PAGE_SCRIPT_ID = "moo-store-page";

/** True when the optional store-page host permission is currently granted. */
export async function hasStoreHostPermission(): Promise<boolean> {
  return browser.permissions.contains({
    origins: [...READMOO_STORE_MATCH_PATTERNS],
  });
}

async function isScriptRegistered(): Promise<boolean> {
  const scripts = await browser.scripting.getRegisteredContentScripts({
    ids: [STORE_PAGE_SCRIPT_ID],
  });
  return scripts.length > 0;
}

async function registerStoreScript(): Promise<void> {
  await browser.scripting.registerContentScripts([
    {
      id: STORE_PAGE_SCRIPT_ID,
      matches: [...READMOO_STORE_MATCH_PATTERNS],
      js: ["content-store.js"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
}

async function alignScriptRegistration(): Promise<void> {
  try {
    const granted = await hasStoreHostPermission();
    await writeStorePageHostGranted(granted ? BoolFlag.TRUE : BoolFlag.FALSE);
    const enabled = (await readStorePageChipEnabled()) === BoolFlag.TRUE;
    const want = granted && enabled;
    const registered = await isScriptRegistered();
    if (want && !registered) await registerStoreScript();
    if (!want && registered) {
      await browser.scripting.unregisterContentScripts({
        ids: [STORE_PAGE_SCRIPT_ID],
      });
    }
  } catch (err) {
    console.warn("[storePageScript] reconcile failed", err);
  }
}

/** True only while the switch is on and the stored index parses and names the stored user and family. */
function isIndexStillBound(stored: Record<string, unknown>): boolean {
  if (stored[STORE_PAGE_CHIP_ENABLED_KEY] !== BoolFlag.TRUE) return false;
  const index = parseStorePageIndex(stored[STORE_PAGE_INDEX_KEY]);
  if (index === null) return false;
  return (
    index.viewerUserId === stored[USER_ID_KEY] &&
    index.familyId === stored[FAMILY_ID_KEY]
  );
}

/** Its own step, so a failing permission or scripting call above never leaves an index behind;
 *  also drops an index the stored binding no longer names (a write racing a leave). */
async function clearIndexUnlessEnabled(): Promise<void> {
  try {
    // Read fresh: the Dialog may have switched on (and written an index) since the step above.
    const stored = await browser.storage.local.get([
      STORE_PAGE_CHIP_ENABLED_KEY,
      USER_ID_KEY,
      FAMILY_ID_KEY,
      STORE_PAGE_INDEX_KEY,
    ]);
    if (stored[STORE_PAGE_INDEX_KEY] === undefined) return;
    if (!isIndexStillBound(stored)) await clearStorePageIndex();
  } catch (err) {
    console.warn("[storePageScript] index clear failed", err);
  }
}

async function runReconcile(): Promise<void> {
  await alignScriptRegistration();
  await clearIndexUnlessEnabled();
}

// Serialises reconciles, so two events never register the same script id at once (the second throws).
let chain: Promise<void> = Promise.resolve();

/**
 * Bring the registered store-page script, the permission mirror and the index
 * in line with the current switch and permission. Idempotent, so any event may
 * call it; calls run one at a time in arrival order. Never rejects.
 */
export function reconcileStorePageScript(): Promise<void> {
  chain = chain.then(runReconcile);
  return chain;
}
