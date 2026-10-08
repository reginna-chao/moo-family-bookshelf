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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";

/**
 * LandingPage × the forced-re-verification marker (#266).
 *
 * The marker is seeded through production's own `markReauthPending`, then the
 * real form decodes a typed sync code, hashes the email and joins. Only the
 * ApiClient is mocked. The end-to-end regression (App writes the marker, the
 * landing re-login reads it) lives in `App.reauthRelogin.test.tsx`; this file
 * covers WHICH logins count as the same identity and what the marker does on
 * the other join outcomes.
 */

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

import { LandingPage } from "@/pages/LandingPage";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";
import { RECOVERY_NOT_MEMBER_LANDING_MESSAGE } from "@/utils/joinErrorMessages";
import {
  REAUTH_PENDING_KEY,
  isReauthPendingFor,
  markReauthPending,
  type ReauthIdentity,
} from "@/utils/reauthPending";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

/** Literal userIds as LandingPage.test.tsx pins them: sha256("moo:test@test.com") and deriveUserId(
 *  "user@example.com"); hard-coded so a match really means "the form derived the marked user's id". */
const EMAIL = "test@test.com";
const USER_ID =
  "fb665feb4ce879ca70bcd4bb4358b56daceb33815ef832461ced74b23c3c25eb";
const OTHER_EMAIL = "user@example.com";
const FAMILY_ID = "fam-001";
const CUSTOM_ENDPOINT = "https://custom.api.com";

/** The marked identity: the default server, as a stored session holds it. */
const MARKED: ReauthIdentity = { familyId: FAMILY_ID, userId: USER_ID };

const mockOnAuth = vi.fn();

function login(syncCode: string, email: string): void {
  fireEvent.change(screen.getByLabelText("同步碼"), {
    target: { value: syncCode },
  });
  fireEvent.change(screen.getByLabelText("讀墨帳號 Email"), {
    target: { value: email },
  });
  const form = screen
    .getByRole("button", { name: /開始使用|處理中/ })
    .closest("form")!;
  fireEvent.submit(form);
}

/** Options object of the n-th (0-based) joinFamily call. */
function joinOpts(n = 0): Record<string, unknown> {
  return mockJoinFamily.mock.calls[n][2] as Record<string, unknown>;
}

describe("LandingPage re-login after a forced re-verification", () => {
  beforeEach(() => {
    mockOnAuth.mockReset();
    mockJoinFamily.mockReset();
    mockGetVerifyMethod.mockReset();
    mockGetVerifyMethod.mockResolvedValue({
      data: { method: "none", prompted: 1 },
    });
    mockJoinFamily.mockResolvedValue({ data: { ok: true, authToken: "tok" } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(REAUTH_PENDING_KEY);
    localStorage.removeItem(REMEMBER_SYNC_CODE_KEY);
  });

  describe("the same identity", () => {
    it.each([
      ["with no @host", `moo-${FAMILY_ID}`],
      [
        "with the default server spelled out",
        `moo-${FAMILY_ID}@${DEFAULT_API_ENDPOINT}`,
      ],
      [
        "with the default server and a trailing slash",
        `moo-${FAMILY_ID}@${DEFAULT_API_ENDPOINT}/`,
      ],
    ])("sends the join flagged as recovery %s", async (_label, code) => {
      await markReauthPending(MARKED);
      render(<LandingPage onAuth={mockOnAuth} />);

      login(code, EMAIL);

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(mockJoinFamily.mock.calls[0][0]).toBe(FAMILY_ID);
      expect(mockJoinFamily.mock.calls[0][1]).toBe(USER_ID);
      expect(joinOpts().recovery).toBe(BoolFlag.TRUE);
      // A successful join spends the marker.
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });

    it("matches a custom server written with a trailing slash in the code", async () => {
      await markReauthPending({ ...MARKED, apiHost: CUSTOM_ENDPOINT });
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}@${CUSTOM_ENDPOINT}/`, EMAIL);

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(joinOpts().recovery).toBe(BoolFlag.TRUE);
    });

    it("keeps the marker after a wrong secret, so the retry is still a recovery join", async () => {
      await markReauthPending(MARKED);
      mockGetVerifyMethod.mockResolvedValue({
        data: { method: "code", prompted: 1 },
      });
      mockJoinFamily
        .mockResolvedValueOnce({
          error: { code: "VERIFICATION_FAILED", message: "Wrong code" },
        })
        .mockResolvedValueOnce({ data: { ok: true, authToken: "tok" } });
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}`, EMAIL);
      const otp = await screen.findByPlaceholderText("6 位數驗證碼");
      fireEvent.change(otp, { target: { value: "111111" } });
      fireEvent.click(screen.getByRole("button", { name: "確認" }));
      await screen.findByText("驗證失敗，請重新輸入。");
      expect(await isReauthPendingFor(MARKED)).toBe(true);

      fireEvent.change(screen.getByPlaceholderText("6 位數驗證碼"), {
        target: { value: "222222" },
      });
      fireEvent.click(screen.getByRole("button", { name: "確認" }));

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(joinOpts(0)).toMatchObject({
        verifySecret: "111111",
        recovery: BoolFlag.TRUE,
      });
      expect(joinOpts(1)).toMatchObject({
        verifySecret: "222222",
        recovery: BoolFlag.TRUE,
      });
    });
  });

  describe("a different identity", () => {
    it.each([
      ["another account (email)", `moo-${FAMILY_ID}`, OTHER_EMAIL],
      ["another family", "moo-fam-002", EMAIL],
      ["another server", `moo-${FAMILY_ID}@${CUSTOM_ENDPOINT}`, EMAIL],
    ])("sends no recovery key at all for %s", async (_label, code, email) => {
      await markReauthPending(MARKED);
      render(<LandingPage onAuth={mockOnAuth} />);

      login(code, email);

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(joinOpts()).not.toHaveProperty("recovery");
    });

    it("keeps the marked user's marker after another account logs in successfully", async () => {
      await markReauthPending(MARKED);
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}`, OTHER_EMAIL);

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(joinOpts()).not.toHaveProperty("recovery");
      // Shared device: the marked user's later re-login must still be a recovery join.
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).not.toBeNull();
      expect(await isReauthPendingFor(MARKED)).toBe(true);
    });

    it("shows the server's own message on RECOVERY_NOT_MEMBER and leaves the marker alone", async () => {
      await markReauthPending(MARKED);
      mockJoinFamily.mockResolvedValue({
        error: { code: "RECOVERY_NOT_MEMBER", message: "Server says no" },
      });
      render(<LandingPage onAuth={mockOnAuth} />);

      login("moo-fam-002", EMAIL);

      expect(await screen.findByText("Server says no")).toBeInTheDocument();
      expect(
        screen.queryByText(RECOVERY_NOT_MEMBER_LANDING_MESSAGE),
      ).not.toBeInTheDocument();
      expect(await isReauthPendingFor(MARKED)).toBe(true);
    });
  });

  /** Shared device (#266 review): B's forced logout came AFTER A's. The marker key holds a set, so A's
   *  re-login is still a recovery join, and spending A's marker must leave B's for B's own later re-login. */
  describe("with another identity also awaiting re-verification", () => {
    /** Another account in another family, signed out after the marked one. */
    const SECOND: ReauthIdentity = {
      familyId: "fam-002",
      userId: "1".repeat(64),
    };

    async function seedBoth(): Promise<void> {
      await markReauthPending(MARKED);
      await markReauthPending(SECOND);
      // Positive companion: both really are pending before A logs in.
      expect(await isReauthPendingFor(MARKED)).toBe(true);
      expect(await isReauthPendingFor(SECOND)).toBe(true);
    }

    it("refuses the first-marked user's re-login on RECOVERY_NOT_MEMBER and keeps the other marker", async () => {
      await seedBoth();
      mockJoinFamily.mockResolvedValue({
        error: { code: "RECOVERY_NOT_MEMBER", message: "Server says no" },
      });
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}`, EMAIL);

      const message = await screen.findByText(
        RECOVERY_NOT_MEMBER_LANDING_MESSAGE,
      );
      expect(message.textContent).toBe(RECOVERY_NOT_MEMBER_LANDING_MESSAGE);
      expect(screen.queryByText("Server says no")).not.toBeInTheDocument();
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(mockJoinFamily.mock.calls[0][0]).toBe(FAMILY_ID);
      expect(mockJoinFamily.mock.calls[0][1]).toBe(USER_ID);
      expect(joinOpts().recovery).toBe(BoolFlag.TRUE);
      expect(mockOnAuth).not.toHaveBeenCalled();
      expect(await isReauthPendingFor(MARKED)).toBe(false);
      expect(await isReauthPendingFor(SECOND)).toBe(true);
    });

    it("logs the first-marked user back in through a recovery join and keeps the other marker", async () => {
      await seedBoth();
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}`, EMAIL);

      await waitFor(() => {
        expect(mockOnAuth).toHaveBeenCalledTimes(1);
      });
      expect(mockOnAuth).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, familyId: FAMILY_ID }),
      );
      expect(joinOpts().recovery).toBe(BoolFlag.TRUE);
      expect(await isReauthPendingFor(MARKED)).toBe(false);
      expect(await isReauthPendingFor(SECOND)).toBe(true);
    });
  });

  describe("without a marker", () => {
    it("treats RECOVERY_NOT_MEMBER like any other server error", async () => {
      mockJoinFamily.mockResolvedValue({
        error: { code: "RECOVERY_NOT_MEMBER", message: "Server says no" },
      });
      render(<LandingPage onAuth={mockOnAuth} />);

      login(`moo-${FAMILY_ID}`, EMAIL);

      expect(await screen.findByText("Server says no")).toBeInTheDocument();
      expect(joinOpts()).not.toHaveProperty("recovery");
      expect(
        screen.queryByText(RECOVERY_NOT_MEMBER_LANDING_MESSAGE),
      ).not.toBeInTheDocument();
      expect(mockOnAuth).not.toHaveBeenCalled();
    });
  });
});
