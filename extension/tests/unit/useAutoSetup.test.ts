import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("user@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("User Name"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

// Mock crypto module
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail, scrapeDisplayName } from "@/content/scraper";
import type { ApiClient } from "@/api/client";

function createMockApiClient(): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
  } as unknown as ApiClient;
}

describe("useAutoSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { encryptionKey: "test-key-123" };
        if (typeof callback === "function") {
          callback(result);
          return undefined as unknown as Promise<Record<string, unknown>>;
        }
        return Promise.resolve(result) as unknown as Promise<Record<string, unknown>>;
      },
    );
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => {
        return Promise.resolve();
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle phase", () => {
    const { result } = renderHook(() => useAutoSetup());
    expect(result.current.phase).toBe("idle");
    expect(result.current.phaseMessage).toBe("");
  });

  it("scrapeProfile navigates to #/me and returns email", async () => {
    const { result } = renderHook(() => useAutoSetup());

    let profileResult: { email: string; displayName: string } | null = null;
    await act(async () => {
      profileResult = await result.current.scrapeProfile();
    });

    expect(profileResult).toEqual({
      email: "user@example.com",
      displayName: "User Name",
    });
    expect(result.current.phase).toBe("idle");
  });

  it("scrapeProfile returns null and sets error when email not found", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValueOnce(null);
    const { result } = renderHook(() => useAutoSetup());

    let profileResult: { email: string; displayName: string } | null = null;
    await act(async () => {
      profileResult = await result.current.scrapeProfile();
    });

    expect(profileResult).toBeNull();
    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toContain("無法取得帳號信箱");
  });

  it("reset returns to idle phase", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValueOnce(null);
    const { result } = renderHook(() => useAutoSetup());

    await act(async () => {
      await result.current.scrapeProfile();
    });

    expect(result.current.phase).toBe("error");

    act(() => {
      result.current.reset();
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.errorMessage).toBe("");
  });

  it("syncBooks returns true on success", async () => {
    const mockApi = createMockApiClient();
    const { result } = renderHook(() => useAutoSetup());

    let success = false;
    await act(async () => {
      success = await result.current.syncBooks({
        userId: "user-hash",
        apiClient: mockApi,
      });
    });

    expect(success).toBe(true);
    expect(result.current.phase).toBe("done");
  });

  it("syncBooks returns false when encryption key is missing", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") {
          callback(result);
          return undefined as unknown as Promise<Record<string, unknown>>;
        }
        return Promise.resolve(result) as unknown as Promise<Record<string, unknown>>;
      },
    );

    const mockApi = createMockApiClient();
    const { result } = renderHook(() => useAutoSetup());

    let success = false;
    await act(async () => {
      success = await result.current.syncBooks({
        userId: "user-hash",
        apiClient: mockApi,
      });
    });

    expect(success).toBe(false);
    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toContain("找不到加密金鑰");
  });
});
