import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiClient } from "@/api/client";

/**
 * useBookSync under the account check (issues #271, #277). EVERY sync re-reads
 * the page's Readmoo account (`recheck`) right before uploading, even when the
 * status is already `match` — another tab sharing the cookies may have switched
 * accounts since the cached confirmation:
 *
 * - mount auto-sync: status not `match` at mount → skipped, no re-check at all;
 *   otherwise once canAutoSync allows it, recheck → match → sync, anything else
 *   → nothing uploaded, back to idle with no error;
 * - manual sync: recheck first — match → sync, mismatch → nothing (App swaps to
 *   the blocking screen), unknown → nothing, with the exported explanation on
 *   the error channel.
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

/** True when `recheck` ran before the first syncBooks call (or with none). */
function recheckedBeforeSync(recheck: ReturnType<typeof vi.fn>): boolean {
  const recheckAt = recheck.mock.invocationCallOrder[0];
  const syncAt = vi.mocked(syncBooks).mock.invocationCallOrder[0];
  return (
    recheckAt !== undefined && (syncAt === undefined || recheckAt < syncAt)
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the canAutoSync → recheck → syncBooks chain run to completion. */
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
    it("re-checks the confirmed account right before syncing", async () => {
      const account = accountCheck("match");
      renderWithAccount(account);
      await flushAsync();

      expect(canAutoSync).toHaveBeenCalledOnce();
      expect(account.recheck).toHaveBeenCalledOnce();
      expect(recheckedBeforeSync(account.recheck)).toBe(true);
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({ navigate: true, userId: "user-1" }),
      );
    });

    it.each([
      ["match", true],
      ["mismatch", false],
      ["unknown", false],
    ] as const)(
      "pre-upload re-check → %s: uploads = %s",
      async (identity, uploads) => {
        const account = accountCheck("match", identity);
        const { result } = renderWithAccount(account);
        await flushAsync();

        // The throttle allowed it: any skip is the re-check's doing.
        expect(canAutoSync).toHaveBeenCalledOnce();
        expect(account.recheck).toHaveBeenCalledOnce();
        expect(syncBooks).toHaveBeenCalledTimes(uploads ? 1 : 0);
        expect(result.current.syncStatus).toBe(uploads ? "done" : "idle");
        expect(result.current.syncError).toBe("");
        expect(result.current.autoSyncDone).toBe(uploads);
      },
    );

    it("shows syncing while the pre-upload re-check is in flight", async () => {
      const pending = deferred<AccountIdentity>();
      const account = accountCheck("match");
      account.recheck.mockReturnValue(pending.promise);
      const { result } = renderWithAccount(account);
      await flushAsync();

      expect(account.recheck).toHaveBeenCalledOnce();
      expect(result.current.syncStatus).toBe("syncing");
      expect(syncBooks).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve("match");
      });
      await flushAsync();
      expect(syncBooks).toHaveBeenCalledOnce();
    });

    it("does not re-check when the throttle refuses the auto-sync", async () => {
      vi.mocked(canAutoSync).mockResolvedValue(false);
      const account = accountCheck("match");
      const { result } = renderWithAccount(account);
      await flushAsync();

      // Companion: the first case, where canAutoSync allows it, re-checks.
      expect(canAutoSync).toHaveBeenCalledOnce();
      expect(account.recheck).not.toHaveBeenCalled();
      expect(syncBooks).not.toHaveBeenCalled();
      expect(result.current.syncStatus).toBe("idle");
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
    it("re-checks first even when the account is confirmed, then syncs", async () => {
      vi.mocked(canAutoSync).mockResolvedValue(false);
      const account = accountCheck("match");
      const { result } = renderWithAccount(account);

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(account.recheck).toHaveBeenCalledOnce();
      expect(recheckedBeforeSync(account.recheck)).toBe(true);
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

    // `match` status is the #277 case: a cached confirmation gone stale.
    it.each(["match", "unknown"] as const)(
      "does not sync when the re-check finds another account (status %s)",
      async (status) => {
        vi.mocked(canAutoSync).mockResolvedValue(false);
        const account = accountCheck(status, "mismatch");
        const { result } = renderWithAccount(account);

        await act(async () => {
          await result.current.triggerManualSync();
        });

        expect(account.recheck).toHaveBeenCalledOnce();
        expect(syncBooks).not.toHaveBeenCalled();
        expect(result.current.syncStatus).toBe("idle");
        expect(result.current.syncError).toBe("");
      },
    );

    it.each(["match", "unknown"] as const)(
      "does not sync and explains why when the re-check is unknown (status %s)",
      async (status) => {
        vi.mocked(canAutoSync).mockResolvedValue(false);
        const account = accountCheck(status, "unknown");
        const { result } = renderWithAccount(account);

        await act(async () => {
          await result.current.triggerManualSync();
        });

        expect(account.recheck).toHaveBeenCalledOnce();
        expect(syncBooks).not.toHaveBeenCalled();
        expect(result.current.syncStatus).toBe("error");
        expect(result.current.syncError).toBe(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE);
      },
    );

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
