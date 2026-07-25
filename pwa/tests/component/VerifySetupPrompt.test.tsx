import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VerifySetupPrompt } from "@/components/VerifySetupPrompt";
import { ApiClient } from "@/api/client";

// Mock the ApiClient
vi.mock("@/api/client", () => ({
  ApiClient: vi.fn(),
}));

const USER_ID = "a".repeat(64);

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 0 } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    markVerifyPrompted: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

describe("VerifySetupPrompt", () => {
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    mockOnComplete.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should show method choices when prompted === 0", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    });

    expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    expect(screen.getByText("不設定驗證")).toBeInTheDocument();
  });

  it("should not render when already prompted", async () => {
    const client = createMockClient({
      getVerifyMethod: vi
        .fn()
        .mockResolvedValue({ data: { method: "none", prompted: 1 } }),
    });

    const { container } = render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(mockOnComplete).not.toHaveBeenCalled();
    });

    // Component should render nothing
    expect(container.innerHTML).toBe("");
  });

  it("should show confirm-skip warning when selecting no verification", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));

    await waitFor(() => {
      expect(screen.getByText("確定不設定驗證？")).toBeInTheDocument();
      expect(screen.getByText(/家庭成員若知道你的 Email/)).toBeInTheDocument();
    });
  });

  it("should call setVerifyMethod and onComplete when confirming skip", async () => {
    const mockSetVerify = vi.fn().mockResolvedValue({ data: { ok: true } });
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      setVerifyMethod: mockSetVerify,
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("不設定驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("不設定驗證"));

    await waitFor(() => {
      expect(screen.getByText("確定不設定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定不設定"));

    await waitFor(() => {
      expect(mockSetVerify).toHaveBeenCalledWith(USER_ID, { method: "none" });
      expect(mockMarkPrompted).toHaveBeenCalledWith(USER_ID);
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it("should call markVerifyPrompted and onComplete when dismissing", async () => {
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("之後再說")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("之後再說"));

    await waitFor(() => {
      expect(mockMarkPrompted).toHaveBeenCalledWith(USER_ID);
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it("should show PIN setup when selecting PIN", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PIN 碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("PIN 碼"));

    await waitFor(() => {
      expect(screen.getByText(/設定 PIN 碼/)).toBeInTheDocument();
    });
  });

  it("should show pattern setup when selecting pattern", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("圖形驗證")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("圖形驗證"));

    await waitFor(() => {
      expect(screen.getByText(/設定圖形驗證/)).toBeInTheDocument();
    });
  });

  it("should call setVerifyMethod with code and complete when selecting random code", async () => {
    const mockSetVerify = vi.fn().mockResolvedValue({ data: { ok: true } });
    const mockMarkPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
    const client = createMockClient({
      setVerifyMethod: mockSetVerify,
      markVerifyPrompted: mockMarkPrompted,
    });

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("隨機驗證碼")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("隨機驗證碼"));

    await waitFor(() => {
      expect(mockSetVerify).toHaveBeenCalledWith(USER_ID, { method: "code" });
      expect(mockMarkPrompted).toHaveBeenCalledWith(USER_ID);
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it("should go back to choose step when cancelling from PIN setup", async () => {
    const client = createMockClient();

    render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByText("PIN 碼"));
    });

    await waitFor(() => {
      expect(screen.getByText(/設定 PIN 碼/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("取消"));

    await waitFor(() => {
      expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    });
  });

  it("should not render when API returns error", async () => {
    const client = createMockClient({
      getVerifyMethod: vi.fn().mockRejectedValue(new Error("network")),
    });

    const { container } = render(
      <VerifySetupPrompt
        userId={USER_ID}
        apiClient={client}
        onComplete={mockOnComplete}
      />,
    );

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });
});
