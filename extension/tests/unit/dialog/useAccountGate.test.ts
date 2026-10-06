import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * useAccountGate (issues #271, #277): App's account status for the main view.
 * `recheck` ALWAYS runs the uncached verifyAccountIdentity (never the cached
 * Dialog-open check). A re-check that confirms the account sets `match`; one
 * that finds a different account hands App the switch to the blocking screen;
 * anything else sets `unknown` — also over an earlier `match`. The
 * navigation-backed check is mocked here — it is covered in
 * tests/unit/dialog/accountIdentityCheck.test.ts.
 */

vi.mock("@/dialog/accountIdentityCheck", () => ({
  checkAccountIdentity: vi.fn(),
  verifyAccountIdentity: vi.fn(),
  markAccountConfirmed: vi.fn(),
  forgetAccountConfirmation: vi.fn(),
}));

import { useAccountGate } from "@/dialog/useAccountGate";
import {
  checkAccountIdentity,
  verifyAccountIdentity,
  markAccountConfirmed,
} from "@/dialog/accountIdentityCheck";

describe("useAccountGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts unknown", () => {
    const { result } = renderHook(() => useAccountGate("user-1", vi.fn()));
    expect(result.current.accountCheck.status).toBe("unknown");
  });

  it.each([
    ["match", "match", false],
    ["unknown", "unknown", false],
    ["mismatch", "unknown", true],
  ] as const)(
    "recheck → %s leaves status %s (mismatch handed to App: %s)",
    async (identity, expectedStatus, mismatchReported) => {
      vi.mocked(verifyAccountIdentity).mockResolvedValue(identity);
      const onMismatch = vi.fn();
      const { result } = renderHook(() => useAccountGate("user-1", onMismatch));

      let returned: string | undefined;
      await act(async () => {
        returned = await result.current.accountCheck.recheck();
      });

      expect(verifyAccountIdentity).toHaveBeenCalledOnce();
      expect(verifyAccountIdentity).toHaveBeenCalledWith("user-1");
      // Never the cached Dialog-open check: its match may be stale (#277).
      expect(checkAccountIdentity).not.toHaveBeenCalled();
      expect(returned).toBe(identity);
      expect(result.current.accountCheck.status).toBe(expectedStatus);
      expect(onMismatch).toHaveBeenCalledTimes(mismatchReported ? 1 : 0);
    },
  );

  it.each([
    ["unknown", false],
    ["mismatch", true],
  ] as const)(
    "a confirmed status drops to unknown when a recheck resolves %s",
    async (identity, mismatchReported) => {
      vi.mocked(verifyAccountIdentity).mockResolvedValue(identity);
      const onMismatch = vi.fn();
      const { result } = renderHook(() => useAccountGate("user-1", onMismatch));
      act(() => {
        result.current.settleAccount("match", "user-1");
      });
      expect(result.current.accountCheck.status).toBe("match");

      await act(async () => {
        await result.current.accountCheck.recheck();
      });

      expect(result.current.accountCheck.status).toBe("unknown");
      expect(onMismatch).toHaveBeenCalledTimes(mismatchReported ? 1 : 0);
    },
  );

  it("does not check at all without a userId", async () => {
    const { result } = renderHook(() => useAccountGate(null, vi.fn()));

    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.accountCheck.recheck();
    });

    expect(returned).toBe("unknown");
    expect(verifyAccountIdentity).not.toHaveBeenCalled();
    expect(checkAccountIdentity).not.toHaveBeenCalled();
  });

  it("settleAccount(match) confirms the account for the page load", () => {
    const { result } = renderHook(() => useAccountGate("user-1", vi.fn()));

    act(() => {
      result.current.settleAccount("match", "user-1");
    });

    expect(result.current.accountCheck.status).toBe("match");
    expect(markAccountConfirmed).toHaveBeenCalledWith("user-1");
  });

  it.each(["unknown", "mismatch"] as const)(
    "settleAccount(%s) records no confirmation",
    (identity) => {
      const { result } = renderHook(() => useAccountGate("user-1", vi.fn()));

      act(() => {
        result.current.settleAccount(identity, "user-1");
      });

      expect(result.current.accountCheck.status).toBe("unknown");
      expect(markAccountConfirmed).not.toHaveBeenCalled();
    },
  );
});
