import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilyShelfPrefs } from "@/dialog/useFamilyShelfPrefs";
import type { ApiClient } from "@/api/client";

const FLUSH_DEBOUNCE_MS = 600;

interface PrefsShape {
  hidden?: string[];
  favorites?: string[];
}

/**
 * Build a mock ApiClient.
 * - `prefs === undefined` → data has no familyShelfPrefs (missing).
 * - otherwise → familyShelfPrefs is the provided partial (hidden/favorites may
 *   individually be absent to exercise the `?? []` fallbacks).
 */
function createMockApiClient(
  prefs: PrefsShape | undefined = {},
  overrides: Partial<ApiClient> = {},
): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: prefs === undefined ? {} : { familyShelfPrefs: prefs },
    }),
    updateFamilyPrefs: vi.fn().mockResolvedValue({
      data: { ok: true, hidden: [], favorites: [] },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

/** Read the single flush call's (userId, prefs) args. */
function flushArgs(apiClient: ApiClient) {
  const calls = vi.mocked(apiClient.updateFamilyPrefs).mock.calls;
  const [userId, prefs] = calls[0];
  return { userId, prefs: prefs as { hidden: string[]; favorites: string[] } };
}

describe("useFamilyShelfPrefs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("initial load", () => {
    it("loads the viewer's hidden AND favorite refs once on mount", async () => {
      const apiClient = createMockApiClient({
        hidden: ["owner-1:b1", "owner-2:b3"],
        favorites: ["owner-1:b1", "owner-5:b9"],
      });

      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(result.current.hiddenRefs.size).toBe(2);
      });
      expect(result.current.isHidden("owner-1", "b1")).toBe(true);
      expect(result.current.isHidden("owner-2", "b3")).toBe(true);
      expect(result.current.favoriteRefs.size).toBe(2);
      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
      expect(result.current.isFavorite("owner-5", "b9")).toBe(true);
      expect(result.current.isFavorite("owner-9", "ghost")).toBe(false);
      expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      expect(apiClient.getPersonalBooks).toHaveBeenCalledWith("user-1");
    });

    it("starts both sets empty when familyShelfPrefs is missing", async () => {
      const apiClient = createMockApiClient(undefined);
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });
      expect(result.current.hiddenRefs.size).toBe(0);
      expect(result.current.favoriteRefs.size).toBe(0);
    });

    it("defaults favorites to empty when only hidden is present", async () => {
      const apiClient = createMockApiClient({ hidden: ["owner-1:b1"] });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(result.current.isHidden("owner-1", "b1")).toBe(true);
      });
      expect(result.current.favoriteRefs.size).toBe(0);
    });

    it("starts empty and does not throw when load rejects", async () => {
      const apiClient = createMockApiClient(
        {},
        {
          getPersonalBooks: vi.fn().mockRejectedValue(new Error("boom")),
        },
      );
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );

      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });
      expect(result.current.hiddenRefs.size).toBe(0);
      expect(result.current.favoriteRefs.size).toBe(0);
    });
  });

  describe("optimistic toggle", () => {
    it("adds a hidden ref immediately on toggle (optimistic)", async () => {
      const apiClient = createMockApiClient({});
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

    it("adds a favorite ref immediately on toggle (optimistic)", async () => {
      const apiClient = createMockApiClient({});
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });

      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
    });

    it("removes an already-favorited ref on toggle", async () => {
      const apiClient = createMockApiClient({ favorites: ["owner-1:b1"] });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
      });

      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });

      expect(result.current.isFavorite("owner-1", "b1")).toBe(false);
    });

    it("keeps hidden and favorites independent (toggling one does not affect the other)", async () => {
      const apiClient = createMockApiClient({});
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });

      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
      expect(result.current.isHidden("owner-1", "b1")).toBe(false);
    });
  });

  describe("debounced flush", () => {
    it("flushes BOTH the complete hidden and favorites arrays after the debounce", async () => {
      const apiClient = createMockApiClient({
        hidden: ["owner-0:existing"],
        favorites: ["owner-fav:existing"],
      });
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

      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      });

      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const { userId, prefs } = flushArgs(apiClient);
      expect(userId).toBe("user-1");
      // Hidden full-replace: existing + newly toggled.
      expect([...prefs.hidden].sort()).toEqual(
        ["owner-0:existing", "owner-1:b1"].sort(),
      );
      // Favorites untouched by the hidden toggle, but still sent in full.
      expect(prefs.favorites).toEqual(["owner-fav:existing"]);
    });

    it("flushes the newly favorited ref alongside existing hidden refs", async () => {
      const apiClient = createMockApiClient({ hidden: ["owner-0:hid"] });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(result.current.isHidden("owner-0", "hid")).toBe(true);
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleFavorite("owner-9", "fav");
      });
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      });

      const { prefs } = flushArgs(apiClient);
      expect(prefs.hidden).toEqual(["owner-0:hid"]);
      expect(prefs.favorites).toEqual(["owner-9:fav"]);
    });

    it("debounces a hidden + a favorite toggle into a single flush with both", async () => {
      const apiClient = createMockApiClient({});
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
        result.current.toggleFavorite("owner-2", "b2");
      });
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
      });
      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const { prefs } = flushArgs(apiClient);
      expect(prefs.hidden).toEqual(["owner-1:b1"]);
      expect(prefs.favorites).toEqual(["owner-2:b2"]);
    });

    it("swallows flush errors without throwing", async () => {
      const apiClient = createMockApiClient(
        {},
        {
          updateFamilyPrefs: vi
            .fn()
            .mockRejectedValue(new Error("flush failed")),
        },
      );
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        });
      }).not.toThrow();
      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
    });
  });

  describe("load-once guard (S2)", () => {
    it("does not re-fetch or clobber a pending toggle when apiClient identity changes after load", async () => {
      const apiClient = createMockApiClient({});
      const { result, rerender } = renderHook(
        ({ client }) => useFamilyShelfPrefs("user-1", client),
        { initialProps: { client: apiClient } },
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      });

      // Optimistic edit made after the initial load resolved.
      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });
      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);

      // A NEW apiClient identity re-fires the load effect (its dep list includes
      // apiClient), but the didLoadRef guard must skip the body: no re-fetch and
      // the optimistic edit survives.
      const nextClient = createMockApiClient({ favorites: ["owner-9:server"] });
      rerender({ client: nextClient });
      await act(async () => {});

      expect(nextClient.getPersonalBooks).not.toHaveBeenCalled();
      expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      // Pending toggle preserved; server payload from the new client not applied.
      expect(result.current.isFavorite("owner-1", "b1")).toBe(true);
      expect(result.current.isFavorite("owner-9", "server")).toBe(false);
    });

    it("re-attempts the load when the FIRST load rejected (guard not set on failure)", async () => {
      const failing = vi.fn().mockRejectedValueOnce(new Error("boom"));
      const apiClient = createMockApiClient({}, { getPersonalBooks: failing });
      const { rerender } = renderHook(
        ({ client }) => useFamilyShelfPrefs("user-1", client),
        { initialProps: { client: apiClient } },
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      });

      // A later apiClient identity change re-fires the effect; because the first
      // load failed, the guard was NOT set, so the load body runs again.
      const nextClient = createMockApiClient({ favorites: ["owner-1:b1"] });
      rerender({ client: nextClient });

      await waitFor(() => {
        expect(nextClient.getPersonalBooks).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("sync-failed signal (S7)", () => {
    it("sets syncFailed true when the flush resolves with an { error } envelope, then clears on a later success", async () => {
      const updateFamilyPrefs = vi
        .fn()
        .mockResolvedValueOnce({ error: { code: "KABOOM", message: "nope" } })
        .mockResolvedValueOnce({
          data: { ok: true, hidden: [], favorites: [] },
        });
      const apiClient = createMockApiClient({}, { updateFamilyPrefs });
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });
      expect(result.current.syncFailed).toBe(false);

      // Real timers throughout: the flush uses a real setTimeout, and the
      // `.then` that sets syncFailed resolves on a real microtask. Mixing fake
      // timers with promise resolution here would deadlock waitFor's polling.
      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });
      await waitFor(() => {
        expect(result.current.syncFailed).toBe(true);
      });

      // A later successful flush clears the failed flag.
      act(() => {
        result.current.toggleFavorite("owner-2", "b2");
      });
      await waitFor(() => {
        expect(result.current.syncFailed).toBe(false);
      });
    });

    it("sets syncFailed true when the flush rejects (network throw)", async () => {
      const apiClient = createMockApiClient(
        {},
        {
          updateFamilyPrefs: vi
            .fn()
            .mockRejectedValue(new Error("network down")),
        },
      );
      const { result } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      act(() => {
        result.current.toggleHidden("owner-1", "b1");
      });
      await waitFor(() => {
        expect(result.current.syncFailed).toBe(true);
      });
    });

    it("does not warn when a failing flush resolves after unmount (guarded setState)", async () => {
      let rejectFlush: (reason: unknown) => void = () => {};
      const apiClient = createMockApiClient(
        {},
        {
          updateFamilyPrefs: vi.fn().mockReturnValue(
            new Promise((_resolve, reject) => {
              rejectFlush = reject;
            }),
          ),
        },
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { result, unmount } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleFavorite("owner-1", "b1");
      });
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      });
      vi.useRealTimers();

      // Unmount, THEN let the in-flight flush reject. The mountedRef guard must
      // prevent a setState-after-unmount warning.
      unmount();
      await act(async () => {
        rejectFlush(new Error("late failure"));
        await Promise.resolve();
      });

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("unmounted"),
      );
      errorSpy.mockRestore();
    });
  });

  describe("cleanup", () => {
    it("flushes a pending favorite change (with hidden) on unmount within the debounce window", async () => {
      const apiClient = createMockApiClient({ hidden: ["owner-0:hid"] });
      const { result, unmount } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(result.current.isHidden("owner-0", "hid")).toBe(true);
      });

      vi.useFakeTimers();
      act(() => {
        result.current.toggleFavorite("owner-1", "fav");
      });

      // Unmount before the debounce fires — cleanup flushes synchronously.
      unmount();

      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      const { userId, prefs } = flushArgs(apiClient);
      expect(userId).toBe("user-1");
      expect(prefs.favorites).toContain("owner-1:fav");
      expect(prefs.hidden).toEqual(["owner-0:hid"]);

      // The pending timer was cleared on unmount — no duplicate flush fires.
      act(() => {
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 2);
      });
      expect(apiClient.updateFamilyPrefs).toHaveBeenCalledTimes(1);
    });

    it("does not flush on unmount when there is no pending change", async () => {
      const apiClient = createMockApiClient({});
      const { unmount } = renderHook(() =>
        useFamilyShelfPrefs("user-1", apiClient),
      );
      await waitFor(() => {
        expect(apiClient.getPersonalBooks).toHaveBeenCalled();
      });

      unmount();

      expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();
    });
  });
});
