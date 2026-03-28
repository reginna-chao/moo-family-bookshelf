import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDisplayName } from "@/dialog/useDisplayName";
import type { ApiClient } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    updateDisplayName: vi.fn().mockResolvedValue({
      data: { userId: "user-123", displayName: "大明" },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("useDisplayName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { displayName: "小明" };
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
  });

  it("loads display name from chrome.storage.local", () => {
    const { result } = renderHook(() => useDisplayName());

    expect(result.current.displayName).toBe("小明");
    expect(result.current.savedDisplayName).toBe("小明");
  });

  it("defaults to empty string when no display name stored", () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );

    const { result } = renderHook(() => useDisplayName());

    expect(result.current.displayName).toBe("");
    expect(result.current.savedDisplayName).toBe("");
  });

  it("saves display name to both local and sync storage", async () => {
    const { result } = renderHook(() => useDisplayName());

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ displayName: "大明" });
    expect(result.current.savedDisplayName).toBe("大明");
    expect(result.current.nameSaveState).toBe("saved");
  });

  it("calls updateDisplayName API when options provided", async () => {
    const apiClient = createMockApiClient();
    const { result } = renderHook(() =>
      useDisplayName({ apiClient, familyId: "fam-1", userId: "user-123" }),
    );

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(apiClient.updateDisplayName).toHaveBeenCalledWith("fam-1", "user-123", "大明");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
    expect(result.current.nameSaveState).toBe("saved");
  });

  it("sets error state when API call fails", async () => {
    const apiClient = createMockApiClient({
      updateDisplayName: vi.fn().mockResolvedValue({
        error: { code: "VALIDATION_ERROR", message: "名稱過長" },
      }),
    });
    const { result } = renderHook(() =>
      useDisplayName({ apiClient, familyId: "fam-1", userId: "user-123" }),
    );

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(result.current.nameSaveState).toBe("error");
    expect(result.current.nameSaveError).toBe("名稱過長");
    // Should NOT save to storage when API fails
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ displayName: "大明" });
  });

  it("trims whitespace from display name before saving", async () => {
    const apiClient = createMockApiClient();
    const { result } = renderHook(() =>
      useDisplayName({ apiClient, familyId: "fam-1", userId: "user-123" }),
    );

    act(() => {
      result.current.setDisplayName("  大明  ");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(apiClient.updateDisplayName).toHaveBeenCalledWith("fam-1", "user-123", "大明");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
  });

  it("skips API call when options not provided", async () => {
    const { result } = renderHook(() => useDisplayName());

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    // Should still save to storage
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
    expect(result.current.nameSaveState).toBe("saved");
  });
});
