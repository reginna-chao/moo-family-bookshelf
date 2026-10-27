// Hands the main view's account-check state (issue #271) to code that uploads for the user:
// useBookSync reads it before every auto/manual sync upload. App provides it (useAccountGate.ts).

import { createContext, useContext } from "react";
import type { AccountIdentity } from "../content/accountIdentity";

/**
 * `match`: the page's Readmoo account is confirmed to be the stored user.
 * `unknown`: it could not be confirmed this page load (a `mismatch` never
 * reaches the main view — App swaps to the blocking screen instead).
 */
export type AccountStatus = "match" | "unknown";

export interface AccountCheck {
  status: AccountStatus;
  /** Re-run the check, ALWAYS via `#/me` and back, never the cache (issue #277). Sets `status` to
   *  `match` or `unknown`; a `mismatch` also switches the Dialog to the blocking screen. */
  recheck: () => Promise<AccountIdentity>;
}

/**
 * Shown when a sync (personal-shelf manual sync, or onboarding's first sync)
 * could not confirm the account.
 */
export const ACCOUNT_UNCONFIRMED_SYNC_MESSAGE =
  "無法確認目前登入的讀墨帳號，這次沒有同步書單。請確認已登入讀墨後再試一次。";

// No default value: a consumer mounted without a provider throws instead of uploading (#365).
const AccountCheckContext = createContext<AccountCheck | null>(null);

export const AccountCheckProvider = AccountCheckContext.Provider;

export function useAccountCheck(): AccountCheck {
  const ctx = useContext(AccountCheckContext);
  if (!ctx) {
    throw new Error("useAccountCheck must be used within AccountCheckProvider");
  }
  return ctx;
}
