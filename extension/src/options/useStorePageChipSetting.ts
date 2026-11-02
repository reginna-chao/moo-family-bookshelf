import { useCallback, useEffect, useState } from "react";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import { STORE_PAGE_CHIP_ENABLED_KEY } from "../constants";
import { readFamilyId } from "../storage/familyId";
import {
  readStorePageChipEnabled,
  toBoolFlag,
  writeStorePageChipEnabled,
} from "../storage/storePageChip";
import { hasStoreHostPermission } from "../background/storePageScript";
import {
  STORE_CHIP_DENIED_MESSAGE,
  storeChipVisibleMessage,
} from "./storePageChipMessages";

export interface UseStorePageChipSettingResult {
  enabled: BoolFlag;
  /** From `permissions.contains` only — never the background's storage mirror. */
  granted: BoolFlag;
  /** Shown under the switch; `""` when there is nothing to say. */
  message: string;
  hasFamily: boolean;
  toggle: () => void;
}

function toFlag(on: boolean): BoolFlag {
  return on ? BoolFlag.TRUE : BoolFlag.FALSE;
}

/** Ask for the store-page permission; resolves false on refusal or any error. */
function requestStorePermission(): Promise<boolean> {
  try {
    return browser.permissions
      .request({ origins: [...READMOO_STORE_MATCH_PATTERNS] })
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * The options page's store-page chip switch. Turning it on asks for the
 * optional host permission first and saves TRUE only once granted; the
 * background registers the store-page script from that storage change.
 */
export function useStorePageChipSetting(): UseStorePageChipSettingResult {
  const [enabled, setEnabled] = useState<BoolFlag>(BoolFlag.FALSE);
  const [granted, setGranted] = useState<BoolFlag>(BoolFlag.FALSE);
  const [message, setMessage] = useState("");
  const [hasFamily, setHasFamily] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const recheckGranted = async () => {
      const on = await hasStoreHostPermission().catch(() => false);
      if (cancelled) return;
      setGranted(toFlag(on));
      if (on) setMessage("");
    };
    void (async () => {
      const [flag, family] = await Promise.all([
        readStorePageChipEnabled().catch(() => BoolFlag.FALSE),
        readFamilyId().catch(() => null),
      ]);
      if (cancelled) return;
      setEnabled(flag);
      setHasFamily(family !== null);
    })();
    void recheckGranted();

    // The Dialog writes the same switch, and the permission can change in the browser's settings.
    const onStorage = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (!Object.hasOwn(changes, STORE_PAGE_CHIP_ENABLED_KEY)) return;
      setEnabled(toBoolFlag(changes[STORE_PAGE_CHIP_ENABLED_KEY].newValue));
    };
    const onPermission = () => void recheckGranted();
    browser.storage.onChanged.addListener(onStorage);
    browser.permissions.onAdded.addListener(onPermission);
    browser.permissions.onRemoved.addListener(onPermission);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onStorage);
      browser.permissions.onAdded.removeListener(onPermission);
      browser.permissions.onRemoved.removeListener(onPermission);
    };
  }, []);

  const toggle = useCallback(() => {
    setMessage("");
    if (enabled === BoolFlag.TRUE) {
      setEnabled(BoolFlag.FALSE);
      void writeStorePageChipEnabled(BoolFlag.FALSE).catch(() => {});
      return;
    }
    // Called synchronously from the click: browsers grant the prompt only inside a user gesture.
    void requestStorePermission().then(async (ok) => {
      if (!ok) {
        setMessage(STORE_CHIP_DENIED_MESSAGE);
        return;
      }
      setGranted(BoolFlag.TRUE);
      setEnabled(BoolFlag.TRUE);
      await writeStorePageChipEnabled(BoolFlag.TRUE).catch(() => {});
    });
  }, [enabled]);

  const visibleMessage = storeChipVisibleMessage(
    enabled === BoolFlag.TRUE,
    granted === BoolFlag.TRUE,
    message,
  );
  return { enabled, granted, message: visibleMessage, hasFamily, toggle };
}
