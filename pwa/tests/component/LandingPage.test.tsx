import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { SYNC_CODE_HOST_SETTLE_DELAY_MS } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { LandingPage } from "@/pages/LandingPage";
import {
  HALF_TYPED_PREFIXES,
  LAN_CODE,
  LAN_ENDPOINT,
  SPOOFED_CODE,
  TRUSTED_CODE,
  TRUSTED_ENDPOINT,
} from "../helpers/syncCodeHostFixtures";

/**
 * Only `decodeSyncCode` is stubbed — these tests drive the flow by dictating
 * what a pasted code decodes to. Everything else in the module stays REAL,
 * including `parseSyncCodeApiHost`: it feeds the `@host` disclosure note that
 * LandingPage renders on every keystroke, so replacing it would leave the note
 * (and the copy it carries) unverified — and a factory that simply forgets it
 * makes the whole page throw on render.
 *
 * `classifySyncCodeApiHost` (imported by LandingPage straight from `shared/`)
 * is never mocked, so the endpoint-refusal guards run the production rules.
 */
vi.mock("@/crypto/syncCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/crypto/syncCode")>()),
  decodeSyncCode: vi.fn(),
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
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const mockDecodeSyncCode = vi.mocked(decodeSyncCode);

/**
 * A self-hosted endpoint the client will ACCEPT. Fixtures carry full URLs
 * because that is what an app-generated sync code contains — a bare host has
 * never been adoptable (`new URL()` needs a scheme).
 */
const CUSTOM_ENDPOINT = "https://custom.api.com";
const QR_ENDPOINT = "https://qr.host.com";

/**
 * Mirrors src/utils/apiHostGuard.ts `UNSAFE_API_HOST_ERROR`. Asserted against
 * the page's own rendering of it, so a copy change here fails loudly rather
 * than leaving a stale duplicate green.
 */
const ABORT_MESSAGE = "此同步碼的伺服器位址無效或不安全，無法加入。";

function fillInput(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), {
    target: { value },
  });
}

function submitForm() {
  const form = screen
    .getByRole("button", { name: /開始使用|處理中/ })
    .closest("form")!;
  fireEvent.submit(form);
}

/**
 * Drain the microtask queue so any request the page started has reached its
 * mock before a "nothing was called" assertion runs. Without this, a probe
 * hidden behind an `await` would slip through the gap between the screen
 * appearing and the assertion — the exact regression those tests guard.
 */
async function flushPendingRequests() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("LandingPage", () => {
  const mockOnAuth = vi.fn();

  beforeEach(() => {
    mockOnAuth.mockReset();
    mockDecodeSyncCode.mockReset();
    mockJoinFamily.mockReset();
    mockGetVerifyMethod.mockReset();
    // Default: no verification, joinFamily succeeds with token
    mockGetVerifyMethod.mockResolvedValue({
      data: { method: "none", prompted: 0 },
    });
    mockJoinFamily.mockResolvedValue({
      data: { ok: true, authToken: "tok-123" } as unknown as { ok: boolean },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("renders form", () => {
    it("should show sync code, email inputs, and submit button", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      expect(screen.getByLabelText("讀墨帳號 Email")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "開始使用" }),
      ).toBeInTheDocument();
    });

    it("should show placeholders", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      expect(
        screen.getByPlaceholderText("moo-xxxxxxxx-xxxxxxxxxxxx"),
      ).toBeInTheDocument();
      expect(screen.getByPlaceholderText("your@email.com")).toBeInTheDocument();
    });
  });

  describe("empty form submission", () => {
    it("should show validation error when sync code is empty", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請輸入同步碼。")).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should show email validation error when sync code is valid but email is empty", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

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

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "bad-code");
      fillInput("讀墨帳號 Email", "user@example.com");
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

      fillInput("同步碼", "bad-code");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼解析失敗，請重試。"),
        ).toBeInTheDocument();
      });
    });

    it("should clear error when user types in sync code field", async () => {
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code");
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "bad");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByText("同步碼格式不正確，請確認後重新輸入。"),
        ).toBeInTheDocument();
      });

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
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "not-an-email");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Email 格式不正確。")).toBeInTheDocument();
      });
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("should clear email error when user types in email field", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "bad");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("Email 格式不正確。")).toBeInTheDocument();
      });

      fillInput("讀墨帳號 Email", "badx");

      expect(screen.queryByText("Email 格式不正確。")).not.toBeInTheDocument();
    });
  });

  describe("valid submission", () => {
    it("should call onAuth with correct AuthState (userId hashed client-side)", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
        apiHost: CUSTOM_ENDPOINT,
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode={`moo-fam1-key1@${CUSTOM_ENDPOINT}`}
        />,
      );

      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: expect.stringMatching(/^[a-f0-9]{64}$/),
          familyId: "fam-1",
          apiHost: CUSTOM_ENDPOINT,
          authToken: "tok-123",
        });
      });
    });

    it("should call onAuth without apiHost when not present", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "test@test.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: expect.stringMatching(/^[a-f0-9]{64}$/),
          familyId: "fam-1",
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
      });
      let resolveJoin!: (value: { data: { ok: boolean } }) => void;
      mockJoinFamily.mockReturnValue(
        new Promise((resolve) => {
          resolveJoin = resolve;
        }),
      );

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockJoinFamily.mockRejectedValue(new Error("network error"));

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_FULL", message: "Family is full" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

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
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

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
    it("should pre-fill sync code field from initialSyncCode prop", () => {
      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-abc1-def2-key123"
        />,
      );

      const syncCodeInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncCodeInput.value).toBe("moo-abc1-def2-key123");
    });

    it("should not pre-fill when initialSyncCode is empty", () => {
      render(<LandingPage onAuth={mockOnAuth} initialSyncCode="" />);

      const syncCodeInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncCodeInput.value).toBe("");
    });
  });

  describe("remembered sync code from localStorage", () => {
    it("should pre-fill sync code from REMEMBERED_LOGOUT_KEY on mount", () => {
      localStorage.setItem(
        "moo:rememberedLogout",
        `moo-fam1-key1@${CUSTOM_ENDPOINT}`,
      );

      render(<LandingPage onAuth={mockOnAuth} />);

      const syncCodeInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncCodeInput.value).toBe(`moo-fam1-key1@${CUSTOM_ENDPOINT}`);
      expect(localStorage.getItem("moo:rememberedLogout")).toBeNull();
    });

    it("should not pre-fill when REMEMBERED_LOGOUT_KEY is absent", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      const syncCodeInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncCodeInput.value).toBe("");
    });
  });

  describe("remember sync code checkbox", () => {
    it("should render remember checkbox checked by default (opt-out)", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      const checkbox = screen.getByRole("checkbox", { name: /記住同步碼/ });
      expect(checkbox).toBeChecked();
    });

    it("should render remember checkbox unchecked when localStorage is '0'", () => {
      localStorage.setItem("moo:rememberSyncCode", "0");

      render(<LandingPage onAuth={mockOnAuth} />);

      const checkbox = screen.getByRole("checkbox", { name: /記住同步碼/ });
      expect(checkbox).not.toBeChecked();
    });

    it("should persist remember preference to localStorage on submit", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      // Uncheck the checkbox via change event
      const checkbox = screen.getByRole("checkbox", {
        name: /記住同步碼/,
      }) as HTMLInputElement;
      fireEvent.change(checkbox, { target: { checked: false } });
      expect(checkbox.checked).toBe(false);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalled();
      });

      expect(localStorage.getItem("moo:rememberSyncCode")).toBe("0");
    });
  });

  describe("sync code eye toggle", () => {
    it("should default to password type for sync code input", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      const syncInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncInput.type).toBe("password");
    });

    it("should toggle sync code visibility with eye button", () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      const syncInput = screen.getByLabelText("同步碼") as HTMLInputElement;
      expect(syncInput.type).toBe("password");

      fireEvent.click(screen.getByRole("button", { name: "顯示同步碼" }));
      expect(syncInput.type).toBe("text");
      expect(
        screen.getByRole("button", { name: "隱藏同步碼" }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "隱藏同步碼" }));
      expect(syncInput.type).toBe("password");
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
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pin", prompted: 1 },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pattern", prompted: 1 },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
        expect(
          screen.getByText("請在電腦版 Extension 查看驗證碼"),
        ).toBeInTheDocument();
      });

      expect(mockJoinFamily).not.toHaveBeenCalled();
    });

    it("should go back to form when cancelling verification", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pin", prompted: 1 },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("取消"));

      await waitFor(() => {
        expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      });
    });

    it("should show VERIFICATION_FAILED error from joinFamily", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-1",
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "VERIFICATION_FAILED", message: "Wrong code" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
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
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "none", prompted: 1 },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      fillInput("同步碼", "moo-fam1-key1");
      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalled();
      });
    });
  });

  describe("QR code auto-login flow", () => {
    /** A 64-hex userId, already hashed by the Extension that made the QR. */
    const QR_USER_ID = "abcdef0123456789".repeat(4);

    it("should auto-join with no interaction when the QR carries no custom host", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-qr",
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "none", prompted: 1 },
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-famqr-keyqr"
          qrUserId={QR_USER_ID}
        />,
      );

      await waitFor(() => {
        expect(mockJoinFamily).toHaveBeenCalledWith(
          "fam-qr",
          QR_USER_ID,
          expect.objectContaining({ verifySecret: undefined }),
        );
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: QR_USER_ID,
          familyId: "fam-qr",
          apiHost: undefined,
          authToken: "tok-123",
        });
      });
      // The default endpoint is the main onboarding path: nothing to disclose,
      // so nothing may interrupt it.
      expect(
        screen.queryByTestId("custom-host-consent"),
      ).not.toBeInTheDocument();
    });

    it("should auto-join to a custom host once its address has been confirmed", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-qr",
        apiHost: QR_ENDPOINT,
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "none", prompted: 1 },
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode={`moo-famqr-keyqr@${QR_ENDPOINT}`}
          qrUserId={QR_USER_ID}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "確認並加入" }),
      );

      await waitFor(() => {
        expect(mockJoinFamily).toHaveBeenCalledWith(
          "fam-qr",
          QR_USER_ID,
          expect.objectContaining({ verifySecret: undefined }),
        );
        expect(mockOnAuth).toHaveBeenCalledWith({
          userId: QR_USER_ID,
          familyId: "fam-qr",
          apiHost: QR_ENDPOINT,
          authToken: "tok-123",
        });
      });
    });

    it("should show PIN verification when qrUserId is provided and verification required", async () => {
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam-qr",
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pin", prompted: 1 },
      });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode="moo-famqr-keyqr"
          qrUserId={QR_USER_ID}
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
          qrUserId={QR_USER_ID}
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
      render(<LandingPage onAuth={mockOnAuth} qrUserId={QR_USER_ID} />);

      // Should show the normal form
      expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      expect(mockGetVerifyMethod).not.toHaveBeenCalled();
    });
  });

  /**
   * A sync code's `@host` decides where this device sends its auth token and,
   * from that point on, its entire book list. The verdict comes from the real
   * `classifySyncCodeApiHost` (never mocked here), i.e. the same rules
   * `new ApiClient(...)` enforces.
   *
   * Both entry points must refuse BEFORE the first request: each one fires a
   * `getVerifyMethod` probe at the sync code's server before any join happens,
   * so "the join failed" is far too late — the address has already been
   * contacted, and with it the fact that this userId exists.
   */
  describe("a sync code whose @host would be refused", () => {
    const REFUSED: Array<[string, string]> = [
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      // `new URL()` cannot parse a scheme-less host, so this was never
      // adoptable; the PWA now says so instead of failing obscurely later.
      ["a bare host with no scheme", "custom.api.com"],
    ];

    describe("typed into the form", () => {
      it.each(REFUSED)(
        "aborts with a plain reason for %s",
        async (_label, apiHost) => {
          mockDecodeSyncCode.mockReturnValue({ familyId: "fam-1", apiHost });

          render(<LandingPage onAuth={mockOnAuth} />);
          fillInput("同步碼", `moo-fam1-key1@${apiHost}`);
          fillInput("讀墨帳號 Email", "user@example.com");
          submitForm();

          await waitFor(() => {
            expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
          });
          expect(mockOnAuth).not.toHaveBeenCalled();
        },
      );

      it.each(REFUSED)(
        "contacts nothing at all for %s",
        async (_label, apiHost) => {
          mockDecodeSyncCode.mockReturnValue({ familyId: "fam-1", apiHost });

          render(<LandingPage onAuth={mockOnAuth} />);
          fillInput("同步碼", `moo-fam1-key1@${apiHost}`);
          fillInput("讀墨帳號 Email", "user@example.com");
          submitForm();

          await waitFor(() => {
            expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
          });
          // The probe is the first thing that would reach the refused server.
          expect(mockGetVerifyMethod).not.toHaveBeenCalled();
          expect(mockJoinFamily).not.toHaveBeenCalled();
        },
      );

      it("refuses before the email is even validated", async () => {
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-1",
          apiHost: "https://real.example@evil.com",
        });

        render(<LandingPage onAuth={mockOnAuth} />);
        fillInput("同步碼", "moo-fam1-key1@https://real.example@evil.com");
        // Email deliberately left blank.
        submitForm();

        await waitFor(() => {
          expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
        });
        // An unusable address is not a "fill in your email" situation.
        expect(screen.queryByText("請輸入 Email。")).not.toBeInTheDocument();
      });

      it("leaves the form usable so the code can be corrected", async () => {
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-1",
          apiHost: "http://evil.example.com",
        });

        render(<LandingPage onAuth={mockOnAuth} />);
        fillInput("同步碼", "moo-fam1-key1@http://evil.example.com");
        fillInput("讀墨帳號 Email", "user@example.com");
        submitForm();

        await waitFor(() => {
          expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
        });
        const button = screen.getByRole("button", { name: "開始使用" });
        expect(button).not.toBeDisabled();

        // Typing again clears the refusal, as with any other sync-code error.
        fillInput("同步碼", "moo-fam1-key1");
        expect(screen.queryByText(ABORT_MESSAGE)).not.toBeInTheDocument();
      });

      it("lets an acceptable @host through, so the guard is not a blanket block", async () => {
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-1",
          apiHost: CUSTOM_ENDPOINT,
        });

        render(<LandingPage onAuth={mockOnAuth} />);
        fillInput("同步碼", `moo-fam1-key1@${CUSTOM_ENDPOINT}`);
        fillInput("讀墨帳號 Email", "user@example.com");
        submitForm();

        await waitFor(() => expect(mockOnAuth).toHaveBeenCalled());
        expect(screen.queryByText(ABORT_MESSAGE)).not.toBeInTheDocument();
        expect(mockGetVerifyMethod).toHaveBeenCalled();
      });
    });

    describe("arriving by QR code", () => {
      const QR_USER_ID = "a".repeat(64);

      it.each(REFUSED)(
        "aborts before probing the server for %s",
        async (_label, apiHost) => {
          mockDecodeSyncCode.mockReturnValue({ familyId: "fam-qr", apiHost });

          render(
            <LandingPage
              onAuth={mockOnAuth}
              initialSyncCode={`moo-famqr-keyqr@${apiHost}`}
              qrUserId={QR_USER_ID}
            />,
          );

          await waitFor(() => {
            expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
          });
          // A QR arrival never typed this host, so nothing may be assumed about
          // it — and the probe would confirm to that server that this userId
          // exists before the user has agreed to anything.
          expect(mockGetVerifyMethod).not.toHaveBeenCalled();
          expect(mockJoinFamily).not.toHaveBeenCalled();
          expect(mockOnAuth).not.toHaveBeenCalled();
        },
      );

      it("aborts even when the QR carries a token that would skip verification", async () => {
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-qr",
          apiHost: "https://real.example@evil.com",
        });

        render(
          <LandingPage
            onAuth={mockOnAuth}
            initialSyncCode="moo-famqr-keyqr@https://real.example@evil.com"
            qrUserId={QR_USER_ID}
            qrToken="qr-token-123"
          />,
        );

        await waitFor(() => {
          expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
        });
        // The token path calls completeJoin directly, so the guard has to sit
        // ahead of that branch too, not only ahead of the probe.
        expect(mockJoinFamily).not.toHaveBeenCalled();
        expect(mockOnAuth).not.toHaveBeenCalled();
      });

      it("keeps the form reachable so the user can enter a code by hand", async () => {
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-qr",
          apiHost: "http://evil.example.com",
        });

        render(
          <LandingPage
            onAuth={mockOnAuth}
            initialSyncCode="moo-famqr-keyqr@http://evil.example.com"
            qrUserId={QR_USER_ID}
          />,
        );

        await waitFor(() => {
          expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
        });
        expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "開始使用" }),
        ).not.toBeDisabled();
      });
    });
  });

  /**
   * Disclosure, not blocking: an acceptable `@host` is still someone else's
   * server. The user is told which one BEFORE authenticating, at BOTH points
   * where that decision is still theirs to make.
   */
  describe("custom-server disclosure", () => {
    const QR_USER_ID = "b".repeat(64);

    describe("on the entry form", () => {
      it("names the endpoint while a code carrying @host is typed", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", `moo-fam1-key1@${CUSTOM_ENDPOINT}`);

        const note = screen.getByTestId("sync-code-host-note");
        expect(note).toHaveTextContent("此同步碼將連線至自訂伺服器：");
        expect(note).toHaveTextContent(CUSTOM_ENDPOINT);
      });

      it("shows the canonical endpoint, not the raw text", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", "moo-fam1-key1@https://CUSTOM.Api.com:443/v1/");

        const note = screen.getByTestId("sync-code-host-note");
        expect(note).toHaveTextContent("https://custom.api.com/v1");
        expect(note.textContent).not.toContain("CUSTOM.Api.com");
      });

      it("warns instead of naming a server for an @host that would be refused", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", "moo-fam1-key1@https://real.example@evil.com");
        // The warning is held back until the value settles, so that a half-typed
        // `@host` cannot flash it on every keystroke. Leaving the field is one of
        // the settle triggers, and it keeps this test about the COPY rather than
        // about the timer — the timing itself has its own block below.
        fireEvent.blur(screen.getByLabelText("同步碼"));

        const warning = screen.getByTestId("sync-code-host-note-invalid");
        expect(warning).toHaveAttribute("role", "alert");
        expect(warning).toHaveTextContent(
          "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
        );
        expect(
          screen.queryByTestId("sync-code-host-note"),
        ).not.toBeInTheDocument();
        // Neither the masqueraded name nor the host really reached.
        expect(warning.textContent).not.toContain("real.example");
        expect(warning.textContent).not.toContain("evil.com");
      });

      it.each([
        ["nothing has been typed", ""],
        ["the code carries no @host", "moo-fam1-key1"],
        ["the code is still being typed", "moo-fam1"],
      ])("says nothing when %s", (_label, value) => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", value);

        expect(
          screen.queryByTestId("sync-code-host-note"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("sync-code-host-note-invalid"),
        ).not.toBeInTheDocument();
      });
    });

    /**
     * WHEN the warning may appear, as opposed to what it says.
     *
     * The warning used to be live, so it flashed through nearly every keystroke
     * of a half-typed `@host` — and a warning that cries wolf during normal
     * typing is one the user is trained to dismiss. That is fatal here: it is
     * the last human-facing defence against a userinfo-spoofed endpoint, which
     * would ship the auth token and the whole book list to the attacker. So it
     * is DELAYED until the value settles, and never suppressed.
     *
     * Kept symmetric with the Extension's copy in
     * extension/tests/component/OnboardingViews.test.tsx — the policy lives in
     * `shared/` exactly so the two cannot drift.
     */
    describe("timing of the warning", () => {
      function expectNoNote() {
        expect(
          screen.queryByTestId("sync-code-host-note"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("sync-code-host-note-invalid"),
        ).not.toBeInTheDocument();
      }

      function expectWarning() {
        const warning = screen.getByTestId("sync-code-host-note-invalid");
        expect(warning).toHaveAttribute("role", "alert");
        expect(warning).toHaveTextContent(
          "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認",
        );
      }

      function advanceSettleDelay() {
        act(() => {
          vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS);
        });
      }

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("shows no warning while a legitimate LAN @host is typed one character at a time", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        for (const prefix of HALF_TYPED_PREFIXES) {
          fillInput("同步碼", prefix);
          expectNoNote();
        }

        // Anchor against a vacuous pass: the same field DOES speak once the
        // value is a complete, adoptable endpoint, so the silence above is the
        // delay doing its job — not a note that never renders at all.
        fillInput("同步碼", LAN_CODE);
        expect(screen.getByTestId("sync-code-host-note")).toBeInTheDocument();
      });

      it("names the endpoint with no delay once the typed @host becomes adoptable", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", LAN_CODE);

        // `valid` is positive information about the CURRENT value, so it is
        // never held back — no timer advance here on purpose.
        expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
          LAN_ENDPOINT,
        );
      });

      it("warns once the typed @host has held still for the settle delay", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", SPOOFED_CODE);
        expectNoNote();

        advanceSettleDelay();

        expectWarning();
      });

      it("warns as soon as a pasted code lands, without waiting for the delay", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        // onPaste fires BEFORE the input value updates, so the trigger has to
        // arm the NEXT value rather than settle the (still empty) current one.
        fireEvent.paste(screen.getByLabelText("同步碼"));
        fillInput("同步碼", SPOOFED_CODE);

        expectWarning();
      });

      it("warns on blur, without waiting for the delay", () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", SPOOFED_CODE);
        expectNoNote();

        fireEvent.blur(screen.getByLabelText("同步碼"));

        expectWarning();
      });

      it("warns when the form is submitted, without waiting for the delay", () => {
        // Submitting also refuses the join outright (isUnsafeApiHost), which is
        // the separate fail-closed guard; the note must not lag behind it.
        mockDecodeSyncCode.mockReturnValue({
          familyId: "fam-1",
          apiHost: "https://api.moofamily.app@evil.com",
        });
        render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", SPOOFED_CODE);
        expectNoNote();

        submitForm();

        expectWarning();
        expect(mockJoinFamily).not.toHaveBeenCalled();
      });

      it("warns immediately for an invite-link prefill present at first render", () => {
        // Trigger 4: a code the user never typed has no typing to flicker
        // through, so it is settled from the very first render. The field is
        // seeded straight from the prop for exactly this reason, which is what
        // makes the PWA warn at the same moment as the Extension — an
        // invite-link arrival is the one path where the user sees the address
        // before they ever touch the keyboard, so a delay here would be a
        // warning that arrives after the decision.
        render(
          <LandingPage onAuth={mockOnAuth} initialSyncCode={SPOOFED_CODE} />,
        );

        expectWarning();
        // No timer was ever armed, so the warning cannot be an artefact of one.
        expect(vi.getTimerCount()).toBe(0);
      });

      /**
       * The hazard this whole mechanism has to avoid creating. If the delay were
       * ever implemented by KEEPING the last rendered note, appending
       * `@evil.com` to a host the user already saw named would leave a
       * reassuring "will connect to api.moofamily.app" standing over a spoofed
       * address — lending the spoof exactly the legitimacy the warning denies.
       */
      it("drops the previously named host the instant the value turns invalid", () => {
        const { container } = render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", TRUSTED_CODE);
        expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
          TRUSTED_ENDPOINT,
        );

        fillInput("同步碼", SPOOFED_CODE);

        // Before the delay elapses: nothing at all on screen…
        expectNoNote();
        // …and specifically not the host that was legitimate a keystroke ago.
        // (An <input> value never lands in textContent, so this reads the note.)
        expect(container.textContent).not.toContain(TRUSTED_ENDPOINT);

        advanceSettleDelay();

        expectWarning();
      });

      it("leaves no settle timer pending after the page unmounts", () => {
        const { unmount } = render(<LandingPage onAuth={mockOnAuth} />);

        fillInput("同步碼", SPOOFED_CODE);
        expect(vi.getTimerCount()).toBe(1);

        unmount();

        expect(vi.getTimerCount()).toBe(0);
      });
    });

    /**
     * A QR / invite arrival is auto-advanced past the form, so the verification
     * screen is the ONLY place they can learn which server they are about to
     * authenticate to. Without a note here, entering a PIN would hand the
     * secret to an undisclosed host.
     *
     * The copy follows what the user can see: no sync code is on this screen,
     * so the note drops the form's "此同步碼" lead-in (`variant="verify"`).
     */
    describe("above the verification screen", () => {
      /**
       * Drive a QR arrival all the way to the PIN prompt. A code carrying an
       * `@host` is parked at the consent gate first, so the helper answers it —
       * the note under test here is the one the CHALLENGE screen carries, which
       * has to stand on its own: the gate's copy is long gone by the time the
       * PIN is typed.
       */
      async function renderQrArrival(apiHost?: string) {
        mockDecodeSyncCode.mockReturnValue({ familyId: "fam-qr", apiHost });
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "pin", prompted: 1 },
        });

        render(
          <LandingPage
            onAuth={mockOnAuth}
            initialSyncCode={
              apiHost ? `moo-famqr-keyqr@${apiHost}` : "moo-famqr-keyqr"
            }
            qrUserId={QR_USER_ID}
          />,
        );

        if (apiHost) {
          fireEvent.click(
            await screen.findByRole("button", { name: "確認並加入" }),
          );
        }

        await waitFor(() => {
          expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
        });
      }

      it("names the endpoint above the PIN prompt", async () => {
        await renderQrArrival(QR_ENDPOINT);

        const note = screen.getByTestId("sync-code-host-note");
        expect(note).toHaveTextContent("將連線至自訂伺服器：");
        // A QR / invite arrival never saw a sync code, so the form's "此同步碼"
        // lead-in would point at something that is not on screen. Its absence is
        // the only thing pinning `variant="verify"`: the join copy CONTAINS the
        // verify copy, so the positive assertion above passes either way.
        expect(note.textContent).not.toContain("此同步碼");
        expect(note).toHaveTextContent(QR_ENDPOINT);
      });

      it("says nothing when the QR points at the official default", async () => {
        await renderQrArrival(undefined);

        expect(
          screen.queryByTestId("sync-code-host-note"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("sync-code-host-note-invalid"),
        ).not.toBeInTheDocument();
      });

      it("shows the canonical endpoint, matching what the client will call", async () => {
        await renderQrArrival("https://QR.Host.com:443/api/");

        expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
          "https://qr.host.com/api",
        );
      });
    });
  });

  /**
   * Disclosure is not enough on the QR path: that path is auto-advanced past
   * the form and has two ZERO-INTERACTION exits (a valid QR token, or an
   * account with no verification configured), so a scanned code could adopt —
   * and persist — somebody else's server with nothing ever on screen.
   *
   * So consent is taken BEFORE the first request, not before the join. The
   * `getVerifyMethod` probe alone already tells that server this userId exists,
   * from this device's IP and UA; "we only asked it a question" is not a
   * meaningful distinction to a host the user never agreed to.
   *
   * The verdict still comes from the real `classifySyncCodeApiHost`, so what
   * the gate shows is the canonical address the client would actually call.
   */
  describe("consent before adopting a QR invite's custom server", () => {
    const QR_USER_ID = "c".repeat(64);
    const QR_TOKEN = "qr-token-123";
    const QR_SYNC_CODE = `moo-famqr-keyqr@${QR_ENDPOINT}`;

    /**
     * Mount the page as a QR arrival whose sync code carries `apiHost`.
     *
     * `rerenderWith` replays a parent re-render: a FRESH element (an identical
     * one would be allowed to bail out of rendering entirely) carrying the same
     * prop values, except for whatever the caller overrides.
     */
    function renderQrArrival(apiHost: string | undefined, qrToken = "") {
      mockDecodeSyncCode.mockReturnValue({ familyId: "fam-qr", apiHost });

      const props = {
        onAuth: mockOnAuth,
        initialSyncCode: apiHost
          ? `moo-famqr-keyqr@${apiHost}`
          : "moo-famqr-keyqr",
        qrUserId: QR_USER_ID,
        qrToken,
      };
      const { rerender } = render(<LandingPage {...props} />);

      return {
        rerenderWith: (overrides: { qrToken?: string } = {}) =>
          rerender(<LandingPage {...props} {...overrides} />),
      };
    }

    const consentScreen = () => screen.findByTestId("custom-host-consent");
    const confirmButton = () =>
      screen.findByRole("button", { name: "確認並加入" });

    /** Every exit the QR path has when it is NOT held back. */
    const ZERO_INTERACTION_EXITS: Array<[string, string]> = [
      ["the QR carries a token that skips verification", QR_TOKEN],
      ["the account has no verification configured", ""],
    ];

    describe("holding the join until the address has been seen", () => {
      it.each(ZERO_INTERACTION_EXITS)(
        "asks first when %s",
        async (_label, qrToken) => {
          mockGetVerifyMethod.mockResolvedValue({
            data: { method: "none", prompted: 1 },
          });

          renderQrArrival(QR_ENDPOINT, qrToken);

          expect(await consentScreen()).toBeInTheDocument();
          await flushPendingRequests();
          // The probe is the FIRST thing that would reach the undisclosed
          // server, so it is the one that proves the gate sits early enough.
          expect(mockGetVerifyMethod).not.toHaveBeenCalled();
          expect(mockJoinFamily).not.toHaveBeenCalled();
          expect(mockOnAuth).not.toHaveBeenCalled();
        },
      );

      it("names the canonical address the client would call, not the raw text", async () => {
        renderQrArrival("https://QR.Host.com:443/api/");
        await consentScreen();

        // Same canonical value the verification screen shows for this host —
        // the disclosure must not drift from where the request would go.
        const note = screen.getByTestId("sync-code-host-note");
        expect(note).toHaveTextContent("將連線至自訂伺服器：");
        // Same reason as the verification screen above: nothing on this gate
        // puts a sync code on screen, so it asks for `variant="verify"` and
        // drops the "此同步碼" lead-in. Only that ABSENCE pins the variant —
        // the join copy contains the verify copy.
        expect(note.textContent).not.toContain("此同步碼");
        expect(note).toHaveTextContent("https://qr.host.com/api");
        expect(note.textContent).not.toContain("QR.Host.com");
      });

      it("never appears for the official default endpoint", async () => {
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "none", prompted: 1 },
        });

        renderQrArrival(undefined, QR_TOKEN);

        await waitFor(() => expect(mockOnAuth).toHaveBeenCalled());
        expect(
          screen.queryByTestId("custom-host-consent"),
        ).not.toBeInTheDocument();
      });

      it("offers no consent for an @host that would be refused", async () => {
        renderQrArrival("https://real.example@evil.com", QR_TOKEN);

        await waitFor(() => {
          expect(screen.getByText(ABORT_MESSAGE)).toBeInTheDocument();
        });
        await flushPendingRequests();
        // Deliberate: an address that fails validation is refused outright, so
        // there is nothing to agree to. Offering a button would let a user
        // wave through exactly what the check exists to stop.
        expect(
          screen.queryByTestId("custom-host-consent"),
        ).not.toBeInTheDocument();
        expect(mockGetVerifyMethod).not.toHaveBeenCalled();
        expect(mockJoinFamily).not.toHaveBeenCalled();
      });
    });

    describe("once the user has agreed to the address", () => {
      it("sends the QR token to that server and completes the join", async () => {
        renderQrArrival(QR_ENDPOINT, QR_TOKEN);

        fireEvent.click(await confirmButton());

        await waitFor(() => {
          expect(mockOnAuth).toHaveBeenCalledWith({
            userId: QR_USER_ID,
            familyId: "fam-qr",
            apiHost: QR_ENDPOINT,
            authToken: "tok-123",
          });
        });
        // The token exit is preserved, not downgraded to a manual challenge.
        expect(mockJoinFamily).toHaveBeenCalledWith(
          "fam-qr",
          QR_USER_ID,
          expect.objectContaining({ qrToken: QR_TOKEN }),
        );
        // And the join is the ONLY request. Without this, "token still goes
        // straight to the join" is indistinguishable from "probe first, then
        // join": the latter would spend an extra round trip telling this
        // server that this userId exists.
        expect(mockGetVerifyMethod).not.toHaveBeenCalled();
      });

      it("probes for a verification method and joins when none is configured", async () => {
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "none", prompted: 1 },
        });

        renderQrArrival(QR_ENDPOINT);

        fireEvent.click(await confirmButton());

        await waitFor(() => {
          expect(mockOnAuth).toHaveBeenCalledWith({
            userId: QR_USER_ID,
            familyId: "fam-qr",
            apiHost: QR_ENDPOINT,
            authToken: "tok-123",
          });
        });
        expect(mockGetVerifyMethod).toHaveBeenCalledWith(QR_USER_ID);
        expect(mockJoinFamily).toHaveBeenCalledWith(
          "fam-qr",
          QR_USER_ID,
          expect.objectContaining({
            verifySecret: undefined,
            qrToken: undefined,
          }),
        );
      });

      it("opens the challenge instead of joining when verification is configured", async () => {
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "pin", prompted: 1 },
        });

        renderQrArrival(QR_ENDPOINT);

        fireEvent.click(await confirmButton());

        await waitFor(() => {
          expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
        });
        expect(mockJoinFamily).not.toHaveBeenCalled();
        expect(mockOnAuth).not.toHaveBeenCalled();
      });
    });

    describe("when the user declines", () => {
      it("falls back to the form with the code still pre-filled", async () => {
        renderQrArrival(QR_ENDPOINT, QR_TOKEN);

        fireEvent.click(await screen.findByRole("button", { name: "取消" }));

        await waitFor(() => {
          expect(
            screen.queryByTestId("custom-host-consent"),
          ).not.toBeInTheDocument();
        });
        const syncCodeInput = screen.getByLabelText(
          "同步碼",
        ) as HTMLInputElement;
        expect(syncCodeInput.value).toBe(QR_SYNC_CODE);
        // Nothing is stuck in-flight: the join never started, so the form is
        // usable rather than sitting disabled behind a phantom submission.
        expect(
          screen.getByRole("button", { name: "開始使用" }),
        ).not.toBeDisabled();
        // The address stays on screen via the form's own note, so declining is
        // not the same as losing the information.
        expect(screen.getByTestId("sync-code-host-note")).toHaveTextContent(
          QR_ENDPOINT,
        );
      });

      it("has still contacted nothing", async () => {
        renderQrArrival(QR_ENDPOINT, QR_TOKEN);

        fireEvent.click(await screen.findByRole("button", { name: "取消" }));

        await waitFor(() => {
          expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
        });
        await flushPendingRequests();
        expect(mockGetVerifyMethod).not.toHaveBeenCalled();
        expect(mockJoinFamily).not.toHaveBeenCalled();
        expect(mockOnAuth).not.toHaveBeenCalled();
      });

      it("lands on the form, never on a progress screen", async () => {
        renderQrArrival(QR_ENDPOINT, QR_TOKEN);

        fireEvent.click(await screen.findByRole("button", { name: "取消" }));

        await waitFor(() => {
          expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
        });
        // Refusing is not "working on it": no join was started, so the QR
        // progress screen must not appear on this exit.
        expect(screen.queryByTestId("qr-join-busy")).not.toBeInTheDocument();
      });

      /**
       * A refusal has to survive the page re-rendering. The auto-join trigger
       * is latched in a ref, so no later render may put the gate back up — let
       * alone start, behind the user's back, the requests they just declined.
       */
      it.each([
        // Same values: the everyday parent re-render.
        ["nothing has changed", {}],
        // A changed dependency is what actually re-enters the effect, so this
        // is the case where the latch is the only thing holding the refusal.
        ["the QR token has been refreshed", { qrToken: "qr-token-456" }],
      ])(
        "stays declined when the page re-renders and %s",
        async (_label, overrides) => {
          const { rerenderWith } = renderQrArrival(QR_ENDPOINT, QR_TOKEN);

          fireEvent.click(await screen.findByRole("button", { name: "取消" }));
          await waitFor(() => {
            expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
          });

          rerenderWith(overrides);
          await flushPendingRequests();

          expect(
            screen.queryByTestId("custom-host-consent"),
          ).not.toBeInTheDocument();
          expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
          expect(mockGetVerifyMethod).not.toHaveBeenCalled();
          expect(mockJoinFamily).not.toHaveBeenCalled();
          expect(mockOnAuth).not.toHaveBeenCalled();
        },
      );
    });
  });

  /**
   * A QR arrival is auto-advanced past the form, so while its join runs there
   * is no submit button left to carry a "處理中..." label — and showing the
   * form would ask someone who just scanned (or just pressed 確認並加入) to
   * type an email. The whole screen becomes the progress indicator instead.
   *
   * The screen belongs to THAT join and only to it: a flag that stayed latched
   * after a failed QR join would hijack the user's next manual submit, which is
   * why the page tracks WHICH entry point is in flight rather than a second
   * boolean beside it.
   */
  describe("progress screen while a QR join runs", () => {
    const QR_USER_ID = "d".repeat(64);
    const QR_TOKEN = "qr-token-123";

    type JoinResult = { data: { ok: boolean; authToken: string } };

    /** A join held open, so the mid-flight screen can be inspected. */
    function deferredJoin() {
      let settle!: (value: JoinResult) => void;
      const pending = new Promise<JoinResult>((resolve) => {
        settle = resolve;
      });
      return {
        pending,
        finish: () => settle({ data: { ok: true, authToken: "tok-123" } }),
      };
    }

    function renderQrArrival(apiHost: string | undefined, qrToken = "") {
      mockDecodeSyncCode.mockReturnValue({ familyId: "fam-qr", apiHost });

      render(
        <LandingPage
          onAuth={mockOnAuth}
          initialSyncCode={
            apiHost ? `moo-famqr-keyqr@${apiHost}` : "moo-famqr-keyqr"
          }
          qrUserId={QR_USER_ID}
          qrToken={qrToken}
        />,
      );
    }

    it("takes over the screen between 確認並加入 and the join finishing", async () => {
      const { pending, finish } = deferredJoin();
      mockJoinFamily.mockReturnValue(pending);

      renderQrArrival(QR_ENDPOINT, QR_TOKEN);
      fireEvent.click(
        await screen.findByRole("button", { name: "確認並加入" }),
      );

      expect(await screen.findByTestId("qr-join-busy")).toHaveTextContent(
        "處理中...",
      );
      // The form is gone, not merely disabled: this user has already answered
      // the only question the QR path asks them.
      expect(screen.queryByLabelText("同步碼")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("讀墨帳號 Email")).not.toBeInTheDocument();

      finish();
      await waitFor(() => expect(mockOnAuth).toHaveBeenCalled());
    });

    /**
     * The verification screen is ordered ahead of this one on purpose: a
     * challenge raised while the QR join is in flight has to reach the user,
     * or the join sits behind a progress screen nobody can answer.
     */
    it("yields to a challenge raised mid-join", async () => {
      // Server rejects the QR token, so the join falls back to verification.
      mockJoinFamily.mockResolvedValue({
        error: {
          code: "VERIFICATION_REQUIRED",
          message: "Verification required",
        },
      });
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pin", prompted: 1 },
      });

      renderQrArrival(QR_ENDPOINT, QR_TOKEN);
      fireEvent.click(
        await screen.findByRole("button", { name: "確認並加入" }),
      );

      await waitFor(() => {
        expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("qr-join-busy")).not.toBeInTheDocument();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    /**
     * The failure mode this whole shape exists to prevent: after a QR join
     * fails, the next attempt is the USER's own form submit, and it must be
     * reported on their submit button — not as a QR screen that swallows the
     * form they are typing into.
     */
    it("does not carry over into a manual submit after a failed QR join", async () => {
      mockJoinFamily.mockResolvedValueOnce({
        error: { code: "NOT_FOUND", message: "Family not found" },
      });

      renderQrArrival(QR_ENDPOINT, QR_TOKEN);
      fireEvent.click(
        await screen.findByRole("button", { name: "確認並加入" }),
      );

      await waitFor(() => {
        expect(screen.getByText("Family not found")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("qr-join-busy")).not.toBeInTheDocument();

      const { pending, finish } = deferredJoin();
      mockJoinFamily.mockReturnValue(pending);

      fillInput("讀墨帳號 Email", "user@example.com");
      submitForm();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "處理中..." }),
        ).toBeDisabled();
      });
      expect(screen.queryByTestId("qr-join-busy")).not.toBeInTheDocument();

      finish();
      await waitFor(() => expect(mockOnAuth).toHaveBeenCalled());
    });

    /**
     * The default endpoint has nothing to disclose, so it keeps both halves of
     * its promise: the screen changes, the interaction count does not. Neither
     * case below fires a single event.
     */
    it.each([
      ["the QR carries a token that skips verification", QR_TOKEN],
      ["the account has no verification configured", ""],
    ])(
      "stands in for the form when %s, with no click at all",
      async (_label, qrToken) => {
        const { pending, finish } = deferredJoin();
        mockJoinFamily.mockReturnValue(pending);
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "none", prompted: 1 },
        });

        renderQrArrival(undefined, qrToken);

        expect(await screen.findByTestId("qr-join-busy")).toHaveTextContent(
          "處理中...",
        );
        expect(screen.queryByLabelText("同步碼")).not.toBeInTheDocument();
        expect(
          screen.queryByTestId("custom-host-consent"),
        ).not.toBeInTheDocument();

        finish();
        await waitFor(() =>
          expect(mockOnAuth).toHaveBeenCalledWith({
            userId: QR_USER_ID,
            familyId: "fam-qr",
            apiHost: undefined,
            authToken: "tok-123",
          }),
        );
      },
    );
  });
});
