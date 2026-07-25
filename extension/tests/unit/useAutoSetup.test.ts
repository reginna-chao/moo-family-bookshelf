import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("user@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("User Name"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
  formatScrapeProgress: (page: number, count: number) =>
    `正在讀取第 ${page} 頁，已收集 ${count} 本…`,
}));

// Mock mergeBooks so tests can inspect what savedBooks gets passed in
vi.mock("@/dialog/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[], _saved: unknown[]) => scraped),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail } from "@/content/scraper";
import { mergeBooks } from "@/dialog/mergeBooks";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import { LAST_SYNC_AT_KEY } from "@/constants";

/** Return the value written to LAST_SYNC_AT_KEY across all storage.set calls, or undefined. */
function lastSyncWrittenValue(): unknown {
  const calls = vi.mocked(chrome.storage.local.set).mock.calls;
  for (const [items] of calls) {
    if (items && typeof items === "object" && LAST_SYNC_AT_KEY in items) {
      return (items as Record<string, unknown>)[LAST_SYNC_AT_KEY];
    }
  }
  return undefined;
}

function createMockApiClient(): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
  } as unknown as ApiClient;
}

describe("useAutoSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") {
          callback(result);
          return undefined as unknown as Promise<Record<string, unknown>>;
        }
        return Promise.resolve(result) as unknown as Promise<
          Record<string, unknown>
        >;
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
    const promise = act(async () => {
      profileResult = await result.current.scrapeProfile();
    });

    // Advance past NAV_SETTLE_MS (1500ms)
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

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
    const promise = act(async () => {
      profileResult = await result.current.scrapeProfile();
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(profileResult).toBeNull();
    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toContain("無法取得帳號信箱");
  });

  it("reset returns to idle phase", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValueOnce(null);
    const { result } = renderHook(() => useAutoSetup());

    const promise = act(async () => {
      await result.current.scrapeProfile();
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

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
    const promise = act(async () => {
      success = await result.current.syncBooks({
        userId: "user-hash",
        apiClient: mockApi,
      });
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(success).toBe(true);
    expect(result.current.phase).toBe("done");
  });

  describe("syncBooks — last-sync timestamp (throttle guard)", () => {
    it("writes LAST_SYNC_AT_KEY with the current time after a successful upload", async () => {
      vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
      const mockApi = createMockApiClient();
      const { result } = renderHook(() => useAutoSetup());

      const promise = act(async () => {
        await result.current.syncBooks({
          userId: "user-hash",
          apiClient: mockApi,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      const written = lastSyncWrittenValue();
      expect(typeof written).toBe("number");
      // Fake timers freeze after advancing, so Date.now() equals the value
      // captured when the hook wrote it.
      expect(written).toBe(Date.now());
    });

    it("does NOT write LAST_SYNC_AT_KEY when the upload responds with an error", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
        updatePersonalBooks: vi.fn().mockResolvedValue({
          error: { code: "UPLOAD_FAILED", message: "上傳失敗" },
        }),
      } as unknown as ApiClient;
      const { result } = renderHook(() => useAutoSetup());

      let success = true;
      const promise = act(async () => {
        success = await result.current.syncBooks({
          userId: "user-hash",
          apiClient: mockApi,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(lastSyncWrittenValue()).toBeUndefined();
    });

    it("does NOT write LAST_SYNC_AT_KEY when scraping throws", async () => {
      const { scrapeBooks } = await import("@/content/scraper");
      vi.mocked(scrapeBooks).mockRejectedValueOnce(new Error("scrape boom"));
      const mockApi = createMockApiClient();
      const { result } = renderHook(() => useAutoSetup());

      let success = true;
      const promise = act(async () => {
        success = await result.current.syncBooks({
          userId: "user-hash",
          apiClient: mockApi,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
      expect(lastSyncWrittenValue()).toBeUndefined();
    });
  });

  describe("phaseMessage — dynamic progress (Wave G)", () => {
    it("returns static message for non-scraping phases", () => {
      const { result } = renderHook(() => useAutoSetup());
      expect(result.current.phaseMessage).toBe("");
    });

    it("returns progressMessage during scraping-books phase when set via onProgress", async () => {
      const { scrapeBooks } = await import("@/content/scraper");
      // Make scrapeBooks invoke onProgress then hang so phase stays scraping-books
      vi.mocked(scrapeBooks).mockImplementationOnce(async (opts) => {
        opts?.onProgress?.(3, 600);
        return new Promise(() => {});
      });

      const mockApi = createMockApiClient();
      const { result } = renderHook(() => useAutoSetup());

      // Fire syncBooks but don't await (it hangs)
      act(() => {
        result.current.syncBooks({ userId: "uid", apiClient: mockApi });
      });

      // Advance past NAV_SETTLE_MS so scrapeBooks gets called
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      expect(result.current.phase).toBe("scraping-books");
      expect(result.current.phaseMessage).toBe(
        "正在讀取第 3 頁，已收集 600 本…",
      );
    });
  });

  describe("syncBooks — saved books handling", () => {
    function makeSavedBook(overrides: Partial<BookEntry> = {}): BookEntry {
      return {
        bookId: "saved-1",
        title: "Saved Book",
        author: "Saved Author",
        isbn: "",
        coverUrl: "",
        readmooUrl: "https://readmoo.com/book/saved-1",
        category: "",
        isShared: BoolFlag.TRUE,
        ...overrides,
      };
    }

    it("reads {books: [...]} from server and forwards to mergeBooks", async () => {
      const savedBook = makeSavedBook();
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { books: [savedBook] },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({
          userId: "user-hash",
          apiClient: mockApi,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mergeBooks).toHaveBeenCalledWith(expect.any(Array), [savedBook]);
    });

    it("passes empty savedBooks when apiResponse.data is null (first-ever sync)", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({
          userId: "user-hash",
          apiClient: mockApi,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mergeBooks).toHaveBeenCalledWith(expect.any(Array), []);
    });
  });
});
