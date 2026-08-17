/**
 * Renderable `@host` verdict for a live sync-code field: `valid` shows at once,
 * `invalid` only once the value has SETTLED, so the security warning cannot
 * flicker through every intermediate keystroke and train the user to ignore it.
 *
 * Twin of extension/src/dialog/useSyncCodeHostVerdict.ts — same API, same
 * triggers. The policy (what may be rendered, and the delay) lives in shared/
 * so the two apps cannot drift apart on a security-facing disclosure.
 *
 * Settle triggers, any one of which is enough:
 *   1. the value stayed unchanged for SYNC_CODE_HOST_SETTLE_DELAY_MS — the
 *      safety net no input method can bypass (typing, IME, autofill, drop);
 *   2. paste (`settleOnNextChange`);
 *   3. blur, and submit / join press (`settleNow`);
 *   4. a non-empty value at first render — an invite-link prefill the user
 *      never typed, so there is no typing to flicker through.
 */

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
    // Also disarms an unconsumed paste flag (e.g. pasting text identical to
    // what was already in the field never produced a change to consume it);
    // otherwise the next keystroke would settle instantly and flicker.
    forceNextRef.current = false;
    setSettledCode(codeRef.current);
  }, []);

  // Paste needs its own trigger because React's onPaste fires BEFORE the input
  // value updates: `settleNow` here would settle the PRE-paste value and leave
  // the pasted one waiting out the full delay.
  const settleOnNextChange = useCallback(() => {
    forceNextRef.current = true;
  }, []);

  const live = useMemo(() => parseSyncCodeApiHost(code), [code]);
  const result = displayedSyncCodeApiHost(live, settledCode === code);

  return { result, settleNow, settleOnNextChange };
}
