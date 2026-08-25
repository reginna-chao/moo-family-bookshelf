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

function makeOptions(
  overrides: Partial<UseBookSyncOptions> = {},
): UseBookSyncOptions {
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
    it("starts with idle syncStatus and empty progressMessage", () => {
      const { result } = renderHook(() => useBookSync(makeOptions()));

      expect(result.current.syncStatus).toBe("idle");
      expect(result.current.syncError).toBe("");
      expect(result.current.lastSyncBooks).toEqual([]);
      expect(result.current.autoSyncDone).toBe(false);
      expect(result.current.progressMessage).toBe("");
    });
  });

  describe("auto-sync", () => {
    it("triggers auto-sync regardless of the current hash (no #/library gate)", async () => {
      // The old isOnLibrary restriction was removed: auto full sync now runs on
      // mount irrespective of hash, since syncBooks(navigate:true) handles the
      // navigation itself and restores the hash afterwards.
      Object.defineProperty(window, "location", {
        writable: true,
        value: { hash: "#/settings" },
      });
      vi.mocked(canAutoSync).mockResolvedValue(true);

      renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(canAutoSync).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledOnce();
      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({ navigate: true }),
      );
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

    it("triggers a full navigate sync when canAutoSync returns true", async () => {
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
      vi.mocked(syncBooks).mockResolvedValue({
        success: true,
        books: mockBooks,
      });

      const options = makeOptions();
      const { result } = renderHook(() => useBookSync(options));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(syncBooks).toHaveBeenCalledOnce();
      // Auto full sync uses navigate:true (same as manual), so it works from any hash.
      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({
          navigate: true,
          userId: "user-123",
          apiClient: options.apiClient,
        }),
      );
      expect(vi.mocked(syncBooks).mock.calls[0][0]).toHaveProperty(
        "onProgress",
      );
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
        () =>
          new Promise((resolve) => {
            resolveSync = resolve;
          }),
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

      expect(syncBooks).toHaveBeenCalledWith(
        expect.objectContaining({
          navigate: true,
          userId: "user-123",
          apiClient: options.apiClient,
        }),
      );
      expect(vi.mocked(syncBooks).mock.calls[0][0]).toHaveProperty(
        "onProgress",
      );
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
      vi.mocked(syncBooks).mockResolvedValue({
        success: true,
        books: mockBooks,
      });

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

    it("stays syncing when the previous sync's done->idle reset comes due", async () => {
      // A manual sync started inside the 2s "done" window must supersede the
      // pending done->idle timer. If that stale timer still fires, syncStatus
      // drops to "idle" mid-sync and the sync button re-enables — the button's
      // disabled state is the only guard against a second concurrent syncBooks().
      const { result } = renderHook(() => useBookSync(makeOptions()));

      // First manual sync completes and arms the done->idle reset.
      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.syncStatus).toBe("done");

      // Second manual sync starts while that reset is still pending; its work
      // never settles, so the status can only change via the stale timer.
      vi.mocked(syncBooks).mockImplementation(
        () => new Promise<never>(() => {}),
      );
      await act(async () => {
        void result.current.triggerManualSync();
      });

      expect(result.current.syncStatus).toBe("syncing");

      // 2000ms is the done->idle delay armed by the first sync.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.syncStatus).toBe("syncing");
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
        .mockResolvedValueOnce({
          success: false,
          books: [],
          error: "First error",
        })
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

  describe("progressMessage (Wave G)", () => {
    it("clears progressMessage after manual sync completes", async () => {
      vi.mocked(syncBooks).mockImplementation(async (opts) => {
        opts.onProgress?.(2, 400);
        return { success: true, books: [] };
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(result.current.progressMessage).toBe("");
    });

    it("passes onProgress that updates progressMessage during sync", async () => {
      let capturedOnProgress:
        ((page: number, count: number) => void) | undefined;
      vi.mocked(syncBooks).mockImplementation(async (opts) => {
        capturedOnProgress = opts.onProgress;
        return { success: true, books: [] };
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });

      expect(capturedOnProgress).toBeTypeOf("function");
    });
  });
});
