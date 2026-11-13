import { describe, it, expect, afterEach } from "vitest";
import {
  ACCOUNT_SETTINGS_GATE_MS,
  awaitAccountSettingsGate,
  setAccountSettingsGate,
} from "@/storage/accountSettingsGate";

/**
 * The account-settings gate (#460, src/storage/accountSettingsGate.ts): a module-level promise the
 * Dialog's `AccountSettingsProvider` sets while its open-time refresh runs, so sync reads the
 * settings another browser changed. With no gate a waiter passes at once; a waiter never rejects,
 * even on a rejected gate. The provider's timeout (`ACCOUNT_SETTINGS_GATE_MS`) is pinned here and
 * exercised in tests/component/AccountSettingsContext.test.tsx.
 */

function held() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function watch(promise: Promise<unknown>) {
  const state = { done: false, rejected: false };
  promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.rejected = true;
    },
  );
  return state;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  setAccountSettingsGate(null);
});

describe("awaitAccountSettingsGate", () => {
  it("waits at most 5 seconds for the refresh", () => {
    expect(ACCOUNT_SETTINGS_GATE_MS).toBe(5000);
  });

  it("resolves at once when no gate is set", async () => {
    const wait = watch(awaitAccountSettingsGate());
    await settle();
    expect(wait.done).toBe(true);
  });

  it("waits for the current gate", async () => {
    const gate = held();
    setAccountSettingsGate(gate.promise);

    const wait = watch(awaitAccountSettingsGate());
    await settle();
    expect(wait.done).toBe(false);

    gate.resolve();
    await settle();
    expect(wait.done).toBe(true);
  });

  it("resolves, never rejects, when the gate rejects", async () => {
    const gate = held();
    setAccountSettingsGate(gate.promise);

    const wait = watch(awaitAccountSettingsGate());
    gate.reject(new Error("refresh blew up"));
    await settle();

    expect(wait.rejected).toBe(false);
    expect(wait.done).toBe(true);
  });

  it("passes at once again after the gate is cleared", async () => {
    setAccountSettingsGate(new Promise(() => {}));
    setAccountSettingsGate(null);

    const wait = watch(awaitAccountSettingsGate());
    await settle();
    expect(wait.done).toBe(true);
  });
});
