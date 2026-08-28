import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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

  /**
   * `setVerifyMethod` resolves the `{ data, error }` envelope through
   * `readEnvelope`, which bare-casts `response.json()` (pwa/src/api/client.ts),
   * and the endpoint is user-configurable (BYO backend), so `error.message` is
   * `unknown` at runtime. This site used to read it as `res.error.message ||
   * "…"`, and `||` lets every truthy non-string through — including exactly the
   * objects and arrays React 19 refuses as a JSX child. With no ErrorBoundary
   * above it, the throw took the whole page white while this overlay
   * (`fixed inset-0`) was covering it.
   */
  describe("hostile save-error envelopes", () => {
    /** Walk to the one save that needs no secret: 不設定驗證 → 確定不設定. */
    async function confirmSkipWith(setVerifyMethod: ReturnType<typeof vi.fn>) {
      const client = createMockClient({ setVerifyMethod });
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
      // `act` is the barrier for the save: its state update lands in a promise
      // continuation that would otherwise settle outside any act scope, between
      // this helper resolving and the caller's next assertion.
      await act(async () => {
        fireEvent.click(screen.getByText("確定不設定"));
      });
    }

    it.each([
      { name: "an object message", message: { zh: "壞掉了" } },
      { name: "an array message", message: ["壞掉了"] },
      { name: "a number message", message: 500 },
      { name: "a boolean message", message: true },
      { name: "a null message", message: null },
      { name: "a missing message", message: undefined },
      // Degrades too: a blank error tells the user nothing.
      { name: "an empty-string message", message: "" },
    ])(
      "should show the local save-failure copy for $name instead of crashing",
      async ({ message }) => {
        await confirmSkipWith(
          vi.fn().mockResolvedValue({
            error: { code: "SERVER_ERROR", message },
          }),
        );

        // The literal lives in VerifySetupPrompt.tsx (`saveMethod`); this reads
        // it back off the production render path. `getByText` matches the
        // node's whole text, so a hostile value that had reached state would
        // fail here rather than hide inside the same node.
        expect(screen.getByText("儲存失敗，請重試。")).toHaveAttribute(
          "role",
          "alert",
        );
        // A thrown render tears the tree down; the still-mounted overlay is
        // what the regression is really about — and a failed save must not
        // report completion.
        expect(screen.getByText("確定不設定驗證？")).toBeInTheDocument();
        expect(mockOnComplete).not.toHaveBeenCalled();
      },
    );

    it("should keep a usable server message unchanged", async () => {
      await confirmSkipWith(
        vi.fn().mockResolvedValue({
          error: { code: "INVALID_METHOD", message: "驗證方式無效" },
        }),
      );

      expect(screen.getByText("驗證方式無效")).toBeInTheDocument();
      expect(screen.queryByText("儲存失敗，請重試。")).not.toBeInTheDocument();
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
