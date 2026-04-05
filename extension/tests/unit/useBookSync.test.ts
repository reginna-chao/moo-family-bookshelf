import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag, type ApiClient } from "@/api/client";

// Mock syncBooks module
vi.mock("@/sync/syncBooks", () => ({
  syncBooks: vi.fn(),
  canAutoSync: vi.fn(),
}));

import { useBookSync, type UseBookSyncOptions } from "@/dialog/useBookSync";
import { syncBooks, canAutoSync } from "@/sync/syncBooks";

function createMockApiClient(): ApiClient {
  return {
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn(),
  } as unknown as ApiClient;
}

function makeOptions(overrides: Partial<UseBookSyncOptions> = {}): UseBookSyncOptions {
  return {
    userId: "user-123",
    apiClient: createMockApiClient(),
    ...overrides,
  };
}

describe("useBookSync", () => {
  let originalHash: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    originalHash = window.location.hash;

    // Default: not on library page, canAutoSync returns false
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/settings" },
    });
    vi.mocked(canAutoSync).mockResolvedValue(false);
    vi.mocked(syncBooks).mockResolvedValue({ success: true, books: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: originalHash },
      });
    } catch {
      // Ignore if restoration fails
    }
  });

  describe("initial state", () => {
    it("starts with idle syncStatus", () => {
      const { result } = renderHook(() => useBookSync(makeOptions()));

      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.syncError).toBe("");
      expect(result.current.lastSyncBooks).toEqual([]);
      expect(result.current.autoSyncDone).toBe(false);
    });
  });

  describe("auto-sync", () => {
    it("does not trigger auto-sync when not on #/library page", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/settings" },
      });

      renderHook(() => useBookSync(makeOptions()));

      // Flush promises
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(canAutoSync).not.toHaveBeenCalled();
      expect(syncBooks).not.toHaveBeenCalled();
    });

    it("does not trigger auto-sync when canAutoSync returns false", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(false);

      renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(canAutoSync).toHaveBeenCalledOnce();
      expect(syncBooks).not.toHaveBeenCalled();
    });

    it("triggers auto-sync when on #/library and canAutoSync returns true", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);

      const mockBooks = [
        {
          bookId: "b1",
          title: "Book 1",
          author: "",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ];
      vi.mocked(syncBooks).mockResolvedValue({ success: true, books: mockBooks });

      const options = makeOptions();
      const { result } = renderHook(() => useBookSync(options));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(syncBooks).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledWith({
        navigate: false,
        userId: "user-123",
        apiClient: options.apiClient,
      });
      expect(result.current.lastSyncBooks).toEqual(mockBooks);
      expect(result.current.autoSyncDone).toBe(true);
    });

    it("transitions to syncing then done on auto-sync success", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);

      let resolveSync: (value: { success: boolean; books: never[] }) => void;
      vi.mocked(syncBooks).mockImplementation(
        () => new Promise((resolve) => { resolveSync = resolve; }),
      );

      const { result } = renderHook(() => useBookSync(makeOptions()));

      // Let canAutoSync resolve
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(result.current.syncStatus).toBe("syncing");

      // Resolve syncBooks
      await act(async () => {
        resolveSync!({ success: true, books: [] });
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(result.current.syncStatus).toBe("done");

      // After 2000ms, transitions back to idle
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.syncStatus).toBe("idle");
    });

    it("sets error state when auto-sync fails", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockResolvedValue({
        success: false,
        books: [],
        error: "Network error",
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("Network error");
    });

    it("sets default error message when auto-sync fails without error string", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockResolvedValue({
        success: false,
        books: [],
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("自動同步失敗");
    });

    it("handles exception thrown during auto-sync", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockRejectedValue(new Error("Unexpected error"));

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("Unexpected error");
    });

    it("handles non-Error exception during auto-sync", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockRejectedValue("string error");

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("自動同步失敗");
    });

    it("only triggers auto-sync once across re-renders", async () => {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/library" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);

      const options = makeOptions();
      const { rerender } = renderHook(() => useBookSync(options));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Re-render should not re-trigger
      rerender();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(syncBooks).toHaveBeenCalledTimes(1);
    });
  });

  describe("manual sync (triggerManualSync)", () => {
    it("calls syncBooks with navigate: true", async () => {
      const options = makeOptions();
      const { result } = renderHook(() => useBookSync(options));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(syncBooks).toHaveBeenCalledWith({
        navigate: true,
        userId: "user-123",
        apiClient: options.apiClient,
      });
    });

    it("transitions syncing -> done -> idle on success", async () => {
      const mockBooks = [
        {
          bookId: "b2",
          title: "Manual Book",
          author: "",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ];
      vi.mocked(syncBooks).mockResolvedValue({ success: true, books: mockBooks });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.syncStatus).toBe("done");
      expect(result.current.lastSyncBooks).toEqual(mockBooks);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.syncStatus).toBe("idle");
    });

    it("sets error state on failed manual sync", async () => {
      vi.mocked(syncBooks).mockResolvedValue({
        success: false,
        books: [],
        error: "Upload failed",
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("Upload failed");
    });

    it("uses default error message when manual sync fails without error string", async () => {
      vi.mocked(syncBooks).mockResolvedValue({
        success: false,
        books: [],
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.syncStatus).toBe("error");
      expect(result.current.syncError).toBe("同步失敗");
    });

    it("clears previous error before starting manual sync", async () => {
      vi.mocked(syncBooks)
        .mockResolvedValueOnce({ success: false, books: [], error: "First error" })
        .mockResolvedValueOnce({ success: true, books: [] });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.syncError).toBe("First error");

      await act(async () => {
        await result.current.triggerManualSync();
      });

      // Error should be cleared on second success
      expect(result.current.syncError).toBe("");
    });
  });
});
