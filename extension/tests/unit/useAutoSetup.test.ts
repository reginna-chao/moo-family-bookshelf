import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * useAutoSetup (`src/dialog/useAutoSetup.ts`): onboarding's first scrape +
 * upload of the personal book list.
 *
 * mergeBooks is mocked to pass the scraped list straight through, so tests
 * assert on the arguments it receives (the vi.fn records every actual arg,
 * including the savedBooks one this stub ignores) without depending on real
 * merge logic. The rename-candidate cases run the real merge instead (see
 * below).
 *
 * #259 conflicts: the onboarding PUT carries the read `lastUpdated`; a
 * `BOOKS_CONFLICT` re-reads and re-PUTs (at most 3 PUTs), then ends in the error
 * phase with the SYNC conflict wording. Retry detail:
 * dialog/onboardingBooksUpload.test.ts.
 *
 * #236 upload guards: auto-setup is an upload path too, so it obeys the same two
 * stops as the regular sync — a failed read of the saved list, and the circuit
 * breaker — both before any upload. The archive is never scraped here, so saved
 * archived books never count against the scrape.
 *
 * #236 F2 rename candidates: onboarding never judges renames, so a brand-new id
 * titled like a saved-only id is held back from its upload (uploading it would
 * make it a server id and the pair could never be resolved by a later sync).
 * The real merge runs there so the saved-only entry is actually in the merged
 * list.
 *
 * #328 kept cache retry: a personal-books cache that a failed create/join upload
 * left behind is retried AFTER the post-scrape account re-check and BEFORE the
 * onboarding upload, so its share flags become the first server record instead
 * of an all-unshared one. These cases back chrome.storage.local.get / remove
 * with a local store and the API with a stateful in-memory record, and run the
 * real merge so the onboarding PUT is built on top of the migrated record.
 */

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("user@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("User Name"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
  formatScrapeProgress: (page: number, count: number) =>
    `正在讀取第 ${page} 頁，已收集 ${count} 本…`,
}));

// Pass-through mergeBooks: tests assert on the args it receives, not on merge
// logic. See the file header.
vi.mock("@/dialog/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[]) => scraped),
}));

// The pre-upload account re-check (#281) navigates `#/me`; it is the confirmed
// account by default. The check itself: tests/unit/dialog/accountIdentityCheck.test.ts.
vi.mock("@/dialog/accountIdentityCheck", () => ({
  verifyAccountIdentity: vi.fn(),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail } from "@/content/scraper";
import { mergeBooks } from "@/dialog/mergeBooks";
import { verifyAccountIdentity } from "@/dialog/accountIdentityCheck";
import { ACCOUNT_UNCONFIRMED_SYNC_MESSAGE } from "@/dialog/AccountCheckContext";
import {
  BoolFlag,
  type ApiClient,
  type BookEntry,
  type PersonalBooks,
} from "@/api/client";
import { LAST_SYNC_AT_KEY, PERSONAL_BOOKS_CACHE_KEY } from "@/constants";
import { encodePersonalBooksCache } from "@/dialog/personalBooksCache";
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
    vi.mocked(verifyAccountIdentity).mockResolvedValue("match");

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

    // #259: `BOOKS_CONFLICT` → re-read and re-PUT (at most 3 PUTs), then the SYNC
    // conflict wording. Retry detail: dialog/onboardingBooksUpload.test.ts.
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

      expect(mergeBooks).toHaveBeenCalledWith(
        expect.any(Array),
        [savedBook],
        undefined,
        new Set(),
      );
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

      expect(mergeBooks).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        undefined,
        new Set(),
      );
    });
  });

  // #236: the regular sync's two stops (failed saved-list read, circuit breaker)
  // apply before any upload. See the header → "#236 upload guards".
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

    // #281: another tab switched the Readmoo account after onboarding read #/me.
    it("enters the error phase with no upload when the account is no longer confirmed after the scrape", async () => {
      vi.mocked(verifyAccountIdentity).mockResolvedValue("unknown");
      const mockApi = createMockApiClient();

      const { success, result } = await runAutoSync(mockApi);

      expect(verifyAccountIdentity).toHaveBeenCalledWith("user-hash");
      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(result.current.errorMessage).toBe(
        ACCOUNT_UNCONFIRMED_SYNC_MESSAGE,
      );
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
      expect(lastSyncWrittenValue()).toBeUndefined();
    });

    // A failed scrape still re-checks the account, so a still-matching one
    // refreshes the cache and the personal-shelf mount auto-sync can retry.
    it("still re-checks the account when the scrape throws", async () => {
      const { scrapeBooks } = await import("@/content/scraper");
      vi.mocked(scrapeBooks).mockRejectedValueOnce(new Error("scrape failed"));
      const mockApi = createMockApiClient();

      const { success, result } = await runAutoSync(mockApi);

      expect(verifyAccountIdentity).toHaveBeenCalledWith("user-hash");
      expect(success).toBe(false);
      expect(result.current.phase).toBe("error");
      expect(result.current.errorMessage).toBe("scrape failed");
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
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

    // #236 F2: a new id titled like a saved-only id is held back (real merge here).
    // See the header → "#236 F2 rename candidates".
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

  // See the header → "#328 kept cache retry".
  describe("syncBooks — retry of a kept personal-books cache (#328)", () => {
    const USER_ID = "user-hash";
    const CACHED_BOOK: BookEntry = {
      bookId: "210000000000001",
      title: "設好分享的書",
      author: "",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.TRUE,
    };
    const ENCODED_CACHE = encodePersonalBooksCache(USER_ID, [CACHED_BOOK]);

    let store: Record<string, unknown>;
    let restoreRemove: () => void;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      store = { [PERSONAL_BOOKS_CACHE_KEY]: ENCODED_CACHE };
      vi.mocked(chrome.storage.local.get).mockImplementation(((
        keys: string | string[],
      ) => {
        const result: Record<string, unknown> = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (key in store) result[key] = store[key];
        }
        return Promise.resolve(result);
      }) as unknown as typeof chrome.storage.local.get);

      const remove = vi.mocked(chrome.storage.local.remove);
      const originalRemove = remove.getMockImplementation();
      remove.mockImplementation(((keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          delete store[key];
        return Promise.resolve();
      }) as unknown as typeof chrome.storage.local.remove);
      restoreRemove = () => {
        if (originalRemove) remove.mockImplementation(originalRemove);
      };

      const { scrapeBooks } = await import("@/content/scraper");
      vi.mocked(scrapeBooks).mockResolvedValueOnce([
        {
          bookId: CACHED_BOOK.bookId,
          title: CACHED_BOOK.title,
          author: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isArchived: BoolFlag.FALSE,
        },
      ]);
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      restoreRemove();
      warnSpy.mockRestore();
    });

    /** A server holding one personal-books record in memory, starting with none. */
    function createServer(): ApiClient {
      let record: PersonalBooks | null = null;
      return {
        getPersonalBooks: vi.fn(async () => ({ data: record })),
        updatePersonalBooks: vi.fn(
          async (_userId: string, body: PersonalBooks) => {
            record = body;
            return { data: { ok: true } };
          },
        ),
      } as unknown as ApiClient;
    }

    async function withRealMerge(): Promise<void> {
      const actual = await vi.importActual<
        typeof import("@/dialog/mergeBooks")
      >("@/dialog/mergeBooks");
      vi.mocked(mergeBooks).mockImplementationOnce(actual.mergeBooks);
    }

    async function runSync(api: ApiClient) {
      const { result } = renderHook(() => useAutoSetup());
      let success = false;
      const promise = act(async () => {
        success = await result.current.syncBooks({
          userId: USER_ID,
          apiClient: api,
        });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;
      return { success, result };
    }

    it("uploads the kept cache before the onboarding upload, keeping its share flags, then removes it", async () => {
      await withRealMerge();
      const api = createServer();

      const { success } = await runSync(api);

      expect(success).toBe(true);
      expect(chrome.storage.local.get).toHaveBeenCalledWith(
        expect.arrayContaining([PERSONAL_BOOKS_CACHE_KEY]),
      );
      const puts = vi
        .mocked(api.updatePersonalBooks)
        .mock.calls.map(([, body]) => body);
      expect(puts).toHaveLength(2);
      const [cachePut, onboardingPut] = puts;
      expect(cachePut.books).toEqual([CACHED_BOOK]);
      expect(cachePut.books[0].isShared).toBe(BoolFlag.TRUE);
      // The onboarding PUT is built on the record the cache upload created.
      expect(onboardingPut.expectedLastUpdated).toBe(cachePut.lastUpdated);
      expect(onboardingPut.books).toEqual([
        expect.objectContaining({
          bookId: CACHED_BOOK.bookId,
          isShared: BoolFlag.TRUE,
        }),
      ]);
      expect(PERSONAL_BOOKS_CACHE_KEY in store).toBe(false);
    });

    it("retries the cache only after the post-scrape account re-check", async () => {
      await withRealMerge();
      const api = createServer();

      await runSync(api);

      const recheckOrder = vi.mocked(verifyAccountIdentity).mock
        .invocationCallOrder[0];
      const cacheReadOrder = vi.mocked(api.getPersonalBooks).mock
        .invocationCallOrder[0];
      expect(recheckOrder).toBeLessThan(cacheReadOrder);
    });

    it("still runs the onboarding upload when the cache retry fails again", async () => {
      await withRealMerge();
      const api = createServer();
      vi.mocked(api.updatePersonalBooks).mockResolvedValueOnce({
        error: { code: "INTERNAL_ERROR", message: "x" },
      });

      const { success } = await runSync(api);

      expect(success).toBe(true);
      expect(api.updatePersonalBooks).toHaveBeenCalledTimes(2);
    });

    it.each(["mismatch", "unknown"] as const)(
      "does not touch the cache or the server when the post-scrape account re-check is %s",
      async (identity) => {
        vi.mocked(verifyAccountIdentity).mockResolvedValue(identity);
        const api = createServer();

        const { success } = await runSync(api);

        expect(success).toBe(false);
        expect(api.getPersonalBooks).not.toHaveBeenCalled();
        expect(api.updatePersonalBooks).not.toHaveBeenCalled();
        expect(chrome.storage.local.get).not.toHaveBeenCalledWith(
          expect.arrayContaining([PERSONAL_BOOKS_CACHE_KEY]),
        );
        expect(chrome.storage.local.remove).not.toHaveBeenCalled();
        expect(store[PERSONAL_BOOKS_CACHE_KEY]).toBe(ENCODED_CACHE);
      },
    );
  });
});
