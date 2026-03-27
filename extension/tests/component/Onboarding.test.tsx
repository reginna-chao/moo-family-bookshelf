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
});
