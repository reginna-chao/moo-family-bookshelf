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

// Mock onboardingFlow module so we can inject recovery-path outcomes
vi.mock("@/dialog/onboardingFlow", () => ({
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
}));

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
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "@/dialog/onboardingFlow";
import { USER_ID_KEY, FAMILY_ID_KEY, DEFAULT_API_ENDPOINT } from "@/constants";
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
