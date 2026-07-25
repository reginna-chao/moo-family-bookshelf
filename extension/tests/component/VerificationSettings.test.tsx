import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VerificationSettings } from "@/dialog/VerificationSettings";
import type { ApiClient } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 0 } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    generateOtp: vi.fn().mockResolvedValue({
      data: { code: "482916", expiresAt: Date.now() + 300000 },
    }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("VerificationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state then current method", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    expect(screen.getByText("載入中...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("目前方式：不設定驗證")).toBeInTheDocument();
    });
  });

  it("displays current method from server", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "pin", prompted: 1 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("目前方式：PIN 碼")).toBeInTheDocument();
    });
  });

  it("renders all 4 method buttons", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });
    expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    expect(screen.getByText("不設定驗證")).toBeInTheDocument();
  });

  it("shows PIN input when PIN method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("PIN 碼"));
    expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
  });

  it("shows pattern lock when pattern method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("圖形驗證"));
    expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
  });

  it("saves immediately when code method is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(api.setVerifyMethod).toHaveBeenCalledWith("user-1", {
        method: "code",
      });
    });
  });

  it("shows warning when none is selected", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));
    expect(
      screen.getByText("家庭成員若知道你的 Email，可能在手機版登入你的帳號"),
    ).toBeInTheDocument();
  });

  it("saves none method after confirming warning", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));
    fireEvent.click(screen.getByText("確定不設定驗證"));

    await waitFor(() => {
      expect(api.setVerifyMethod).toHaveBeenCalledWith("user-1", {
        method: "none",
      });
    });
  });

  it("shows generate OTP button when current method is code", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("產生驗證碼")).toBeInTheDocument();
    });
  });

  it("generates and displays OTP code", async () => {
    const api = createMockApiClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "code", prompted: 0 } }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("產生驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("產生驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("482916")).toBeInTheDocument();
    });
  });

  it("shows saved confirmation after successful save", async () => {
    const api = createMockApiClient();
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("shows error on save failure", async () => {
    const api = createMockApiClient({
      setVerifyMethod: vi.fn().mockResolvedValue({
        error: { code: "INVALID", message: "驗證方式無效" },
      }),
    });
    render(<VerificationSettings userId="user-1" apiClient={api} />);

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(screen.getByText("驗證方式無效")).toBeInTheDocument();
    });
  });
});
