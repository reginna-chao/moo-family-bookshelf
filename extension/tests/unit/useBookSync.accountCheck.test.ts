import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiClient } from "@/api/client";

/**
 * useBookSync under the account check (issue #271). While the page's Readmoo
 * account is not confirmed to be the stored user, nothing may upload without a
 * click: the mount auto-sync is skipped, and a manual sync re-checks first —
 * match → sync, mismatch → nothing (App swaps to the blocking screen), still
 * unknown → nothing, with the exported explanation on the error channel.
 *
 * Each skip has a `match` companion with the same mocks that DOES sync, so the
 * negative assertions cannot pass for an unrelated reason.
 */

vi.mock("@/sync/syncBooks", () => ({
  syncBooks: vi.fn(),
  canAutoSync: vi.fn(),
}));

import { useBookSync } from "@/dialog/useBookSync";
import { syncBooks, canAutoSync } from "@/sync/syncBooks";
import {
  AccountCheckProvider,
  ACCOUNT_UNCONFIRMED_SYNC_MESSAGE,
  type AccountCheck,
  type AccountStatus,
} from "@/dialog/AccountCheckContext";
import type { AccountIdentity } from "@/content/accountIdentity";

const apiClient = {} as ApiClient;

function accountCheck(
  status: AccountStatus,
  recheckResult: AccountIdentity = "match",
): AccountCheck & { recheck: ReturnType<typeof vi.fn> } {
  return { status, recheck: vi.fn().mockResolvedValue(recheckResult) };
}

/** Render useBookSync inside a provider whose value the test can swap. */
function renderWithAccount(initial: AccountCheck) {
  let current = initial;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AccountCheckProvider, { value: current }, children);
  const hook = renderHook(() => useBookSync({ userId: "user-1", apiClient }), {
    wrapper,
  });
  return {
    ...hook,
    setAccount(next: AccountCheck) {
      current = next;
      hook.rerender();
    },
  };
}

/** Let the canAutoSync → syncBooks chain run to completion. */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useBookSync account check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(canAutoSync).mockResolvedValue(true);
    vi.mocked(syncBooks).mockResolvedValue({ success: true, books: [] });
  });

  describe("mount auto-sync", () => {
    it("runs when the account is confirmed (match)", async () => {
      renderWithAccount(accountCheck("match"));
      await flushAsync();

      expect(canAutoSync).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({ navigate: true, userId: "user-1" }),
      );
    });

    it("is skipped while the account is unknown, without re-checking", async () => {
      const account = accountCheck("unknown");
      const { result } = renderWithAccount(account);
      await flushAsync();

      expect(canAutoSync).not.toHaveBeenCalled();
      expect(syncBooks).not.toHaveBeenCalled();
      // No navigation to #/me either: the re-check is click-driven only.
      expect(account.recheck).not.toHaveBeenCalled();
      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.autoSyncDone).toBe(false);
    });

    it("does not start later when the account becomes confirmed", async () => {
      const { setAccount } = renderWithAccount(accountCheck("unknown"));
      await flushAsync();

      setAccount(accountCheck("match"));
      await flushAsync();

      expect(syncBooks).not.toHaveBeenCalled();
    });
  });

  describe("manual sync", () => {
    it("syncs without re-checking when the account is confirmed", async () => {
      vi.mocked(canAutoSync).mockResolvedValue(false);
      const account = accountCheck("match");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(account.recheck).not.toHaveBeenCalled();
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(result.current.syncStatus).toBe("done");
    });

    it("re-checks first and syncs when the account now matches", async () => {
      const account = accountCheck("unknown", "match");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(account.recheck).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({ navigate: true, userId: "user-1" }),
      );
      expect(result.current.syncStatus).toBe("done");
      expect(result.current.syncError).toBe("");
    });

    it("does not sync when the re-check finds another account", async () => {
      const account = accountCheck("unknown", "mismatch");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(account.recheck).toHaveBeenCalledOnce();
      expect(syncBooks).not.toHaveBeenCalled();
      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.syncError).toBe("");
    });

    it("does not sync and explains why when the account is still unknown", async () => {
      const account = accountCheck("unknown", "unknown");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(account.recheck).toHaveBeenCalledOnce();
      expect(syncBooks).not.toHaveBeenCalled();
      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE);
    });

    it("clears the unconfirmed explanation once a retry confirms the account", async () => {
      const account = accountCheck("unknown");
      account.recheck
        .mockResolvedValueOnce("unknown")
        .mockResolvedValueOnce("match");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.syncError).toBe(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE);

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(result.current.syncError).toBe("");
      expect(result.current.syncStatus).toBe("done");
    });
  });
});

describe("ACCOUNT_UNCONFIRMED_SYNC_MESSAGE", () => {
  // Production-anchored copy pin (test.md → Anti-Drift Rules): the hook test
  // above compares against the import, so the literal is pinned once, here.
  it("tells the user nothing was synced and to log in to Readmoo", () => {
    expect(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE).toBe(
      "無法確認目前登入的讀墨帳號，這次沒有同步書單。請確認已登入讀墨後再試一次。",
    );
  });
});
