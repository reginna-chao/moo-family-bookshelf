import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDisplayName } from "@/dialog/useDisplayName";

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
});
