import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scraper module before importing the hook
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("user@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("User Name"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

// Mock crypto module
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ books: [] })),
}));

// Mock mergeBooks so tests can inspect what savedBooks gets passed in
vi.mock("@/dialog/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[], _saved: unknown[]) => scraped),
}));

import { useAutoSetup } from "@/dialog/useAutoSetup";
import { scrapeUserEmail } from "@/content/scraper";
import { decrypt } from "@/crypto/encrypt";
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
        const result = { encryptionKey: "test-key-123" };
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

  it("syncBooks returns false when encryption key is missing", async () => {
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

    expect(success).toBe(false);
    expect(result.current.phase).toBe("error");
    expect(result.current.errorMessage).toContain("找不到加密金鑰");
  });

  describe("syncBooks — saved books decryption", () => {
    // Guards against a real bug where syncBooks read `apiResponse.data?.books`
    // directly (which is always undefined because the server returns
    // `{ payload: "<ciphertext>" }`), silently wiping isShared flags on every
    // recovery. These tests lock in the decrypt-then-merge behavior.

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

    it("decrypts {payload} from server and forwards decoded books to mergeBooks", async () => {
      const savedBook = makeSavedBook();
      vi.mocked(decrypt).mockResolvedValueOnce(
        JSON.stringify({ books: [savedBook] }),
      );
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { payload: "ciphertext-blob" },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({ userId: "user-hash", apiClient: mockApi });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      // decrypt should have received the ciphertext payload
      expect(decrypt).toHaveBeenCalledWith("ciphertext-blob", expect.anything());
      // mergeBooks should receive the decrypted savedBooks as second arg
      expect(mergeBooks).toHaveBeenCalledWith(
        expect.any(Array),
        [savedBook],
      );
    });

    it("passes empty savedBooks to mergeBooks when decrypt throws (solo recovery key rotation)", async () => {
      // Solo recovery rotates the fingerprint; old ciphertext can't be
      // decrypted with the new key. syncBooks must swallow this and continue.
      vi.mocked(decrypt).mockRejectedValueOnce(new Error("OperationError"));

      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { payload: "stale-ciphertext" },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({ userId: "user-hash", apiClient: mockApi });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      // syncBooks should NOT have thrown — merge should still run
      expect(mergeBooks).toHaveBeenCalledWith(expect.any(Array), []);
      expect(result.current.phase).toBe("done");
    });

    it("reads legacy {books: [...]} shape when payload is absent", async () => {
      const legacyBook = makeSavedBook({ bookId: "legacy-1" });
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { books: [legacyBook] },
        }),
        updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
      } as unknown as ApiClient;

      const { result } = renderHook(() => useAutoSetup());
      const promise = act(async () => {
        await result.current.syncBooks({ userId: "user-hash", apiClient: mockApi });
      });
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(decrypt).not.toHaveBeenCalled();
      expect(mergeBooks).toHaveBeenCalledWith(
        expect.any(Array),
        [legacyBook],
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

      expect(decrypt).not.toHaveBeenCalled();
      expect(mergeBooks).toHaveBeenCalledWith(expect.any(Array), []);
    });

    it("passes empty savedBooks when decrypted payload has no books field", async () => {
      vi.mocked(decrypt).mockResolvedValueOnce(
        JSON.stringify({ schemaVersion: 1, userId: "x" }),
      );
      const mockApi = {
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { payload: "ciphertext-no-books" },
        }),
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
