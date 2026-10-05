/**
 * App's half of the account check (issue #271): holds whether the page's
 * Readmoo account is confirmed to be `userId`, and builds the AccountCheck
 * value App provides to the main view (dialog/AccountCheckContext.ts).
 */

import { useState, useCallback, useMemo, useRef } from "react";
import type { AccountIdentity } from "../content/accountIdentity";
import type { AccountCheck, AccountStatus } from "./AccountCheckContext";
import {
  checkAccountIdentity,
  markAccountConfirmed,
} from "./accountIdentityCheck";

export interface UseAccountGateReturn {
  accountCheck: AccountCheck;
  /**
   * Record a known result for `checkedUserId`: the boot check's, or `match`
   * after onboarding derived the userId from the page's own account.
   */
  settleAccount: (identity: AccountIdentity, checkedUserId: string) => void;
}

export function useAccountGate(
  userId: string | null,
  onMismatch: () => void,
): UseAccountGateReturn {
  const [status, setStatus] = useState<AccountStatus>("unknown");
  const onMismatchRef = useRef(onMismatch);
  onMismatchRef.current = onMismatch;

  const recheck = useCallback(async (): Promise<AccountIdentity> => {
    if (!userId) return "unknown";
    const identity = await checkAccountIdentity(userId);
    if (identity === "match") setStatus("match");
    if (identity === "mismatch") onMismatchRef.current();
    return identity;
  }, [userId]);

  const settleAccount = useCallback(
    (identity: AccountIdentity, checkedUserId: string) => {
      if (identity === "match") markAccountConfirmed(checkedUserId);
      setStatus(identity === "match" ? "match" : "unknown");
    },
    [],
  );

  const accountCheck = useMemo(() => ({ status, recheck }), [status, recheck]);
  return { accountCheck, settleAccount };
}
