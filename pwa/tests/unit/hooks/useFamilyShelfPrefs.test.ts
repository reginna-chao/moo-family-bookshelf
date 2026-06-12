import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilyShelfPrefs } from "@/hooks/useFamilyShelfPrefs";
import type { ApiClient } from "@/api/client";

const FLUSH_DEBOUNCE_MS = 600;
const USER = "a".repeat(64);

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

describe("useFamilyShelfPrefs (PWA)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads the viewer's hidden refs once on mount", async () => {
    const apiClient = createMockApiClient(["owner-1:b1", "owner-2:b3"]);
    const { result } = renderHook(() => useFamilyShelfPrefs(USER, apiClient));

    await waitFor(() => {
      expect(result.current.hiddenRefs.size).toBe(2);
    });
    expect(result.current.isHidden("owner-1", "b1")).toBe(true);
    expect(result.current.isHidden("owner-9", "ghost")).toBe(false);
    expect(apiClient.getPersonalBooks).toHaveBeenCalledTimes(1);
    expect(apiClient.getPersonalBooks).toHaveBeenCalledWith(USER);
  });

  it("starts empty and does not throw when load rejects", async () => {
    const apiClient = createMockApiClient([], {
      getPersonalBooks: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { result } = renderHook(() => useFamilyShelfPrefs(USER, apiClient));

    await waitFor(() => {
      expect(apiClient.getPersonalBooks).toHaveBeenCalled();
    });
    expect(result.current.hiddenRefs.size).toBe(0);
  });

  it("toggles a ref optimistically", async () => {
    const apiClient = createMockApiClient([]);
    const { result } = renderHook(() => useFamilyShelfPrefs(USER, apiClient));
    await waitFor(() => {
      expect(apiClient.getPersonalBooks).toHaveBeenCalled();
    });

    act(() => {
      result.current.toggleHidden("owner-1", "b1");
    });
    expect(result.current.isHidden("owner-1", "b1")).toBe(true);
  });

  it("flushes the COMPLETE hidden array after the debounce window", async () => {
    const apiClient = createMockApiClient(["owner-0:existing"]);
    const { result } = renderHook(() => useFamilyShelfPrefs(USER, apiClient));
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
    const [userIdArg, hiddenArg] = vi.mocked(
      apiClient.updateFamilyPrefs,
    ).mock.calls[0];
    expect(userIdArg).toBe(USER);
    expect([...hiddenArg].sort()).toEqual(
      ["owner-0:existing", "owner-1:b1"].sort(),
    );
  });

  it("clears the pending timer on unmount — no flush after unmount", async () => {
    const apiClient = createMockApiClient([]);
    const { result, unmount } = renderHook(() =>
      useFamilyShelfPrefs(USER, apiClient),
    );
    await waitFor(() => {
      expect(apiClient.getPersonalBooks).toHaveBeenCalled();
    });

    vi.useFakeTimers();
    act(() => {
      result.current.toggleHidden("owner-1", "b1");
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 2);
    });

    expect(apiClient.updateFamilyPrefs).not.toHaveBeenCalled();
  });

  it("swallows flush errors without throwing", async () => {
    const apiClient = createMockApiClient([], {
      updateFamilyPrefs: vi.fn().mockRejectedValue(new Error("flush failed")),
    });
    const { result } = renderHook(() => useFamilyShelfPrefs(USER, apiClient));
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
    expect(result.current.isHidden("owner-1", "b1")).toBe(true);
  });
});
