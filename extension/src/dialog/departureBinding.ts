import browser from "webextension-polyfill";
import { FAMILY_ID_KEY, USER_ID_KEY } from "../constants";

/**
 * Whether storage still binds the account and family a leave / delete was sent for. False only
 * when storage binds ANOTHER account or family. No family bound any more (another tab left or was
 * removed) with no account or the same account is true, and so is a read that throws: the caller
 * still clears (a deleted account or a completed leave must never get stuck, nor leave a deleted
 * account's cache behind). The server is not compared — see docs/architecture.md → 端點切換確認.
 */
export async function departureBindingIsCurrent(binding: {
  userId: string;
  familyId: string;
}): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get([
      USER_ID_KEY,
      FAMILY_ID_KEY,
    ]);
    const storedUser = stored[USER_ID_KEY];
    const storedFamily = stored[FAMILY_ID_KEY];
    // No family bound any more (another tab left or was removed): no other session to keep.
    if (storedFamily === undefined) {
      return storedUser === undefined || storedUser === binding.userId;
    }
    return storedUser === binding.userId && storedFamily === binding.familyId;
  } catch {
    return true;
  }
}
