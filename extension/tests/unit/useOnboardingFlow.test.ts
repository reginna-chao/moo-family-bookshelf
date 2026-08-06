import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

// Mock crypto.deriveUserId — deterministic hex for tests
vi.mock("@/crypto/hash", () => ({
  deriveUserId: vi.fn().mockResolvedValue("a".repeat(64)),
}));

// Mock onboardingFlow module so we can inject recovery-path outcomes.
// CreateFamilyError is re-exported UNMOCKED: useOnboardingFlow narrows the
// create failure with `instanceof`, so a hand-rolled stand-in would silently
// drift from the production class (and drop the code/retryAfter fields).
vi.mock("@/dialog/onboardingFlow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/dialog/onboardingFlow")>();
  return {
    CreateFamilyError: actual.CreateFamilyError,
    createNewFamily: vi.fn().mockResolvedValue({
      familyId: "fam-new",
      userId: "u",
      syncCode: "moo-sync-code",
    }),
    performJoin: vi.fn().mockResolvedValue({
      ok: true,
      familyId: "fam-joined",
      userId: "u",
    }),
    performSoloRecovery: vi.fn().mockResolvedValue({ recovered: true }),
    tryAutoRecovery: vi.fn().mockResolvedValue({ recovered: false }),
  };
});

// Mock syncCode for handleJoin path (not exercised here, but required for import graph)
vi.mock("@/crypto/syncCode", () => ({
  SyncCodeError: class SyncCodeError extends Error {},
  decodeSyncCode: vi.fn(),
  encodeSyncCode: vi.fn(),
}));

import { waitFor } from "@testing-library/react";
import { useOnboardingFlow } from "@/dialog/useOnboardingFlow";
import { deriveUserId } from "@/crypto/hash";
import { encodeSyncCode } from "@/crypto/syncCode";
import {
  CreateFamilyError,
  createNewFamily,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "@/dialog/onboardingFlow";
import { USER_ID_KEY, FAMILY_ID_KEY, DEFAULT_API_ENDPOINT } from "@/constants";
import { BoolFlag } from "@/api/client";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";
import type { useAutoSetup } from "@/dialog/useAutoSetup";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    lookupUser: vi.fn().mockResolvedValue({
      data: { existingFamilyId: null, memberCount: 0 },
    }),
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    setAuthToken: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    // Every verification prompt loads the method before rendering an input.
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
    ...overrides,
  } as unknown as ApiClient;
}

function createMockAutoSetup(
  overrides: Partial<ReturnType<typeof useAutoSetup>> = {},
): ReturnType<typeof useAutoSetup> {
  return {
    phase: "idle",
    phaseMessage: "",
    errorMessage: "",
    scrapeProfile: vi.fn().mockResolvedValue({
      email: "user@example.com",
      displayName: "User",
    }),
    syncBooks: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useAutoSetup>;
}

function renderFlow(
  apiClient: ApiClient = createMockApiClient(),
  autoSetup: ReturnType<typeof useAutoSetup> = createMockAutoSetup(),
  onFamilyJoined: (familyId: string, userId: string) => void = vi.fn(),
) {
  return renderHook(() =>
    useOnboardingFlow({ apiClient, onFamilyJoined, autoSetup }),
  );
}

/**
 * Drive handleStart such that the hook lands in "recovery-choice".
 * This is the canonical precondition for any test that exercises
 * post-discovery handlers (handleRecoveryChoice*, handleSoloRecovery*).
 */
async function driveToRecoveryChoice(
  apiClient: ApiClient = createMockApiClient({
    lookupUser: vi.fn().mockResolvedValue({
      data: { existingFamilyId: "fam-existing", memberCount: 2 },
    }),
  }),
  autoSetup: ReturnType<typeof useAutoSetup> = createMockAutoSetup(),
  onFamilyJoined: (familyId: string, userId: string) => void = vi.fn(),
) {
  const { result } = renderFlow(apiClient, autoSetup, onFamilyJoined);
  await act(async () => {
    await result.current.handleStart();
  });
  return { result, apiClient, autoSetup, onFamilyJoined };
}

describe("useOnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks wipes implementations — re-apply defaults
    vi.mocked(deriveUserId).mockResolvedValue("a".repeat(64));
    vi.mocked(tryAutoRecovery).mockResolvedValue({ recovered: false });
    vi.mocked(performSoloRecovery).mockResolvedValue({ recovered: true });
    vi.mocked(createNewFamily).mockResolvedValue({
      familyId: "fam-new",
      userId: "u",
      syncCode: "moo-sync-code",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in 'welcome' state", () => {
    const { result } = renderFlow();
    expect(result.current.state).toBe("welcome");
  });

  describe("handleStart → recovery-choice", () => {
    it("routes to 'recovery-choice' when family exists", async () => {
      const apiClient = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
      });

      const { result } = renderFlow(apiClient);
      await act(async () => {
        await result.current.handleStart();
      });

      expect(result.current.state).toBe("recovery-choice");
    });

    it("calls onFamilyJoined when auto-recovery succeeds", async () => {
      const onFamilyJoined = vi.fn();
      const apiClient = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
      });
      vi.mocked(tryAutoRecovery).mockImplementationOnce(async (opts) => {
        opts.onFamilyJoined(opts.familyId, opts.userId);
        return { recovered: true };
      });

      const { result } = renderFlow(
        apiClient,
        createMockAutoSetup(),
        onFamilyJoined,
      );
      await act(async () => {
        await result.current.handleStart();
      });

      expect(onFamilyJoined).toHaveBeenCalledWith(
        "fam-existing",
        expect.any(String),
      );
    });

    it("falls back to 'recovery-choice' when auto-recovery fails", async () => {
      const apiClient = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
      });
      vi.mocked(tryAutoRecovery).mockResolvedValueOnce({ recovered: false });

      const { result } = renderFlow(apiClient);
      await act(async () => {
        await result.current.handleStart();
      });

      expect(tryAutoRecovery).toHaveBeenCalledOnce();
      expect(result.current.state).toBe("recovery-choice");
    });
  });

  describe("recovery navigation handlers", () => {
    it("handleRecoveryChoiceUseSyncCode → state 'recovery-join' and clears syncCodeInput", async () => {
      const { result } = await driveToRecoveryChoice();

      act(() => {
        result.current.setSyncCodeInput("stale-input");
      });
      expect(result.current.syncCodeInput).toBe("stale-input");

      act(() => {
        result.current.handleRecoveryChoiceUseSyncCode();
      });

      expect(result.current.state).toBe("recovery-join");
      expect(result.current.syncCodeInput).toBe("");
    });

    it("handleRecoveryChoiceSkip → tries solo recovery, then state 'solo-recovery-confirm' on failure", async () => {
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const { result } = await driveToRecoveryChoice();

      await act(async () => {
        await result.current.handleRecoveryChoiceSkip();
      });

      expect(performSoloRecovery).toHaveBeenCalled();
      expect(result.current.state).toBe("solo-recovery-confirm");
    });

    it("handleRecoveryJoinBack → state 'recovery-choice'", async () => {
      const { result } = await driveToRecoveryChoice();

      act(() => {
        result.current.handleRecoveryChoiceUseSyncCode();
      });
      expect(result.current.state).toBe("recovery-join");

      act(() => {
        result.current.handleRecoveryJoinBack();
      });

      expect(result.current.state).toBe("recovery-choice");
    });

    it("handleSoloRecoveryBack → state 'recovery-choice'", async () => {
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const { result } = await driveToRecoveryChoice();

      await act(async () => {
        await result.current.handleRecoveryChoiceSkip();
      });
      expect(result.current.state).toBe("solo-recovery-confirm");

      act(() => {
        result.current.handleSoloRecoveryBack();
      });

      expect(result.current.state).toBe("recovery-choice");
    });
  });

  describe("handleSoloRecoveryConfirm", () => {
    /** Drive to solo-recovery-confirm by making handleRecoveryChoiceSkip's attempt fail */
    async function driveToSoloRecoveryConfirm() {
      // Make the first performSoloRecovery call (from handleRecoveryChoiceSkip) fail
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const driven = await driveToRecoveryChoice();

      await act(async () => {
        await driven.result.current.handleRecoveryChoiceSkip();
      });
      expect(driven.result.current.state).toBe("solo-recovery-confirm");
      return driven;
    }

    it("calls performSoloRecovery with the familyId captured during lookup", async () => {
      const { result, apiClient } = await driveToSoloRecoveryConfirm();
      vi.mocked(performSoloRecovery).mockImplementationOnce(async (opts) => {
        opts.onFamilyJoined(opts.familyId, opts.userId);
        return { recovered: true };
      });

      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });

      // Called twice: once by handleRecoveryChoiceSkip (failed), once by handleSoloRecoveryConfirm
      expect(performSoloRecovery).toHaveBeenCalledTimes(2);
      const arg = vi.mocked(performSoloRecovery).mock.calls[1][0];
      expect(arg.familyId).toBe("fam-existing");
      expect(arg.apiClient).toBe(apiClient);
    });

    it("sets state to 'error' when performSoloRecovery returns { recovered: false }", async () => {
      const { result } = await driveToSoloRecoveryConfirm();
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });

      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });

      expect(result.current.state).toBe("error");
      expect(result.current.errorMessage).toContain("恢復失敗");
    });

    it("sets state to 'error' when performSoloRecovery throws", async () => {
      const { result } = await driveToSoloRecoveryConfirm();
      vi.mocked(performSoloRecovery).mockRejectedValueOnce(
        new Error("network down"),
      );

      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });

      expect(result.current.state).toBe("error");
      expect(result.current.errorMessage).toBe("network down");
    });

    it("errors out when recoveryFamilyIdRef is empty (no prior handleStart)", async () => {
      // Fresh render — handleStart was never called, so recoveryFamilyIdRef is empty
      const { result } = renderFlow();

      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });

      expect(result.current.state).toBe("error");
      expect(result.current.errorMessage).toContain("恢復資料遺失");
      expect(performSoloRecovery).not.toHaveBeenCalled();
    });
  });

  describe("handleRetry", () => {
    it("returns to 'welcome' when called from 'recovery-choice'", async () => {
      const { result } = await driveToRecoveryChoice();
      expect(result.current.state).toBe("recovery-choice");

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.state).toBe("welcome");
    });

    it("returns to 'welcome' when called from 'recovery-join'", async () => {
      const { result } = await driveToRecoveryChoice();
      act(() => {
        result.current.handleRecoveryChoiceUseSyncCode();
      });
      expect(result.current.state).toBe("recovery-join");

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.state).toBe("welcome");
    });

    it("returns to 'welcome' when called from 'solo-recovery-confirm'", async () => {
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const { result } = await driveToRecoveryChoice();
      await act(async () => {
        await result.current.handleRecoveryChoiceSkip();
      });
      expect(result.current.state).toBe("solo-recovery-confirm");

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.state).toBe("welcome");
    });

    it("returns to 'idle' when called from non-recovery error with an email captured", async () => {
      // Drive to idle via a clean handleStart (no existing family)
      const { result } = renderFlow();
      await act(async () => {
        await result.current.handleStart();
      });
      expect(result.current.state).toBe("idle");
      expect(result.current.userEmail).toBe("user@example.com");

      act(() => {
        result.current.handleRetry();
      });

      // With a captured email and no recovery flow in progress, retry stays on idle
      expect(result.current.state).toBe("idle");
    });

    it("returns to 'welcome' when called without a captured email", () => {
      const { result } = renderFlow();
      // No handleStart called — userEmail is still null

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.state).toBe("welcome");
    });
  });

  /**
   * SEC-1: an existing verification-enabled member reconnecting on a fresh
   * device gets VERIFICATION_REQUIRED. Every join path must bridge to the
   * "verify-prompt" state (not a generic error / silent recovery-choice
   * fallback), retry with the secret, and restore the prior view on cancel.
   */
  describe("verification prompt bridge (verify-prompt)", () => {
    function apiClientWithFamily(method: VerifyMethod = "pin"): ApiClient {
      return createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method, prompted: 0 } }),
      });
    }

    it("auto-recovery: VERIFICATION_REQUIRED routes to verify-prompt and fetches the method", async () => {
      vi.mocked(tryAutoRecovery).mockResolvedValue({
        recovered: false,
        errorCode: "VERIFICATION_REQUIRED",
      });
      const { result } = renderFlow(apiClientWithFamily("pattern"));

      await act(async () => {
        await result.current.handleStart();
      });

      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.verify.active).toBe(true);
      expect(result.current.verify.method).toBe("pattern");
    });

    it("auto-recovery: entering the correct secret retries and completes the join", async () => {
      const onFamilyJoined = vi.fn();
      // First (no secret) fails with verification; retry (with secret) succeeds.
      vi.mocked(tryAutoRecovery).mockImplementation(async (opts) => {
        if (opts.verifySecret) {
          opts.onFamilyJoined(opts.familyId, opts.userId);
          return { recovered: true };
        }
        return { recovered: false, errorCode: "VERIFICATION_REQUIRED" };
      });
      const { result } = renderFlow(
        apiClientWithFamily(),
        createMockAutoSetup(),
        onFamilyJoined,
      );

      await act(async () => {
        await result.current.handleStart();
      });
      expect(result.current.state).toBe("verify-prompt");

      await act(async () => {
        await result.current.verify.submit("123456");
      });

      expect(onFamilyJoined).toHaveBeenCalledWith(
        "fam-existing",
        expect.any(String),
      );
      const lastCall = vi.mocked(tryAutoRecovery).mock.calls.at(-1);
      expect(lastCall?.[0].verifySecret).toBe("123456");
    });

    it("auto-recovery: cancel returns to the recovery-choice screen", async () => {
      vi.mocked(tryAutoRecovery).mockResolvedValue({
        recovered: false,
        errorCode: "VERIFICATION_REQUIRED",
      });
      const { result } = renderFlow(apiClientWithFamily());

      await act(async () => {
        await result.current.handleStart();
      });
      expect(result.current.state).toBe("verify-prompt");

      act(() => {
        result.current.verify.cancel();
      });

      expect(result.current.state).toBe("recovery-choice");
      expect(result.current.verify.active).toBe(false);
    });

    it("manual join: VERIFICATION_REQUIRED routes to verify-prompt, then the secret completes the join", async () => {
      const onFamilyJoined = vi.fn();
      vi.mocked(performJoin).mockImplementation(async (opts) => {
        if (opts.verifySecret) {
          return { ok: true, familyId: "fam-joined", userId: opts.userId };
        }
        return {
          ok: false,
          errorCode: "VERIFICATION_REQUIRED",
          errorMessage: "需要驗證",
        };
      });
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
      });
      const { result } = renderFlow(api, createMockAutoSetup(), onFamilyJoined);

      // Land in idle first so a manual join is possible.
      await act(async () => {
        await result.current.handleStart();
      });
      act(() => {
        result.current.setSyncCodeInput("moo-fam-joined");
      });

      await act(async () => {
        await result.current.handleJoin();
      });
      expect(result.current.state).toBe("verify-prompt");

      await act(async () => {
        await result.current.verify.submit("654321");
      });

      expect(onFamilyJoined).toHaveBeenCalledWith(
        "fam-joined",
        expect.any(String),
      );
    });

    it("manual join: cancel returns to the idle screen", async () => {
      vi.mocked(performJoin).mockResolvedValue({
        ok: false,
        errorCode: "VERIFICATION_REQUIRED",
        errorMessage: "需要驗證",
      });
      const api = createMockApiClient({
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
      });
      const { result } = renderFlow(api);

      await act(async () => {
        await result.current.handleStart();
      });
      act(() => {
        result.current.setSyncCodeInput("moo-fam-joined");
      });
      await act(async () => {
        await result.current.handleJoin();
      });
      expect(result.current.state).toBe("verify-prompt");

      act(() => {
        result.current.verify.cancel();
      });

      expect(result.current.state).toBe("idle");
    });

    it("solo recovery: VERIFICATION_REQUIRED routes to verify-prompt", async () => {
      // Reach solo-recovery-confirm, then confirm with a verification failure.
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const { result } = await driveToRecoveryChoice(apiClientWithFamily());
      await act(async () => {
        await result.current.handleRecoveryChoiceSkip();
      });
      expect(result.current.state).toBe("solo-recovery-confirm");

      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
        errorCode: "VERIFICATION_REQUIRED",
      });
      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });

      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.verify.active).toBe(true);
    });

    /**
     * REGRESSION: a 429 lockout carries `retryAfter`. Every join path must
     * forward it into the prompt so a dialog opened while the account is locked
     * shows the remaining wait immediately, instead of an open-ended
     * "請稍後再試" that never resolves on its own. The handleStart path used to
     * drop it — each call site is pinned below.
     */
    describe("lockout countdown (retryAfter forwarding)", () => {
      const LOCKED = "VERIFICATION_LOCKED";

      it("auto-recovery on handleStart forwards retryAfter into the prompt", async () => {
        vi.mocked(tryAutoRecovery).mockResolvedValue({
          recovered: false,
          errorCode: LOCKED,
          retryAfter: 120,
        });
        const { result } = renderFlow(apiClientWithFamily());

        await act(async () => {
          await result.current.handleStart();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.locked).toBe(true);
        expect(result.current.verify.countdownSeconds).toBe(120);
      });

      it("auto-recovery on handleCreate forwards retryAfter into the prompt", async () => {
        vi.mocked(tryAutoRecovery)
          // handleStart: plain failure → recovery-choice.
          .mockResolvedValueOnce({ recovered: false })
          // handleCreate: the family is locked.
          .mockResolvedValueOnce({
            recovered: false,
            errorCode: LOCKED,
            retryAfter: 75,
          });
        const { result } = renderFlow(apiClientWithFamily());

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.handleCreate();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.countdownSeconds).toBe(75);
      });

      it("solo recovery (skip) forwards retryAfter into the prompt", async () => {
        const { result } = await driveToRecoveryChoice(apiClientWithFamily());

        vi.mocked(performSoloRecovery).mockResolvedValueOnce({
          recovered: false,
          errorCode: LOCKED,
          retryAfter: 45,
        });
        await act(async () => {
          await result.current.handleRecoveryChoiceSkip();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.countdownSeconds).toBe(45);
      });

      it("solo recovery (confirm) forwards retryAfter into the prompt", async () => {
        vi.mocked(performSoloRecovery).mockResolvedValueOnce({
          recovered: false,
        });
        const { result } = await driveToRecoveryChoice(apiClientWithFamily());
        await act(async () => {
          await result.current.handleRecoveryChoiceSkip();
        });
        expect(result.current.state).toBe("solo-recovery-confirm");

        vi.mocked(performSoloRecovery).mockResolvedValueOnce({
          recovered: false,
          errorCode: LOCKED,
          retryAfter: 30,
        });
        await act(async () => {
          await result.current.handleSoloRecoveryConfirm();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.countdownSeconds).toBe(30);
      });

      it("manual sync-code join forwards retryAfter into the prompt", async () => {
        vi.mocked(performJoin).mockResolvedValue({
          ok: false,
          errorCode: LOCKED,
          errorMessage: "locked",
          retryAfter: 90,
        });
        const api = createMockApiClient({
          getVerifyMethod: vi
            .fn()
            .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
        });
        const { result } = renderFlow(api);

        await act(async () => {
          await result.current.handleStart();
        });
        act(() => {
          result.current.setSyncCodeInput("moo-fam-joined");
        });
        await act(async () => {
          await result.current.handleJoin();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.locked).toBe(true);
        expect(result.current.verify.countdownSeconds).toBe(90);
      });

      it("leaves countdownSeconds null when the backend omits retryAfter", async () => {
        vi.mocked(tryAutoRecovery).mockResolvedValue({
          recovered: false,
          errorCode: LOCKED,
        });
        const { result } = renderFlow(apiClientWithFamily());

        await act(async () => {
          await result.current.handleStart();
        });

        // Older backend: still locked, but with the open-ended static copy.
        expect(result.current.verify.locked).toBe(true);
        expect(result.current.verify.countdownSeconds).toBeNull();
      });
    });
  });

  /**
   * SEC-1 (lookup side): `POST /api/auth/lookup` no longer answers with the
   * family data for an account that has verification configured — it returns 200
   * with `requiresVerification: TRUE` and a withheld payload. Read naively that
   * looks exactly like "this account has no family", which would drop a user who
   * HAS one onto the create/join screen and let them fork a second family.
   */
  describe("auth-lookup verification gate", () => {
    /** 200 + withheld payload: the server refuses to say whether a family exists. */
    const WITHHELD = {
      data: {
        existingFamilyId: null,
        memberCount: 0,
        requiresVerification: BoolFlag.TRUE,
      },
    };
    const REVEALED_FAMILY = {
      data: { existingFamilyId: "fam-existing", memberCount: 2 },
    };
    const NO_FAMILY = { data: { existingFamilyId: null, memberCount: 0 } };

    describe("handleStart", () => {
      it("opens the verification prompt instead of the create/join screen", async () => {
        const lookupUser = vi.fn().mockResolvedValue(WITHHELD);
        const { result } = renderFlow(
          createMockApiClient({
            lookupUser,
            getVerifyMethod: vi
              .fn()
              .mockResolvedValue({ data: { method: "pattern", prompted: 0 } }),
          }),
        );

        await act(async () => {
          await result.current.handleStart();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.active).toBe(true);
        expect(result.current.verify.method).toBe("pattern");
        // The first lookup carries no secret — the gate is discovered, not guessed.
        expect(lookupUser).toHaveBeenCalledWith(expect.any(String), undefined);
      });

      it("re-runs the lookup with the secret and recovers into the revealed family", async () => {
        const onFamilyJoined = vi.fn();
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(WITHHELD)
          .mockResolvedValueOnce(REVEALED_FAMILY);
        vi.mocked(tryAutoRecovery).mockImplementation(async (opts) => {
          opts.onFamilyJoined(opts.familyId, opts.userId);
          return { recovered: true };
        });
        const { result } = renderFlow(
          createMockApiClient({ lookupUser }),
          createMockAutoSetup(),
          onFamilyJoined,
        );

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.verify.submit("123456");
        });

        expect(lookupUser).toHaveBeenNthCalledWith(2, expect.any(String), {
          verifySecret: "123456",
        });
        // The verified secret is carried into the join, not re-prompted.
        expect(vi.mocked(tryAutoRecovery).mock.calls.at(-1)?.[0]).toMatchObject(
          {
            familyId: "fam-existing",
            verifySecret: "123456",
          },
        );
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "fam-existing",
          expect.any(String),
        );
        expect(result.current.verify.active).toBe(false);
        expect(result.current.state).not.toBe("verify-prompt");
      });

      it("continues into normal onboarding when the verified lookup reveals no family", async () => {
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(WITHHELD)
          .mockResolvedValueOnce(NO_FAMILY);
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.verify.submit("123456");
        });

        expect(result.current.state).toBe("idle");
        expect(result.current.verify.active).toBe(false);
        expect(tryAutoRecovery).not.toHaveBeenCalled();
      });

      it("keeps a wrong secret's error inside the prompt (never 'no family')", async () => {
        // The server still withholds the payload — reading that as an empty
        // lookup is the exact bug onboardingLookup normalizes away.
        const lookupUser = vi.fn().mockResolvedValue(WITHHELD);
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.verify.submit("000000");
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.state).not.toBe("idle");
        expect(result.current.verify.active).toBe(true);
        expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
        expect(result.current.verify.submitting).toBe(false);
      });

      it("keeps a 403 VERIFICATION_FAILED envelope inside the prompt", async () => {
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(WITHHELD)
          .mockResolvedValueOnce({
            error: { code: "VERIFICATION_FAILED", message: "驗證失敗" },
          });
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.verify.submit("000000");
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
      });

      it("forwards a 429 lockout's retryAfter from the re-lookup into the prompt", async () => {
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(WITHHELD)
          .mockResolvedValueOnce({
            error: {
              code: "VERIFICATION_LOCKED",
              message: "locked",
              retryAfter: 60,
            },
          });
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        await act(async () => {
          await result.current.verify.submit("000000");
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.locked).toBe(true);
        expect(result.current.verify.countdownSeconds).toBe(60);
      });

      it("opens the prompt already counting down when the FIRST lookup is locked", async () => {
        const lookupUser = vi.fn().mockResolvedValue({
          error: {
            code: "VERIFICATION_LOCKED",
            message: "locked",
            retryAfter: 300,
          },
        });
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.countdownSeconds).toBe(300);
      });

      /**
       * COPY PIN: START_VERIFY_CANCELLED_MESSAGE and its 「重新驗證」 action label
       * are module-private in src/dialog/useOnboardingFlow.ts. This is the single
       * place the literals are asserted — a wording change fails HERE.
       */
      it("shows the retryable 「重新驗證」 error when the user cancels the challenge", async () => {
        const lookupUser = vi.fn().mockResolvedValue(WITHHELD);
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        act(() => {
          result.current.verify.cancel();
        });

        expect(result.current.state).toBe("error");
        expect(result.current.errorMessage).toBe(
          "需要完成驗證才能讀取你的家庭資料，請重試。",
        );
        expect(result.current.errorActions).toHaveLength(1);
        expect(result.current.errorActions[0].label).toBe("重新驗證");
        expect(result.current.errorActions[0].variant).toBe("primary");
      });

      it("re-enters the challenge from the 「重新驗證」 action, not the create/join screen", async () => {
        const lookupUser = vi.fn().mockResolvedValue(WITHHELD);
        const { result } = renderFlow(createMockApiClient({ lookupUser }));

        await act(async () => {
          await result.current.handleStart();
        });
        act(() => {
          result.current.verify.cancel();
        });
        expect(result.current.state).toBe("error");

        // The generic 重試 action would land on "create or join a family" — the
        // very misreading the message warns against.
        await act(async () => {
          result.current.errorActions[0].onClick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => {
          expect(result.current.state).toBe("verify-prompt");
        });

        expect(result.current.state).not.toBe("idle");
        expect(result.current.verify.active).toBe(true);
        expect(lookupUser).toHaveBeenCalledTimes(2);
      });
    });

    describe("handleCreate", () => {
      /** handleCreate needs a captured email, so land in idle via handleStart. */
      async function driveToIdle(
        apiClient: ApiClient,
        onFamilyJoined = vi.fn(),
      ) {
        const { result } = renderFlow(
          apiClient,
          createMockAutoSetup(),
          onFamilyJoined,
        );
        await act(async () => {
          await result.current.handleStart();
        });
        expect(result.current.state).toBe("idle");
        return { result, onFamilyJoined };
      }

      it("recovers into the family the verified lookup reveals instead of creating a second one", async () => {
        const lookupUser = vi
          .fn()
          // handleStart: no gate yet, no family → idle.
          .mockResolvedValueOnce(NO_FAMILY)
          // handleCreate: verification was switched on in between.
          .mockResolvedValueOnce(WITHHELD)
          // …and the unlocked lookup reveals a family after all.
          .mockResolvedValueOnce(REVEALED_FAMILY);
        vi.mocked(tryAutoRecovery).mockImplementation(async (opts) => {
          opts.onFamilyJoined(opts.familyId, opts.userId);
          return { recovered: true };
        });
        const { result, onFamilyJoined } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        expect(result.current.state).toBe("verify-prompt");

        await act(async () => {
          await result.current.verify.submit("123456");
        });

        expect(createNewFamily).not.toHaveBeenCalled();
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "fam-existing",
          expect.any(String),
        );
      });

      it("refuses to create a family when the lookup fails for a NON-verification reason", async () => {
        // A network blip / EMPTY_RESPONSE must not be read as "no family" —
        // creating here would fork a second family for an existing member.
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(NO_FAMILY)
          .mockResolvedValueOnce({
            error: { code: "SERVER_ERROR", message: "boom" },
          });
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });

        expect(createNewFamily).not.toHaveBeenCalled();
        expect(result.current.state).toBe("error");
        expect(result.current.errorMessage).toBe("無法驗證帳號，請重試。");
      });

      it("prompts and retries with the secret when the create itself is refused (403)", async () => {
        const lookupUser = vi.fn().mockResolvedValue(NO_FAMILY);
        vi.mocked(createNewFamily).mockRejectedValueOnce(
          new CreateFamilyError("需要驗證", "VERIFICATION_REQUIRED"),
        );
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.active).toBe(true);

        await act(async () => {
          await result.current.verify.submit("123456");
        });

        expect(vi.mocked(createNewFamily).mock.calls.at(-1)?.[0]).toMatchObject(
          {
            verifySecret: "123456",
          },
        );
        expect(result.current.state).toBe("created");
        expect(result.current.generatedSyncCode).toBe("moo-sync-code");
        expect(result.current.verify.active).toBe(false);
      });

      it("forwards a 429 VERIFICATION_LOCKED create refusal's retryAfter into the prompt", async () => {
        const lookupUser = vi.fn().mockResolvedValue(NO_FAMILY);
        vi.mocked(createNewFamily).mockRejectedValueOnce(
          new CreateFamilyError("locked", "VERIFICATION_LOCKED", 150),
        );
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.locked).toBe(true);
        expect(result.current.verify.countdownSeconds).toBe(150);
      });

      it("keeps a wrong secret's error in the prompt when the create is refused again", async () => {
        const lookupUser = vi.fn().mockResolvedValue(NO_FAMILY);
        vi.mocked(createNewFamily)
          .mockRejectedValueOnce(
            new CreateFamilyError("需要驗證", "VERIFICATION_REQUIRED"),
          )
          .mockRejectedValueOnce(
            new CreateFamilyError("驗證失敗", "VERIFICATION_FAILED"),
          );
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        await act(async () => {
          await result.current.verify.submit("000000");
        });

        expect(result.current.state).toBe("verify-prompt");
        expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
        expect(result.current.state).not.toBe("created");
      });

      /**
       * COPY PIN: VERIFY_CANCELLED_MESSAGE and its 「重新驗證」 action label are
       * module-private in src/dialog/useOnboardingFlow.ts. This is the single
       * place the literals are asserted — a wording change fails HERE.
       */
      it("shows the create-cancelled message with a 「重新驗證」 action on cancel", async () => {
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(NO_FAMILY)
          .mockResolvedValue(WITHHELD);
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        act(() => {
          result.current.verify.cancel();
        });

        expect(result.current.state).toBe("error");
        expect(result.current.errorMessage).toBe(
          "需要完成驗證才能建立家庭書櫃，請重試。",
        );
        expect(result.current.errorActions).toHaveLength(1);
        expect(result.current.errorActions[0].label).toBe("重新驗證");
        expect(result.current.errorActions[0].variant).toBe("primary");
      });

      it("re-enters the challenge from the 「重新驗證」 action after a withheld lookup, not the create/join screen", async () => {
        const lookupUser = vi
          .fn()
          .mockResolvedValueOnce(NO_FAMILY)
          .mockResolvedValue(WITHHELD);
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        act(() => {
          result.current.verify.cancel();
        });
        expect(result.current.state).toBe("error");

        // The generic 重試 action would land on "create or join a family",
        // inviting a second family — the very fork this message warns against.
        await act(async () => {
          result.current.errorActions[0].onClick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => {
          expect(result.current.state).toBe("verify-prompt");
        });

        expect(result.current.state).not.toBe("idle");
        expect(result.current.verify.active).toBe(true);
        // handleStart + the cancelled handleCreate + the re-run handleCreate.
        expect(lookupUser).toHaveBeenCalledTimes(3);
        expect(createNewFamily).not.toHaveBeenCalled();
      });

      it("re-enters the challenge from the 「重新驗證」 action after a refused create, not the create/join screen", async () => {
        const lookupUser = vi.fn().mockResolvedValue(NO_FAMILY);
        // Persistent refusal: the re-run must hit the same gate, not succeed.
        vi.mocked(createNewFamily).mockRejectedValue(
          new CreateFamilyError("需要驗證", "VERIFICATION_REQUIRED"),
        );
        const { result } = await driveToIdle(
          createMockApiClient({ lookupUser }),
        );

        await act(async () => {
          await result.current.handleCreate();
        });
        act(() => {
          result.current.verify.cancel();
        });
        expect(result.current.state).toBe("error");
        expect(result.current.errorActions[0].label).toBe("重新驗證");

        await act(async () => {
          result.current.errorActions[0].onClick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => {
          expect(result.current.state).toBe("verify-prompt");
        });

        expect(result.current.state).not.toBe("idle");
        expect(result.current.verify.active).toBe(true);
        expect(createNewFamily).toHaveBeenCalledTimes(2);
      });
    });
  });

  /**
   * REGRESSION (UI deadlock, had zero coverage): every retry closure runs a whole
   * onboarding flow, and several of them move the state machine into a progress
   * view ("recovering") whose full-screen LoadingOverlay covers the prompt. When
   * the attempt failed, nothing brought the state machine back — one wrong PIN
   * left the dialog stuck under the overlay until the user reopened it.
   * `onAttemptFailed` restores "verify-prompt" on every failed attempt.
   */
  describe("failed retry restores the prompt (no loading-overlay deadlock)", () => {
    function apiClientWithFamily(): ApiClient {
      return createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
      });
    }

    it("auto-recovery bridge: a wrong secret returns to verify-prompt, not 'recovering'", async () => {
      vi.mocked(tryAutoRecovery)
        .mockResolvedValueOnce({
          recovered: false,
          errorCode: "VERIFICATION_REQUIRED",
        })
        .mockResolvedValueOnce({
          recovered: false,
          errorCode: "VERIFICATION_FAILED",
        });
      const { result } = renderFlow(apiClientWithFamily());

      await act(async () => {
        await result.current.handleStart();
      });
      expect(result.current.state).toBe("verify-prompt");

      await act(async () => {
        await result.current.verify.submit("000000");
      });

      // attemptRecovery set "recovering" on the way in; the failure must undo it.
      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.state).not.toBe("recovering");
      expect(result.current.verify.active).toBe(true);
      expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
      expect(result.current.verify.submitting).toBe(false);
    });

    it("lookup-gate bridge: a join failure after a verified lookup returns to verify-prompt", async () => {
      const lookupUser = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        })
        .mockResolvedValueOnce({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        });
      vi.mocked(tryAutoRecovery).mockResolvedValue({
        recovered: false,
        errorCode: "VERIFICATION_FAILED",
      });
      const { result } = renderFlow(createMockApiClient({ lookupUser }));

      await act(async () => {
        await result.current.handleStart();
      });
      await act(async () => {
        await result.current.verify.submit("000000");
      });

      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
    });

    it("solo-recovery bridge: a wrong secret returns to verify-prompt, not 'recovering'", async () => {
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({
        recovered: false,
      });
      const { result } = await driveToRecoveryChoice(apiClientWithFamily());
      await act(async () => {
        await result.current.handleRecoveryChoiceSkip();
      });
      expect(result.current.state).toBe("solo-recovery-confirm");

      vi.mocked(performSoloRecovery)
        .mockResolvedValueOnce({
          recovered: false,
          errorCode: "VERIFICATION_REQUIRED",
        })
        .mockResolvedValueOnce({
          recovered: false,
          errorCode: "VERIFICATION_FAILED",
        });
      await act(async () => {
        await result.current.handleSoloRecoveryConfirm();
      });
      expect(result.current.state).toBe("verify-prompt");

      await act(async () => {
        await result.current.verify.submit("000000");
      });

      // This bridge's retry closure calls performSoloRecovery directly and does
      // not (today) enter a progress view, so the assertion pins the invariant
      // rather than reproducing the overlay bug — it starts catching a real
      // deadlock the moment the closure gains one, as attemptRecovery has.
      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.state).not.toBe("recovering");
      expect(result.current.verify.active).toBe(true);
      expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
    });

    it("a retry closure that THROWS leaves a usable prompt with a generic error", async () => {
      vi.mocked(tryAutoRecovery)
        .mockResolvedValueOnce({
          recovered: false,
          errorCode: "VERIFICATION_REQUIRED",
        })
        .mockRejectedValueOnce(new Error("storage exploded"));
      const { result } = renderFlow(apiClientWithFamily());

      await act(async () => {
        await result.current.handleStart();
      });
      await act(async () => {
        await result.current.verify.submit("123456");
      });

      expect(result.current.verify.submitting).toBe(false);
      expect(result.current.verify.active).toBe(true);
      expect(result.current.verify.error).toBe("發生錯誤，請稍後再試");
      expect(result.current.state).toBe("verify-prompt");
    });

    it("a successful retry navigates away instead of resurrecting the prompt", async () => {
      const onFamilyJoined = vi.fn();
      vi.mocked(tryAutoRecovery).mockImplementation(async (opts) => {
        if (!opts.verifySecret) {
          return { recovered: false, errorCode: "VERIFICATION_REQUIRED" };
        }
        opts.onFamilyJoined(opts.familyId, opts.userId);
        return { recovered: true };
      });
      const { result } = renderFlow(
        apiClientWithFamily(),
        createMockAutoSetup(),
        onFamilyJoined,
      );

      await act(async () => {
        await result.current.handleStart();
      });
      await act(async () => {
        await result.current.verify.submit("123456");
      });

      expect(onFamilyJoined).toHaveBeenCalledWith(
        "fam-existing",
        expect.any(String),
      );
      expect(result.current.verify.active).toBe(false);
      // The success path must NOT force the prompt back over a completed journey.
      expect(result.current.state).not.toBe("verify-prompt");
    });

    // performJoin only advances the state machine ("syncing-books") on success,
    // so this path cannot deadlock today; the case guards the shared bridge
    // handleJoin was migrated onto against a future progress view.
    it("manual sync-code join: a wrong secret keeps the prompt open", async () => {
      vi.mocked(performJoin).mockResolvedValue({
        ok: false,
        errorCode: "VERIFICATION_FAILED",
        errorMessage: "驗證失敗",
      });
      const { result } = renderFlow(createMockApiClient());

      await act(async () => {
        await result.current.handleStart();
      });
      act(() => {
        result.current.setSyncCodeInput("moo-fam-joined");
      });
      await act(async () => {
        await result.current.handleJoin();
      });
      expect(result.current.state).toBe("verify-prompt");

      await act(async () => {
        await result.current.verify.submit("000000");
      });

      expect(result.current.state).toBe("verify-prompt");
      expect(result.current.verify.error).toBe("驗證失敗，請重新輸入");
      expect(result.current.verify.submitting).toBe(false);
    });
  });

  /**
   * On mount the hook pre-fills the sync-code input from a storage.sync REMNANT:
   * when this device has onboarded (local userId) but lost its local familyId
   * while sync still holds one, it offers the encoded sync code so the user can
   * rejoin in one tap. It is PRE-FILL only — never auto-submits — and uses a
   * functional state update so it can never clobber what the user is typing.
   */
  describe("sync-code pre-fill from storage.sync remnant", () => {
    /** local = onboarded but no familyId; sync = holds the remnant familyId. */
    function mockRemnantStorage(opts: {
      localUserId?: string;
      localFamilyId?: string;
      syncFamilyId?: string;
      syncGet?: () => Promise<Record<string, unknown>>;
    }): void {
      const local: Record<string, unknown> = {};
      if (opts.localUserId) local[USER_ID_KEY] = opts.localUserId;
      if (opts.localFamilyId) local[FAMILY_ID_KEY] = opts.localFamilyId;
      vi.mocked(chrome.storage.local.get).mockResolvedValue(local as never);

      const sync: Record<string, unknown> = {};
      if (opts.syncFamilyId) sync[FAMILY_ID_KEY] = opts.syncFamilyId;
      vi.mocked(chrome.storage.sync.get).mockImplementation(
        (opts.syncGet ?? (() => Promise.resolve(sync))) as never,
      );
    }

    afterEach(() => {
      // Restore an EMPTY storage read so the file's other tests (which expect no
      // pre-fill) are unaffected by these per-test overrides.
      vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({} as never);
    });

    it("pre-fills the input with the encoded sync code when a remnant exists", async () => {
      mockRemnantStorage({ localUserId: "u1", syncFamilyId: "fam-remnant" });
      vi.mocked(encodeSyncCode).mockReturnValue("moo-fam-remnant");
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn().mockReturnValue(DEFAULT_API_ENDPOINT),
      });

      const { result } = renderFlow(apiClient);

      await waitFor(() => {
        expect(result.current.syncCodeInput).toBe("moo-fam-remnant");
      });
      // Default endpoint → encode WITHOUT an @host segment.
      expect(encodeSyncCode).toHaveBeenCalledWith({
        familyId: "fam-remnant",
        apiHost: undefined,
      });
    });

    it("encodes the @host segment when a custom endpoint is configured", async () => {
      mockRemnantStorage({ localUserId: "u1", syncFamilyId: "fam-remnant" });
      vi.mocked(encodeSyncCode).mockReturnValue(
        "moo-fam-remnant@custom.example",
      );
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn().mockReturnValue("https://custom.example"),
      });

      const { result } = renderFlow(apiClient);

      await waitFor(() => {
        expect(result.current.syncCodeInput).toBe(
          "moo-fam-remnant@custom.example",
        );
      });
      expect(encodeSyncCode).toHaveBeenCalledWith({
        familyId: "fam-remnant",
        apiHost: "https://custom.example",
      });
    });

    it("leaves the input empty when there is no remnant", async () => {
      // Onboarded, but sync holds no familyId → nothing to pre-fill.
      mockRemnantStorage({ localUserId: "u1" });

      const { result } = renderFlow();

      // Give the async effect a chance to run, then assert it stayed empty.
      await waitFor(() => {
        expect(chrome.storage.sync.get).toHaveBeenCalled();
      });
      expect(result.current.syncCodeInput).toBe("");
      expect(encodeSyncCode).not.toHaveBeenCalled();
    });

    it("does not pre-fill when the device has never onboarded (no local userId)", async () => {
      mockRemnantStorage({ syncFamilyId: "fam-remnant" }); // no local userId

      const { result } = renderFlow();

      await waitFor(() => {
        expect(chrome.storage.local.get).toHaveBeenCalled();
      });
      expect(result.current.syncCodeInput).toBe("");
      expect(encodeSyncCode).not.toHaveBeenCalled();
    });

    it("never clobbers a value the user is already typing", async () => {
      // Hold the sync read pending so the user can type BEFORE the remnant
      // resolves; the functional update must then keep the user's value.
      let resolveSync!: (v: Record<string, unknown>) => void;
      const pending = new Promise<Record<string, unknown>>((resolve) => {
        resolveSync = resolve;
      });
      mockRemnantStorage({ localUserId: "u1", syncGet: () => pending });
      vi.mocked(encodeSyncCode).mockReturnValue("moo-fam-remnant");

      const { result } = renderFlow();

      // User types while the remnant lookup is still in flight.
      act(() => {
        result.current.setSyncCodeInput("user-typed-code");
      });

      // Now the remnant resolves.
      await act(async () => {
        resolveSync({ [FAMILY_ID_KEY]: "fam-remnant" });
        await pending;
      });

      await waitFor(() => {
        expect(chrome.storage.sync.get).toHaveBeenCalled();
      });
      // The user's in-progress input survives — pre-fill did NOT overwrite it.
      expect(result.current.syncCodeInput).toBe("user-typed-code");
    });
  });
});
