import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDisplayName } from "@/dialog/useDisplayName";
import type { ApiClient } from "@/api/client";
import { DISPLAY_NAME_KEY } from "@/constants";

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
        const result = { [DISPLAY_NAME_KEY]: "小明" };
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
  });

  it("loads display name from chrome.storage.local when no initial value provided", async () => {
    const { result } = renderHook(() => useDisplayName());

    await waitFor(() => {
      expect(result.current.displayName).toBe("小明");
    });
    expect(result.current.savedDisplayName).toBe("小明");
  });

  it("defaults to empty string when no display name stored and no initial provided", async () => {
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

    await act(async () => {});
    expect(result.current.displayName).toBe("");
    expect(result.current.savedDisplayName).toBe("");
  });

  it("saves display name to both local and sync storage", async () => {
    const { result } = renderHook(() => useDisplayName());

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
    expect(result.current.savedDisplayName).toBe("大明");
    expect(result.current.nameSaveState).toBe("saved");
  });

  it("treats save as successful when sync.set rejects but local.set succeeds (Firefox)", async () => {
    vi.mocked(chrome.storage.sync.set).mockRejectedValue(
      new Error("sync unavailable"),
    );

    const { result } = renderHook(() => useDisplayName());

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("大明");
    });

    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.handleSaveDisplayName();
    });

    // Local write must still land; sync failure is best-effort and swallowed.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
    // A sync rejection must NOT flip the save to error or return false.
    expect(saved).toBe(true);
    expect(result.current.nameSaveState).toBe("saved");
    expect(result.current.savedDisplayName).toBe("大明");
  });

  it("calls updateDisplayName API when options provided", async () => {
    const apiClient = createMockApiClient();
    const { result } = renderHook(() =>
      useDisplayName({ apiClient, familyId: "fam-1", userId: "user-123" }),
    );

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(apiClient.updateDisplayName).toHaveBeenCalledWith("fam-1", "user-123", "大明");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
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

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(result.current.nameSaveState).toBe("error");
    expect(result.current.nameSaveError).toBe("名稱過長");
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
  });

  it("trims whitespace from display name before saving", async () => {
    const apiClient = createMockApiClient();
    const { result } = renderHook(() =>
      useDisplayName({ apiClient, familyId: "fam-1", userId: "user-123" }),
    );

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("  大明  ");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(apiClient.updateDisplayName).toHaveBeenCalledWith("fam-1", "user-123", "大明");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
  });

  it("skips API call when options not provided", async () => {
    const { result } = renderHook(() => useDisplayName());

    await waitFor(() => expect(result.current.displayName).toBe("小明"));

    act(() => {
      result.current.setDisplayName("大明");
    });

    await act(async () => {
      await result.current.handleSaveDisplayName();
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [DISPLAY_NAME_KEY]: "大明" });
    expect(result.current.nameSaveState).toBe("saved");
  });

  describe("initialDisplayName from context", () => {
    it("uses initialDisplayName as source of truth, ignoring local cache", async () => {
      const { result } = renderHook(() =>
        useDisplayName({ initialDisplayName: "伺服器名稱" }),
      );

      await waitFor(() => expect(result.current.displayName).toBe("伺服器名稱"));
      expect(result.current.savedDisplayName).toBe("伺服器名稱");
    });

    it("does NOT call getFamilyMembers (no redundant fetch)", async () => {
      const getFamilyMembers = vi.fn();
      const apiClient = createMockApiClient({ getFamilyMembers });
      renderHook(() =>
        useDisplayName({
          apiClient,
          familyId: "fam-1",
          userId: "user-123",
          initialDisplayName: "伺服器名稱",
        }),
      );

      await act(async () => {});
      expect(getFamilyMembers).not.toHaveBeenCalled();
    });

    it("updates state when initialDisplayName changes (user not editing)", async () => {
      const { result, rerender } = renderHook(
        ({ initial }) => useDisplayName({ initialDisplayName: initial }),
        { initialProps: { initial: "舊名" } },
      );

      await waitFor(() => expect(result.current.displayName).toBe("舊名"));

      rerender({ initial: "新名" });

      await waitFor(() => expect(result.current.displayName).toBe("新名"));
      expect(result.current.savedDisplayName).toBe("新名");
    });

    it("does NOT clobber displayName when user is editing (only updates savedDisplayName)", async () => {
      const { result, rerender } = renderHook(
        ({ initial }) => useDisplayName({ initialDisplayName: initial }),
        { initialProps: { initial: "舊名" } },
      );

      await waitFor(() => expect(result.current.displayName).toBe("舊名"));

      // Simulate user starting to edit (typing "User Typed")
      act(() => {
        result.current.setDisplayName("User Typed");
      });
      expect(result.current.displayName).toBe("User Typed");
      expect(result.current.savedDisplayName).toBe("舊名");

      // Server pushes a new value while user is editing
      rerender({ initial: "新名" });

      await waitFor(() => expect(result.current.savedDisplayName).toBe("新名"));
      // displayName MUST stay as the user's typed value
      expect(result.current.displayName).toBe("User Typed");
    });

    it("falls back to chrome.storage.local while initialDisplayName is undefined (loading)", async () => {
      const { result } = renderHook(() =>
        useDisplayName({ initialDisplayName: undefined }),
      );

      await waitFor(() => expect(result.current.displayName).toBe("小明"));
    });

    it("switches from local cache to server value when context loads", async () => {
      const { result, rerender } = renderHook(
        ({ initial }) => useDisplayName({ initialDisplayName: initial }),
        { initialProps: { initial: undefined as string | undefined } },
      );

      // Initial: undefined → fall back to chrome.storage.local "小明"
      await waitFor(() => expect(result.current.displayName).toBe("小明"));

      // Context finishes loading → switch to server value
      rerender({ initial: "伺服器名稱" });

      await waitFor(() => expect(result.current.displayName).toBe("伺服器名稱"));
      expect(result.current.savedDisplayName).toBe("伺服器名稱");
    });

    it("accepts empty string from context (clear is durable)", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { [DISPLAY_NAME_KEY]: "停留在 cache 的舊名" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const { result } = renderHook(() =>
        useDisplayName({ initialDisplayName: "" }),
      );

      // Empty initialDisplayName must override local cache (deliberate clear)
      await waitFor(() => expect(result.current.savedDisplayName).toBe(""));
      expect(result.current.displayName).toBe("");
    });

    it("does not write to chrome.storage on context-driven updates", async () => {
      const { rerender } = renderHook(
        ({ initial }) => useDisplayName({ initialDisplayName: initial }),
        { initialProps: { initial: "初始" } },
      );

      // Wait for initial sync
      await act(async () => {});

      vi.mocked(chrome.storage.local.set).mockClear();
      vi.mocked(chrome.storage.sync.set).mockClear();

      rerender({ initial: "更新" });

      await act(async () => {});

      // Storage writes happen only on explicit save, not on prop sync
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("cleans up on unmount (no setState after unmount)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { unmount } = renderHook(() =>
        useDisplayName({ initialDisplayName: "name" }),
      );

      unmount();

      // Wait long enough that any deferred storage callback would have fired
      await new Promise((r) => setTimeout(r, 50));

      // No "setState on unmounted" warnings
      const calls = errorSpy.mock.calls.flat().join(" ");
      expect(calls).not.toContain("unmounted");

      errorSpy.mockRestore();
    });
  });
});
