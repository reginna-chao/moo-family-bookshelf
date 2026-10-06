/**
 * Hands the main view's account-check state (issue #271) to the code that
 * uploads on the user's behalf — useBookSync reads it for both the auto-sync
 * and the manual sync before every upload. App provides it; see
 * dialog/useAccountGate.ts.
 */

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
  /**
   * Run the check again: ALWAYS navigates to `#/me` and back, never the
   * cached result (issue #277). Sets `status` to `match` or `unknown`; a
   * `mismatch` also switches the Dialog to the blocking screen.
   */
  recheck: () => Promise<AccountIdentity>;
}

/** Shown on the personal shelf when a manual sync could not confirm the account. */
export const ACCOUNT_UNCONFIRMED_SYNC_MESSAGE =
  "無法確認目前登入的讀墨帳號，這次沒有同步書單。請確認已登入讀墨後再試一次。";

/**
 * Value with NO provider: behaves as confirmed, i.e. exactly as before #271.
 * App is the only production mount of the main view and always provides one.
 */
const NO_PROVIDER: AccountCheck = {
  status: "match",
  recheck: () => Promise.resolve("match"),
};

const AccountCheckContext = createContext<AccountCheck>(NO_PROVIDER);

export const AccountCheckProvider = AccountCheckContext.Provider;

export function useAccountCheck(): AccountCheck {
  return useContext(AccountCheckContext);
}
