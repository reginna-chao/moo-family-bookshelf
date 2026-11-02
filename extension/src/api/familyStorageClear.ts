/** Local teardown when the family is gone for this user (removed, family deleted); split out of
 *  auth-refresh.ts, which re-exports it. */

import browser from "webextension-polyfill";
import { FAMILY_ID_KEY, STORE_PAGE_INDEX_KEY } from "../constants";
import { resetFamilyEndpointChoice } from "../storage/familyEndpointChoice";

/**
 * Clear local + synced family data, then drop this device's family-scoped API
 * endpoint choice.
 *
 * Exported for the dialog's re-verification flow (`dialog/useReauth.ts`), whose
 * own join can be refused with a family-gone code after the silent recovery was
 * blocked by the verification gate: it needs byte-identical teardown, and a
 * second copy of these steps is exactly how the two paths would drift. Housing
 * the endpoint reset here (rather than in each caller) is what structurally
 * guarantees that parity.
 *
 * The store-page chip index (family members' names + book ids) goes with the
 * family id: it must not outlive the membership. The chip switch itself is the
 * user's and stays.
 *
 * The endpoint reset drops BOTH the accepted endpoint and the declined marker,
 * for the same reason `resetFamilyEndpointChoice` gives for a voluntary leave:
 * the endpoint is a FAMILY-scoped setting (the owner picks it, every member
 * adopts it) and must not outlive the membership. A client left pointing at a
 * former family's server would send the next create/join there — userId,
 * display name, the auth token that server issues, and the whole personal book
 * list, unshared books included — and would bake that host into the sync code it
 * hands out next. Being removed ends the membership exactly like leaving does.
 * `resetFamilyEndpointChoice` swallows its own storage failures, so it cannot
 * abort the teardown. It runs AFTER the family-id removals so the endpoint is
 * never reset while the family binding still stands.
 *
 * Deliberately does NOT invoke `onFamilyRemoved` — reacting in the UI is the
 * caller's business, and the two callers do it at different moments.
 */
export async function clearFamilyStorage(): Promise<void> {
  await browser.storage.local.remove([FAMILY_ID_KEY, STORE_PAGE_INDEX_KEY]);
  try {
    await browser.storage.sync.remove([FAMILY_ID_KEY]);
  } catch {
    // sync storage may not be available in all contexts
  }
  await resetFamilyEndpointChoice();
}
