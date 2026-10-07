/** Opportunistic profile caching on `#/me`: the keys describe the STORED user, so another Readmoo
 *  account's visit writes nothing (#271). See docs/architecture.md → 讀墨帳號確認（已加入家庭時）. */

import browser from "webextension-polyfill";
import { scrapeUserEmail, scrapeDisplayName } from "./scraper";
import { compareAccountIdentity } from "./accountIdentity";
import { isExtensionContextValid } from "../utils/extensionContext";
import { USER_ID_KEY, USER_EMAIL_KEY, DISPLAY_NAME_KEY } from "../constants";

/** True when no account is stored yet, or the stored one is this email's. */
async function isStoredAccount(email: string): Promise<boolean> {
  const stored = await browser.storage.local.get([USER_ID_KEY]);
  const storedUserId = stored[USER_ID_KEY];
  if (typeof storedUserId !== "string") return true;
  return (await compareAccountIdentity(email, storedUserId)) === "match";
}

async function cacheProfileIfStoredAccount(): Promise<void> {
  const email = scrapeUserEmail();
  if (!email) return;

  const displayName = scrapeDisplayName() ?? "";
  try {
    if (!(await isStoredAccount(email))) return;
    await browser.storage.local.set({
      [USER_EMAIL_KEY]: email,
      [DISPLAY_NAME_KEY]: displayName,
    });
  } catch {
    // Best-effort cache: an unreadable store or a failed hash writes nothing.
  }
}

/**
 * Opportunistically scrape user email when on the #/me page
 * and cache it in chrome.storage.local for later use.
 */
export function tryScrapeAndCacheEmail(): void {
  if (!isExtensionContextValid()) return;
  if (!location.hash.includes("/me")) return;

  // Delay slightly to let React render the profile panel
  setTimeout(() => {
    void cacheProfileIfStoredAccount();
  }, 1000);
}
