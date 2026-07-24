/**
 * Best-effort storage read helper.
 *
 * After the extension is reloaded / updated / disabled, a content script left
 * behind on the page becomes an orphan: its `browser.storage.local.*` references
 * are severed and any `.get(...)` call throws `Extension context invalidated`.
 * A fire-and-forget `await browser.storage.local.get(...)` then surfaces as an
 * uncaught promise rejection.
 *
 * `safeStorageGet` degrades silently in that case: it checks the context first
 * and swallows any read error, returning an empty result so callers fall back to
 * their existing defaults instead of crashing.
 *
 * NOTE: swallowing the error is intentional and this helper is for best-effort
 * READS only. Do NOT use it where a read failure must be surfaced to the user;
 * callers must be correct when they receive `{}` (an empty object).
 */

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
