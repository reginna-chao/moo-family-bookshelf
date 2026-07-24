import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isVerificationError,
  useVerificationPrompt,
  type VerificationContext,
  type VerificationAttemptResult,
} from "@/dialog/useVerificationPrompt";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";

function createMockApiClient(method: VerifyMethod = "pin"): ApiClient {
  return {
    getVerifyMethod: vi.fn().mockResolvedValue({ data: { method, prompted: 0 } }),
  } as unknown as ApiClient;
}

/** Build a VerificationContext with vi.fn() retry/onCancel for inspection. */
function makeCtx(
  retry: VerificationContext["retry"],
  onCancel: () => void = vi.fn(),
): VerificationContext {
  return { userId: "user-1", retry, onCancel };
}

describe("isVerificationError", () => {
  it.each([
    ["VERIFICATION_REQUIRED", true],
    ["VERIFICATION_FAILED", true],
    ["VERIFICATION_LOCKED", true],
    ["RATE_LIMITED", false],
    ["NOT_FOUND", false],
    ["", false],
    [undefined, false],
  ])("returns %s → %s", (code, expected) => {
    expect(isVerificationError(code as string | undefined)).toBe(expected);
  });
});

describe("useVerificationPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts inactive with no method and no method error", () => {
    const { result } = renderHook(() => useVerificationPrompt(createMockApiClient()));
    expect(result.current.active).toBe(false);
    expect(result.current.method).toBeNull();
    expect(result.current.methodError).toBe(false);
    expect(result.current.locked).toBe(false);
    expect(result.current.submitting).toBe(false);
  });

  it("begin() is a no-op and returns false for non-verification codes", async () => {
    const api = createMockApiClient();
    const { result } = renderHook(() => useVerificationPrompt(api));

    let handled = true;
    await act(async () => {
      handled = await result.current.begin("RATE_LIMITED", makeCtx(vi.fn()));
    });

    expect(handled).toBe(false);
    expect(result.current.active).toBe(false);
    expect(api.getVerifyMethod).not.toHaveBeenCalled();
  });

  it("begin(VERIFICATION_REQUIRED) fetches the method and goes active", async () => {
    const api = createMockApiClient("pattern");
    const { result } = renderHook(() => useVerificationPrompt(api));

    let handled = false;
    await act(async () => {
      handled = await result.current.begin("VERIFICATION_REQUIRED", makeCtx(vi.fn()));
    });

    expect(handled).toBe(true);
    expect(result.current.active).toBe(true);
    expect(result.current.method).toBe("pattern");
    expect(result.current.methodError).toBe(false);
    expect(api.getVerifyMethod).toHaveBeenCalledWith("user-1");
  });

  it("begin() with a genuine 'code' method sets method 'code' without a method error", async () => {
    const api = createMockApiClient("code");
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(vi.fn()));
    });

    expect(result.current.method).toBe("code");
    expect(result.current.methodError).toBe(false);
  });

  it("begin() sets methodError when the backend omits a method (data null)", async () => {
    const api = {
      getVerifyMethod: vi.fn().mockResolvedValue({ data: null }),
    } as unknown as ApiClient;
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(vi.fn()));
    });

    expect(result.current.active).toBe(true);
    expect(result.current.method).toBeNull();
    expect(result.current.methodError).toBe(true);
  });

  it("begin() sets methodError when the backend reports method 'none' for an active challenge", async () => {
    const api = createMockApiClient("none");
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(vi.fn()));
    });

    expect(result.current.method).toBeNull();
    expect(result.current.methodError).toBe(true);
  });

  it("begin(VERIFICATION_FAILED) as the first code still fetches the method (no dead-load)", async () => {
    const api = createMockApiClient("pin");
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_FAILED", makeCtx(vi.fn()));
    });

    expect(result.current.active).toBe(true);
    expect(result.current.locked).toBe(false);
    expect(result.current.error).not.toBe("");
    // Even though the very first code is FAILED, the method must load so the
    // input renders instead of dead-loading on "載入中…".
    expect(result.current.method).toBe("pin");
    expect(result.current.methodError).toBe(false);
    expect(api.getVerifyMethod).toHaveBeenCalledWith("user-1");
  });

  it("begin(VERIFICATION_LOCKED) goes active and locked, still fetching the method", async () => {
    const api = createMockApiClient("pin");
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_LOCKED", makeCtx(vi.fn()));
    });

    expect(result.current.active).toBe(true);
    expect(result.current.locked).toBe(true);
    expect(result.current.error).not.toBe("");
    // The method fetch now runs for every verification code so the prompt never
    // dead-loads once the lock clears.
    expect(api.getVerifyMethod).toHaveBeenCalledWith("user-1");
    expect(result.current.method).toBe("pin");
  });

  it("submit(correct secret) clears the prompt when retry resolves ok", async () => {
    const api = createMockApiClient();
    const retry = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("123456");
    });

    expect(retry).toHaveBeenCalledWith("123456");
    expect(result.current.active).toBe(false);
    expect(result.current.method).toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it("submit(wrong secret) stays active with an error when retry returns VERIFICATION_FAILED", async () => {
    const api = createMockApiClient();
    const retry = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: "VERIFICATION_FAILED" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("000000");
    });

    expect(result.current.active).toBe(true);
    expect(result.current.locked).toBe(false);
    expect(result.current.error).not.toBe("");
    expect(result.current.submitting).toBe(false);
  });

  it("locks after retry returns VERIFICATION_LOCKED and ignores further submits", async () => {
    const api = createMockApiClient();
    const retry = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: "VERIFICATION_LOCKED" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("111111");
    });

    expect(result.current.locked).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);

    // Further submits are a no-op while locked.
    await act(async () => {
      await result.current.submit("222222");
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("submit() shows a generic error when retry fails with a non-verification code", async () => {
    const api = createMockApiClient();
    const retry = vi.fn().mockResolvedValue({ ok: false, errorCode: "SERVER_ERROR" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("123456");
    });

    expect(result.current.active).toBe(true);
    expect(result.current.error).not.toBe("");
    expect(result.current.locked).toBe(false);
  });

  it("keeps the prompt open with a rate-limit message when retry returns RATE_LIMITED", async () => {
    const api = createMockApiClient();
    const retry = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: "RATE_LIMITED" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("123456");
    });

    // 429 join quota exhausted: the prompt stays open so the user can retry once
    // the window clears, with a message distinct from the generic error.
    expect(result.current.active).toBe(true);
    expect(result.current.error).toContain("嘗試次數過多");
    expect(result.current.locked).toBe(false);
    expect(result.current.submitting).toBe(false);
  });

  it("shows the generic error message (not the rate-limit one) for an unknown non-verification code", async () => {
    const api = createMockApiClient();
    const retry = vi.fn().mockResolvedValue({ ok: false, errorCode: "UNKNOWN_THING" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });
    await act(async () => {
      await result.current.submit("123456");
    });

    expect(result.current.active).toBe(true);
    expect(result.current.error).toContain("發生錯誤");
    expect(result.current.error).not.toContain("嘗試次數過多");
  });

  it("cancel() resets state and invokes the caller's onCancel", async () => {
    const api = createMockApiClient();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(vi.fn(), onCancel));
    });
    expect(result.current.active).toBe(true);

    act(() => {
      result.current.cancel();
    });

    expect(result.current.active).toBe(false);
    expect(result.current.method).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores a re-entrant submit while the first retry is still pending (retry fires once)", async () => {
    const api = createMockApiClient("pin");
    let resolveRetry: (r: VerificationAttemptResult) => void = () => {};
    const retry = vi.fn(
      () =>
        new Promise<VerificationAttemptResult>((res) => {
          resolveRetry = res;
        }),
    );
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });

    // First submit kicks off retry but the promise stays pending.
    let firstSubmit: Promise<void> = Promise.resolve();
    act(() => {
      firstSubmit = result.current.submit("111111");
    });
    expect(result.current.submitting).toBe(true);

    // A racing second onComplete (fast double-tap) must be dropped synchronously
    // by the submittingRef guard — no second network join.
    await act(async () => {
      await result.current.submit("222222");
    });
    expect(retry).toHaveBeenCalledTimes(1);

    // Settle the first attempt; still exactly one retry.
    await act(async () => {
      resolveRetry({ ok: false, errorCode: "VERIFICATION_FAILED" });
      await firstSubmit;
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.submitting).toBe(false);
  });

  it("allows a fresh submit once the first attempt has settled (retry fires again)", async () => {
    const api = createMockApiClient("pin");
    const retry = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: "VERIFICATION_FAILED" });
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry));
    });

    await act(async () => {
      await result.current.submit("111111");
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.submitting).toBe(false);

    // The guard is released after the first attempt settles, so the user can
    // correct a wrong secret and submit again.
    await act(async () => {
      await result.current.submit("222222");
    });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenLastCalledWith("222222");
  });

  it("ignores a submit whose retry resolves after cancel (S2: generation advanced)", async () => {
    const api = createMockApiClient("pin");
    let resolveRetry: (r: VerificationAttemptResult) => void = () => {};
    const retry = vi.fn(
      () =>
        new Promise<VerificationAttemptResult>((res) => {
          resolveRetry = res;
        }),
    );
    const onCancel = vi.fn();
    const { result } = renderHook(() => useVerificationPrompt(api));

    await act(async () => {
      await result.current.begin("VERIFICATION_REQUIRED", makeCtx(retry, onCancel));
    });

    // Kick off a submit but keep the retry promise pending.
    let submitPromise: Promise<void> = Promise.resolve();
    act(() => {
      submitPromise = result.current.submit("123456");
    });
    expect(result.current.submitting).toBe(true);

    // User cancels while the retry is still in flight → generation advances.
    act(() => {
      result.current.cancel();
    });
    expect(result.current.active).toBe(false);

    // The late resolution must be ignored: no error/method re-applied post-reset.
    await act(async () => {
      resolveRetry({ ok: false, errorCode: "VERIFICATION_FAILED" });
      await submitPromise;
    });

    expect(result.current.active).toBe(false);
    expect(result.current.method).toBeNull();
    expect(result.current.methodError).toBe(false);
    expect(result.current.error).toBe("");
    expect(result.current.submitting).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
