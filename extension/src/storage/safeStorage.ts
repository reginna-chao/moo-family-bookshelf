/** Best-effort `storage.local` read: `{}` on an orphaned content script or any error. READS only —
 *  never where a failure must surface. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import { isExtensionContextValid } from "../utils/extensionContext";

export async function safeStorageGet(
  keys: string | string[],
): Promise<Record<string, unknown>> {
  // Orphaned content script after an extension reload: chrome.* APIs are gone,
  // so skip the call entirely and degrade to an empty result.
  if (!isExtensionContextValid()) {
    return {};
  }

  try {
    // webextension-polyfill types the result as a broad record; narrow it to the
    // helper's stricter `unknown`-valued shape for callers to type-guard.
    return (await browser.storage.local.get(keys)) as Record<string, unknown>;
  } catch {
    // Context invalidated (or storage otherwise unavailable) mid-read; degrade
    // silently to keep the residual dialog from throwing an uncaught rejection.
    return {};
  }
}
