import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LandingPage } from "@/pages/LandingPage";
import type { ApiClient, ApiResponse } from "@/api/client";

// Mock crypto modules
vi.mock("@/crypto/syncCode", () => ({
  decodeSyncCode: vi.fn(),
  SyncCodeError: class SyncCodeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SyncCodeError";
    }
  },
}));

// Mock ApiClient constructor so joinFamily can be controlled in LandingPage
const { mockJoinFamily } = vi.hoisted(() => ({
  mockJoinFamily: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  ApiClient: vi.fn().mockImplementation(() => ({
    joinFamily: mockJoinFamily,
  })),
}));

import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";

const mockDecodeSyncCode = vi.mocked(decodeSyncCode);
const mockHashEmail = vi.fn<(email: string) => Promise<ApiResponse<{ userId: string }>>>();
const mockApiClient = { hashEmail: mockHashEmail } as unknown as ApiClient;

function fillInput(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), {
    target: { value },
  });
}

function submitForm() {
  // Use fireEvent.submit on the form element directly to bypass
  // jsdom's built-in HTML5 constraint validation for type="email" inputs.
  const form = screen.getByRole("button", { name: /開始使用|處理中/ })
    .closest("form")!;
  fireEvent.submit(form);
}

describe("LandingPage", () => {
  const mockOnAuth = vi.fn();

  beforeEach(() => {
    mockOnAuth.mockReset();
    mockDecodeSyncCode.mockReset();
    mockHashEmail.mockReset();
    mockJoinFamily.mockReset();
    // Default: joinFamily succeeds with token
    mockJoinFamily.mockResolvedValue({ data: { ok: true, authToken: "tok-123" } as unknown as { ok: boolean } });
  });

  afterEach(() => {
    // Use clearAllMocks instead of restoreAllMocks to preserve vi.mock() factory mocks.
    // restoreAllMocks undoes mockResolvedValue set in beforeEach for hoisted fns.
    vi.clearAllMocks();
  });

  describe("renders form", () => {
    it("should show sync code input, email input, and submit button", () => {
      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      expect(screen.getByLabelText("讀墨帳號 Email")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "開始使用" }),
      ).toBeInTheDocument();
    });

    it("should show placeholders", () => {
      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      expect(screen.getByPlaceholderText("moo-familyId-encryptionKey")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("your@email.com"),
      ).toBeInTheDocument();
    });
  });

  describe("empty form submission", () => {
    it("should show sync code validation error when sync code is empty", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code format");
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼格式不正確，請確認後重新輸入。"),
        ).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should show email validation error when sync code is valid but email is empty", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
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

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "bad-code");
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

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "bad-code");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼解析失敗，請重試。"),
        ).toBeInTheDocument();
      });
    });

    it("should clear sync code error when user types in sync code field", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code");
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼格式不正確，請確認後重新輸入。"),
        ).toBeInTheDocument();
      });

      // Type in the sync code field to clear error
      fillInput("同步碼", "m");

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

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
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

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "bad");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Email 格式不正確。")).toBeInTheDocument();
      });

      // Type in the email field to clear error
      fillInput("讀墨帳號 Email", "badx");

      expect(
        screen.queryByText("Email 格式不正確。"),
      ).not.toBeInTheDocument();
    });
  });

  describe("valid submission", () => {
    it("should call onAuth with correct AuthState", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.api.com",
      });
      mockHashEmail.mockResolvedValue({ data: { userId: "abc123hash" } });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1@custom.api.com");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: "abc123hash",
          familyId: "fam-1",
          encryptionKey: "key-1",
          apiHost: "custom.api.com",
          authToken: "tok-123",
        });
      });

      expect(mockHashEmail).toHaveBeenCalledWith("user@example.com");
    });

    it("should call onAuth without apiHost when not present", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockHashEmail.mockResolvedValue({ data: { userId: "def456hash" } });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "test@test.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: "def456hash",
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
      // Create a promise that we control to keep the submission pending
      let resolveHash!: (value: ApiResponse<{ userId: string }>) => void;
      mockHashEmail.mockReturnValue(
        new Promise<ApiResponse<{ userId: string }>>((resolve) => {
          resolveHash = resolve;
        }),
      );

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      // Button should now show processing state
      await waitFor(() => {
        const button = screen.getByRole("button", { name: "處理中..." });
        expect(button).toBeInTheDocument();
        expect(button).toBeDisabled();
      });

      // Resolve to clean up
      resolveHash({ data: { userId: "hash123" } });

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalled();
      });
    });

    it("should re-enable button when hashEmail returns an error", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockHashEmail.mockResolvedValue({
        error: { code: "HASH_FAILED", message: "hash failed" },
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("無法驗證帳號，請重試。")).toBeInTheDocument();
      });

      // Button should be re-enabled
      const button = screen.getByRole("button", { name: "開始使用" });
      expect(button).not.toBeDisabled();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should re-enable button when hashEmail throws", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      mockHashEmail.mockRejectedValue(new Error("network error"));

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("處理失敗，請重試。")).toBeInTheDocument();
      });

      // Button should be re-enabled
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
      mockHashEmail.mockResolvedValue({ data: { userId: "hash123" } });
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_FULL", message: "Family is full" },
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      mockHashEmail.mockResolvedValue({ data: { userId: "hash123" } });
      mockJoinFamily.mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Family not found")).toBeInTheDocument();
      });

      expect(mockOnAuth).not.toHaveBeenCalled();
    });
  });

  describe("initialSyncCode prop", () => {
    it("should pre-fill sync code from initialSyncCode prop", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          apiClient={mockApiClient}
          initialSyncCode="moo-abc1-def2-key123"
        />,
      );

      const input = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(input.value).toBe("moo-abc1-def2-key123");
    });

    it("should not pre-fill when initialSyncCode is empty", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          apiClient={mockApiClient}
          initialSyncCode=""
        />,
      );

      const input = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(input.value).toBe("");
    });
  });

  describe("remembered sync code from localStorage", () => {
    it("should pre-fill sync code from REMEMBERED_LOGOUT_KEY on mount", () => {
      localStorage.setItem("moo:rememberedLogout", "moo-fam1-key1@custom.host.com");

      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      const input = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(input.value).toBe("moo-fam1-key1@custom.host.com");
      // Key should be consumed
      expect(localStorage.getItem("moo:rememberedLogout")).toBeNull();
    });

    it("should not pre-fill when REMEMBERED_LOGOUT_KEY is absent", () => {
      render(<LandingPage onAuth={mockOnAuth} apiClient={mockApiClient} />);

      const input = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(input.value).toBe("");
    });
  });

  describe("externalError prop", () => {
    it("should display externalError when provided", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          apiClient={mockApiClient}
          externalError="家庭成員已達上限（每個家庭最多 2 位成員）"
        />,
      );

      expect(
        screen.getByText("家庭成員已達上限（每個家庭最多 2 位成員）"),
      ).toBeInTheDocument();
    });
  });
});
