import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { STORE_PAGE_HOST_GRANTED_KEY } from "../constants";
import {
  readStorePageHostGranted,
  toBoolFlag,
  updateStorePageIndexIfEnabled,
} from "../storage/storePageChip";
import {
  STORE_CHIP_OPEN_OPTIONS_FALLBACK,
  storeChipVisibleMessage,
} from "../options/storePageChipMessages";
import { useFamilyData } from "./FamilyDataContext";
import { useAccountSetting } from "./useAccountSetting";
import type { LoadState, MemberBooks } from "./familyDataTypes";

export interface UseStorePageChipResult {
  enabled: BoolFlag;
  /** The background's mirror of the host permission (the Dialog has no permissions API). */
  granted: BoolFlag;
  /** On for the account but not granted in this browser: the 前往設定頁授權 control shows. */
  needsGrant: boolean;
  /** Shown under the switch; `""` when there is nothing to say. */
  hint: string;
  /** A failed save of the switch; `""` when there is nothing to report. */
  message: string;
  toggle: () => void;
  /** Open the options page, where the permission prompt lives. */
  openOptions: () => void;
}

/** Ask the background to open the options page; `onFail` when it cannot (Firefox's sleeping page). */
function openOptionsPage(onFail: () => void): void {
  try {
    void Promise.resolve(
      browser.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" }),
    )
      .then((response: unknown) => {
        if (response === undefined) onFail();
      })
      .catch(onFail);
  } catch {
    onFail();
  }
}

/**
 * The 個人設定 store-page chip switch, an account setting (#460) the options
 * page also writes. Turning it on needs this browser's host permission, which
 * only the options page can request, so without it the switch opens that page
 * instead. `familyId` is the family the on-screen shelf belongs to; the index
 * is bound to it.
 */
export function useStorePageChip(
  userId: string,
  familyId: string,
): UseStorePageChipResult {
  const { bookshelfMembers, bookshelfState } = useFamilyData();
  const setting = useAccountSetting("storePageChipEnabled", BoolFlag.FALSE);
  const { value: enabled, change } = setting;
  const [granted, setGranted] = useState<BoolFlag>(BoolFlag.FALSE);
  const [hint, setHint] = useState("");
  const membersRef = useRef<readonly MemberBooks[]>(bookshelfMembers);
  const stateRef = useRef<LoadState>(bookshelfState);

  useEffect(() => {
    membersRef.current = bookshelfMembers;
    stateRef.current = bookshelfState;
  }, [bookshelfMembers, bookshelfState]);

  useEffect(() => {
    let cancelled = false;
    void readStorePageHostGranted()
      .then((storedGranted) => {
        if (!cancelled) setGranted(storedGranted);
      })
      .catch(() => {
        // storage.local unavailable — keep the default
      });
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (!Object.hasOwn(changes, STORE_PAGE_HOST_GRANTED_KEY)) return;
      const nextGranted = toBoolFlag(
        changes[STORE_PAGE_HOST_GRANTED_KEY].newValue,
      );
      setGranted(nextGranted);
      if (nextGranted === BoolFlag.TRUE) setHint("");
    };
    try {
      browser.storage.onChanged.addListener(listener);
    } catch {
      // Extension context may be invalidated
    }
    return () => {
      cancelled = true;
      try {
        browser.storage.onChanged.removeListener(listener);
      } catch {
        // Extension context may be invalidated
      }
    };
  }, []);

  const openOptions = useCallback(() => {
    setHint("");
    openOptionsPage(() => setHint(STORE_CHIP_OPEN_OPTIONS_FALLBACK));
  }, []);

  const toggle = useCallback(() => {
    setHint("");
    if (enabled !== BoolFlag.TRUE && granted !== BoolFlag.TRUE) {
      openOptions();
      return;
    }
    const next = enabled === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    // Index a loaded shelf only once the switch is stored on; the writer re-checks the binding, and
    // a running refresh indexes itself on landing.
    void change(next).then((outcome) => {
      if (next !== BoolFlag.TRUE) return;
      if (outcome !== "saved" && outcome !== "localOnly") return;
      if (stateRef.current !== "ready") return;
      void updateStorePageIndexIfEnabled(membersRef.current, userId, familyId);
    });
  }, [enabled, granted, change, openOptions, userId, familyId]);

  const enabledOn = enabled === BoolFlag.TRUE;
  const grantedOn = granted === BoolFlag.TRUE;
  return {
    enabled,
    granted,
    needsGrant: enabledOn && !grantedOn,
    hint: storeChipVisibleMessage(enabledOn, grantedOn, hint, "dialog"),
    message: setting.message,
    toggle,
    openOptions,
  };
}
