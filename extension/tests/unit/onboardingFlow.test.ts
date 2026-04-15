import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

// Mock crypto module — deterministic values for unit tests
vi.mock("@/crypto/encrypt", () => ({
  generateKey: vi.fn().mockResolvedValue({} as CryptoKey),
  exportKey: vi.fn().mockResolvedValue("fresh-key-string"),
  computeKeyFingerprint: vi.fn().mockResolvedValue("f".repeat(64)),
  importKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue("mock-encrypted-payload"),
  deriveUserId: vi.fn().mockResolvedValue("a".repeat(64)),
}));

import { performSoloRecovery, tryAutoRecovery } from "@/dialog/onboardingFlow";
import { generateKey, exportKey, computeKeyFingerprint } from "@/crypto/encrypt";
import type { ApiClient } from "@/api/client";
import type { useAutoSetup } from "@/dialog/useAutoSetup";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    joinFamily: vi.fn().mockResolvedValue({
      data: { authToken: "tok", expiresAt: 9999999999 },
    }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    setAuthToken: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
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

    // Re-apply crypto mock implementations cleared by clearAllMocks
    vi.mocked(generateKey).mockResolvedValue({} as CryptoKey);
    vi.mocked(exportKey).mockResolvedValue("fresh-key-string");
    vi.mocked(computeKeyFingerprint).mockResolvedValue("f".repeat(64));

    // Reset chrome.storage mocks
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => Promise.resolve(),
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

    expect(result).toEqual({ recovered: true, keyRotated: true });
    expect(onFamilyJoined).toHaveBeenCalledWith("fam-solo-1", "user-abc");
  });

  it("calls joinFamily with the freshly generated keyFingerprint", async () => {
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
      expect.objectContaining({ keyFingerprint: "f".repeat(64) }),
    );
  });

  it("passes only keyFingerprint to joinFamily (recoverySource removed in C1 security fix)", async () => {
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
      {
        keyFingerprint: "f".repeat(64),
      },
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
        userId: "user-abc",
        encryptionKey: "fresh-key-string",
        authToken: "tok",
        tokenExpiresAt: 9999999999,
      }),
    );

    // familyId written to sync storage
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: "fam-solo-1" }),
    );

    // Background messages sent
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_FAMILY_ID", familyId: "fam-solo-1" }),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_ENCRYPTION_KEY", encryptionKey: "fresh-key-string" }),
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

  it("returns { recovered: false } when joinFamily returns an error", async () => {
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

    expect(result).toEqual({ recovered: false });
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

    vi.mocked(chrome.storage.sync.set).mockRejectedValue(new Error("sync unavailable"));

    const result = await performSoloRecovery({
      familyId: "fam-solo-syncerrr",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined,
    });

    // sync storage failure is swallowed; recovery still succeeds
    expect(result).toEqual({ recovered: true, keyRotated: true });
    expect(onFamilyJoined).toHaveBeenCalled();
  });
});

describe("tryAutoRecovery", () => {
  /**
   * Wire chrome.runtime.sendMessage so GET_ENCRYPTION_KEY returns the given key.
   * Mirrors the helper used in component tests.
   */
  function mockEncryptionKeyMessage(encryptionKey: string | null) {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (...args: unknown[]) => {
        const msg = args[0] as Record<string, unknown>;
        const callback = args[1] as ((response: unknown) => void) | undefined;
        if (msg.type === "GET_ENCRYPTION_KEY" && typeof callback === "function") {
          callback({ encryptionKey });
        }
        return Promise.resolve();
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(generateKey).mockResolvedValue({} as CryptoKey);
    vi.mocked(exportKey).mockResolvedValue("fresh-key-string");
    vi.mocked(computeKeyFingerprint).mockResolvedValue("f".repeat(64));

    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => Promise.resolve(),
    );
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        if (typeof callback === "function") callback({});
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => Promise.resolve(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("regression guard: does NOT pass recoverySource to joinFamily (only keyFingerprint)", async () => {
    // tryAutoRecovery uses a synced key from another device. It must NOT
    // signal `recoverySource: "extension"` — that flag is reserved for the
    // solo-recovery path where a fresh key is generated. Widening this flag
    // would let any auto-recovery bypass PWA verification, breaking trust.
    mockEncryptionKeyMessage("synced-key-from-other-device");
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(apiClient.joinFamily).toHaveBeenCalledTimes(1);
    const fourthArg = vi.mocked(apiClient.joinFamily).mock.calls[0][3];
    expect(fourthArg).toBeDefined();
    expect(fourthArg).toHaveProperty("keyFingerprint");
    expect(fourthArg).not.toHaveProperty("recoverySource");
  });

  it("returns { recovered: false } when no synced encryption key is available", async () => {
    mockEncryptionKeyMessage(null);
    const apiClient = createMockApiClient();
    const autoSetup = createMockAutoSetup();

    const result = await tryAutoRecovery({
      familyId: "fam-existing",
      userId: "user-abc",
      displayName: "Test User",
      apiClient,
      autoSetup,
      onFamilyJoined: vi.fn(),
    });

    expect(result).toEqual({ recovered: false });
    expect(apiClient.joinFamily).not.toHaveBeenCalled();
  });

  it("returns { recovered: true } and calls onFamilyJoined on successful auto-recovery", async () => {
    mockEncryptionKeyMessage("synced-key-from-other-device");
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
