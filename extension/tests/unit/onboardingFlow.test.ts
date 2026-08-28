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

// Mock sync code codec — tests set return values per case to simulate decoding.
vi.mock("@/crypto/syncCode", () => ({
  SyncCodeError: class SyncCodeError extends Error {},
  decodeSyncCode: vi.fn(),
  encodeSyncCode: vi.fn(),
}));

import {
  performJoin,
  performSoloRecovery,
  restoreApiEndpoint,
  tryAutoRecovery,
  createNewFamily,
  CreateFamilyError,
} from "@/dialog/onboardingFlow";
import { decodeSyncCode } from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";
import type { ApiClient } from "@/api/client";
import type { useAutoSetup } from "@/dialog/useAutoSetup";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  TOKEN_EXPIRES_AT_KEY,
  USER_ID_KEY,
} from "@/constants";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  // Mirrors the real client: setEndpoint is what getEndpoint reports back, so
  // callers that persist `getEndpoint()` after a switch see the new value.
  let endpoint = DEFAULT_API_ENDPOINT;
  return {
    joinFamily: vi.fn().mockResolvedValue({
      data: { authToken: "tok", expiresAt: 9999999999 },
    }),
    createFamily: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-created-1",
        authToken: "tok",
        expiresAt: 9999999999,
      },
    }),
    updateFamilyEndpoint: vi.fn().mockResolvedValue({ data: { ok: true } }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    setAuthToken: vi.fn(),
    // Default endpoint so createNewFamily does NOT take the custom-endpoint path.
    getEndpoint: vi.fn(() => endpoint),
    setEndpoint: vi.fn((url: string) => {
      endpoint = url;
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function createMockAutoSetup(): ReturnType<typeof useAutoSetup> {
  return {
    syncBooks: vi.fn().mockResolvedValue(undefined),
    scrapeProfile: vi.fn(),
    phase: "idle",
    phaseMessage: "",
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useAutoSetup>;
}

describe("performSoloRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset chrome.storage mocks
    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { recovered: true } and calls onFamilyJoined on success", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    expect(result).toEqual({ recovered: true });
    expect(onFamilyJoined).toHaveBeenCalledWith("fam-solo-1", "user-abc");
  });

  it("calls joinFamily with undefined verify opts when no secret is given", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(apiClient.joinFamily).toHaveBeenCalledWith(
      "fam-solo-1",
      "user-abc",
      "Test User",
      undefined,
    );
  });

  it("persists credentials and sends chrome messages on success", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    // Credentials written to local storage
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [USER_ID_KEY]: "user-abc",
        [AUTH_TOKEN_KEY]: "tok",
        [TOKEN_EXPIRES_AT_KEY]: 9999999999,
      }),
    );

    // familyId written to sync storage
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      expect.objectContaining({ [FAMILY_ID_KEY]: "fam-solo-1" }),
    );

    // Background messages sent
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_FAMILY_ID",
        familyId: "fam-solo-1",
      }),
    );
  });

  it("sets auth token on apiClient on success", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(apiClient.setAuthToken).toHaveBeenCalledWith("tok");
  });

  it("calls syncBooks on success", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(autoSetup.syncBooks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-abc", apiClient }),
    );
  });

  it("returns { recovered: false, errorCode } when joinFamily returns an error", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: { code: "ERR", message: "fail" },
      }),
    });
    const autoSetup = createMockAutoSetup();

    const result = await performSoloRecovery({
      familyId: "fam-solo-err",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    expect(result).toEqual({ recovered: false, errorCode: "ERR" });
    expect(onFamilyJoined).not.toHaveBeenCalled();
  });

  it("does not call syncBooks or setAuthToken when joinFamily returns an error", async () => {
    const apiClient = createMockApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: { code: "ERR", message: "fail" },
      }),
    });
    const autoSetup = createMockAutoSetup();

    await performSoloRecovery({
      familyId: "fam-solo-err",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(autoSetup.syncBooks).not.toHaveBeenCalled();
    expect(apiClient.setAuthToken).not.toHaveBeenCalled();
  });

  it("still returns { recovered: true } when sync storage write fails", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    vi.mocked(chrome.storage.sync.set).mockRejectedValue(
      new Error("sync unavailable"),
    );

    const result = await performSoloRecovery({
      familyId: "fam-solo-syncerrr",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    // sync storage failure is swallowed; recovery still succeeds
    expect(result).toEqual({ recovered: true });
    expect(onFamilyJoined).toHaveBeenCalled();
  });
});

describe("tryAutoRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { recovered: true } and calls onFamilyJoined on successful auto-recovery", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    expect(result).toEqual({ recovered: true });
    expect(onFamilyJoined).toHaveBeenCalledWith("fam-existing", "user-abc");
  });
});

describe("performJoin", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default sync-code decode: plain local host, no apiHost override.
    vi.mocked(decodeSyncCode).mockReturnValue({
      familyId: "fam-join-1",
    });

    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls joinFamily with undefined verify opts when no secret is given", async () => {
    const apiClient = createMockApiClient();

    await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(apiClient.joinFamily).toHaveBeenCalledWith(
      "fam-join-1",
      "user-x",
      "Name",
      undefined,
    );
  });

  it("returns ok:true with familyId and userId on success", async () => {
    const apiClient = createMockApiClient();

    const result = await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(result).toEqual({
      ok: true,
      familyId: "fam-join-1",
      userId: "user-x",
    });
  });

  it("returns ok:false with errorCode and errorMessage when joinFamily fails", async () => {
    const apiClient = createMockApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: {
          code: "VERIFICATION_REQUIRED",
          message: "此帳號需要驗證才能登入",
        },
      }),
    });

    const result = await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "VERIFICATION_REQUIRED",
      errorMessage: "此帳號需要驗證才能登入",
    });
  });

  /**
   * Pasting an `@host` sync code IS an explicit choice of that endpoint, so the
   * join path persists it through the same helper the Settings confirmation
   * uses: a DIRECT storage.local write (authoritative — a sleeping Firefox
   * background page can drop the message) plus a best-effort SET_API_ENDPOINT
   * message. It also clears any stale "declined family endpoint" marker.
   */
  it("adopts, persists, and broadcasts the endpoint when decoded.apiHost is set", async () => {
    vi.mocked(decodeSyncCode).mockReturnValue({
      familyId: "fam-join-1",
      apiHost: "https://custom.example.com",
    });

    const apiClient = createMockApiClient();

    await performJoin({
      syncCodeInput: "moo-fam-join-1@https://custom.example.com",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(apiClient.setEndpoint).toHaveBeenCalledWith(
      "https://custom.example.com",
    );
    // The stored value is the client's normalised endpoint, not the raw segment.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [API_ENDPOINT_KEY]: "https://custom.example.com",
    });
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      DECLINED_FAMILY_ENDPOINT_KEY,
    ]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_API_ENDPOINT",
        apiEndpoint: "https://custom.example.com",
      }),
    );
  });

  it("leaves the endpoint alone when the sync code carries no @host", async () => {
    vi.mocked(decodeSyncCode).mockReturnValue({ familyId: "fam-join-1" });

    const apiClient = createMockApiClient();

    await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(apiClient.setEndpoint).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_API_ENDPOINT" }),
    );
  });

  /**
   * A sync code's `@host` is attacker-supplied text: whoever shares the code
   * chooses where the joiner's auth token and full book list are sent. It is
   * adopted through `setEndpoint`, i.e. the production `validateEndpointUrl`
   * allowlist — which now also refuses embedded credentials, so
   * `https://real.example@evil.com` (reads as real.example, fetches evil.com)
   * throws instead of being adopted.
   *
   * When it throws, the join must ABORT: no endpoint stored, no join request,
   * no credentials persisted, and the client left on the endpoint it already
   * trusted. `PerformJoinFailure` carries a Chinese message so the UI never
   * surfaces the raw English `Error`.
   */
  describe("an @host the endpoint validator refuses", () => {
    /**
     * The refusal path logs the underlying reason. Silenced here so the suite
     * stays readable, and restored after each test so no other file inherits a
     * muted console.
     */
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    /**
     * Mock client whose `setEndpoint` runs the REAL validator, so these tests
     * fail if the production allowlist ever stops rejecting these URLs.
     */
    function createValidatingApiClient(): ApiClient {
      let endpoint = DEFAULT_API_ENDPOINT;
      return createMockApiClient({
        getEndpoint: vi.fn(() => endpoint),
        setEndpoint: vi.fn((url: string) => {
          endpoint = validateEndpointUrl(url);
        }),
      });
    }

    const refusedHosts: Array<[string, string]> = [
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      // App-generated codes always carry a full URL; a scheme-less host was
      // never adoptable (`new URL()` throws), so aborting is not a regression.
      ["a bare host with no scheme", "my-worker.example.com"],
    ];

    it.each(refusedHosts)(
      "aborts the join with INVALID_ENDPOINT for %s",
      async (_label, apiHost) => {
        vi.mocked(decodeSyncCode).mockReturnValue({
          familyId: "fam-join-1",
          apiHost,
        });
        const apiClient = createValidatingApiClient();

        const result = await performJoin({
          syncCodeInput: `moo-fam-join-1@${apiHost}`,
          userId: "user-x",
          displayName: "Name",
          apiClient,
        });

        expect(result).toEqual({
          ok: false,
          errorCode: "INVALID_ENDPOINT",
          errorMessage: "此同步碼的伺服器位址無效或不安全，無法加入",
        });
      },
    );

    it.each(refusedHosts)(
      "persists nothing and never contacts the backend for %s",
      async (_label, apiHost) => {
        vi.mocked(decodeSyncCode).mockReturnValue({
          familyId: "fam-join-1",
          apiHost,
        });
        const apiClient = createValidatingApiClient();

        await performJoin({
          syncCodeInput: `moo-fam-join-1@${apiHost}`,
          userId: "user-x",
          displayName: "Name",
          apiClient,
        });

        expect(apiClient.joinFamily).not.toHaveBeenCalled();
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
        expect(chrome.storage.local.remove).not.toHaveBeenCalled();
        expect(chrome.storage.sync.set).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
      },
    );

    it("leaves the client on the endpoint it was already using", async () => {
      vi.mocked(decodeSyncCode).mockReturnValue({
        familyId: "fam-join-1",
        apiHost: "https://real.example@evil.com",
      });
      const apiClient = createValidatingApiClient();

      await performJoin({
        syncCodeInput: "moo-fam-join-1@https://real.example@evil.com",
        userId: "user-x",
        displayName: "Name",
        apiClient,
      });

      // setEndpoint throws BEFORE assigning, so the previous endpoint stands.
      expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
    });

    /**
     * The user-facing copy is deliberately generic ("無效或不安全"), so without
     * this log the reason a join was refused is unrecoverable — a self-hoster
     * debugging "why won't my family's code work?" has nothing to go on.
     */
    it.each(refusedHosts)(
      "logs why the join was refused for %s",
      async (_label, apiHost) => {
        vi.mocked(decodeSyncCode).mockReturnValue({
          familyId: "fam-join-1",
          apiHost,
        });

        await performJoin({
          syncCodeInput: `moo-fam-join-1@${apiHost}`,
          userId: "user-x",
          displayName: "Name",
          apiClient: createValidatingApiClient(),
        });

        expect(warn).toHaveBeenCalledWith(
          "[Onboarding] Sync code endpoint rejected",
          expect.any(Error),
        );
      },
    );

    it("logs nothing when the @host is acceptable", async () => {
      vi.mocked(decodeSyncCode).mockReturnValue({
        familyId: "fam-join-1",
        apiHost: "https://custom.example.com",
      });

      await performJoin({
        syncCodeInput: "moo-fam-join-1@https://custom.example.com",
        userId: "user-x",
        displayName: "Name",
        apiClient: createValidatingApiClient(),
      });

      expect(warn).not.toHaveBeenCalledWith(
        "[Onboarding] Sync code endpoint rejected",
        expect.anything(),
      );
    });

    it("adopts the NORMALIZED URL when the @host is acceptable", async () => {
      vi.mocked(decodeSyncCode).mockReturnValue({
        familyId: "fam-join-1",
        apiHost: "https://CUSTOM.Example.COM:443/api/",
      });
      const apiClient = createValidatingApiClient();

      const result = await performJoin({
        syncCodeInput: "moo-fam-join-1@https://CUSTOM.Example.COM:443/api/",
        userId: "user-x",
        displayName: "Name",
        apiClient,
      });

      expect(result).toEqual({
        ok: true,
        familyId: "fam-join-1",
        userId: "user-x",
      });
      // Stored in the same canonical form the endpoint-switch path persists, so
      // the two cannot later disagree about "the same" endpoint.
      expect(apiClient.getEndpoint()).toBe("https://custom.example.com/api");
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [API_ENDPOINT_KEY]: "https://custom.example.com/api",
      });
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SET_API_ENDPOINT",
          apiEndpoint: "https://custom.example.com/api",
        }),
      );
    });
  });

  /**
   * ENDPOINT LIFETIME, backend-refusal half. The `@host` is applied in memory
   * (the join request has to go there) but is PERSISTED only once the backend
   * accepts: a host whose server said "no" has proven nothing, and a persisted
   * endpoint outlives the attempt — it would still be in force when the user
   * gives up and presses 建立家庭, shipping the userId, the token create issues
   * and the whole book list there.
   *
   * The in-memory endpoint deliberately STAYS adopted here, because a
   * verification challenge is a continuation of the same attempt (it queries
   * that same server for the account's method). Handing it back is the caller's
   * job — pinned in tests/unit/useOnboardingFlow.test.ts → "handleJoin endpoint
   * lifetime (@host adoption and rollback)".
   */
  describe("a backend that refuses the join", () => {
    const REFUSED_HOST = "https://attacker.example";

    async function joinRefusedBy(errorCode: string): Promise<ApiClient> {
      vi.mocked(decodeSyncCode).mockReturnValue({
        familyId: "fam-join-1",
        apiHost: REFUSED_HOST,
      });
      const apiClient = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: errorCode, message: "拒絕" },
        }),
      });

      await performJoin({
        syncCodeInput: `moo-fam-join-1@${REFUSED_HOST}`,
        userId: "user-x",
        displayName: "Name",
        apiClient,
      });
      return apiClient;
    }

    const refusals = [
      ["a terminal refusal", "FAMILY_NOT_FOUND"],
      ["a verification challenge", "VERIFICATION_REQUIRED"],
      ["a rate limit", "RATE_LIMITED"],
    ] as const;

    it.each(refusals)(
      "persists no endpoint after %s",
      async (_label, errorCode) => {
        await joinRefusedBy(errorCode);

        expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
          expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
        );
        // The declined marker is dropped only by an ACCEPTED switch; a refused
        // join must not silently clear the user's earlier refusal either.
        expect(chrome.storage.local.remove).not.toHaveBeenCalledWith([
          DECLINED_FAMILY_ENDPOINT_KEY,
        ]);
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "SET_API_ENDPOINT" }),
        );
      },
    );

    it.each(refusals)(
      "leaves the @host applied in memory after %s, for the caller to release",
      async (_label, errorCode) => {
        const apiClient = await joinRefusedBy(errorCode);

        expect(apiClient.getEndpoint()).toBe(REFUSED_HOST);
      },
    );
  });

  it("persists credentials and sends SET_FAMILY_ID on success", async () => {
    const apiClient = createMockApiClient();

    await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [USER_ID_KEY]: "user-x",
        [AUTH_TOKEN_KEY]: "tok",
        [TOKEN_EXPIRES_AT_KEY]: 9999999999,
      }),
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_FAMILY_ID",
        familyId: "fam-join-1",
      }),
    );
  });
});

/**
 * `restoreApiEndpoint` hands the in-memory client back to the endpoint an
 * abandoned join attempt started from. It touches the client ONLY: performJoin
 * persists a sync code's `@host` after the backend accepts, so an attempt that
 * ended without a join has nothing durable to undo.
 *
 * It runs on error paths, where a throw would replace the failure the caller is
 * in the middle of reporting — so a refusing setEndpoint must be swallowed and
 * logged, never propagated.
 */
describe("restoreApiEndpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the client back on the given endpoint", () => {
    const apiClient = createMockApiClient();
    apiClient.setEndpoint("https://attacker.example");

    restoreApiEndpoint(apiClient, DEFAULT_API_ENDPOINT);

    expect(apiClient.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
  });

  it("writes nothing to storage and sends no message", () => {
    const apiClient = createMockApiClient();

    restoreApiEndpoint(apiClient, DEFAULT_API_ENDPOINT);

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("swallows and logs a setEndpoint that throws, instead of masking the caller's failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = new Error("endpoint rejected");
    const apiClient = createMockApiClient({
      setEndpoint: vi.fn(() => {
        throw boom;
      }),
    });

    expect(() =>
      restoreApiEndpoint(apiClient, "https://unreachable.example"),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[Onboarding] Failed to restore previous API endpoint",
      boom,
    );

    warn.mockRestore();
  });
});

/**
 * SEC-1: existing verification-enabled members hit VERIFICATION_REQUIRED on a
 * fresh device. The three join flows must (a) forward the collected verifySecret
 * into joinFamily's opts, and (b) the two recovery flows must surface the
 * backend errorCode on failure so the caller can open the verification prompt
 * instead of silently dropping to a generic error.
 */
describe("verification secret forwarding & errorCode surfacing (SEC-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decodeSyncCode).mockReturnValue({ familyId: "fam-join-1" });
    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tryAutoRecovery forwards verifySecret into joinFamily opts", async () => {
    const apiClient = createMockApiClient();

    await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup: createMockAutoSetup(),
      onFamilyJoined: vi.fn(),
      verifySecret: "123456",
    });

    expect(apiClient.joinFamily).toHaveBeenCalledWith(
      "fam-existing",
      "user-abc",
      "Test User",
      { verifySecret: "123456" },
    );
  });

  it("performSoloRecovery forwards verifySecret into joinFamily opts", async () => {
    const apiClient = createMockApiClient();

    await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup: createMockAutoSetup(),
      onFamilyJoined: vi.fn(),
      verifySecret: "654321",
    });

    expect(apiClient.joinFamily).toHaveBeenCalledWith(
      "fam-solo-1",
      "user-abc",
      "Test User",
      { verifySecret: "654321" },
    );
  });

  it("performJoin forwards verifySecret into joinFamily opts", async () => {
    const apiClient = createMockApiClient();

    await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-x",
      displayName: "Name",
      apiClient,
      verifySecret: "778899",
    });

    expect(apiClient.joinFamily).toHaveBeenCalledWith(
      "fam-join-1",
      "user-x",
      "Name",
      { verifySecret: "778899" },
    );
  });

  it("tryAutoRecovery surfaces VERIFICATION_REQUIRED errorCode on failure", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: { code: "VERIFICATION_REQUIRED", message: "需要驗證" },
      }),
    });

    const result = await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup: createMockAutoSetup(),
      onFamilyJoined,
    });

    expect(result).toEqual({
      recovered: false,
      errorCode: "VERIFICATION_REQUIRED",
    });
    expect(onFamilyJoined).not.toHaveBeenCalled();
  });

  it("performSoloRecovery surfaces VERIFICATION_LOCKED errorCode on failure", async () => {
    const apiClient = createMockApiClient({
      joinFamily: vi.fn().mockResolvedValue({
        error: { code: "VERIFICATION_LOCKED", message: "已鎖定" },
      }),
    });

    const result = await performSoloRecovery({
      familyId: "fam-solo-1",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup: createMockAutoSetup(),
      onFamilyJoined: vi.fn(),
    });

    expect(result).toEqual({
      recovered: false,
      errorCode: "VERIFICATION_LOCKED",
    });
  });

  /**
   * A 429 lockout body carries `error.retryAfter` (seconds). Each flow must pass
   * it through untouched — it is what lets the verification prompt show a live
   * countdown instead of an open-ended "請稍後再試".
   */
  describe("retryAfter surfacing on 429 failures", () => {
    /** joinFamily answering with a locked 429 that includes retryAfter. */
    function lockedApiClient(retryAfter?: number): ApiClient {
      return createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "VERIFICATION_LOCKED", message: "已鎖定", retryAfter },
        }),
      });
    }

    it("tryAutoRecovery surfaces retryAfter alongside the errorCode", async () => {
      const result = await tryAutoRecovery({
        familyId: "fam-existing",
        userId: "user-abc",
        displayName: "Test User",
        apiClient: lockedApiClient(120),
        autoSetup: createMockAutoSetup(),
        onFamilyJoined: vi.fn(),
      });

      expect(result).toEqual({
        recovered: false,
        errorCode: "VERIFICATION_LOCKED",
        retryAfter: 120,
      });
    });

    it("performSoloRecovery surfaces retryAfter alongside the errorCode", async () => {
      const result = await performSoloRecovery({
        familyId: "fam-solo-1",
        userId: "user-abc",
        displayName: "Test User",
        apiClient: lockedApiClient(45),
        autoSetup: createMockAutoSetup(),
        onFamilyJoined: vi.fn(),
      });

      expect(result).toEqual({
        recovered: false,
        errorCode: "VERIFICATION_LOCKED",
        retryAfter: 45,
      });
    });

    it("performJoin surfaces retryAfter alongside the errorCode", async () => {
      const result = await performJoin({
        syncCodeInput: "moo-fam-join-1",
        userId: "user-x",
        displayName: "Name",
        apiClient: lockedApiClient(90),
      });

      expect(result).toEqual({
        ok: false,
        errorCode: "VERIFICATION_LOCKED",
        errorMessage: "已鎖定",
        retryAfter: 90,
      });
    });

    it("leaves retryAfter undefined when the backend omits it", async () => {
      const result = await tryAutoRecovery({
        familyId: "fam-existing",
        userId: "user-abc",
        displayName: "Test User",
        apiClient: lockedApiClient(),
        autoSetup: createMockAutoSetup(),
        onFamilyJoined: vi.fn(),
      });

      expect(result.retryAfter).toBeUndefined();
      expect(result.errorCode).toBe("VERIFICATION_LOCKED");
    });
  });

  it("success side-effects still fire when no verifySecret is needed", async () => {
    const onFamilyJoined = vi.fn();
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    expect(result).toEqual({ recovered: true });
    expect(apiClient.setAuthToken).toHaveBeenCalledWith("tok");
    expect(autoSetup.syncBooks).toHaveBeenCalled();
    expect(onFamilyJoined).toHaveBeenCalledWith("fam-existing", "user-abc");
  });
});

/**
 * Firefox: the background event page can be asleep, so the fire-and-forget
 * SET_FAMILY_ID message rejects. familyId persistence must NOT depend on that
 * message — every flow writes FAMILY_ID_KEY DIRECTLY to storage.local. These
 * tests force chrome.runtime.sendMessage to reject and assert the direct write
 * still happened with the expected familyId.
 */
describe("familyId persists to storage.local even when SET_FAMILY_ID message rejects (Firefox)", () => {
  // Find the local.set call whose payload includes FAMILY_ID_KEY (the credential
  // write batches USER_ID_KEY + FAMILY_ID_KEY + auth fields in a single set).
  function familyIdSetCall(): Record<string, unknown> | undefined {
    const calls = vi.mocked(chrome.storage.local.set).mock.calls;
    const match = calls.find(
      ([items]) =>
        typeof items === "object" &&
        items !== null &&
        FAMILY_ID_KEY in (items as Record<string, unknown>),
    );
    return match?.[0] as Record<string, unknown> | undefined;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(decodeSyncCode).mockReturnValue({ familyId: "fam-join-1" });

    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(() =>
      Promise.resolve(),
    );
    // Simulate sleeping Firefox background: every message round-trip rejects.
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error(
        "Could not establish connection. Receiving end does not exist.",
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createNewFamily writes FAMILY_ID_KEY to storage.local", async () => {
    const apiClient = createMockApiClient();

    const result = await createNewFamily({
      userId: "user-create",
      displayName: "Creator",
      apiClient,
    });

    expect(result.familyId).toBe("fam-created-1");
    const setCall = familyIdSetCall();
    expect(setCall).toBeDefined();
    expect(setCall).toMatchObject({ [FAMILY_ID_KEY]: "fam-created-1" });
  });

  it("performJoin writes FAMILY_ID_KEY to storage.local", async () => {
    const apiClient = createMockApiClient();

    const result = await performJoin({
      syncCodeInput: "moo-fam-join-1",
      userId: "user-join",
      displayName: "Joiner",
      apiClient,
    });

    expect(result).toMatchObject({ ok: true, familyId: "fam-join-1" });
    const setCall = familyIdSetCall();
    expect(setCall).toBeDefined();
    expect(setCall).toMatchObject({ [FAMILY_ID_KEY]: "fam-join-1" });
  });

  it("tryAutoRecovery writes FAMILY_ID_KEY to storage.local", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await tryAutoRecovery({
      familyId: "fam-recover-1",
      userId: "user-recover",
      displayName: "Recoverer",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(result).toEqual({ recovered: true });
    const setCall = familyIdSetCall();
    expect(setCall).toBeDefined();
    expect(setCall).toMatchObject({ [FAMILY_ID_KEY]: "fam-recover-1" });
  });

  it("performSoloRecovery writes FAMILY_ID_KEY to storage.local", async () => {
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await performSoloRecovery({
      familyId: "fam-solo-recover-1",
      userId: "user-solo",
      displayName: "Solo",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(result).toEqual({ recovered: true });
    const setCall = familyIdSetCall();
    expect(setCall).toBeDefined();
    expect(setCall).toMatchObject({ [FAMILY_ID_KEY]: "fam-solo-recover-1" });
  });
});

/**
 * `createFamily` resolves the `{ data, error }` envelope through `readEnvelope`,
 * which bare-casts `response.json()` (src/api/client.ts), and the endpoint is
 * user-configurable (BYO backend via the sync code's `@host`), so
 * `error.message` is `unknown` at runtime — while `CreateFamilyError`'s
 * constructor parameter is typed `string`.
 *
 * That gap is load-bearing here, because the thrown value is not just copy: the
 * caller distinguishes a verification challenge from a dead end by
 * `instanceof CreateFamilyError` plus its `code`. A message the Error
 * constructor cannot stringify (ToString throws for an object with `toString`
 * and `valueOf` nulled out) used to throw a TypeError from INSIDE the
 * constructor, so no CreateFamilyError ever existed — the VERIFICATION_REQUIRED
 * bridge was skipped and the user was dead-ended on an account that only needed
 * a PIN. Coercing before construction is what keeps that bridge reachable.
 */
describe("createNewFamily — refused by the backend", () => {
  const FALLBACK = "建立家庭失敗，請稍後再試";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(() =>
      Promise.resolve(),
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A client whose createFamily refuses with the given envelope error. */
  function refusingApiClient(error: Record<string, unknown>): ApiClient {
    return createMockApiClient({
      createFamily: vi.fn().mockResolvedValue({ error }),
    });
  }

  /**
   * Run createNewFamily and hand back whatever it threw. The trailing throw
   * keeps a resolved call from passing vacuously.
   */
  async function captureThrown(apiClient: ApiClient): Promise<unknown> {
    try {
      await createNewFamily({
        userId: "user-create",
        displayName: "Creator",
        apiClient,
      });
    } catch (err) {
      return err;
    }
    throw new Error("createNewFamily resolved; expected it to throw");
  }

  it.each([
    { name: "an object message", message: { zh: "壞掉了" } },
    // Degrades too: a blank error would leave the dialog reporting nothing.
    { name: "an empty-string message", message: "" },
  ])(
    "throws CreateFamilyError with the local copy and the code preserved for $name",
    async ({ message }) => {
      const thrown = await captureThrown(
        refusingApiClient({ code: "VERIFICATION_REQUIRED", message }),
      );

      expect(thrown).toBeInstanceOf(CreateFamilyError);
      // Literal from src/dialog/onboardingFlow.ts (createNewFamily).
      expect((thrown as CreateFamilyError).message).toBe(FALLBACK);
      // The code is what the caller bridges on — degrading the message must
      // never cost it.
      expect((thrown as CreateFamilyError).code).toBe("VERIFICATION_REQUIRED");
    },
  );

  it("still throws CreateFamilyError (not TypeError) for a message that cannot be stringified", async () => {
    // The exact payload from review: nulling both `toString` and `valueOf`
    // makes ToPrimitive throw, so `new CreateFamilyError(message, …)` used to
    // die inside its own constructor with a TypeError. A TypeError is not a
    // CreateFamilyError, so the caller's instanceof check failed and the
    // verification prompt never opened.
    const thrown = await captureThrown(
      refusingApiClient({
        code: "VERIFICATION_REQUIRED",
        message: { toString: null, valueOf: null },
      }),
    );

    expect(thrown).toBeInstanceOf(CreateFamilyError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as CreateFamilyError).message).toBe(FALLBACK);
    expect((thrown as CreateFamilyError).code).toBe("VERIFICATION_REQUIRED");
  });

  it("passes a legitimate server message through, with code and retryAfter", async () => {
    // The guard must not over-degrade: a real string still reaches the user,
    // and the 429 wait rides along so the prompt can count down.
    const thrown = await captureThrown(
      refusingApiClient({
        code: "VERIFICATION_LOCKED",
        message: "驗證已鎖定，請稍後再試",
        retryAfter: 120,
      }),
    );

    expect(thrown).toBeInstanceOf(CreateFamilyError);
    expect((thrown as CreateFamilyError).message).toBe(
      "驗證已鎖定，請稍後再試",
    );
    expect((thrown as CreateFamilyError).code).toBe("VERIFICATION_LOCKED");
    expect((thrown as CreateFamilyError).retryAfter).toBe(120);
  });
});
