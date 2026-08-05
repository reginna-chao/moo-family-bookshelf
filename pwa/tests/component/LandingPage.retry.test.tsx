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
import { render, screen, fireEvent, act } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { LandingPage } from "@/pages/LandingPage";
import {
  buildRetryMessage,
  buildStaticRetryMessage,
} from "@/utils/retryMessage";
import type { RetryErrorCode } from "@/utils/retryMessage";
import {
  connectedDotsText,
  drawPattern,
  patternGrid,
  stubPatternGridRect,
} from "./helpers/patternGrid";

// Mock sync-code helpers (userId hashing stays real — see beforeAll)
vi.mock("@/crypto/syncCode", () => ({
  decodeSyncCode: vi.fn(),
  encodeSyncCode: vi.fn(),
  SyncCodeError: class SyncCodeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SyncCodeError";
    }
  },
}));

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

import { decodeSyncCode } from "@/crypto/syncCode";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const mockDecodeSyncCode = vi.mocked(decodeSyncCode);
const mockOnAuth = vi.fn();

/**
 * Flush pending promise chains (hashing + mocked API calls) without advancing
 * the countdown clock. `advanceTimersByTimeAsync(0)` yields to the real event
 * loop, so Web Crypto results settle without wall-clock time passing.
 */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/**
 * Poll `check` between flushes until it stops throwing. RTL's `waitFor` is not
 * usable here: it does not detect Vitest fake timers, so its own polling timer
 * would never fire.
 */
async function flushUntil(check: () => void, attempts = 40) {
  let lastError: unknown = new Error("flushUntil: check never ran");
  for (let i = 0; i < attempts; i++) {
    await flush(1);
    try {
      check();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const waitForVerificationPrompt = () =>
  flushUntil(() => expect(screen.getByText("輸入驗證碼")).toBeInTheDocument());

const waitForPinPrompt = () =>
  flushUntil(() => expect(pinField()).toBeInTheDocument());

const waitForPatternPrompt = () =>
  flushUntil(() => expect(patternGrid()).toBeInTheDocument());

const waitForAlert = () =>
  flushUntil(() => expect(screen.getByRole("alert")).toBeInTheDocument());

const waitForAuth = () =>
  flushUntil(() => expect(mockOnAuth).toHaveBeenCalled());

function fillInput(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submitForm() {
  const form = screen
    .getByRole("button", { name: /開始使用|處理中/ })
    .closest("form")!;
  fireEvent.submit(form);
}

/** Fill in the login form and submit it. */
function login() {
  fillInput("同步碼", "moo-fam1-key1");
  fillInput("讀墨帳號 Email", "user@example.com");
  submitForm();
}

const codeField = () => screen.getByPlaceholderText("6 位數驗證碼");

/** Submit a 6-digit code from the verification prompt. */
function submitVerificationCode() {
  fireEvent.change(codeField(), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "確認" }));
}

const pinField = () => screen.getByLabelText("PIN 輸入");

/** Submit a valid PIN from the PIN verification prompt. */
function submitPin() {
  fireEvent.change(pinField(), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "確認" }));
}

/** A valid (>= 4 dots) pattern for the pattern verification prompt. */
const VALID_PATTERN = [0, 1, 2, 5];

/** Sentence inside the single live region (`role="alert"`). */
function alertText(): string {
  return screen.getByRole("alert").textContent ?? "";
}

/**
 * Assert both layers of a live back-off notice: the announced sentence is the
 * countdown-free twin (announced once instead of once per tick), while the
 * ticking sentence is visible but hidden from assistive tech.
 */
function expectCountdownNotice(code: RetryErrorCode, remaining: number) {
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(alertText()).toBe(buildStaticRetryMessage(code));
  expect(screen.getByText(buildRetryMessage(code, remaining))).toHaveAttribute(
    "aria-hidden",
    "true",
  );
}

/** Assert a non-ticking error: one node is both the visible copy and the alert. */
function expectStaticNotice(message: string) {
  const alert = screen.getByRole("alert");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(alert.textContent).toBe(message);
  expect(alert).not.toHaveAttribute("aria-hidden");
}

function submitButton() {
  return screen.getByRole("button", { name: /開始使用|處理中/ });
}

function confirmButton() {
  return screen.getByRole("button", { name: /確認|驗證中/ });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Make the next login attempt succeed without verification. */
function mockSuccessfulJoin() {
  mockGetVerifyMethod.mockResolvedValue({
    data: { method: "none", prompted: 0 },
  });
  mockJoinFamily.mockResolvedValue({
    data: { ok: true, authToken: "tok-123" },
  });
}

describe("LandingPage retry back-off", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockOnAuth.mockReset();
    mockDecodeSyncCode.mockReset();
    mockJoinFamily.mockReset();
    mockGetVerifyMethod.mockReset();
    mockDecodeSyncCode.mockReturnValue({ familyId: "fam-1" });
    mockSuccessfulJoin();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("VERIFICATION_LOCKED with a retryAfter hint", () => {
    beforeEach(() => {
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
      mockJoinFamily.mockResolvedValue({
        error: {
          code: "VERIFICATION_LOCKED",
          message: "Too many attempts",
          retryAfter: 90,
        },
      });
    });

    it("drops the verification prompt and shows the countdown on the form", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();

      submitVerificationCode();
      await waitForAlert();

      expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
      expect(screen.queryByText("輸入驗證碼")).not.toBeInTheDocument();
      expectCountdownNotice("VERIFICATION_LOCKED", 90);
      expect(submitButton()).toBeDisabled();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("counts the remaining time down once per second", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      advance(1000);
      expectCountdownNotice("VERIFICATION_LOCKED", 89);

      advance(29_000);
      expectCountdownNotice("VERIFICATION_LOCKED", 60);

      advance(31_000);
      expectCountdownNotice("VERIFICATION_LOCKED", 29);
    });

    it("announces one stable sentence instead of re-announcing every tick", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      const announced = alertText();
      advance(1000);
      advance(1000);

      // Visible copy moved on; the live region did not.
      expect(
        screen.getByText(buildRetryMessage("VERIFICATION_LOCKED", 88)),
      ).toBeInTheDocument();
      expect(alertText()).toBe(announced);
      expect(announced).not.toContain("88");
    });

    it("clears the notice and re-enables submit when the countdown expires", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      advance(89_000);
      expect(submitButton()).toBeDisabled();

      advance(1000);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(submitButton()).not.toBeDisabled();
    });

    it("ignores further submit attempts while the countdown runs", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();
      const callsWhenLocked = mockJoinFamily.mock.calls.length;

      submitForm();
      await flush(10);

      expect(mockJoinFamily).toHaveBeenCalledTimes(callsWhenLocked);
      expectCountdownNotice("VERIFICATION_LOCKED", 90);
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("accepts a new submit once the countdown has expired", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      advance(90_000);

      mockSuccessfulJoin();
      submitForm();
      await waitForAuth();

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("drops the rejected code so the re-opened prompt starts empty", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      advance(90_000);
      submitForm();
      await waitForVerificationPrompt();

      expect(codeField()).toHaveValue("");
      expect(confirmButton()).toBeDisabled();
    });
  });

  describe("VERIFICATION_LOCKED without a retryAfter hint", () => {
    beforeEach(() => {
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "VERIFICATION_LOCKED", message: "Too many attempts" },
      });
    });

    it("shows the static notice and keeps submit enabled", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      expectStaticNotice(buildRetryMessage("VERIFICATION_LOCKED", 0));
      expect(submitButton()).not.toBeDisabled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the static notice on the next submit", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();
      expectStaticNotice(buildRetryMessage("VERIFICATION_LOCKED", 0));

      mockSuccessfulJoin();
      submitForm();
      await waitForAuth();

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("RATE_LIMITED with a retryAfter hint", () => {
    it("keeps the verification prompt mounted and blocks the confirm button", async () => {
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
      mockJoinFamily.mockResolvedValue({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryAfter: 45,
        },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
      expectCountdownNotice("RATE_LIMITED", 45);
      expect(confirmButton()).toBeDisabled();

      advance(45_000);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
      expect(confirmButton()).not.toBeDisabled();
    });

    it("shows the countdown on the form when no verification is pending", async () => {
      mockJoinFamily.mockResolvedValue({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryAfter: 30,
        },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForAlert();

      expectCountdownNotice("RATE_LIMITED", 30);
      expect(submitButton()).toBeDisabled();

      advance(30_000);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(submitButton()).not.toBeDisabled();
    });
  });

  describe("RATE_LIMITED with a PIN or pattern challenge", () => {
    const rateLimited = {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        retryAfter: 45,
      },
    };

    describe("PIN challenge", () => {
      beforeEach(() => {
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "pin", prompted: 1 },
        });
        mockJoinFamily.mockResolvedValue(rateLimited);
      });

      it("disables the PIN widget while the countdown runs", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPinPrompt();
        submitPin();
        await waitForAlert();

        expectCountdownNotice("RATE_LIMITED", 45);
        expect(pinField()).toBeDisabled();
        expect(confirmButton()).toBeDisabled();
      });

      it("does not re-fire the join when the PIN is re-submitted while locked", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPinPrompt();
        submitPin();
        await waitForAlert();
        const callsWhenLocked = mockJoinFamily.mock.calls.length;

        fireEvent.keyDown(pinField(), { key: "Enter" });
        fireEvent.click(confirmButton());
        await flush(10);

        expect(mockJoinFamily).toHaveBeenCalledTimes(callsWhenLocked);
        expect(mockOnAuth).not.toHaveBeenCalled();
        expectCountdownNotice("RATE_LIMITED", 45);
      });

      it("re-enables the PIN widget and accepts a retry once the countdown expires", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPinPrompt();
        submitPin();
        await waitForAlert();

        advance(45_000);

        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(pinField()).toBeEnabled();
        expect(confirmButton()).toBeEnabled();

        mockSuccessfulJoin();
        fireEvent.click(confirmButton());
        await waitForAuth();
      });
    });

    describe("pattern challenge", () => {
      let restoreRect: () => void;

      beforeEach(() => {
        restoreRect = stubPatternGridRect();
        mockGetVerifyMethod.mockResolvedValue({
          data: { method: "pattern", prompted: 1 },
        });
        mockJoinFamily.mockResolvedValue(rateLimited);
      });

      afterEach(() => {
        restoreRect();
      });

      it("dims the grid and disables 確認 while the countdown runs", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPatternPrompt();
        drawPattern(VALID_PATTERN);
        fireEvent.click(confirmButton());
        await waitForAlert();

        expectCountdownNotice("RATE_LIMITED", 45);
        expect(patternGrid()).toHaveAttribute("aria-disabled", "true");
        expect(confirmButton()).toBeDisabled();
      });

      it("ignores a redraw and does not re-fire the join while locked", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPatternPrompt();
        drawPattern(VALID_PATTERN);
        fireEvent.click(confirmButton());
        await waitForAlert();
        const callsWhenLocked = mockJoinFamily.mock.calls.length;

        drawPattern([3, 4, 5, 8]);
        fireEvent.click(confirmButton());
        await flush(10);

        expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
        expect(mockJoinFamily).toHaveBeenCalledTimes(callsWhenLocked);
        expect(mockOnAuth).not.toHaveBeenCalled();
      });

      it("re-enables the grid and accepts a retry once the countdown expires", async () => {
        render(<LandingPage onAuth={mockOnAuth} />);

        login();
        await waitForPatternPrompt();
        drawPattern(VALID_PATTERN);
        fireEvent.click(confirmButton());
        await waitForAlert();

        advance(45_000);

        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(patternGrid()).not.toHaveAttribute("aria-disabled");
        expect(confirmButton()).toBeEnabled();

        mockSuccessfulJoin();
        fireEvent.click(confirmButton());
        await waitForAuth();
      });
    });
  });

  describe("RATE_LIMITED without a retryAfter hint", () => {
    it("falls back to the generic error copy and arms no countdown", async () => {
      mockJoinFamily.mockResolvedValue({
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForAlert();

      expectStaticNotice("Too many requests");
      expect(submitButton()).not.toBeDisabled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("non-back-off errors while a challenge is open", () => {
    beforeEach(() => {
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
    });

    it("shows a quota error with no retryAfter hint on the open prompt", async () => {
      mockJoinFamily.mockResolvedValue({
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
      expectStaticNotice("Too many requests");
      expect(confirmButton()).toBeEnabled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("shows a non-verification failure on the open prompt", async () => {
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      expect(screen.getByText("輸入驗證碼")).toBeInTheDocument();
      expectStaticNotice("Family not found");
      expect(mockOnAuth).not.toHaveBeenCalled();
    });

    it("falls back to the generic join copy when the error carries no message", async () => {
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_NOT_FOUND" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForVerificationPrompt();
      submitVerificationCode();
      await waitForAlert();

      expectStaticNotice("加入家庭失敗，請重試。");
    });

    it("shows the failure on an open PIN prompt", async () => {
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "pin", prompted: 1 },
      });
      mockJoinFamily.mockResolvedValue({
        error: { code: "FAMILY_NOT_FOUND", message: "Family not found" },
      });

      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForPinPrompt();
      submitPin();
      await waitForAlert();

      expect(pinField()).toBeInTheDocument();
      expectStaticNotice("Family not found");
      expect(pinField()).toBeEnabled();
    });
  });

  describe("timer hygiene", () => {
    beforeEach(() => {
      mockJoinFamily.mockResolvedValue({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryAfter: 60,
        },
      });
    });

    it("leaves no running interval after the countdown expires", async () => {
      render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForAlert();
      expect(vi.getTimerCount()).toBe(1);

      advance(60_000);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the countdown interval on unmount", async () => {
      const { unmount } = render(<LandingPage onAuth={mockOnAuth} />);

      login();
      await waitForAlert();
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
