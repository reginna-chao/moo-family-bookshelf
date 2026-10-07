// App's half of the account check (issue #271): whether the page's Readmoo account is confirmed to be
// `userId`, plus the AccountCheck value App provides to the main view (AccountCheckContext.ts).

import { useState, useCallback, useMemo, useRef } from "react";
import type { AccountIdentity } from "../content/accountIdentity";
import type { AccountCheck, AccountStatus } from "./AccountCheckContext";
import {
  markAccountConfirmed,
  verifyAccountIdentity,
} from "./accountIdentityCheck";

export interface UseAccountGateReturn {
  accountCheck: AccountCheck;
  /** Record a known result for `checkedUserId`: the boot check's, or onboarding's
   *  `cachedIdentity(newUserId)` after its pre-upload check (#281). */
  settleAccount: (identity: AccountIdentity, checkedUserId: string) => void;
}

export function useAccountGate(
  userId: string | null,
  onMismatch: () => void,
): UseAccountGateReturn {
  const [status, setStatus] = useState<AccountStatus>("unknown");
  const onMismatchRef = useRef(onMismatch);
  onMismatchRef.current = onMismatch;

  // Always a fresh `#/me` read (issue #277): the cached match may be stale.
  const recheck = useCallback(async (): Promise<AccountIdentity> => {
    if (!userId) return "unknown";
    const identity = await verifyAccountIdentity(userId);
    setStatus(identity === "match" ? "match" : "unknown");
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
