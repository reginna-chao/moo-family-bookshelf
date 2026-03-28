import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Onboarding, OnboardingProps } from "@/dialog/Onboarding";
import type { ApiClient } from "@/api/client";
import { scrapeUserEmail } from "@/content/scraper";

import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

// Mock the scraper module
vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn().mockReturnValue("test@example.com"),
  scrapeDisplayName: vi.fn().mockReturnValue("Test User"),
  scrapeBooks: vi.fn().mockResolvedValue([]),
}));

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    hashEmail: vi.fn().mockResolvedValue({ data: { userId: "a".repeat(64) } }),
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

    // Reset chrome.storage.local mock
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({});
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

    it("shows error when hashEmail fails", async () => {
      const mockApi = createMockApiClient({
        hashEmail: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "Hash failed" },
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

    it("shows error when hashEmail fails during join", async () => {
      const mockApi = createMockApiClient({
        hashEmail: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "Hash failed" },
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
        expect(screen.getByText("無法驗證帳號，請重試。")).toBeInTheDocument();
      });
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
