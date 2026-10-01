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

  // #236: the personal shelf shows a notice when a sync moved books to their
  // new Readmoo id; the count reflects the last SUCCESSFUL sync only.
  describe("renamedBookCount", () => {
    it("starts at 0", () => {
      const { result } = renderHook(() => useBookSync(makeOptions()));
      expect(result.current.renamedBookCount).toBe(0);
    });

    it("reports the count of a successful auto-sync", async () => {
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockResolvedValue({
        success: true,
        books: [],
        renamedBookCount: 2,
      });

      const { result } = renderHook(() => useBookSync(makeOptions()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(syncBooks).toHaveBeenCalledOnce();
      expect(result.current.renamedBookCount).toBe(2);
    });

    it("updates on a successful manual sync and keeps the value across a failed one", async () => {
      vi.mocked(syncBooks)
        .mockResolvedValueOnce({
          success: true,
          books: [],
          renamedBookCount: 3,
        })
        .mockResolvedValueOnce({
          success: false,
          books: [],
          error: "讀墨可能改版了，已暫停同步書櫃",
          renamedBookCount: 9,
        })
        .mockResolvedValueOnce({ success: true, books: [] });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.renamedBookCount).toBe(3);

      // A failed sync uploaded nothing → the last success's count stands.
      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.syncStatus).toBe("error");
      expect(result.current.renamedBookCount).toBe(3);

      // A success that reports nothing renamed clears the notice.
      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.renamedBookCount).toBe(0);
    });
  });

  // #236 S1: the personal shelf moves an unsaved toggle from a renamed book's
  // old id to its new one, so the rename pairs must belong to the SAME sync as
  // `lastSyncBooks` — never a newer list with an older sync's pairs.
  describe("lastSyncRenamedBooks", () => {
    const bookOf = (bookId: string) => ({
      bookId,
      title: `書 ${bookId}`,
      author: "",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.FALSE,
    });
    const FIRST = {
      success: true,
      books: [bookOf("210000000000002")],
      renamedBooks: [{ oldId: "210000000000001", newId: "210000000000002" }],
      renamedBookCount: 1,
    };
    const SECOND = {
      success: true,
      books: [bookOf("210000000000004")],
      renamedBooks: [{ oldId: "210000000000003", newId: "210000000000004" }],
      renamedBookCount: 1,
    };

    it("starts empty", () => {
      const { result } = renderHook(() => useBookSync(makeOptions()));
      expect(result.current.lastSyncRenamedBooks).toEqual([]);
    });

    it("comes from the same successful sync as lastSyncBooks in every render", async () => {
      vi.mocked(syncBooks)
        .mockResolvedValueOnce(FIRST)
        .mockResolvedValueOnce(SECOND);
      const seen: Array<{ books: unknown; renamed: unknown }> = [];
      const { result } = renderHook(() => {
        const sync = useBookSync(makeOptions());
        seen.push({
          books: sync.lastSyncBooks,
          renamed: sync.lastSyncRenamedBooks,
        });
        return sync;
      });

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.lastSyncBooks).toBe(FIRST.books);
      expect(result.current.lastSyncRenamedBooks).toBe(FIRST.renamedBooks);

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.lastSyncBooks).toBe(SECOND.books);
      expect(result.current.lastSyncRenamedBooks).toBe(SECOND.renamedBooks);

      // No render ever paired one sync's list with another sync's renames.
      expect(seen.some((r) => r.books === FIRST.books)).toBe(true);
      expect(seen.some((r) => r.books === SECOND.books)).toBe(true);
      const renamedOf = new Map<unknown, unknown>([
        [FIRST.books, FIRST.renamedBooks],
        [SECOND.books, SECOND.renamedBooks],
      ]);
      for (const render of seen) {
        const expected = renamedOf.get(render.books);
        if (expected === undefined) {
          expect(render.renamed).toEqual([]);
        } else {
          expect(render.renamed).toBe(expected);
        }
      }
    });

    it("is kept across a failed sync and reset by a success without renames", async () => {
      vi.mocked(syncBooks)
        .mockResolvedValueOnce(FIRST)
        .mockResolvedValueOnce({
          success: false,
          books: [],
          error: "同步失敗",
          renamedBooks: [{ oldId: "x", newId: "y" }],
        })
        .mockResolvedValueOnce({
          success: true,
          books: [bookOf("210000000000009")],
        });

      const { result } = renderHook(() => useBookSync(makeOptions()));

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.lastSyncRenamedBooks).toEqual(FIRST.renamedBooks);

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.syncStatus).toBe("error");
      expect(result.current.lastSyncBooks).toBe(FIRST.books);
      expect(result.current.lastSyncRenamedBooks).toEqual(FIRST.renamedBooks);

      await act(async () => {
        await result.current.triggerManualSync();
      });
      expect(result.current.lastSyncRenamedBooks).toEqual([]);
    });

    it("reports the pairs of a successful auto-sync", async () => {
      vi.mocked(canAutoSync).mockResolvedValue(true);
      vi.mocked(syncBooks).mockResolvedValue(FIRST);

      const { result } = renderHook(() => useBookSync(makeOptions()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(syncBooks).toHaveBeenCalledOnce();
      expect(result.current.lastSyncBooks).toBe(FIRST.books);
      expect(result.current.lastSyncRenamedBooks).toEqual(FIRST.renamedBooks);
    });
  });
});
