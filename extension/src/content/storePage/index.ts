/** Store-page content script (`content-store.js`, IIFE), registered by the background only while the
 *  switch is on and the host permission granted. See docs/architecture.md → 購買頁家人開放提示. */

import browser from "webextension-polyfill";
import { storeBookIdFromPath } from "moo-family-bookshelf-shared/config/readmooStore";
import {
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "../../constants";
import { isExtensionContextValid } from "../../utils/extensionContext";
import { resolveStoreChip } from "./eligibility";
import { removeStoreChip, renderStoreChip } from "./chip";

// The granted mirror is rewritten on every background reconcile, `permissions.onRemoved` included.
const WATCHED_KEYS = [
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
  FAMILY_ID_KEY,
];

// Bumped by every render; a render whose epoch is no longer current drops its result.
let renderEpoch = 0;

async function render(bookId: string): Promise<void> {
  const epoch = ++renderEpoch;
  if (!isExtensionContextValid()) {
    removeStoreChip();
    return;
  }
  const state = await resolveStoreChip(bookId);
  if (epoch !== renderEpoch) return; // superseded by a newer render
  renderStoreChip(state);
}

function start(): void {
  const bookId = storeBookIdFromPath(location.pathname);
  if (bookId === null) return;
  void render(bookId);
  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!WATCHED_KEYS.some((key) => Object.hasOwn(changes, key))) return;
      void render(bookId);
    });
    watchPageReturn(() => void render(bookId));
  } catch {
    // Extension context already gone: the first render removed any chip.
  }
}

/** Re-render when the user comes back to this page. The login cookie can change in another tab
 *  (account switch) without any storage change, so the storage listener alone would miss it. */
function watchPageReturn(onReturn: () => void): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onReturn();
  });
  window.addEventListener("focus", onReturn);
  window.addEventListener("pageshow", onReturn);
}

start();
