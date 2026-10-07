/** Renderable `@host` verdict: `valid` at once, `invalid` only once SETTLED (delay, paste, blur/submit,
 *  prefill). Twin of extension/src/dialog/useSyncCodeHostVerdict.ts; docs/architecture.md → 同步碼位址的驗證與揭露. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayedSyncCodeApiHost,
  SYNC_CODE_HOST_SETTLE_DELAY_MS,
} from "moo-family-bookshelf-shared/api/syncCodeHost";
import {
  parseSyncCodeApiHost,
  type SyncCodeApiHostResult,
} from "@/crypto/syncCode";

export interface UseSyncCodeHostVerdictResult {
  /** Verdict to render — already filtered by the shared display policy. */
  result: SyncCodeApiHostResult;
  /** Settle the CURRENT value now — wire to blur and to submit/join. */
  settleNow: () => void;
  /** Settle the NEXT value as soon as it arrives — wire to onPaste. */
  settleOnNextChange: () => void;
}

export function useSyncCodeHostVerdict(
  code: string,
): UseSyncCodeHostVerdictResult {
  // Seeded with the initial value: a prefilled code was never typed, so it is
  // settled from the very first render (trigger 4).
  const [settledCode, setSettledCode] = useState(code);
  const forceNextRef = useRef(false);
  const codeRef = useRef(code);
  codeRef.current = code;

  useEffect(() => {
    if (settledCode === code) return;
    if (forceNextRef.current) {
      forceNextRef.current = false;
      setSettledCode(code);
      return;
    }
    const timer = setTimeout(() => {
      setSettledCode(code);
    }, SYNC_CODE_HOST_SETTLE_DELAY_MS);
    // Cleared on every re-run and on unmount, so a queued settle can never fire
    // for a value the field no longer holds, nor after the view is gone.
    return () => clearTimeout(timer);
  }, [code, settledCode]);

  const settleNow = useCallback(() => {
    // Also disarms an unconsumed paste flag (a paste identical to the field's value causes no
    // change to consume it), or the next keystroke would settle instantly and flicker.
    forceNextRef.current = false;
    setSettledCode(codeRef.current);
  }, []);

  // React's onPaste fires BEFORE the value updates: `settleNow` would settle the PRE-paste value
  // and leave the pasted one waiting out the full delay.
  const settleOnNextChange = useCallback(() => {
    forceNextRef.current = true;
  }, []);

  const live = useMemo(() => parseSyncCodeApiHost(code), [code]);
  const result = displayedSyncCodeApiHost(live, settledCode === code);

  return { result, settleNow, settleOnNextChange };
}
