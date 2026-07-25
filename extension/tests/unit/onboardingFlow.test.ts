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
  tryAutoRecovery,
  createNewFamily,
} from "@/dialog/onboardingFlow";
import { decodeSyncCode } from "@/crypto/syncCode";
import type { ApiClient } from "@/api/client";
import type { useAutoSetup } from "@/dialog/useAutoSetup";
import {
  DEFAULT_API_ENDPOINT,
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
} from "@/constants";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
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
    getEndpoint: vi.fn().mockReturnValue(DEFAULT_API_ENDPOINT),
    setEndpoint: vi.fn(),
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
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
        Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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

    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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

    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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

  it("updates api endpoint and sends SET_API_ENDPOINT when decoded.apiHost is set", async () => {
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
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_API_ENDPOINT",
        apiEndpoint: "https://custom.example.com",
      }),
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
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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

    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) =>
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
