import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  onTestFinished,
} from "vitest";
import { Onboarding, OnboardingProps } from "@/dialog/Onboarding";
import { BoolFlag, validateEndpointUrl, type ApiClient } from "@/api/client";
import { scrapeUserEmail } from "@/content/scraper";
import {
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
} from "@/constants";
import { verificationLockedMessage } from "@/dialog/verificationMessages";

import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

// Mock crypto/hash — deriveUserId uses crypto.subtle which competes with
// fake timers in the test environment, causing CI flakes.
vi.mock("@/crypto/hash", () => ({
  deriveUserId: vi.fn().mockResolvedValue("a".repeat(64)),
  sha256Hex: vi.fn().mockResolvedValue("b".repeat(64)),
}));

// Mock the scraper module
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("test@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("Test User"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

function createMockApiClient(
  overrides: Partial<ApiClient> = {},
  initialEndpoint = "https://test.workers.dev",
): ApiClient {
  // Mirrors the real client: setEndpoint canonicalizes through the same shared
  // validator and is what getEndpoint reports back, so the join path persists —
  // and the verification screen discloses — exactly what production would.
  let endpoint = validateEndpointUrl(initialEndpoint);
  return {
    lookupUser: vi
      .fn()
      .mockResolvedValue({ data: { existingFamilyId: null, memberCount: 0 } }),
    createFamily: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        members: ["user-1"],
        createdAt: "2026-01-01",
      },
    }),
    joinFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        members: ["user-1"],
        createdAt: "2026-01-01",
      },
    }),
    getFamilyBookshelf: vi.fn(),
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
    getEndpoint: vi.fn(() => endpoint),
    setEndpoint: vi.fn((url: string) => {
      endpoint = validateEndpointUrl(url);
    }),
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
      (
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        if (typeof callback === "function") {
          callback({});
        }
        return Promise.resolve({}) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.local.set).mockImplementation(() => {
      return Promise.resolve();
    });
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
      expect(screen.getByText(/無法取得帳號信箱/)).toBeInTheDocument();
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
      });

      // Enter a valid sync code
      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someEncryptionKey" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        // Drain the full handleJoin → performJoin → autoSetup.syncBooks chain
        // (including the keyFingerprint computation) in one pass, without
        // relying on a fixed iteration count that grows fragile as awaits
        // are added to production code.
        await vi.runAllTimersAsync();
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
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
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "fam-sync-fail",
          expect.any(String),
        );
      });
    });
  });

  describe("handleJoin with custom API endpoint", () => {
    /**
     * An `@host` sync code is an explicit choice of that server, so joining
     * persists it directly to storage.local (authoritative — Firefox's sleeping
     * background page can drop the message) AND still broadcasts
     * SET_API_ENDPOINT so the rest of the extension follows.
     */
    it("persists and broadcasts the endpoint when the sync code contains @host", async () => {
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
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
        // The direct storage write is what makes the choice stick.
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [API_ENDPOINT_KEY]: "https://custom.api.dev",
        });
        // Verify SET_API_ENDPOINT was sent to chrome.runtime
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "SET_API_ENDPOINT",
            apiEndpoint: "https://custom.api.dev",
          }),
        );
        // Also verify the API client endpoint was updated
        expect(mockApi.setEndpoint).toHaveBeenCalledWith(
          "https://custom.api.dev",
        );
      });
      // Pasting an @host code is an explicit acceptance, so any earlier refusal
      // of that endpoint is dropped.
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]);
    });

    /**
     * The refusal is the whole attack: a server that FAILS the join has proven
     * nothing, yet an adopted endpoint outlives the attempt. Left in force it
     * would still be the address when the user gives up and presses 建立家庭 —
     * shipping the userId, the token that create issues and the entire personal
     * book list (unshared books included) to that host, which would then be
     * baked into the sync code handed to the rest of the family.
     */
    it("hands the endpoint back and persists nothing when the @host server refuses the join", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "FAMILY_NOT_FOUND", message: "找不到這個家庭" },
        }),
      });

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh@https://attacker.example" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      // The refusal reaches the user…
      await waitFor(() => {
        expect(screen.getByText("找不到這個家庭")).toBeInTheDocument();
      });
      expect(onFamilyJoined).not.toHaveBeenCalled();

      // …the endpoint was adopted for the request, then handed back.
      expect(mockApi.setEndpoint).toHaveBeenCalledWith(
        "https://attacker.example",
      );
      expect(mockApi.getEndpoint()).toBe("https://test.workers.dev");

      // Nothing durable was written, so a reload lands on the same endpoint.
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
      expect(chrome.storage.local.remove).not.toHaveBeenCalledWith([
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_API_ENDPOINT" }),
      );
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-someEncryptionKey" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        await vi.runAllTimersAsync();
      });

      await waitFor(() => {
        // Despite sync failure, join succeeded so onFamilyJoined should be called
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "abcd-efgh",
          expect.any(String),
        );
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
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const keyArr = Array.isArray(keys)
            ? keys
            : typeof keys === "string"
              ? [keys]
              : [];
          const result: Record<string, unknown> = {};
          if (cache && keyArr.includes(PERSONAL_BOOKS_CACHE_KEY)) {
            result[PERSONAL_BOOKS_CACHE_KEY] = JSON.stringify(cache);
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

      // Migration should have called updatePersonalBooks with userId and a PersonalBooks object
      expect(mockApi.updatePersonalBooks).toHaveBeenCalledWith(
        expect.any(String), // userId (hashed)
        expect.objectContaining({
          schemaVersion: 1,
          books: expect.any(Array),
        }),
      );

      // Cache should be removed after successful migration
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        PERSONAL_BOOKS_CACHE_KEY,
      ]);
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
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
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
        expect.any(String), // userId (hashed)
        expect.objectContaining({
          schemaVersion: 1,
          books: expect.any(Array),
        }),
      );

      // Cache should be removed
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        PERSONAL_BOOKS_CACHE_KEY,
      ]);
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
        updatePersonalBooks: vi
          .fn()
          .mockRejectedValue(new Error("Upload failed")),
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
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        PERSONAL_BOOKS_CACHE_KEY,
      ]);
    });
  });

  describe("auto-recovery flow", () => {
    it("auto-recovers when existingFamilyId is returned from lookup", async () => {
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

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      // The early recovery in handleStart should fire and call onFamilyJoined
      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalledWith(
          "fam-existing",
          expect.any(String),
        );
      });

      // Should have called joinFamily with the existing family (no verify secret opts)
      expect(mockApi.joinFamily).toHaveBeenCalledWith(
        "fam-existing",
        expect.any(String), // userId
        expect.any(String), // displayName
        undefined, // no verifySecret
      );
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

      renderOnboarding({ onFamilyJoined, apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(onFamilyJoined).toHaveBeenCalled();
      });

      // tryAutoRecovery should overwrite sync storage familyId
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        expect.objectContaining({ [FAMILY_ID_KEY]: "fam-new-sync" }),
      );
    });

    it("handleStart: auto-recovery failure shows recovery-choice screen", async () => {
      const onFamilyJoined = vi.fn();
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-solo", memberCount: 1 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "UNKNOWN", message: "Server error" },
        }),
      });

      renderOnboarding({ apiClient: mockApi, onFamilyJoined });

      await clickStartAndWait();

      // Auto-recovery failed → user must decide via recovery-choice
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
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "UNKNOWN", message: "fail" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("帳號：test@example.com")).toBeInTheDocument();
      });
    });

    it("recovery-choice: clicking '輸入同步碼' reveals sync code input for recovery", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-to-recover", memberCount: 2 },
        }),
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "UNKNOWN", message: "fail" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("輸入同步碼重新加入"));
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
        // 1st call (tryAutoRecovery) fails → recovery-choice
        // 2nd call (performSoloRecovery in handleRecoveryChoiceSkip) fails → solo-recovery-confirm
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "FAIL", message: "recovery failed" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      await waitFor(() => {
        expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: "確認重新同步" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    });

    it("solo-recovery-confirm: '返回' goes back to recovery-choice", async () => {
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-back", memberCount: 1 },
        }),
        // All joinFamily calls fail → forces recovery-choice then solo-recovery-confirm
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "FAIL", message: "recovery failed" },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      // choice → confirm → back → choice
      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });
      await waitFor(() => {
        expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "返回" }));
        await flushMicrotasks();
      });

      expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
    });

    it("solo-recovery-confirm: '確認重新同步' triggers performSoloRecovery and calls onFamilyJoined on success", async () => {
      const onFamilyJoined = vi.fn();
      // 1st call (tryAutoRecovery in handleStart) fails → recovery-choice
      // 2nd call (performSoloRecovery in handleRecoveryChoiceSkip) fails → solo-recovery-confirm
      // 3rd call (performSoloRecovery in handleSoloRecoveryConfirm) succeeds
      const joinFamilyMock = vi
        .fn()
        .mockResolvedValueOnce({
          error: { code: "FAIL", message: "auto recovery failed" },
        })
        .mockResolvedValueOnce({
          error: { code: "FAIL", message: "solo recovery failed" },
        })
        .mockResolvedValue({
          data: { authToken: "tok-solo", expiresAt: 9999999999 },
        });
      const mockApi = createMockApiClient({
        lookupUser: vi.fn().mockResolvedValue({
          data: { existingFamilyId: "fam-confirm-solo", memberCount: 1 },
        }),
        joinFamily: joinFamilyMock,
      });

      renderOnboarding({ apiClient: mockApi, onFamilyJoined });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("發現您的家庭書架帳號")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("略過，重新同步書籍資料"));
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(500);
          await flushMicrotasks();
        }
      });

      // Wait for async handleRecoveryChoiceSkip to finish and show solo-recovery-confirm
      await waitFor(() => {
        expect(screen.getByText("確認重新同步書籍資料？")).toBeInTheDocument();
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
      // Solo recovery calls joinFamily without a verify secret (4th arg undefined)
      expect(joinFamilyMock).toHaveBeenCalledWith(
        "fam-confirm-solo",
        expect.any(String),
        expect.any(String),
        undefined,
      );
    });
  });

  /**
   * SEC-1: a manual sync-code join that hits a verification error must open the
   * verification prompt (heading "需要驗證") so the member can supply their
   * PIN/pattern — it must NOT be mislabeled as a generic sync-code error.
   */
  describe("handleJoin verification error responses", () => {
    async function joinWithError(
      code: string,
      overrides: Partial<ApiClient> = {},
    ) {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code, message: "verification" },
        }),
        ...overrides,
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: "moo-abcd-efgh-validKey123" },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        await flushMicrotasks();
      });
    }

    it.each([
      "VERIFICATION_REQUIRED",
      "VERIFICATION_FAILED",
      "VERIFICATION_LOCKED",
    ] as const)(
      "routes server error %s to the verification prompt, not a sync-code error",
      async (code) => {
        await joinWithError(code);

        await waitFor(() => {
          expect(screen.getByText("需要驗證")).toBeInTheDocument();
        });
        // The old stopgap that mislabeled this as a sync-code error is gone.
        expect(screen.queryByText("發生錯誤")).not.toBeInTheDocument();
      },
    );

    it("renders the PIN challenge when the backend method is PIN", async () => {
      await joinWithError("VERIFICATION_REQUIRED", {
        getVerifyMethod: vi
          .fn()
          .mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
      });

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });
    });

    it("shows the locked message for VERIFICATION_LOCKED", async () => {
      await joinWithError("VERIFICATION_LOCKED");

      await waitFor(() => {
        // Asserted through the production formatter; the literal is pinned in
        // tests/unit/dialog/verificationMessages.test.ts.
        expect(
          screen.getByText(verificationLockedMessage(null)),
        ).toBeInTheDocument();
      });
    });

    it("shows the remaining wait when the backend sends retryAfter with the lock", async () => {
      // The lockout line is re-rendered from Date.now() once a second, and this
      // file's fake clock auto-advances with real time (shouldAdvanceTime), so a
      // join flow taking over a second would tick 90 → 89 and flake the exact
      // copy assertion. Freeze Date only — the timer machinery that
      // clickStartAndWait drives keeps advancing normally.
      const frozenNow = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
      onTestFinished(() => nowSpy.mockRestore());

      // A locked join that carries `retryAfter` must open the prompt already
      // counting down instead of showing the open-ended static copy.
      await joinWithError("VERIFICATION_LOCKED", {
        joinFamily: vi.fn().mockResolvedValue({
          error: {
            code: "VERIFICATION_LOCKED",
            message: "locked",
            retryAfter: 90,
          },
        }),
      });

      await waitFor(() => {
        expect(
          screen.getByText(verificationLockedMessage(90)),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText(verificationLockedMessage(null)),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * The verification challenge REPLACES the join screen, taking that screen's
   * `@host` disclosure with it — precisely when the user is asked to hand a
   * PIN/pattern to whichever server the sync code named. So the challenge
   * carries its own note, and its verdict comes from the endpoint the client has
   * ACTUALLY adopted (never from input text): a sync-code join has already
   * applied its `@host` by the time the challenge opens, while a create/lookup
   * challenge is still on the official default and must stay silent.
   *
   * The copy follows the same boundary — no sync code is visible here, so the
   * note drops the join screens' "此同步碼" lead-in (`variant="verify"`).
   */
  describe("verification challenge endpoint disclosure", () => {
    /** A self-hosted family server, written the way a sync code would carry it. */
    const SELF_HOSTED = "https://nas.example.com/moo/";

    /** Land in idle, paste `syncCode`, press 加入 — the join is refused. */
    async function joinInto(syncCode: string, mockApi: ApiClient) {
      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("輸入家庭同步碼"),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("輸入家庭同步碼"), {
        target: { value: syncCode },
      });

      await act(async () => {
        fireEvent.click(screen.getByText("加入家庭公開書櫃"));
        await flushMicrotasks();
      });

      await waitFor(() => {
        expect(screen.getByText("需要驗證")).toBeInTheDocument();
      });
    }

    it("names the sync code's server above the challenge", async () => {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "VERIFICATION_REQUIRED", message: "verification" },
        }),
      });

      await joinInto(`moo-abcd-efgh@${SELF_HOSTED}`, mockApi);

      const note = screen.getByTestId("sync-code-host-note");
      expect(note).toHaveTextContent("將連線至自訂伺服器：");
      // No sync code is on THIS screen — it was typed on the previous one — so
      // the join lead-in's "此同步碼" would point the user at something that is
      // not there. Its absence is the only thing pinning `variant="verify"`:
      // the join copy contains the verify copy as a substring, so the positive
      // assertion above passes either way.
      expect(note.textContent).not.toContain("此同步碼");
      // The canonical address the client actually adopted — not the raw `@host`
      // text, so a trailing slash / uppercase host / IDN cannot make the
      // disclosure read as a different server from the one being talked to.
      expect(mockApi.getEndpoint()).toBe(validateEndpointUrl(SELF_HOSTED));
      expect(note).toHaveTextContent(mockApi.getEndpoint());
    });

    /**
     * A create/lookup-triggered challenge never left the official endpoint, so
     * there is nothing to disclose. Silence matters: a note on EVERY challenge
     * would train the user to ignore the one that means something.
     */
    it("stays silent when the challenge arrives on the official default endpoint", async () => {
      const mockApi = createMockApiClient(
        {
          lookupUser: vi.fn().mockResolvedValue({
            data: {
              existingFamilyId: null,
              memberCount: 0,
              requiresVerification: BoolFlag.TRUE,
            },
          }),
        },
        DEFAULT_API_ENDPOINT,
      );

      renderOnboarding({ apiClient: mockApi });

      // The lookup inside handleStart is what raises this challenge.
      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("需要驗證")).toBeInTheDocument();
      });
      expect(mockApi.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("sync-code-host-note-invalid"),
      ).not.toBeInTheDocument();
      // Nothing else on the challenge announces itself, so an alert here could
      // only be the note.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    /**
     * Defence in depth: `ApiClient.setEndpoint` validates, so `getEndpoint()`
     * cannot normally return an address the client would refuse. Pinned anyway —
     * whatever put it there, the note must warn rather than lend a refused host
     * the legitimacy of the reassuring line.
     */
    it("warns instead of naming an adopted endpoint the validator would refuse", async () => {
      const mockApi = createMockApiClient({
        getEndpoint: vi.fn(() => "https://real.example@evil.com"),
        lookupUser: vi.fn().mockResolvedValue({
          data: {
            existingFamilyId: null,
            memberCount: 0,
            requiresVerification: BoolFlag.TRUE,
          },
        }),
      });

      renderOnboarding({ apiClient: mockApi });

      await clickStartAndWait();

      await waitFor(() => {
        expect(screen.getByText("需要驗證")).toBeInTheDocument();
      });
      const warning = screen.getByTestId("sync-code-host-note-invalid");
      expect(warning).toHaveAttribute("role", "alert");
      expect(
        screen.queryByTestId("sync-code-host-note"),
      ).not.toBeInTheDocument();
      // Neither the masqueraded name nor the host the browser would reach.
      expect(warning.textContent).not.toContain("real.example");
      expect(warning.textContent).not.toContain("evil.com");
    });

    it("keeps the challenge itself intact alongside the note", async () => {
      const mockApi = createMockApiClient({
        joinFamily: vi.fn().mockResolvedValue({
          error: { code: "VERIFICATION_REQUIRED", message: "verification" },
        }),
      });

      await joinInto(`moo-abcd-efgh@${SELF_HOSTED}`, mockApi);

      // The disclosure is added ABOVE the prompt, not in place of it.
      expect(screen.getByTestId("sync-code-host-note")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    });
  });

  describe("copy sync code", () => {
    /**
     * Create a family and land on the created view, with the clipboard stubbed
     * so 複製同步碼 resolves. Returns the render handle (for `unmount`) and the
     * clipboard spy.
     */
    async function reachCreatedViewWithClipboard() {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

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

      const view = renderOnboarding({ apiClient: mockApi });

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

      return { view, writeText };
    }

    /**
     * Undoes the clearTimeout spy of the unmount-cleanup test. It must run
     * BEFORE the outer `afterEach`'s `vi.useRealTimers()` — the spy wraps the
     * FAKE clearTimeout, so restoring after the clock swap would strand the
     * fake on globalThis for every later test. Vitest runs a nested suite's
     * afterEach ahead of its parent's, which is exactly that order.
     */
    let restoreClearTimeout = () => {};

    afterEach(() => {
      restoreClearTimeout();
      restoreClearTimeout = () => {};
    });

    it("copies sync code to clipboard", async () => {
      const { writeText } = await reachCreatedViewWithClipboard();

      await act(async () => {
        fireEvent.click(screen.getByText("複製同步碼"));
      });

      expect(writeText).toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByText("已複製")).toBeInTheDocument();
      });

      // After 2000ms, should revert
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText("複製同步碼")).toBeInTheDocument();
    });

    /**
     * The 已複製 reset is a 2s timer armed by the copy click. Closing the dialog
     * inside that window must cancel it — a bare `setTimeout(() => setCopied
     * (false), 2000)` would fire on a component that is gone. The flag is held
     * by `useTimedFlag`, whose unmount cleanup does the cancelling.
     */
    it("clears the pending 已複製 reset timer when the dialog unmounts", async () => {
      const { view } = await reachCreatedViewWithClipboard();

      await act(async () => {
        fireEvent.click(screen.getByText("複製同步碼"));
      });

      // The flag on screen is the proof the 2s reset timer is now armed.
      await waitFor(() => {
        expect(screen.getByText("已複製")).toBeInTheDocument();
      });

      // Spy only from here, so nothing the copy itself cleared can be mistaken
      // for the unmount cleanup.
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      restoreClearTimeout = () => clearSpy.mockRestore();

      view.unmount();

      expect(clearSpy).toHaveBeenCalled();
    });
  });
});
