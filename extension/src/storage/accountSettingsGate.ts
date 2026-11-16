/** The account-settings gate (#460): while the Dialog's open-time refresh runs, sync waits for it so it
 *  reads the settings another browser changed. See docs/architecture.md → 書單同步. */

/** The longest any reader waits for the refresh; after it, the stored values are used as they are. */
export const ACCOUNT_SETTINGS_GATE_MS = 5000;

let currentGate: Promise<void> | null = null;

/** Set by `AccountSettingsProvider` on mount (the refresh's settle-or-timeout promise), `null` on unmount. */
export function setAccountSettingsGate(gate: Promise<void> | null): void {
  currentGate = gate;
}

/** Resolves when the current gate does, or at once when there is none. Never rejects. */
export function awaitAccountSettingsGate(): Promise<void> {
  const gate = currentGate;
  if (gate === null) return Promise.resolve();
  return gate.catch(() => undefined);
}
