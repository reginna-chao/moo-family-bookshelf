import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { buildStorePageIndex } from "moo-family-bookshelf-shared/storePage/index";
import {
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
} from "../constants";
import {
  readStorePageChipEnabled,
  readStorePageHostGranted,
  toBoolFlag,
  writeStorePageChipEnabled,
  writeStorePageIndex,
} from "../storage/storePageChip";
import {
  STORE_CHIP_OPEN_OPTIONS_FALLBACK,
  storeChipVisibleMessage,
} from "../options/storePageChipMessages";
import { useFamilyData } from "./FamilyDataContext";
import type { LoadState, MemberBooks } from "./familyDataTypes";

export interface UseStorePageChipResult {
  enabled: BoolFlag;
  /** The background's mirror of the host permission (the Dialog has no permissions API). */
  granted: BoolFlag;
  /** Shown under the switch; `""` when there is nothing to say. */
  hint: string;
  toggle: () => void;
}

/** Switch on, then index the shelf already on screen — only when it is loaded; a running refresh
 *  writes the index itself when it lands (`updateStorePageIndexIfEnabled`). No rollback on failure. */
async function enableWithIndex(
  userId: string,
  members: readonly MemberBooks[],
  state: LoadState,
): Promise<void> {
  try {
    await writeStorePageChipEnabled(BoolFlag.TRUE);
    if (state !== "ready") return;
    await writeStorePageIndex(buildStorePageIndex(members, userId, new Date()));
  } catch {
    // Storage unavailable — the switch stays on screen, as with the other preferences.
  }
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
 * The 個人設定 store-page chip switch: the same storage flag as the options
 * page. Turning it on needs the host permission, which only the options page
 * can request, so without it the switch opens that page instead.
 */
export function useStorePageChip(userId: string): UseStorePageChipResult {
  const { bookshelfMembers, bookshelfState } = useFamilyData();
  const [enabled, setEnabled] = useState<BoolFlag>(BoolFlag.FALSE);
  const [granted, setGranted] = useState<BoolFlag>(BoolFlag.FALSE);
  const [hint, setHint] = useState("");
  const membersRef = useRef<readonly MemberBooks[]>(bookshelfMembers);
  const stateRef = useRef<LoadState>(bookshelfState);
  // Set once the user toggles, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    membersRef.current = bookshelfMembers;
    stateRef.current = bookshelfState;
  }, [bookshelfMembers, bookshelfState]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([readStorePageChipEnabled(), readStorePageHostGranted()])
      .then(([storedEnabled, storedGranted]) => {
        if (cancelled) return;
        if (!userChoseRef.current) setEnabled(storedEnabled);
        setGranted(storedGranted);
      })
      .catch(() => {
        // storage.local unavailable — keep the defaults
      });
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (Object.hasOwn(changes, STORE_PAGE_CHIP_ENABLED_KEY)) {
        setEnabled(toBoolFlag(changes[STORE_PAGE_CHIP_ENABLED_KEY].newValue));
      }
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

  const toggle = useCallback(() => {
    setHint("");
    userChoseRef.current = true;
    if (enabled === BoolFlag.TRUE) {
      setEnabled(BoolFlag.FALSE);
      void writeStorePageChipEnabled(BoolFlag.FALSE).catch(() => {});
      return;
    }
    if (granted === BoolFlag.TRUE) {
      setEnabled(BoolFlag.TRUE);
      void enableWithIndex(userId, membersRef.current, stateRef.current);
      return;
    }
    openOptionsPage(() => setHint(STORE_CHIP_OPEN_OPTIONS_FALLBACK));
  }, [enabled, granted, userId]);

  const visibleHint = storeChipVisibleMessage(
    enabled === BoolFlag.TRUE,
    granted === BoolFlag.TRUE,
    hint,
  );
  return { enabled, granted, hint: visibleHint, toggle };
}
