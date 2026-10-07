import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useReauth } from "@/dialog/useReauth";
import { BoolFlag, type ApiClient } from "@/api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
} from "@/constants";
import { verificationLockedMessage } from "@/dialog/verificationMessages";

/**
 * useReauth drives the in-place re-verification prompt shown when a dead token
 * can only be recovered by re-supplying the user's PWA-login verification secret
 * (security-ux Invariant 2). It wires apiClient.onReauthRequired; on the signal
 * it reads userId/familyId/displayName from storage, drives the REAL
 * useVerificationPrompt, re-joins with the secret, persists the fresh token, and
 * self-dismisses.
 *
 * The real useVerificationPrompt hook is intentionally NOT mocked (mock policy);
 * only the ApiClient boundary and chrome.storage are stubbed.
 *
 * Lockout clock: countdownSeconds is derived from Date.now() and re-derived once a second by the
 * real (unmocked) useRetryCountdown. This file runs on real timers, so a slow render would tick
 * 60 → 59 before the assertion and flake; the lockout case freezes Date.now instead, so the seeded
 * wait stays exactly what the backend sent. The afterEach `vi.restoreAllMocks()` restores it, and no
 * timers are faked, so nothing else changes.
 *
 * Family gone after a verified re-join — REGRESSION (PR #130 review): a verification-enabled member
 * whom the owner REMOVED could never learn of it through this prompt. The worker's verification gate
 * answers BEFORE its kicked-tombstone check, so the silent recovery in api/auth-refresh only ever saw
 * VERIFICATION_REQUIRED and handed over to this prompt; the re-join then came back 403
 * MEMBER_REMOVED even though the PIN was CORRECT, and the prompt re-offered the same input — the user
 * looped on "right secret → error" for the tombstone's whole life (6h). The teardown ends that loop
 * and must be byte-identical to the silent path's (both go through `clearFamilyStorageAndBroadcast`,
 * pinned in tests/unit/api/auth-refresh.test.ts); the family's API endpoint dies with the membership,
 * since a client left pointing at the ex-family's server would send the next create/join there.
 *
 * Storage-clear rejection: the teardown's FIRST step writes storage, and that write can genuinely
 * reject (extension context invalidated mid-flow, quota, a storage area that went away). Unguarded, it
 * took the whole handover down: the reauth latch stayed set — muting silent recovery for every later
 * 401, so no prompt ever appeared again this session — the dead token stayed primed, the dialog never
 * flipped to onboarding, and the rejection escaped through submit() as an unhandled promise
 * rejection. Storage is the least critical of the four steps, so it must never block the other three.
 * Swallowing alone was not enough: the aborted clear also skips the endpoint reset that normally rides
 * inside it while the handover still completes, so the catch re-runs that reset itself. Without it the
 * `finally` still notifies onFamilyRemoved, the dialog flips to onboarding while storage holds the
 * ex-family's custom @host — the value the NEXT boot restores, which a later join with a plain
 * (no-@host) sync code never overwrites — and the new family's traffic goes to the old family's
 * server. In that case a family-gone join short-circuits runReauthJoin before its cooldown remove, so
 * the FIRST storage.local.remove is the `[FAMILY_ID_KEY]` clear inside clearFamilyStorageAndBroadcast,
 * which the rejection aborts before its own endpoint reset and FAMILY_REMOVED broadcast.
 * `mockRejectedValueOnce` fails only that call; later removes resolve through the shared setup mock.
 * Exactly two clears, in order (the failed familyId one, then the recovery reset), distinguish the
 * catch-block reset from the one inside clearFamilyStorageAndBroadcast — before the fix there was only
 * ever call #1.
 */

function seedStorage(
  data: Record<string, unknown> = {
    [USER_ID_KEY]: "u1",
    [FAMILY_ID_KEY]: "fam-1",
    [DISPLAY_NAME_KEY]: "小明",
  },
): void {
  vi.mocked(chrome.storage.local.get).mockResolvedValue(data as never);
}

function createApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    onReauthRequired: null,
    onFamilyRemoved: null,
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
    joinFamily: vi.fn().mockResolvedValue({
      data: { authToken: "fresh-token", expiresAt: 7777 },
    }),
    setAuthToken: vi.fn(),
    clearReauthPending: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

/** Fire the reauth signal and wait for the prompt. `info` mirrors what auth-refresh hands over (the
 *  blocking code + its retryAfter); omitting it exercises the legacy no-arg call. */
async function triggerReauth(
  apiClient: ApiClient,
  result: { current: ReturnType<typeof useReauth> },
  info?: { errorCode: string; retryAfter?: number },
): Promise<void> {
  await act(async () => {
    apiClient.onReauthRequired?.(info);
  });
  await waitFor(() => expect(result.current.active).toBe(true));
}

describe("useReauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires apiClient.onReauthRequired on mount and clears it on unmount", () => {
    const apiClient = createApiClient();
    const { unmount } = renderHook(() => useReauth(apiClient));

    expect(apiClient.onReauthRequired).toBeInstanceOf(Function);

    unmount();
    expect(apiClient.onReauthRequired).toBeNull();
  });

  it("opens the verification prompt with the fetched method on the reauth signal", async () => {
    seedStorage();
    const apiClient = createApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "pattern" } }),
    });
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    expect(result.current.method).toBe("pattern");
    expect(apiClient.getVerifyMethod).toHaveBeenCalledWith("u1");
  });

  it("re-joins with the secret, persists the fresh token, and closes the prompt on success", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("1234");
    });

    // joinFamily called with the collected secret (displayName preserved),
    // flagged recovery so the server refuses a user no longer listed (#263).
    expect(apiClient.joinFamily).toHaveBeenCalledWith("fam-1", "u1", "小明", {
      verifySecret: "1234",
      recovery: BoolFlag.TRUE,
    });
    // Fresh token primed in-memory and persisted with its expiry.
    expect(apiClient.setAuthToken).toHaveBeenCalledWith("fresh-token");
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [AUTH_TOKEN_KEY]: "fresh-token",
        [TOKEN_EXPIRES_AT_KEY]: 7777,
      }),
    );
    // Prompt self-dismisses so the user continues where they were.
    expect(result.current.active).toBe(false);
  });

  it("clears the recovery cooldown and calls onSuccess exactly once on a successful re-verify", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReauth(apiClient, { onSuccess }));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("1234");
    });

    // A valid manual re-verify proves the credentials again: a leftover recovery cooldown is removed
    // and the caller notified once so the stale 401 view reloads itself.
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      RECOVERY_COOLDOWN_UNTIL_KEY,
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not clear the cooldown or call onSuccess when the re-verify fails", async () => {
    seedStorage();
    const apiClient = createApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: { code: "VERIFICATION_FAILED", message: "bad" },
      }),
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReauth(apiClient, { onSuccess }));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("0000");
    });

    // Failed verification leaves the cooldown intact and never signals success.
    expect(chrome.storage.local.remove).not.toHaveBeenCalledWith(
      RECOVERY_COOLDOWN_UNTIL_KEY,
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  it("keeps the prompt open and surfaces an error when the secret is wrong, allowing retry", async () => {
    seedStorage();
    const joinFamily = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code: "VERIFICATION_FAILED", message: "bad" },
      })
      .mockResolvedValueOnce({
        data: { authToken: "ok-token", expiresAt: 5555 },
      });
    const apiClient = createApiClient({ joinFamily });
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    // First attempt: wrong secret → prompt stays, no token persisted.
    await act(async () => {
      await result.current.submit("0000");
    });
    expect(result.current.active).toBe(true);
    expect(result.current.error).toBe("驗證失敗，請重新輸入");
    expect(apiClient.setAuthToken).not.toHaveBeenCalled();

    // Retry with the right secret → recovers and closes.
    await act(async () => {
      await result.current.submit("1234");
    });
    expect(apiClient.setAuthToken).toHaveBeenCalledWith("ok-token");
    expect(result.current.active).toBe(false);
  });

  it("releases the reauth latch and closes the prompt when the user cancels", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);
    expect(result.current.active).toBe(true);

    // Cancelling must release the client-side latch so a later authenticated
    // action can re-challenge, and close the prompt without joining.
    act(() => {
      result.current.cancel();
    });

    expect(apiClient.clearReauthPending).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(apiClient.joinFamily).not.toHaveBeenCalled();
  });

  /** A locked member must land on the lockout screen (with the backend's wait) instead of an input that
   *  can only fail; any non-verification code still falls back to plain VERIFICATION_REQUIRED. */
  describe("blocking-code seeding", () => {
    it("opens already locked with the countdown for VERIFICATION_LOCKED + retryAfter", async () => {
      // Freeze Date.now: the real useRetryCountdown re-derives the countdown each second on real timers,
      // so a slow render would tick 60 → 59. See the file header, "Lockout clock".
      const frozenNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(frozenNow);

      seedStorage();
      const apiClient = createApiClient();
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result, {
        errorCode: "VERIFICATION_LOCKED",
        retryAfter: 60,
      });

      await waitFor(() => expect(result.current.locked).toBe(true));
      expect(result.current.countdownSeconds).toBe(60);
      // Copy pinned in tests/unit/dialog/verificationMessages.test.ts; the live
      // countdown variant is rendered by VerificationPrompt.
      expect(result.current.error).toBe(verificationLockedMessage(null));
      // The method is still fetched so the input renders once the lock clears.
      expect(apiClient.getVerifyMethod).toHaveBeenCalledWith("u1");
    });

    it("locks without a countdown when the backend sends no retryAfter", async () => {
      seedStorage();
      const apiClient = createApiClient();
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result, {
        errorCode: "VERIFICATION_LOCKED",
      });

      await waitFor(() => expect(result.current.locked).toBe(true));
      expect(result.current.countdownSeconds).toBeNull();
    });

    it("seeds the wrong-secret message for VERIFICATION_FAILED", async () => {
      seedStorage();
      const apiClient = createApiClient();
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result, {
        errorCode: "VERIFICATION_FAILED",
      });

      expect(result.current.locked).toBe(false);
      expect(result.current.error).toBe("驗證失敗，請重新輸入");
      expect(result.current.countdownSeconds).toBeNull();
    });

    it("falls back to the plain challenge for a non-verification blocking code", async () => {
      seedStorage();
      const apiClient = createApiClient();
      const { result } = renderHook(() => useReauth(apiClient));

      // RATE_LIMITED is not a verification code: seeding it verbatim would make
      // begin() a no-op and never open the prompt.
      await triggerReauth(apiClient, result, {
        errorCode: "RATE_LIMITED",
        retryAfter: 300,
      });

      expect(result.current.active).toBe(true);
      expect(result.current.locked).toBe(false);
      expect(result.current.error).toBe("");
      expect(result.current.countdownSeconds).toBeNull();
      expect(result.current.method).toBe("pin");
    });

    it("keeps the legacy VERIFICATION_REQUIRED path for a no-arg signal", async () => {
      seedStorage();
      const apiClient = createApiClient();
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result);

      expect(result.current.locked).toBe(false);
      expect(result.current.error).toBe("");
      expect(result.current.countdownSeconds).toBeNull();
      expect(result.current.method).toBe("pin");
    });
  });

  /** REGRESSION (PR #130 review): a removed member with a CORRECT PIN looped on 403 MEMBER_REMOVED for
   *  6h. See the file header, "Family gone after a verified re-join". */
  describe("family gone after a verified re-join", () => {
    /** Arbitrary backend-style message: these tests assert PASS-THROUGH, not production copy, so it is
     *  deliberately NOT claimed to be the worker's own wording. */
    const GONE_MESSAGE = "你已被家庭管理者移出，無法重新加入";

    function goneApiClient(errorCode: string): ApiClient {
      return createApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: errorCode, message: GONE_MESSAGE },
        }),
        onFamilyRemoved: vi.fn(),
      });
    }

    it.each([
      "MEMBER_REMOVED",
      "FAMILY_NOT_FOUND",
      "FAMILY_FULL",
      // #263: the recovery-flagged re-join from a user no longer listed.
      "RECOVERY_NOT_MEMBER",
    ])(
      "clears the family binding and closes the prompt on %s",
      async (errorCode) => {
        seedStorage();
        const apiClient = goneApiClient(errorCode);
        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
          useReauth(apiClient, { onSuccess }),
        );

        await triggerReauth(apiClient, result);
        await act(async () => {
          await result.current.submit("1234");
        });

        // Dropped from BOTH storage areas — a synced familyId left behind would
        // let another device hand the local one back and resume rejoining.
        expect(chrome.storage.local.remove).toHaveBeenCalledWith([
          FAMILY_ID_KEY,
        ]);
        expect(chrome.storage.sync.remove).toHaveBeenCalledWith([
          FAMILY_ID_KEY,
        ]);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          type: "FAMILY_REMOVED",
        });
        // The family's endpoint dies with the membership, identical to the silent path (both use
        // clearFamilyStorageAndBroadcast, pinned in tests/unit/api/auth-refresh.test.ts).
        expect(chrome.storage.local.remove).toHaveBeenCalledWith(
          expect.arrayContaining([
            API_ENDPOINT_KEY,
            DECLINED_FAMILY_ENDPOINT_KEY,
          ]),
        );
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          type: "SET_API_ENDPOINT",
          apiEndpoint: null,
        });
        // The dead token goes, the reauth latch is released (a stale one mutes every later 401), and
        // the dialog falls back naming the refusal, so onboarding can explain itself.
        expect(apiClient.setAuthToken).toHaveBeenCalledWith(null);
        expect(apiClient.clearReauthPending).toHaveBeenCalledTimes(1);
        expect(apiClient.onFamilyRemoved).toHaveBeenCalledTimes(1);
        expect(apiClient.onFamilyRemoved).toHaveBeenCalledWith({ errorCode });
        // The prompt is gone rather than errored: there is nothing left to type.
        expect(result.current.active).toBe(false);
        expect(result.current.error).toBe("");
        expect(result.current.locked).toBe(false);
        expect(onSuccess).not.toHaveBeenCalled();
      },
    );

    it("notifies the dialog only after storage and the client are consistent", async () => {
      seedStorage();
      const apiClient = goneApiClient("MEMBER_REMOVED");
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result);
      await act(async () => {
        await result.current.submit("1234");
      });

      // The dialog flips to onboarding inside onFamilyRemoved; arriving before the clears land would
      // render a family-less view over a client and storage that still claim a family.
      const notifiedAt = vi.mocked(apiClient.onFamilyRemoved!).mock
        .invocationCallOrder[0];
      expect(notifiedAt).toBeGreaterThan(
        vi.mocked(chrome.storage.local.remove).mock.invocationCallOrder[0],
      );
      expect(notifiedAt).toBeGreaterThan(
        vi.mocked(apiClient.setAuthToken).mock.invocationCallOrder[0],
      );
      expect(notifiedAt).toBeGreaterThan(
        vi.mocked(apiClient.clearReauthPending).mock.invocationCallOrder[0],
      );
    });

    it("does not re-join after the teardown", async () => {
      seedStorage();
      const apiClient = goneApiClient("MEMBER_REMOVED");
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result);
      await act(async () => {
        await result.current.submit("1234");
      });
      await act(async () => {
        await result.current.submit("1234");
      });

      // Re-spending the server's join budget for a membership that no longer
      // exists is exactly the loop this branch ends.
      expect(apiClient.joinFamily).toHaveBeenCalledTimes(1);
      expect(apiClient.onFamilyRemoved).toHaveBeenCalledTimes(1);
    });

    /** A rejecting storage clear must not block the handover, and the catch re-runs the endpoint reset
     *  it skipped. See the file header, "Storage-clear rejection". */
    it("resets the endpoint choice and finishes the handover even when the storage clear rejects", async () => {
      seedStorage();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The FIRST storage.local.remove here is clearFamilyStorageAndBroadcast's `[FAMILY_ID_KEY]` clear;
      // fail only that call. See the file header, "Storage-clear rejection".
      vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
        new Error("Extension context invalidated"),
      );
      const apiClient = goneApiClient("MEMBER_REMOVED");
      const { result } = renderHook(() => useReauth(apiClient));

      await triggerReauth(apiClient, result);
      await act(async () => {
        // An escaping rejection here is the unhandled-rejection half of the bug.
        await expect(result.current.submit("1234")).resolves.toBeUndefined();
      });

      // The clear really was attempted and really did fail.
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([FAMILY_ID_KEY]);
      // ...and every step after it still ran. Releasing the latch is the one
      // that must not be skipped, or re-auth is muted for the whole session.
      expect(apiClient.clearReauthPending).toHaveBeenCalledTimes(1);
      expect(apiClient.setAuthToken).toHaveBeenCalledWith(null);
      expect(apiClient.onFamilyRemoved).toHaveBeenCalledTimes(1);
      // Swallowed, not silenced — the failure stays on the record. Exactly one warning: the recovery
      // reset below succeeds, so it adds none of its own.
      expect(warn).toHaveBeenCalledTimes(1);
      // The prompt is gone regardless of the storage outcome: with the family
      // gone there is nothing left to type.
      expect(result.current.active).toBe(false);

      // The teardown really was partial — the aborted clear never reached its
      // broadcast, so nothing downstream of it re-ran on its own.
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
        type: "FAMILY_REMOVED",
      });
      // ...which is why the catch re-runs the endpoint reset: otherwise the ex-family's @host survives
      // into the next boot. See the file header, "Storage-clear rejection".
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        expect.arrayContaining([
          API_ENDPOINT_KEY,
          DECLINED_FAMILY_ENDPOINT_KEY,
        ]),
      );
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: null,
      });
      // Exactly two clears, in order: the failed familyId one, then the recovery reset — this sequence
      // separates the catch-block reset from the one that never ran (before the fix: call #1 only).
      const removeCalls = vi.mocked(chrome.storage.local.remove).mock.calls;
      expect(removeCalls).toHaveLength(2);
      expect(removeCalls[0][0]).toEqual([FAMILY_ID_KEY]);
      expect(removeCalls[1][0]).toEqual(
        expect.arrayContaining([
          API_ENDPOINT_KEY,
          DECLINED_FAMILY_ENDPOINT_KEY,
        ]),
      );
      // And it lands BEFORE the dialog is told the family is gone, so onboarding
      // never renders over a stored endpoint still pointing at the ex-family.
      expect(
        vi.mocked(apiClient.onFamilyRemoved!).mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        vi.mocked(chrome.storage.local.remove).mock.invocationCallOrder[1],
      );
    });

    /** The mirror image, and why the classification must be exact: a retryable refusal must NEVER drop
     *  the user's family data (Invariant 2). */
    it.each(["VERIFICATION_FAILED", "RATE_LIMITED"])(
      "keeps the family binding intact on a retryable %s refusal",
      async (errorCode) => {
        seedStorage();
        const apiClient = createApiClient({
          joinFamily: vi.fn().mockResolvedValue({
            error: { code: errorCode, message: "nope" },
          }),
          onFamilyRemoved: vi.fn(),
        });
        const { result } = renderHook(() => useReauth(apiClient));

        await triggerReauth(apiClient, result);
        await act(async () => {
          await result.current.submit("0000");
        });

        expect(chrome.storage.local.remove).not.toHaveBeenCalledWith([
          FAMILY_ID_KEY,
        ]);
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
          type: "FAMILY_REMOVED",
        });
        expect(apiClient.onFamilyRemoved).not.toHaveBeenCalled();
        // The endpoint survives too — the retry the user is about to make has to
        // reach the SAME server, so an over-eager reset would break it.
        expect(chrome.storage.local.remove).not.toHaveBeenCalledWith(
          expect.arrayContaining([
            API_ENDPOINT_KEY,
            DECLINED_FAMILY_ENDPOINT_KEY,
          ]),
        );
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
          type: "SET_API_ENDPOINT",
          apiEndpoint: null,
        });
        // The user can still correct the secret / wait out the window.
        expect(result.current.active).toBe(true);
      },
    );
  });

  it("no-ops the reauth signal when userId or familyId is missing from storage", async () => {
    seedStorage({ [USER_ID_KEY]: "u1" }); // familyId absent
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await act(async () => {
      apiClient.onReauthRequired?.();
    });

    // Give any pending microtasks a chance; the prompt must stay closed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.active).toBe(false);
    expect(apiClient.joinFamily).not.toHaveBeenCalled();
  });
});
