import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, act } from "@testing-library/react";
import { useEffect } from "react";
import {
  AccountSettingsProvider,
  useAccountSettingsSync,
  useAccountSettingsUnsupported,
} from "@/dialog/AccountSettingsContext";
import type { AccountSettingsSync } from "@/dialog/accountSettingsSync";
import {
  ACCOUNT_SETTINGS_GATE_MS,
  awaitAccountSettingsGate,
} from "@/storage/accountSettingsGate";
import { BoolFlag, type ApiResponse } from "@/api/client";
import type { AccountSettings } from "moo-family-bookshelf-shared/api/accountSettings";
import { SYNC_ARCHIVED_KEY, USER_ID_KEY } from "@/constants";
import {
  accountSettingsWrapper,
  createAccountSettingsServer,
} from "../helpers/accountSettingsServer";

/**
 * `AccountSettingsProvider` (#460): one `AccountSettingsSync` per mount (= per Dialog open), whose
 * refresh starts at once and whose settle-or-timeout promise becomes the module-level sync gate
 * (`storage/accountSettingsGate.ts`). Acceptance 12: the gate is published from a LAYOUT effect,
 * because React runs a child's passive effects before its parent's — a child mounted in the same
 * commit (the personal shelf's mount auto-sync, `useBookSync`) that awaits the gate from its own
 * mount effect must get the provider's gate, still pending until the refresh settles, never the
 * resolve-at-once of "no gate". The gate gives up after `ACCOUNT_SETTINGS_GATE_MS` (fake timers,
 * restored by the file-level `afterEach`); unmount disposes the controller and clears the gate.
 */

const USER = "a1b2c3d4e5f60718";

function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Awaits the gate from its own mount effect, like `useBookSync`'s mount auto-sync. */
function GateProbe({ onPassed }: { onPassed: () => void }) {
  useEffect(() => {
    void awaitAccountSettingsGate().then(onPassed);
  }, [onPassed]);
  return null;
}

function SyncProbe({
  onSync,
}: {
  onSync: (s: AccountSettingsSync | null) => void;
}) {
  onSync(useAccountSettingsSync());
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ [USER_ID_KEY]: USER });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AccountSettingsProvider", () => {
  it("holds a child's mount-effect gate wait until the refresh settles (acceptance 12)", async () => {
    const server = createAccountSettingsServer({ syncArchived: BoolFlag.TRUE });
    const reply = held<ApiResponse<AccountSettings>>();
    server.get.mockReturnValueOnce(reply.promise);
    const onPassed = vi.fn();

    const { unmount } = render(
      <AccountSettingsProvider apiClient={server.client} userId={USER}>
        <GateProbe onPassed={onPassed} />
      </AccountSettingsProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(server.get).toHaveBeenCalledTimes(1);
    expect(onPassed).not.toHaveBeenCalled();

    await act(async () => {
      reply.release({ data: { syncArchived: BoolFlag.TRUE } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onPassed).toHaveBeenCalledTimes(1);
    // The refresh had already cached the server's value when the gate opened.
    const stored = await chrome.storage.local.get(null);
    expect(stored).toMatchObject({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
    unmount();
  });

  it("opens the gate after ACCOUNT_SETTINGS_GATE_MS when the refresh never settles", async () => {
    expect(ACCOUNT_SETTINGS_GATE_MS).toBe(5000);
    vi.useFakeTimers();
    const server = createAccountSettingsServer();
    server.get.mockReturnValueOnce(new Promise(() => {}));
    const onPassed = vi.fn();

    const { unmount } = render(
      <AccountSettingsProvider apiClient={server.client} userId={USER}>
        <GateProbe onPassed={onPassed} />
      </AccountSettingsProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_GATE_MS - 1);
    });
    expect(onPassed).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onPassed).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("clears the gate and disposes its controller on unmount", async () => {
    const server = createAccountSettingsServer();
    server.get.mockReturnValueOnce(new Promise(() => {}));
    const captured: { sync: AccountSettingsSync | null } = { sync: null };

    const { unmount } = render(
      <AccountSettingsProvider apiClient={server.client} userId={USER}>
        <SyncProbe onSync={(s) => (captured.sync = s)} />
      </AccountSettingsProvider>,
    );
    expect(captured.sync).not.toBeNull();
    unmount();

    let passed = false;
    void awaitAccountSettingsGate().then(() => {
      passed = true;
    });
    await Promise.resolve();
    expect(passed).toBe(true);
    await expect(
      captured.sync!.save("syncArchived", BoolFlag.TRUE),
    ).resolves.toBe("stale");
    expect(server.patch).not.toHaveBeenCalled();
  });
});

describe("useAccountSettingsUnsupported", () => {
  it("is false without a provider, and the controller is null there", () => {
    const { result } = renderHook(() => ({
      unsupported: useAccountSettingsUnsupported(),
      sync: useAccountSettingsSync(),
    }));
    expect(result.current.unsupported).toBe(false);
    expect(result.current.sync).toBeNull();
  });

  it("turns true once the server answers the read with 404 NOT_FOUND", async () => {
    const server = createAccountSettingsServer();
    server.get.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = renderHook(() => useAccountSettingsUnsupported(), {
      wrapper: accountSettingsWrapper(server.client, USER),
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe(true);
  });

  it("stays false on any other read failure", async () => {
    const server = createAccountSettingsServer();
    server.get.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = renderHook(() => useAccountSettingsUnsupported(), {
      wrapper: accountSettingsWrapper(server.client, USER),
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe(false);
  });
});
