import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilyShelfPrefs } from "@/dialog/useFamilyShelfPrefs";
import type { ApiClient } from "@/api/client";

const FLUSH_DEBOUNCE_MS = 600;

function createMockApiClient(
  hidden: string[] | undefined = [],
  overrides: Partial<ApiClient> = {},
): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: hidden === undefined ? {} : { familyShelfPrefs: { hidden } },
    }),
    updateFamilyPrefs: vi.fn().mockResolvedValue({
      data: { ok: true, hidden: [] },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("useFamilyShelfPrefs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("initial load", () => {
    it("loads the viewer's hidden refs once on mount", async () => {
      const apiClient = createMockApiClient(["owner-1:b1", "owner-2:b3"]);

      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(result.current.hiddenRefs.size).toBe(2);
      });
      expect(result.current.isHidden("owner-1", "b1")).toBe(true);
      expect(result.current.isHidden("owner-2", "b3")).toBe(true);
      expect(result.current.isHidden("owner-9", "ghost")).toBe(false);
      expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      expect(apiClient.getPersonalBooks).toHaveBeenCalledWith("user-1");
    });

    it("starts empty when familyShelfPrefs is missing", async () => {
      const apiClient = createMockApiClient(undefined);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });
      expect(result.current.hiddenRefs.size).toBe(0);
    });

    it("starts empty and does not throw when load rejects", async () => {
      const apiClient = createMockApiClient([], {
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });
      expect(result.current.hiddenRefs.size).toBe(0);
    });
  });

  describe("optimistic toggle", () => {
    it("adds a ref immediately on toggle (optimistic)", async () => {
      const apiClient = createMockApiClient([]);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });

      expect(result.current.isHidden("owner-1", "b1")).toBe(true);
    });

    it("removes an already-hidden ref on toggle", async () => {
      const apiClient = createMockApiClient(["owner-1:b1"]);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(result.current.isHidden("owner-1", "b1")).toBe(true);
      });

      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });

      expect(result.current.isHidden("owner-1", "b1")).toBe(false);
    });
  });

  describe("debounced flush", () => {
    it("flushes the COMPLETE hidden array after the debounce window", async () => {
      const apiClient = createMockApiClient(["owner-0:existing"]);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(result.current.isHidden("owner-0", "existing")).toBe(true);
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });

      // Before debounce elapses, no flush.
      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      });

      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const [userIdArg, hiddenArg] = vi.mocked(
        apiClient.updateFamilyPrefs,
      ).mock.calls[0];
      expect(userIdArg).toBe("user-1");
      // Full replace: existing ref + newly toggled ref.
      expect([...hiddenArg].sort()).toEqual(
        ["owner-0:existing", "owner-1:b1"].sort(),
      );
    });

    it("debounces multiple rapid toggles into a single flush with the final state", async () => {
      const apiClient = createMockApiClient([]);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 100);
      });
      act(() => {
        result.current.toggleHidden("owner-2", "b2");
      });
      // Not yet flushed — second toggle reset the timer.
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
      });
      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const [, hiddenArg] = vi.mocked(apiClient.updateFamilyPrefs).mock.calls[0];
      expect([...hiddenArg].sort()).toEqual(
        ["owner-1:b1", "owner-2:b2"].sort(),
      );
    });

    it("swallows flush errors without throwing", async () => {
      const apiClient = createMockApiClient([], {
        updateFamilyPrefs: vi.fn().mockRejectedValue(new Error("flush failed")),
      });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        });
      }).not.toThrow();
      // Optimistic state still reflects the toggle.
      expect(result.current.isHidden("owner-1", "b1")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("flushes the pending change on unmount within the debounce window", async () => {
      const apiClient = createMockApiClient([]);
      const { result, unmount } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });

      // Unmount before the debounce fires — the cleanup flushes synchronously.
      unmount();

      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const [userIdArg, hiddenArg] = vi.mocked(
        apiClient.updateFamilyPrefs,
      ).mock.calls[0];
      expect(userIdArg).toBe("user-1");
      expect([...hiddenArg]).toContain("owner-1:b1");

      // The pending timer was cleared on unmount — no duplicate flush fires.
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 2);
      });
      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
    });

    it("does not flush on unmount when there is no pending change", async () => {
      const apiClient = createMockApiClient([]);
      const { unmount } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      // No toggle was made, so there is no pending timer to flush.
      unmount();

      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();
    });
  });
});
