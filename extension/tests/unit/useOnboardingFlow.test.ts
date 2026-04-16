import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
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

import { useOnboardingFlow } from "@/dialog/useOnboardingFlow";
import { deriveUserId } from "@/crypto/hash";
import {
  performSoloRecovery,
  tryAutoRecovery,
} from "@/dialog/onboardingFlow";
import type { ApiClient } from "@/api/client";
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

      const { result } = renderFlow(apiClient, createMockAutoSetup(), onFamilyJoined);
      await act(async () => {
        await result.current.handleStart();
      });

      expect(onFamilyJoined).toHaveBeenCalledWith("fam-existing", expect.any(String));
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
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({ recovered: false });
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
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({ recovered: false });
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
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({ recovered: false });
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
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({ recovered: false });

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
      vi.mocked(performSoloRecovery).mockResolvedValueOnce({ recovered: false });
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
});
