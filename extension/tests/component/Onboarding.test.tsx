import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Onboarding, OnboardingProps } from "@/dialog/Onboarding";
import { BoolFlag, type ApiClient } from "@/api/client";
import { scrapeUserEmail } from "@/content/scraper";

import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

// Partially mock crypto module — override async functions that depend on
// crypto.subtle, for deterministic & fast resolution in fake-timer environment.
// 說明：generateKey、exportKey、importKey、computeKeyFingerprint 等都會觸發真實的
// crypto.subtle 運算，在 fake-timer 環境下會與 timer advancement 競爭 microtask
// 導致 CI flake。統一 mock 以確保穩定性；真實的 crypto 正確性由
// extension/tests/unit/crypto/encrypt.test.ts 負責驗證。
vi.mock("@/crypto/encrypt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/crypto/encrypt")>();
  const mockCryptoKey = {
    type: "secret",
    algorithm: { name: "AES-GCM" },
    extractable: true,
    usages: ["encrypt", "decrypt"],
  } as unknown as CryptoKey;
  return {
    ...actual,
    deriveUserId: vi.fn().mockResolvedValue("a".repeat(64)),
    computeKeyFingerprint: vi.fn().mockResolvedValue("f".repeat(64)),
    // generateKey is called in solo recovery; mock to avoid real crypto.subtle in fake-timer env
    generateKey: vi.fn().mockResolvedValue(mockCryptoKey),
    // exportKey is called after generateKey; return a deterministic base62-like string
    exportKey: vi.fn().mockResolvedValue("mock-exported-key-string"),
    // importKey is called in handleJoin and syncBooks; mock for speed in fake-timer env
    importKey: vi.fn().mockResolvedValue(mockCryptoKey),
    // encrypt is called in syncBooks; return a stable string
    encrypt: vi.fn().mockResolvedValue("mock-encrypted-payload"),
  };
});

// Mock the scraper module
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("test@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("Test User"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    lookupUser: vi.fn().mockResolvedValue({ data: { existingFamilyId: null, memberCount: 0 } }),
    createFamily: vi.fn().mockResolvedValue({
      data: { familyId: "fam-123", members: ["user-1"], createdAt: "2026-01-01" },
    }),
    joinFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: { familyId: "fam-123", members: ["user-1"], createdAt: "2026-01-01" },
    }),
    getFamilyBookshelf: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    setAuthToken: vi.fn(),
    updateFamilyEndpoint: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderOnboarding(props: Partial<OnboardingProps> = {}) {
  const defaultProps: OnboardingProps = {
    onFamilyJoined: vi.fn(),
    apiClient: createMockApiClient(),
  };
  return render(<Onboarding {...defaultProps} {...props} />);
}

/** Flush microtask queue */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
    vi.advanceTimersByTime(0);
  });
}

describe("Onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Restore default scraper mock
    vi.mocked(scrapeUserEmail).mockReturnValue("test@example.com");

    // Reset chrome.storage.local mock — handle both callback-based and promise-based calls
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        if (typeof callback === "function") {
          callback({});
        }
        return Promise.resolve({}) as unknown as void;
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

  /**
   * Click the start button and advance timers enough to complete
   * the navigateAndRun flow (1500ms timeout + microtask flushing).
   */
  async function clickStartAndWait() {
    // Fire click — this starts the async handleStart flow
    fireEvent.click(screen.getByText("開始使用"));

    // The handleStart calls scrapeProfile which calls navigateAndRun
    // which sets location.hash then calls wait(1500).
    // We need to let the microtask chain progress and advance timers.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(500);
        await flushMicrotasks();
      });
    }
  }

  it("renders welcome state with '開始使用' button on first load", () => {
    renderOnboarding();

    expect(screen.getByText("歡迎使用家庭書櫃")).toBeInTheDocument();
    expect(screen.getByText("開始使用")).toBeInTheDocument();
    expect(
      screen.getByText(/一鍵開始，自動同步你的讀墨帳號與書單/),
    ).toBeInTheDocument();
  });

  it("does not show the old '前往個人帳戶頁面' link", () => {
    renderOnboarding();

    expect(screen.queryByText("前往個人帳戶頁面")).not.toBeInTheDocument();
  });

  it("shows loading overlay when '開始使用' is clicked", async () => {
    renderOnboarding();

    // Click start — overlay should appear before timer advances
    await act(async () => {
      fireEvent.click(screen.getByText("開始使用"));
      // Let the setPhase("scraping-profile") microtask run
      await flushMicrotasks();
    });

    expect(screen.getByTestId("loading-overlay")).toBeInTheDocument();
    expect(screen.getByText("正在取得帳號資訊...")).toBeInTheDocument();

    // Clean up by completing the flow
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(500);
        await flushMicrotasks();
      });
    }
  });

  it("transitions to idle state after successful profile scrape", async () => {
    renderOnboarding();

    await clickStartAndWait();

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      expect(screen.getByText("加入家庭公開書櫃")).toBeInTheDocument();
    });
  });

  it("shows error when profile scrape fails to find email", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValue(null);

    renderOnboarding();

    await clickStartAndWait();

    await waitFor(() => {
      expect(screen.getByText("發生錯誤")).toBeInTheDocument();
      expect(
        screen.getByText(/無法取得帳號信箱/),
      ).toBeInTheDocument();
    });
  });

  it("join button is disabled when sync code input is empty", async () => {
    renderOnboarding();

    await clickStartAndWait();

    await waitFor(() => {
      const joinBtn = screen.getByText("加入家庭公開書櫃");
      expect(joinBtn).toBeDisabled();
    });
  });

  it("shows error state on API failure during create", async () => {
    const mockApi = createMockApiClient({
      createFamily: vi.fn().mockResolvedValue({
        error: { code: "INTERNAL_ERROR", message: "伺服器錯誤" },
      }),
    });

    renderOnboarding({ apiClient: mockApi });

    await clickStartAndWait();

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("建立家庭公開書櫃"));
    });

    await waitFor(() => {
      expect(screen.getByText("發生錯誤")).toBeInTheDocument();
      expect(screen.getByText("伺服器錯誤")).toBeInTheDocument();
    });
  });

  it("retry from error returns to welcome if no email", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValue(null);

    renderOnboarding();

    await clickStartAndWait();

    await waitFor(() => {
      expect(screen.getByText("發生錯誤")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("重試"));
    });

    expect(screen.getByText("開始使用")).toBeInTheDocument();
  });

  it("retry from error returns to idle if email was already captured", async () => {
    const mockApi = createMockApiClient({
      createFamily: vi.fn().mockResolvedValue({
        error: { code: "INTERNAL_ERROR", message: "伺服器錯誤" },
      }),
    });

    renderOnboarding({ apiClient: mockApi });

    // Complete start flow to capture email
    await clickStartAndWait();

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
    });

    // Create fails with error
    await act(async () => {
      fireEvent.click(screen.getByText("建立家庭公開書櫃"));
    });

    await waitFor(() => {
      expect(screen.getByText("發生錯誤")).toBeInTheDocument();
      expect(screen.getByText("伺服器錯誤")).toBeInTheDocument();
    });

    // Retry should go back to idle (not welcome) because email is known
    await act(async () => {
      fireEvent.click(screen.getByText("重試"));
    });

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
    });
  });

  describe("handleCreate flow", () => {
    it("generates key, creates family, stores auth token, and shows created view", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-new-123",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "auth-token-abc",
          },
        }),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      // Wait for the async create flow to complete
      await waitFor(() => {
        expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
      });

      // Should have called createFamily
      expect(mockApi.createFamily).toHaveBeenCalled();

      // Should have stored authToken
      expect(chrome.storage.local.set).toHaveBeenCalled();

      // Should show sync code and copy/continue buttons
      expect(screen.getByText("複製同步碼")).toBeInTheDocument();
      expect(screen.getByText("繼續")).toBeInTheDocument();
    });

    it("shows error when lookupUser fails", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "Lookup failed" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText("無法驗證帳號，請重試。")).toBeInTheDocument();
      });
    });

    it("shows error when createFamily returns no data", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: null,
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText("伺服器未回傳資料")).toBeInTheDocument();
      });
    });

    it("handles exception during create flow", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockRejectedValue(new Error("Network failure")),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText("Network failure")).toBeInTheDocument();
      });
    });
  });

  describe("handleJoin flow", () => {
    it("validates sync code and joins family", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "abcd-efgh",
            members: [],
            createdAt: "2026-01-01",
            authToken: "join-token",
          },
        }),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      // Enter a valid sync code
      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someEncryptionKey" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        // Let the join + sync flow complete
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        expect(mockApi.joinFamily).toHaveBeenCalled();
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "abcd-efgh",
          expect.any(String),
        );
      });
    });

    it("shows error for invalid sync code format", async () => {
      renderOnboarding();

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "invalid-code" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText(/同步碼格式錯誤/)).toBeInTheDocument();
      });
    });

    it("shows error when joinFamily API fails", async () => {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "FAMILY_FULL", message: "家庭成員已滿" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-validKey123" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText("家庭成員已滿")).toBeInTheDocument();
      });
    });

    // Note: the join flow no longer calls lookupUser — it hashes client-side
    // via deriveUserId, so there is no server-side hash failure path to test.
  });

  describe("handleContinueAfterCreate when sync fails", () => {
    it("calls onFamilyJoined even when book sync fails", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-sync-fail",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "token-abc",
          },
        }),
        // getPersonalBooks is called during syncBooks — make it fail
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("sync boom")),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      // Create family
      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
      });

      // Click continue — syncBooks will fail but onFamilyJoined should still be called
      await act(async () => {
        fireEvent.click(screen.getByText("繼續"));
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalledWith("fam-sync-fail", expect.any(String));
      });
    });
  });

  describe("handleJoin with custom API endpoint", () => {
    it("sends SET_API_ENDPOINT message when sync code contains @host", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "abcd-efgh",
            members: [],
            createdAt: "2026-01-01",
            authToken: "join-token",
          },
        }),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      // Enter a sync code with @host suffix
      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someKey123@https://custom.api.dev" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        // Verify SET_API_ENDPOINT was sent to chrome.runtime
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "SET_API_ENDPOINT",
            apiEndpoint: "https://custom.api.dev",
          }),
        );
        // Also verify the API client endpoint was updated
        expect(mockApi.setEndpoint).toHaveBeenCalledWith("https://custom.api.dev");
      });
    });
  });

  describe("handleJoin when sync fails after join", () => {
    it("calls onFamilyJoined even when book sync fails after successful join", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "abcd-efgh",
            members: [],
            createdAt: "2026-01-01",
            authToken: "join-token",
          },
        }),
        // Make book sync fail
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("sync failed")),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someEncryptionKey" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        // Despite sync failure, join succeeded so onFamilyJoined should be called
        expect(onFamilyJoined).toHaveBeenCalledWith("abcd-efgh", expect.any(String));
      });
    });
  });

  describe("personalBooksCache migration", () => {
    const cachedBooks = [
      {
        bookId: "book-cached-1",
        title: "快取書籍一",
        author: "作者X",
        coverUrl: "https://example.com/cached1.jpg",
        readmooUrl: "https://readmoo.com/book/book-cached-1",
        isShared: BoolFlag.TRUE,
      },
    ];

    function setupCacheMock(cache: unknown[] | null) {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const keyArr = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
          const result: Record<string, unknown> = {};
          if (cache && keyArr.includes("personalBooksCache")) {
            result.personalBooksCache = JSON.stringify(cache);
          }
          if (typeof callback === "function") {
            callback(result);
          }
          return Promise.resolve(result) as unknown as void;
        },
      );
    }

    it("migrates cached books when creating a new family", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-migrate-1",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "auth-token-migrate",
          },
        }),
      });

      setupCacheMock(cachedBooks);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
      });

      // Migration should have called updatePersonalBooks with userId and encrypted payload
      expect(mockApi.updatePersonalBooks).toHaveBeenCalledWith(
        expect.any(String), // userId (hashed)
        expect.any(String), // encrypted payload
      );

      // Cache should be removed after successful migration
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(["personalBooksCache"]);
    });

    it("migrates cached books when joining a family", async () => {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "abcd-efgh",
            members: [],
            createdAt: "2026-01-01",
            authToken: "join-token-migrate",
          },
        }),
      });

      setupCacheMock(cachedBooks);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someEncryptionKey" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        expect(mockApi.joinFamily).toHaveBeenCalled();
      });

      // Migration should have uploaded cached books
      expect(mockApi.updatePersonalBooks).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
      );

      // Cache should be removed
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(["personalBooksCache"]);
    });

    it("skips migration when no cache exists", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-no-cache",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "auth-token-no-cache",
          },
        }),
      });

      // No cache
      setupCacheMock(null);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
      });

      // updatePersonalBooks should NOT have been called for migration
      expect(mockApi.updatePersonalBooks).not.toHaveBeenCalled();
    });

    it("cleans up cache even when migration fails", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-fail-migrate",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "auth-token-fail",
          },
        }),
        // Make migration upload fail
        updatePersonalBooks: vi.fn().mockRejectedValue(new Error("Upload failed")),
      });

      setupCacheMock(cachedBooks);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      // The create flow should still succeed despite migration failure
      await waitFor(() => {
        expect(screen.getByText("家庭公開書櫃已建立")).toBeInTheDocument();
      });

      // Cache should still be cleaned up even on failure
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(["personalBooksCache"]);
    });
  });

  describe("auto-recovery flow", () => {
    /**
     * Helper to mock chrome.runtime.sendMessage so GET_ENCRYPTION_KEY
     * returns a given encryptionKey value.
     */
    function mockEncryptionKeyMessage(encryptionKey: string | null) {
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(
        (...args: unknown[]) => {
          const msg = args[0] as Record<string, unknown>;
          const callback = args[1] as ((response: unknown) => void) | undefined;
          if (msg.type === "GET_ENCRYPTION_KEY" && typeof callback === "function") {
            callback({ encryptionKey });
          }
          return Promise.resolve();
        },
      );
    }

    it("auto-recovers when existingFamilyId is returned and encryption key is available", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-existing", memberCount: 2 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-existing",
            members: [],
            createdAt: "2026-01-01",
            authToken: "recovery-token",
          },
        }),
      });

      mockEncryptionKeyMessage("synced-key-abc");

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      // Wait for the create button in case early recovery did not trigger
      // The early recovery in handleStart should fire and call onFamilyJoined
      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalledWith("fam-existing", expect.any(String));
      });

      // Should have called joinFamily with the existing family and fingerprint in opts
      expect(mockApi.joinFamily).toHaveBeenCalledWith(
        "fam-existing",
        expect.any(String), // userId
        expect.any(String), // displayName
        expect.objectContaining({ keyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      );
    });

    it("passes keyFingerprint in tryAutoRecovery joinFamily call", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-fp-test", memberCount: 2 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-fp-test",
            members: [],
            createdAt: "2026-01-01",
            authToken: "fp-token",
          },
        }),
      });

      mockEncryptionKeyMessage("myBase62KeyData");

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalled();
      });

      const joinCall = vi.mocked(mockApi.joinFamily).mock.calls[0];
      // 4th argument is opts
      const opts = joinCall[3] as Record<string, string> | undefined;
      expect(opts?.keyFingerprint).toBeDefined();
      expect(opts?.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sets familyId in sync storage (overwriting stale value) on successful auto-recovery", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-new-sync", memberCount: 2 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-new-sync",
            members: [],
            createdAt: "2026-01-01",
            authToken: "sync-token",
          },
        }),
      });

      mockEncryptionKeyMessage("freshKey");

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalled();
      });

      // tryAutoRecovery should overwrite sync storage familyId
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: "fam-new-sync" }),
      );
    });

    it("handleStart: solo-member family, no sync key → shows recovery-choice screen (no silent solo rotation)", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-solo", memberCount: 1 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          data: { authToken: "tok", expiresAt: 9999999999 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi, onFamilyJoined });

      await clickStartAndWait();

      // No encryption key → no auto-solo-recovery; user must decide via recovery-choice
      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      // joinFamily (performSoloRecovery) must NOT have fired silently
      expect(mockApi.joinFamily).not.toHaveBeenCalled();
      expect(onFamilyJoined).not.toHaveBeenCalled();
    });

    it("handleStart: multi-member family, no sync key → shows recovery-choice screen", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-multi-2", memberCount: 2 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi, onFamilyJoined });

      await clickStartAndWait();

      // Multi-member + no key → recovery-choice (unified path)
      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      expect(onFamilyJoined).not.toHaveBeenCalled();
    });

    it("handleStart: recovery-choice screen displays the scraped userEmail", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-email-check", memberCount: 1 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(
          screen.getByText("帳號：test@example.com"),
        ).toBeInTheDocument();
      });
    });

    it("recovery-choice: clicking '輸入同步碼' reveals sync code input for recovery", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-to-recover", memberCount: 2 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("輸入同步碼，保留書架設定"));
        await flushMicrotasks();
      });

      // Now on recovery-join mini view
      expect(screen.getByText("輸入同步碼")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "加入並還原書架" }),
      ).toBeInTheDocument();
    });

    it("recovery-choice: clicking '略過' shows solo-recovery-confirm warning", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-to-skip", memberCount: 1 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        await flushMicrotasks();
      });

      expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "確認重新同步" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "返回，輸入同步碼" }),
      ).toBeInTheDocument();
    });

    it("solo-recovery-confirm: '返回' goes back to recovery-choice", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-back", memberCount: 1 },
        }),
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      // choice → confirm → back → choice
      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        await flushMicrotasks();
      });
      expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText("返回，輸入同步碼"));
        await flushMicrotasks();
      });

      expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
    });

    it("solo-recovery-confirm: '確認重新同步' triggers performSoloRecovery and calls onFamilyJoined on success", async () => {
      const onFamilyJoined = vi.fn();
      const joinFamilyMock = vi.fn().mockResolvedValue({
        data: { authToken: "tok-solo", expiresAt: 9999999999 },
      });
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-confirm-solo", memberCount: 1 },
        }),
        joinFamily: joinFamilyMock,
      });

      mockEncryptionKeyMessage(null);

      renderOnboarding({ apiClient: mockApi, onFamilyJoined });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        await flushMicrotasks();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("確認重新同步"));
        await flushMicrotasks();
      });

      // Advance through syncBooks timer
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        });
      }

      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "fam-confirm-solo",
          expect.any(String),
        );
      });
      // Solo recovery signals extension recoverySource to bypass PWA verification
      expect(joinFamilyMock).toHaveBeenCalledWith(
        "fam-confirm-solo",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ recoverySource: "extension" }),
      );
    });
  });

  describe("handleCreate with keyFingerprint", () => {
    it("calls createFamily with keyFingerprint in the request", async () => {
      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-fp-create",
            members: ["user-1"],
            createdAt: "2026-01-01",
            authToken: "auth-token-fp",
          },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(mockApi.createFamily).toHaveBeenCalled();
      });

      const createCall = vi.mocked(mockApi.createFamily).mock.calls[0];
      // createFamily(userId, displayName, keyFingerprint)
      const keyFingerprint = createCall[2];
      expect(keyFingerprint).toBeDefined();
      expect(typeof keyFingerprint).toBe("string");
      expect(keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

  });

  describe("handleJoin VERIFICATION_REQUIRED", () => {
    it("shows Q5 verification notice when server returns VERIFICATION_REQUIRED", async () => {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: {
            code: "VERIFICATION_REQUIRED",
            message: "Verification required",
          },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByPlaceholderText("輸入家庭同步碼")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-validKey123" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
      });

      await waitFor(() => {
        expect(screen.getByText("發生錯誤")).toBeInTheDocument();
        expect(screen.getByText(
          "此家庭需要使用手機 App 完成驗證後才能加入。請先在手機 App 中登入並設定驗證，或向家人取得新的同步碼。",
        )).toBeInTheDocument();
      });

      // Should show single "我知道了" button instead of "重試"
      expect(screen.getByRole("button", { name: "我知道了" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重試" })).not.toBeInTheDocument();
    });
  });

  describe("copy sync code", () => {
    it("copies sync code to clipboard", async () => {
      const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      Object.assign(navigator, { clipboard: mockClipboard });

      const mockApi = createMockApiClient({
        createFamily: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-copy-test",
            members: [],
            createdAt: "2026-01-01",
            authToken: "token",
          },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("建立家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(screen.getByText("複製同步碼")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("複製同步碼"));
      });

      expect(mockClipboard.writeText).toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByText("已複製")).toBeInTheDocument();
      });

      // After 2000ms, should revert
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText("複製同步碼")).toBeInTheDocument();
    });
  });
});
