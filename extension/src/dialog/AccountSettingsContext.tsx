import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApiClient } from "../api/client";
import {
  ACCOUNT_SETTINGS_GATE_MS,
  setAccountSettingsGate,
} from "../storage/accountSettingsGate";
import { AccountSettingsSync } from "./accountSettingsSync";

const AccountSettingsContext = createContext<AccountSettingsSync | null>(null);

interface AccountSettingsProviderProps {
  apiClient: ApiClient;
  userId: string;
  children: React.ReactNode;
}

/**
 * Owns this Dialog open's `AccountSettingsSync` (#460): starts the refresh and
 * publishes its settle-or-timeout promise as the sync gate. A layout effect,
 * not a passive one: React runs children's passive effects before a parent's,
 * so the personal shelf's mount auto-sync would otherwise read no gate. Each
 * Dialog open is a new React root, so this reads the server once per open.
 */
export function AccountSettingsProvider({
  apiClient,
  userId,
  children,
}: AccountSettingsProviderProps) {
  const [sync, setSync] = useState<AccountSettingsSync | null>(null);

  useLayoutEffect(() => {
    const s = new AccountSettingsSync(apiClient, userId);
    setSync(s);
    void s.refresh();
    setAccountSettingsGate(s.whenSettled(ACCOUNT_SETTINGS_GATE_MS));
    return () => {
      s.dispose();
      setAccountSettingsGate(null);
    };
  }, [apiClient, userId]);

  return (
    <AccountSettingsContext.Provider value={sync}>
      {children}
    </AccountSettingsContext.Provider>
  );
}

/** This open's controller; `null` outside the provider (or before its first layout effect), where
 *  `useAccountSetting` writes storage.local only. */
export function useAccountSettingsSync(): AccountSettingsSync | null {
  return useContext(AccountSettingsContext);
}

const noopUnsubscribe = () => {};

/** Whether the server answered 404 to account settings, so every change stays in this browser. */
export function useAccountSettingsUnsupported(): boolean {
  const sync = useAccountSettingsSync();
  const subscribe = useCallback(
    (listener: () => void) =>
      sync === null ? noopUnsubscribe : sync.subscribe(listener),
    [sync],
  );
  const getSnapshot = useCallback(() => sync?.isUnsupported() ?? false, [sync]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
