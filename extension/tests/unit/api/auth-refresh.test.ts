import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { doRefreshToken } from "@/api/auth-refresh";
import type { ApiResponse } from "@/api/types";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "@/constants";

/**
 * doRefreshToken branching contract (security-ux Invariant 2 — a dead token must
 * NEVER silently drop the user's family data). Returns a `RefreshOutcome`
 * ({ refreshed, rateLimited?, cooldownUntil? }), not a bare boolean:
 *
 *  - refresh succeeds            → store the new token, { refreshed: true },
 *    clear any recovery cooldown.
 *  - refresh fails, join recovers → store the recovered token, { refreshed: true },
 *    clear any recovery cooldown.
 *  - recovery rate-limited (fresh 429) → write a recovery cooldown, return
 *    { refreshed: false, rateLimited: true, cooldownUntil }; do NOT prompt
 *    verification and do NOT clear family data.
 *  - recovery cooldown still active → skip the join entirely, same rate-limited
 *    outcome.
 *  - recovery blocked by a verification code → call onReauthRequired, KEEP data.
 *  - recovery says family is gone (FAMILY_NOT_FOUND / FAMILY_FULL) → clear +
 *    FAMILY_REMOVED.
 *  - any other / transient failure → leave family data intact for a later retry.
 *
 * doRefreshToken takes an injected `deps` boundary (request / setAuthToken /
 * callbacks) so this is a pure unit test of the branching — only browser.storage
 * (via the shared setup mock) and the injected request are stubbed.
 */

interface RequestOutcome {
  refresh: ApiResponse<{ token: string; expiresAt: number }>;
  join: ApiResponse<{ authToken: string; expiresAt: number }>;
}

/** Build an injected `request` that answers refresh vs. join by path. */
function makeRequest(outcome: Partial<RequestOutcome>) {
  return vi.fn((path: string) => {
    if (path === "/api/auth/refresh") {
      return Promise.resolve(outcome.refresh ?? { error: { code: "REFRESH_FAILED", message: "x" } });
    }
    if (path.endsWith("/join")) {
      return Promise.resolve(outcome.join ?? { error: { code: "UNKNOWN", message: "x" } });
    }
    return Promise.resolve({});
  }) as never;
}

function makeDeps(
  outcome: Partial<RequestOutcome>,
  isReauthPending: () => boolean = () => false,
) {
  return {
    request: makeRequest(outcome),
    setAuthToken: vi.fn(),
    onFamilyRemoved: vi.fn(),
    onReauthRequired: vi.fn(),
    isReauthPending: vi.fn(isReauthPending),
  };
}

/** Seed storage.local so doRefreshToken + attemptJoinRecovery find userId/familyId. */
function seedStorage(
  data: Record<string, unknown> = {
    [USER_ID_KEY]: "u1",
    [FAMILY_ID_KEY]: "fam-1",
    [AUTH_TOKEN_KEY]: "old-token",
  },
): void {
  vi.mocked(chrome.storage.local.get).mockResolvedValue(data as never);
}

/** True when family data (FAMILY_ID_KEY) was removed from storage. */
function familyWasCleared(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some(
      (call) => Array.isArray(call[0]) && (call[0] as string[]).includes(FAMILY_ID_KEY),
    );
}

/** True when the recovery cooldown key was removed (cleared) from storage. */
function cooldownWasCleared(): boolean {
  return vi
    .mocked(chrome.storage.local.remove)
    .mock.calls.some((call) => (call[0] as unknown) === RECOVERY_COOLDOWN_UNTIL_KEY);
}

/** The epoch-ms deadline the cooldown key was last written with, or undefined. */
function cooldownWriteValue(): number | undefined {
  const calls = vi.mocked(chrome.storage.local.set).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const arg = calls[i][0] as Record<string, unknown>;
    if (arg && RECOVERY_COOLDOWN_UNTIL_KEY in arg) {
      return arg[RECOVERY_COOLDOWN_UNTIL_KEY] as number;
    }
  }
  return undefined;
}

/** Inspect the injected request spy: was any `/join` request issued? */
function joinWasRequested(request: unknown): boolean {
  const spy = request as ReturnType<typeof vi.fn>;
  return spy.mock.calls.some((call) => String(call[0]).endsWith("/join"));
}

describe("doRefreshToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not-refreshed without calling request when userId/familyId are missing", async () => {
    seedStorage({}); // no userId/familyId
    const deps = makeDeps({ refresh: { data: { token: "t", expiresAt: 1 } } });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(false);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("stores the new token and reports refreshed when refresh succeeds", async () => {
    seedStorage();
    const deps = makeDeps({
      refresh: { data: { token: "fresh-token", expiresAt: 9999 } },
    });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(true);
    expect(deps.setAuthToken).toHaveBeenCalledWith("fresh-token");
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [AUTH_TOKEN_KEY]: "fresh-token",
        [TOKEN_EXPIRES_AT_KEY]: 9999,
      }),
    );
    // No recovery/clear path was taken.
    expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    expect(deps.onReauthRequired).not.toHaveBeenCalled();
    expect(familyWasCleared()).toBe(false);
  });

  it("recovers via joinFamily and reports refreshed when refresh fails but join succeeds", async () => {
    seedStorage();
    const deps = makeDeps({
      refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
      join: { data: { authToken: "recovered-token", expiresAt: 8888 } },
    });

    const result = await doRefreshToken(deps);

    expect(result.refreshed).toBe(true);
    expect(deps.setAuthToken).toHaveBeenCalledWith("recovered-token");
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [AUTH_TOKEN_KEY]: "recovered-token",
        [TOKEN_EXPIRES_AT_KEY]: 8888,
      }),
    );
    expect(deps.onReauthRequired).not.toHaveBeenCalled();
    expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    expect(familyWasCleared()).toBe(false);
  });

  describe("recovery-failure branching by join error code", () => {
    interface Case {
      name: string;
      code: string | undefined;
      expectReauth: boolean;
      expectFamilyRemoved: boolean;
      expectCleared: boolean;
    }

    const cases: Case[] = [
      {
        name: "VERIFICATION_REQUIRED → prompt re-verify, keep data",
        code: "VERIFICATION_REQUIRED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "VERIFICATION_FAILED → prompt re-verify, keep data",
        code: "VERIFICATION_FAILED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "VERIFICATION_LOCKED → prompt re-verify, keep data",
        code: "VERIFICATION_LOCKED",
        expectReauth: true,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
      {
        name: "FAMILY_NOT_FOUND → clear family + notify",
        code: "FAMILY_NOT_FOUND",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        name: "FAMILY_FULL → clear family + notify",
        code: "FAMILY_FULL",
        expectReauth: false,
        expectFamilyRemoved: true,
        expectCleared: true,
      },
      {
        name: "no error code (network-ish) → leave data intact",
        code: undefined,
        expectReauth: false,
        expectFamilyRemoved: false,
        expectCleared: false,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        seedStorage();
        const join = c.code
          ? { error: { code: c.code, message: "x" } }
          : {}; // no data.authToken and no error.code
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: join as ApiResponse<{ authToken: string; expiresAt: number }>,
        });

        const result = await doRefreshToken(deps);

        expect(result.refreshed).toBe(false);
        expect(deps.onReauthRequired).toHaveBeenCalledTimes(c.expectReauth ? 1 : 0);
        expect(deps.onFamilyRemoved).toHaveBeenCalledTimes(
          c.expectFamilyRemoved ? 1 : 0,
        );
        expect(familyWasCleared()).toBe(c.expectCleared);
        if (c.expectFamilyRemoved) {
          expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "FAMILY_REMOVED",
          });
        } else {
          expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
            type: "FAMILY_REMOVED",
          });
        }
      });
    }
  });

  it("always clears only the token (not family) before attempting recovery", async () => {
    seedStorage();
    const deps = makeDeps({
      refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
      join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
    });

    await doRefreshToken(deps);

    // Token is cleared regardless of the recovery branch...
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
    ]);
    // ...but the verification branch must NOT clear family data.
    expect(familyWasCleared()).toBe(false);
  });

  it("does not throw when onReauthRequired is null on a verification failure", async () => {
    seedStorage();
    const deps = {
      request: makeRequest({
        refresh: { error: { code: "REFRESH_FAILED", message: "x" } },
        join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
      }),
      setAuthToken: vi.fn(),
      onFamilyRemoved: null,
      onReauthRequired: null,
      isReauthPending: () => false,
    };

    const result = await doRefreshToken(deps);
    expect(result.refreshed).toBe(false);
    expect(familyWasCleared()).toBe(false);
  });

  describe("recovery cooldown (rate limiting)", () => {
    // Pin the clock so cooldown deadlines (Date.now() + seconds*1000) are exact.
    const FIXED_NOW = 1_700_000_000_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    interface CooldownCase {
      name: string;
      retryAfter: number | undefined;
      expectedSeconds: number;
    }

    const cases: CooldownCase[] = [
      {
        name: "derives the cooldown from the join's retryAfter",
        retryAfter: 120,
        expectedSeconds: 120,
      },
      {
        name: "falls back to 300s when the 429 omits retryAfter",
        retryAfter: undefined,
        expectedSeconds: 300,
      },
    ];

    for (const c of cases) {
      it(`${c.name} on a fresh RATE_LIMITED recovery`, async () => {
        seedStorage(); // no cooldown key → no active cooldown
        const deps = makeDeps({
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: {
            error: {
              code: "RATE_LIMITED",
              message: "too many",
              ...(c.retryAfter !== undefined ? { retryAfter: c.retryAfter } : {}),
            },
          } as ApiResponse<{ authToken: string; expiresAt: number }>,
        });

        const result = await doRefreshToken(deps);

        const expectedUntil = FIXED_NOW + c.expectedSeconds * 1000;
        expect(result).toEqual({
          refreshed: false,
          rateLimited: true,
          cooldownUntil: expectedUntil,
        });
        // Cooldown was persisted with the derived deadline.
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [RECOVERY_COOLDOWN_UNTIL_KEY]: expectedUntil,
        });
        expect(cooldownWriteValue()).toBe(expectedUntil);
        // A rate-limit must NOT prompt verification nor drop family data.
        expect(deps.onReauthRequired).not.toHaveBeenCalled();
        expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
        expect(familyWasCleared()).toBe(false);
      });
    }

    it("skips the join entirely while a cooldown is still active", async () => {
      const activeUntil = FIXED_NOW + 60_000; // 60s in the future
      seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [RECOVERY_COOLDOWN_UNTIL_KEY]: activeUntil,
      });
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        // Would recover if called — the point is that it must NOT be called.
        join: { data: { authToken: "should-not-be-used", expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result).toEqual({
        refreshed: false,
        rateLimited: true,
        cooldownUntil: activeUntil,
      });
      // The quota-sensitive join must be suppressed entirely.
      expect(joinWasRequested(deps.request)).toBe(false);
      // No fresh cooldown write and no data loss on the suppressed path.
      expect(cooldownWriteValue()).toBeUndefined();
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(familyWasCleared()).toBe(false);
    });

    it("attempts the join when the stored cooldown has expired", async () => {
      seedStorage({
        [USER_ID_KEY]: "u1",
        [FAMILY_ID_KEY]: "fam-1",
        [AUTH_TOKEN_KEY]: "old-token",
        [RECOVERY_COOLDOWN_UNTIL_KEY]: FIXED_NOW - 1_000, // already expired
      });
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: "recovered-token", expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(joinWasRequested(deps.request)).toBe(true);
      // A successful recovery clears the stale cooldown.
      expect(cooldownWasCleared()).toBe(true);
    });

    it("clears the cooldown after a successful refresh", async () => {
      seedStorage();
      const deps = makeDeps({
        refresh: { data: { token: "fresh-token", expiresAt: 9999 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(cooldownWasCleared()).toBe(true);
    });

    it("clears the cooldown after a successful join recovery", async () => {
      seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: { data: { authToken: "recovered-token", expiresAt: 8888 } },
      });

      const result = await doRefreshToken(deps);

      expect(result.refreshed).toBe(true);
      expect(cooldownWasCleared()).toBe(true);
    });

    it("does not prompt re-verification (onReauthRequired) on a rate-limited recovery", async () => {
      seedStorage();
      const deps = makeDeps({
        refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
        join: {
          error: { code: "RATE_LIMITED", message: "too many", retryAfter: 42 },
        } as ApiResponse<{ authToken: string; expiresAt: number }>,
      });

      const result = await doRefreshToken(deps);

      expect(result.rateLimited).toBe(true);
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
    });
  });

  /**
   * Reauth-pending latch (skip guard): a verification prompt raised by an
   * earlier 401 wave sets `isReauthPending() === true`. On the dialog's second
   * data wave the refresh POST still runs, but silent join-recovery must be
   * suppressed — otherwise it would re-burn a join-quota unit and re-fire
   * onReauthRequired, wiping the user's in-progress pattern/PIN input.
   */
  describe("reauth-pending latch", () => {
    it("skips join recovery and all side effects when isReauthPending() is true", async () => {
      seedStorage();
      const deps = makeDeps(
        {
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          // Would recover if the join fired — it must NOT fire while latched.
          join: { data: { authToken: "should-not-be-used", expiresAt: 8888 } },
        },
        () => true,
      );

      const result = await doRefreshToken(deps);

      expect(result).toEqual({ refreshed: false });
      // The quota-sensitive join is suppressed entirely.
      expect(joinWasRequested(deps.request)).toBe(false);
      // No prompt re-fire, no data drop, no cooldown write on the latched path.
      expect(deps.onReauthRequired).not.toHaveBeenCalled();
      expect(deps.onFamilyRemoved).not.toHaveBeenCalled();
      expect(familyWasCleared()).toBe(false);
      expect(cooldownWriteValue()).toBeUndefined();
    });

    it("proceeds with join recovery when isReauthPending() is false", async () => {
      seedStorage();
      const deps = makeDeps(
        {
          refresh: { error: { code: "REFRESH_FAILED", message: "expired" } },
          join: { error: { code: "VERIFICATION_REQUIRED", message: "x" } },
        },
        () => false,
      );

      const result = await doRefreshToken(deps);

      // Latch open → the join fires and the verification branch prompts re-verify.
      expect(result.refreshed).toBe(false);
      expect(joinWasRequested(deps.request)).toBe(true);
      expect(deps.onReauthRequired).toHaveBeenCalledTimes(1);
      expect(familyWasCleared()).toBe(false);
    });
  });
});
