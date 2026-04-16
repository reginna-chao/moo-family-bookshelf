import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("user@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("User Name"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

// Mock mergeBooks so tests can inspect what savedBooks gets passed in
vi.mock("@/dialog/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[], _saved: unknown[]) => scraped),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail } from "@/content/scraper";
import { mergeBooks } from "@/dialog/mergeBooks";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";

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
        return Promise.resolve(result) as unknown as Promise<Record<string, unknown>>;
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
        await result.current.syncBooks({ userId: "user-hash", apiClient: mockApi });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mergeBooks).toHaveBeenCalledWith(
        expect.any(Array),
        [savedBook],
      );
    });

    it("passes empty savedBooks when apiResponse.data is null (first-ever sync)", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({ userId: "user-hash", apiClient: mockApi });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mergeBooks).toHaveBeenCalledWith(expect.any(Array), []);
    });
  });
});
