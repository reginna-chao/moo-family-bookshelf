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

// Mock mergeBooks to pass the scraped list straight through, so tests assert on
// the arguments it receives (the vi.fn records every actual arg, including the
// savedBooks one this stub ignores) without depending on real merge logic.
vi.mock("@/dialog/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[]) => scraped),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail } from "@/content/scraper";
import { mergeBooks } from "@/dialog/mergeBooks";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import { LAST_SYNC_AT_KEY } from "@/constants";
import {
  BOOKS_CONFLICT_MESSAGE,
  BOOKS_SAVE_CONFLICT_MESSAGE,
  BOOKS_TOO_LARGE_MESSAGE,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import { SYNC_PAUSED_MESSAGE } from "@/sync/syncBreaker";

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
    vi.mocked(chrome.storage.local.set).mockImplementation(() => {
      return Promise.resolve();
    });
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

    it("shows the too-large copy, not the server's English message, on a 413 PAYLOAD_TOO_LARGE upload", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
        updatePersonalBooks: vi.fn().mockResolvedValue({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds 2MB limit",
          },
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
      expect(result.current.errorMessage).toBe(BOOKS_TOO_LARGE_MESSAGE);
      expect(result.current.errorMessage).not.toContain("Request body exceeds");
    });

    /**
     * #259: the onboarding PUT carries the read `lastUpdated`; a `BOOKS_CONFLICT`
     * re-reads and re-PUTs (at most 3 PUTs), then ends in the error phase with
     * the SYNC conflict wording. Retry detail: dialog/onboardingBooksUpload.test.ts.
     */
    const CONFLICT = {
      error: {
        code: "BOOKS_CONFLICT",
        message: "Books record changed since it was read",
      },
    };
    const stamped = (lastUpdated: string) => ({
      data: { books: [], lastUpdated },
    });

    it("re-reads and lands the onboarding upload after a conflict", async () => {
      const mockApi = {
        getPersonalBooks: vi
          .fn()
          .mockResolvedValueOnce(stamped("read-1"))
          .mockResolvedValueOnce(stamped("read-2")),
        updatePersonalBooks: vi
          .fn()
          .mockResolvedValueOnce(CONFLICT)
          .mockResolvedValueOnce({ data: { ok: true } }),
      } as unknown as ApiClient;
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
      const puts = vi.mocked(mockApi.updatePersonalBooks).mock.calls;
      expect(puts.map(([, body]) => body.expectedLastUpdated)).toEqual([
        "read-1",
        "read-2",
      ]);
      expect(typeof lastSyncWrittenValue()).toBe("number");
    });

    it("ends in the error phase with the sync conflict copy after 3 conflicted PUTs", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue(stamped("read")),
        updatePersonalBooks: vi.fn().mockResolvedValue(CONFLICT),
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
      expect(mockApi.updatePersonalBooks).toHaveBeenCalledTimes(3);
      expect(result.current.errorMessage).toBe(BOOKS_CONFLICT_MESSAGE);
      expect(result.current.errorMessage).not.toBe(BOOKS_SAVE_CONFLICT_MESSAGE);
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

  /**
   * #236: auto-setup is an upload path too, so it obeys the same two stops as
   * the regular sync — a failed read of the saved list, and the circuit
   * breaker — both before any upload. The archive is never scraped here, so
   * saved archived books never count against the scrape.
   */
  describe("syncBooks — upload guards", () => {
    let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

    afterEach(() => {
      warnSpy?.mockRestore();
      warnSpy = null;
    });

    function realId(n: number): string {
      return `2100000${String(n).padStart(8, "0")}`;
    }

    function makeBook(n: number, overrides: Partial<BookEntry> = {}) {
      return {
        bookId: realId(n),
        title: `書${n}`,
        author: "",
        isbn: "",
        coverUrl: "",
        readmooUrl: "",
        category: "",
        isShared: BoolFlag.FALSE,
        ...overrides,
      };
    }

    function scrapedOf(books: BookEntry[]) {
      return books.map((b) => ({
        bookId: b.bookId,
        title: b.title,
        author: "",
        coverUrl: "",
        readmooUrl: "",
        category: "",
        isArchived: BoolFlag.FALSE,
      }));
    }

    async function runAutoSync(mockApi: ApiClient) {
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
      return { success, result };
    }

    it("enters the error phase with no upload when reading the saved list fails", async () => {
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { success, result } = await runAutoSync(mockApi);

      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(result.current.errorMessage).toBe("伺服器忙碌");
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
      expect(lastSyncWrittenValue()).toBeUndefined();
    });

    it("enters the error phase with no upload when the circuit breaker trips", async () => {
      const { scrapeBooks } = await import("@/content/scraper");
      const saved = Array.from({ length: 50 }, (_, i) => makeBook(i));
      vi.mocked(scrapeBooks).mockResolvedValueOnce(
        scrapedOf(saved.slice(0, 10)),
      );
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({ data: { books: saved } }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { success, result } = await runAutoSync(mockApi);

      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(result.current.errorMessage).toBe(SYNC_PAUSED_MESSAGE);
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
      expect(lastSyncWrittenValue()).toBeUndefined();
    });

    it("does not count saved archived books against the scrape (archive never scraped here)", async () => {
      const { scrapeBooks } = await import("@/content/scraper");
      const active = Array.from({ length: 20 }, (_, i) => makeBook(i));
      const archived = Array.from({ length: 60 }, (_, i) =>
        makeBook(100 + i, { isArchived: BoolFlag.TRUE }),
      );
      vi.mocked(scrapeBooks).mockResolvedValueOnce(scrapedOf(active));
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { books: [...active, ...archived] },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { success } = await runAutoSync(mockApi);

      expect(success).toBe(true);
      expect(mockApi.updatePersonalBooks).toHaveBeenCalledTimes(1);
    });

    /**
     * #236 F2: onboarding never judges renames, so a brand-new id titled like a
     * saved-only id is held back from its upload (uploading it would make it a
     * server id and the pair could never be resolved by a later sync). The real
     * merge runs here so the saved-only entry is actually in the merged list.
     */
    describe("rename candidates", () => {
      async function withRealMerge(): Promise<void> {
        const actual = await vi.importActual<
          typeof import("@/dialog/mergeBooks")
        >("@/dialog/mergeBooks");
        vi.mocked(mergeBooks).mockImplementationOnce(actual.mergeBooks);
      }

      function uploadedIds(mockApi: ApiClient): string[] {
        const update = vi.mocked(mockApi.updatePersonalBooks);
        expect(update).toHaveBeenCalledTimes(1);
        return update.mock.calls[0][1].books.map((b) => b.bookId);
      }

      it("excludes a held-back candidate from the onboarding upload", async () => {
        const { scrapeBooks } = await import("@/content/scraper");
        const old = makeBook(1, {
          title: "改了編號的書",
          isShared: BoolFlag.TRUE,
        });
        const kept = makeBook(2);
        const renamed = makeBook(3, { title: "改了編號的書" });
        vi.mocked(scrapeBooks).mockResolvedValueOnce(
          scrapedOf([kept, renamed]),
        );
        await withRealMerge();
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const mockApi = {
          getPersonalBooks: vi.fn().mockResolvedValue({
            data: { books: [old, kept] },
          }),
          updatePersonalBooks: vi
            .fn()
            .mockResolvedValue({ data: { ok: true } }),
        } as unknown as ApiClient;

        const { success } = await runAutoSync(mockApi);

        expect(success).toBe(true);
        expect(uploadedIds(mockApi)).toEqual([kept.bookId, old.bookId]);
        expect(warnSpy).toHaveBeenCalledWith(
          "[moo] renames cannot be judged this sync; held back possible renamed books",
          { deferredCount: 1 },
        );
      });

      it("uploads the merged list unchanged when there is no candidate", async () => {
        const { scrapeBooks } = await import("@/content/scraper");
        const old = makeBook(1, { title: "舊書" });
        const kept = makeBook(2);
        const fresh = makeBook(3, { title: "新買的書" });
        vi.mocked(scrapeBooks).mockResolvedValueOnce(scrapedOf([kept, fresh]));
        await withRealMerge();
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const mockApi = {
          getPersonalBooks: vi.fn().mockResolvedValue({
            data: { books: [old, kept] },
          }),
          updatePersonalBooks: vi
            .fn()
            .mockResolvedValue({ data: { ok: true } }),
        } as unknown as ApiClient;

        const { success } = await runAutoSync(mockApi);

        expect(success).toBe(true);
        expect(uploadedIds(mockApi)).toEqual([
          kept.bookId,
          fresh.bookId,
          old.bookId,
        ]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });
});
