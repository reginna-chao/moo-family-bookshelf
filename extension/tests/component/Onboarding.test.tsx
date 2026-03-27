import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Onboarding, OnboardingProps } from "@/dialog/Onboarding";
import type { ApiClient } from "@/api/client";

import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn().mockResolvedValue({
      data: { familyId: "fam-123", members: ["user-1"], createdAt: "2026-01-01" },
    }),
    joinFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn(),
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

describe("Onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chrome.storage.local.get to return empty by default (no email cached)
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({});
      },
    );
  });

  it("renders need-email state when no email cached", async () => {
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByText("歡迎使用家庭書櫃")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/首次使用需要先確認你的讀墨帳號/),
    ).toBeInTheDocument();
  });

  it("shows '前往個人帳戶頁面' link in need-email state", async () => {
    renderOnboarding();

    await waitFor(() => {
      const link = screen.getByText("前往個人帳戶頁面");
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute(
        "href",
        "https://read.readmoo.com/#/me",
      );
    });
  });

  it("transitions to idle state when email is found in chrome.storage", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({ userEmail: "test@example.com" });
      },
    );

    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      expect(screen.getByText("加入家庭公開書櫃")).toBeInTheDocument();
    });
  });

  it("shows create and join buttons in idle state", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({ userEmail: "user@readmoo.com" });
      },
    );

    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByText("建立家庭公開書櫃")).toBeInTheDocument();
      expect(screen.getByText("加入家庭公開書櫃")).toBeInTheDocument();
    });
  });

  it("join button is disabled when sync code input is empty", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({ userEmail: "user@readmoo.com" });
      },
    );

    renderOnboarding();

    await waitFor(() => {
      const joinBtn = screen.getByText("加入家庭公開書櫃");
      expect(joinBtn).toBeDisabled();
    });
  });

  it("shows error state on API failure during create", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({ userEmail: "user@readmoo.com" });
      },
    );

    const mockApi = createMockApiClient({
      createFamily: vi.fn().mockResolvedValue({
        error: { code: "INTERNAL_ERROR", message: "伺服器錯誤" },
      }),
    });

    renderOnboarding({ apiClient: mockApi });

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
});
