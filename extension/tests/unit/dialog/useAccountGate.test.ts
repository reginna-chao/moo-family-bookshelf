import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * useAccountGate (issue #271): App's account status for the main view. A
 * re-check that confirms the account flips it to `match`; one that finds a
 * different account hands App the switch to the blocking screen; anything
 * else leaves it `unknown`. The navigation-backed check is mocked here — it is
 * covered in tests/unit/dialog/accountIdentityCheck.test.ts.
 */

vi.mock("@/dialog/accountIdentityCheck", () => ({
  checkAccountIdentity: vi.fn(),
  markAccountConfirmed: vi.fn(),
  forgetAccountConfirmation: vi.fn(),
}));

import { useAccountGate } from "@/dialog/useAccountGate";
import {
  checkAccountIdentity,
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
      vi.mocked(checkAccountIdentity).mockResolvedValue(identity);
      const onMismatch = vi.fn();
      const { result } = renderHook(() => useAccountGate("user-1", onMismatch));

      let returned: string | undefined;
      await act(async () => {
        returned = await result.current.accountCheck.recheck();
      });

      expect(checkAccountIdentity).toHaveBeenCalledWith("user-1");
      expect(returned).toBe(identity);
      expect(result.current.accountCheck.status).toBe(expectedStatus);
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
