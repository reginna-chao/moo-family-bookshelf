import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { LandingPage } from "@/pages/LandingPage";


// Mock crypto modules
vi.mock("@/crypto/syncCode", () => ({
  decodeSyncCode: vi.fn(),
  encodeSyncCode: vi.fn((data: { familyId: string; encryptionKey: string; apiHost?: string }) => {
    const base = `moo-${data.familyId}-${data.encryptionKey}`;
    return data.apiHost ? `${base}@${data.apiHost}` : base;
  }),
  SyncCodeError: class SyncCodeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SyncCodeError";
    }
  },
}));

// Mock ApiClient constructor so joinFamily and getVerifyMethod can be controlled
const { mockJoinFamily, mockGetVerifyMethod } = vi.hoisted(() => ({
  mockJoinFamily: vi.fn(),
  mockGetVerifyMethod: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    joinFamily: mockJoinFamily,
    getVerifyMethod: mockGetVerifyMethod,
  })),
}));

import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
  }
});

const mockDecodeSyncCode = vi.mocked(decodeSyncCode);

function fillInput(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), {
    target: { value },
  });
}

function submitForm() {
  const form = screen.getByRole("button", { name: /開始使用|處理中/ })
    .closest("form")!;
  fireEvent.submit(form);
}

describe("LandingPage", () => {
  const mockOnAuth = vi.fn();

  beforeEach(() => {
    mockOnAuth.mockReset();
    mockDecodeSyncCode.mockReset();
    mockJoinFamily.mockReset();
    mockGetVerifyMethod.mockReset();
    // Default: no verification, joinFamily succeeds with token
    mockGetVerifyMethod.mockResolvedValue({ data: { method: "none", prompted: 0 } });
    mockJoinFamily.mockResolvedValue({ data: { ok: true, authToken: "tok-123" } as unknown as { ok: boolean } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("renders form", () => {
    it("should show family ID, encryption key, email inputs, and submit button", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      expect(screen.getByLabelText("家庭 ID")).toBeInTheDocument();
      expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      expect(screen.getByLabelText("讀墨帳號 Email")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "開始使用" }),
      ).toBeInTheDocument();
    });

    it("should show placeholders", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      expect(screen.getByPlaceholderText("abc1-def2")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("同步碼")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("your@email.com"),
      ).toBeInTheDocument();
    });
  });

  describe("empty form submission", () => {
    it("should show validation error when family ID is empty", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("請輸入家庭 ID。"),
        ).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should show email validation error when fields are valid but email is empty", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請輸入 Email。")).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });
  });

  describe("invalid sync code", () => {
    it("should show SyncCodeError message for invalid format", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code");
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "bad");
      fillInput("同步碼", "code");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼格式不正確，請確認後重新輸入。"),
        ).toBeInTheDocument();
      });
    });

    it("should show generic error for non-SyncCodeError exceptions", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "bad");
      fillInput("同步碼", "code");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼解析失敗，請重試。"),
        ).toBeInTheDocument();
      });
    });

    it("should clear error when user types in family ID field", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code");
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "bad");
      fillInput("同步碼", "code");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼格式不正確，請確認後重新輸入。"),
        ).toBeInTheDocument();
      });

      fillInput("家庭 ID", "m");

      expect(
        screen.queryByText("同步碼格式不正確，請確認後重新輸入。"),
      ).not.toBeInTheDocument();
    });
  });

  describe("invalid email", () => {
    it("should show email format error for invalid email", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "not-an-email");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("Email 格式不正確。"),
        ).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should clear email error when user types in email field", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "bad");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Email 格式不正確。")).toBeInTheDocument();
      });

      fillInput("讀墨帳號 Email", "badx");

      expect(
        screen.queryByText("Email 格式不正確。"),
      ).not.toBeInTheDocument();
    });
  });

  describe("valid submission", () => {
    it("should call onAuth with correct AuthState (userId hashed client-side)", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.api.com",
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-fam1-key1@custom.api.com"
        />,
      );

      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: expect.stringMatching(/^[a-f0-9]{64}$/),
          familyId: "fam-1",
          encryptionKey: "key-1",
          apiHost: "custom.api.com",
          authToken: "tok-123",
        });
      });
    });

    it("should call onAuth without apiHost when not present", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "test@test.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: expect.stringMatching(/^[a-f0-9]{64}$/),
          familyId: "fam-1",
          encryptionKey: "key-1",
          apiHost: undefined,
          authToken: "tok-123",
        });
      });
    });
  });

  describe("submit button disabled during processing", () => {
    it("should show '處理中...' and disable button during submission", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      let resolveJoin!: (value: { data: { ok: boolean } }) => void;
      mockJoinFamily.mockReturnValue(
        new Promise((resolve) => {
          resolveJoin = resolve;
        }),
      );

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        const button = screen.getByRole("button", { name: "處理中..." });
        expect(button).toBeInTheDocument();
        expect(button).toBeDisabled();
      });

      resolveJoin({ data: { ok: true } });

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalled();
      });
    });

    it("should re-enable button when joinFamily returns an error", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Family not found")).toBeInTheDocument();
      });

      const button = screen.getByRole("button", { name: "開始使用" });
      expect(button).not.toBeDisabled();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should re-enable button when joinFamily throws", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockJoinFamily.mockRejectedValue(new Error("network error"));

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("處理失敗，請重試。")).toBeInTheDocument();
      });

      const button = screen.getByRole("button", { name: "開始使用" });
      expect(button).not.toBeDisabled();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });
  });

  describe("FAMILY_FULL error", () => {
    it("should show family full error when joinFamily returns FAMILY_FULL", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_FULL", message: "Family is full" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("家庭成員已達上限（每個家庭最多 2 位成員）"),
        ).toBeInTheDocument();
      });

      expect(mockOnAuth).not.toHaveBeenCalled();
      const button = screen.getByRole("button", { name: "開始使用" });
      expect(button).not.toBeDisabled();
    });

    it("should show joinFamily error message for non-FAMILY_FULL errors", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Family not found")).toBeInTheDocument();
      });

      expect(mockOnAuth).not.toHaveBeenCalled();
    });
  });

  describe("initialSyncCode prop", () => {
    it("should pre-fill both fields from initialSyncCode prop", () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "abc1-def2",
        encryptionKey: "key123",
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-abc1-def2-key123"
        />,
      );

      const familyIdInput = screen.getByLabelText("家庭 ID") as HTMLInputElement;
      const keyInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(familyIdInput.value).toBe("abc1-def2");
      expect(keyInput.value).toBe("key123");
    });

    it("should not pre-fill when initialSyncCode is empty", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode=""
        />,
      );

      const familyIdInput = screen.getByLabelText("家庭 ID") as HTMLInputElement;
      const keyInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(familyIdInput.value).toBe("");
      expect(keyInput.value).toBe("");
    });
  });

  describe("remembered sync code from localStorage", () => {
    it("should pre-fill both fields from REMEMBERED_LOGOUT_KEY on mount", () => {
      localStorage.setItem("moo:rememberedLogout", "moo-fam1-key1@custom.host.com");
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam1",
        encryptionKey: "key1",
        apiHost: "custom.host.com",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      const familyIdInput = screen.getByLabelText("家庭 ID") as HTMLInputElement;
      const keyInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(familyIdInput.value).toBe("fam1");
      expect(keyInput.value).toBe("key1");
      expect(localStorage.getItem("moo:rememberedLogout")).toBeNull();
    });

    it("should not pre-fill when REMEMBERED_LOGOUT_KEY is absent", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      const familyIdInput = screen.getByLabelText("家庭 ID") as HTMLInputElement;
      const keyInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(familyIdInput.value).toBe("");
      expect(keyInput.value).toBe("");
    });
  });

  describe("initialJoinFamilyId prop", () => {
    it("should pre-fill family ID from initialJoinFamilyId prop", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialJoinFamilyId="abc-join-123"
        />,
      );

      const familyIdInput = screen.getByLabelText("家庭 ID") as HTMLInputElement;
      const keyInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(familyIdInput.value).toBe("abc-join-123");
      expect(keyInput.value).toBe("");
    });
  });

  describe("externalError prop", () => {
    it("should display externalError when provided", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          externalError="家庭成員已達上限（每個家庭最多 2 位成員）"
        />,
      );

      expect(
        screen.getByText("家庭成員已達上限（每個家庭最多 2 位成員）"),
      ).toBeInTheDocument();
    });
  });

  describe("verification flow", () => {
    it("should show PIN verification when method is pin", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "pin", prompted: 1 } });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });

      // joinFamily should NOT have been called yet
      expect(mockJoinFamily).not.toHaveBeenCalled();
    });

    it("should show pattern verification when method is pattern", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "pattern", prompted: 1 } });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請繪製圖形驗證")).toBeInTheDocument();
      });

      expect(mockJoinFamily).not.toHaveBeenCalled();
    });

    it("should show code input when method is code", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "code", prompted: 1 } });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
        expect(screen.getByText("請在電腦版 Extension 查看驗證碼")).toBeInTheDocument();
      });

      expect(mockJoinFamily).not.toHaveBeenCalled();
    });

    it("should go back to form when cancelling verification", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "pin", prompted: 1 } });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("取消"));

      await waitFor(() => {
        expect(screen.getByLabelText("家庭 ID")).toBeInTheDocument();
      });
    });

    it("should show VERIFICATION_FAILED error from joinFamily", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "code", prompted: 1 } });
      mockJoinFamily.mockResolvedValue({
        error: { code: "VERIFICATION_FAILED", message: "Wrong code" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
      });

      // Enter a 6-digit code
      const codeInput = screen.getByPlaceholderText("6 位數驗證碼");
      fireEvent.change(codeInput, { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("button", { name: "確認" }));

      await waitFor(() => {
        expect(screen.getByText("驗證失敗，請重新輸入。")).toBeInTheDocument();
      });

      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should proceed directly when method is none", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "none", prompted: 1 } });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("家庭 ID", "fam-1");
      fillInput("同步碼", "key-1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalled();
      });
    });
  });

  describe("QR code auto-login flow", () => {
    it("should auto-join when qrUserId is provided and no verification needed", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-qr",
        encryptionKey: "key-qr",
        apiHost: "qr.host.com",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "none", prompted: 1 } });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-famqr-keyqr@qr.host.com"
          qrUserId="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        />,
      );

      await waitFor(() => {
        expect(mockJoinFamily).toHaveBeenCalledWith(
          "fam-qr",
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          undefined,
        );
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          familyId: "fam-qr",
          encryptionKey: "key-qr",
          apiHost: "qr.host.com",
          authToken: "tok-123",
        });
      });
    });

    it("should show PIN verification when qrUserId is provided and verification required", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-qr",
        encryptionKey: "key-qr",
      });
      mockGetVerifyMethod.mockResolvedValue({ data: { method: "pin", prompted: 1 } });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-famqr-keyqr"
          qrUserId="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });

      // joinFamily should NOT have been called yet (waiting for verification)
      expect(mockJoinFamily).not.toHaveBeenCalled();
    });

    it("should show error when QR sync code is invalid", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new Error("Invalid");
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="bad-code"
          qrUserId="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText("QR Code 同步碼解析失敗，請手動輸入。"),
        ).toBeInTheDocument();
      });

      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should not auto-trigger when only qrUserId is provided without initialSyncCode", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          qrUserId="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        />,
      );

      // Should show the normal form
      expect(screen.getByLabelText("家庭 ID")).toBeInTheDocument();
      expect(mockGetVerifyMethod).not.toHaveBeenCalled();
    });
  });
});
