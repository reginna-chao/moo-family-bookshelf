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

/**
 * #266 REGRESSION, end to end through App and the REAL LandingPage.
 *
 * A member with PWA-login verification leaves the family on another device.
 * The PWA's silent recovery join is answered VERIFICATION_REQUIRED, so App logs
 * out and asks for re-verification. The landing re-login used to be a plain
 * join, and the Worker re-added the departed user. It must now carry
 * `recovery: 1` for that same identity, show a landing explanation on 409
 * RECOVERY_NOT_MEMBER without logging anyone in, and let the NEXT submit be an
 * explicit (non-recovery) re-join.
 *
 * Only `useAuth` (the hook — its module exports stay real), the ApiClient and
 * the signed-in pages are mocked; the sync-code pre-fill, the userId hash, the
 * verification screen and the join choke point all run production code.
 */

const mockLogin = vi.fn();
const mockLogout = vi.fn();
const mockForceLogout = vi.fn();
let mockAuth: Record<string, unknown> | null = null;

vi.mock("@/hooks/useAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAuth")>();
  return {
    ...actual,
    useAuth: () => ({
      auth: mockAuth,
      isLoading: false,
      login: mockLogin,
      logout: mockLogout,
      forceLogout: mockForceLogout,
      initialSyncCode: "",
      qrUserId: "",
      qrToken: "",
    }),
  };
});

const { mockJoinFamily, mockGetVerifyMethod } = vi.hoisted(() => ({
  mockJoinFamily: vi.fn(),
  mockGetVerifyMethod: vi.fn(),
}));

vi.mock("@/api/client", () => {
  class MockApiClient {
    setAuthToken = vi.fn();
    setTokenRefresher = vi.fn();
    getEndpoint = vi.fn().mockReturnValue("https://api.example.com");
    setEndpoint = vi.fn();
    joinFamily = mockJoinFamily;
    getVerifyMethod = mockGetVerifyMethod;
    setVerifyMethod = vi.fn().mockResolvedValue({ data: { ok: true } });
    markVerifyPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
  }
  return { ApiClient: MockApiClient };
});

vi.mock("@/pages/FamilyShelfPage", () => ({
  FamilyShelfPage: () => <div data-testid="family-shelf-page" />,
}));
vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: () => <div data-testid="personal-shelf-page" />,
}));
vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));
vi.mock("@/components/InstallPrompt", () => ({ InstallPrompt: () => null }));
vi.mock("@/components/VersionWarning", () => ({ VersionWarning: () => null }));
vi.mock("@/hooks/useFamilyData", () => ({
  FamilyDataProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useFamilyData: () => ({
    members: [],
    hasBookshelfUpdates: false,
    markBookshelfSeen: vi.fn(),
  }),
}));

import React from "react";
import App from "@/App";
import {
  REMEMBER_SYNC_CODE_KEY,
  REMEMBERED_LOGOUT_KEY,
  USER_ID_KEY,
} from "@/hooks/useAuth";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  JOIN_BLOCKED_MESSAGES,
  RECOVERY_NOT_MEMBER_LANDING_MESSAGE,
  REVERIFY_LOGOUT_MESSAGE,
} from "@/utils/joinErrorMessages";
import { REAUTH_PENDING_KEY } from "@/utils/reauthPending";
import { RECOVERY_COOLDOWN_UNTIL_KEY } from "@/utils/recoveryCooldown";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const EMAIL = "test@test.com";
/** sha256("moo:test@test.com") — the literal LandingPage.test.tsx pins, so the re-login below
 *  derives the SAME userId the stored session holds. */
const USER_ID =
  "fb665feb4ce879ca70bcd4bb4358b56daceb33815ef832461ced74b23c3c25eb";
/** Two dash-separated parts, so `encodeSyncCode` → `decodeSyncCode` round-trips. */
const FAMILY_ID = "fam-001";
/** No apiHost and no authToken: the auto-acquire effect runs the recovery join. */
const SESSION = { userId: USER_ID, familyId: FAMILY_ID, encryptionKey: "k" };
const OTP = "123456";

function setMockSession(next: Record<string, unknown> | null): void {
  mockAuth = next;
  if (next) localStorage.setItem(USER_ID_KEY, next.userId as string);
  else localStorage.removeItem(USER_ID_KEY);
}

function clearSuiteStorageKeys(): void {
  for (const key of [
    REAUTH_PENDING_KEY,
    REMEMBERED_LOGOUT_KEY,
    REMEMBER_SYNC_CODE_KEY,
    RECOVERY_COOLDOWN_UNTIL_KEY,
    USER_ID_KEY,
  ]) {
    localStorage.removeItem(key);
  }
}

/** Submit the landing form, then answer the "code" challenge with the OTP. */
async function submitAndVerify(): Promise<void> {
  const form = screen
    .getByRole("button", { name: "開始使用" })
    .closest("form")!;
  fireEvent.submit(form);
  const otp = await screen.findByPlaceholderText("6 位數驗證碼");
  fireEvent.change(otp, { target: { value: OTP } });
  fireEvent.click(screen.getByRole("button", { name: "確認" }));
}

describe("App re-login after a forced re-verification (#266)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSuiteStorageKeys();
    window.location.hash = "";
    setMockSession(null);
    mockLogout.mockImplementation(() => setMockSession(null));
    mockLogin.mockImplementation((next: Record<string, unknown>) =>
      setMockSession(next),
    );
    // prompted: 1 keeps the signed-in VerifySetupPrompt out of the way.
    mockGetVerifyMethod.mockResolvedValue({
      data: { method: "code", prompted: 1 },
    });
  });

  afterEach(async () => {
    await act(async () => {});
    vi.restoreAllMocks();
    clearSuiteStorageKeys();
  });

  /** Render the token-less session; its recovery join needs re-verification. */
  async function renderForcedLogout(): Promise<void> {
    mockJoinFamily.mockResolvedValueOnce({
      error: { code: "VERIFICATION_REQUIRED", message: "stub" },
    });
    setMockSession({ ...SESSION });
    await act(async () => {
      render(<App />);
    });

    // The forced logout really happened, with the sync code pre-filled and the
    // marker written, before the user starts typing.
    await waitFor(() => {
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).not.toBeNull();
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockJoinFamily).toHaveBeenNthCalledWith(1, FAMILY_ID, USER_ID, {
      recovery: BoolFlag.TRUE,
    });
    expect(screen.getByText(REVERIFY_LOGOUT_MESSAGE)).toBeInTheDocument();
    expect((screen.getByLabelText("同步碼") as HTMLInputElement).value).toBe(
      `moo-${FAMILY_ID}`,
    );
    fireEvent.change(screen.getByLabelText("讀墨帳號 Email"), {
      target: { value: EMAIL },
    });
  }

  it("refuses the re-login of a user who left meanwhile, then lets the next submit re-join explicitly", async () => {
    await renderForcedLogout();
    mockJoinFamily.mockResolvedValueOnce({
      error: { code: "RECOVERY_NOT_MEMBER", message: "Not a member" },
    });

    await submitAndVerify();

    // The re-login for the SAME identity is flagged as recovery.
    await waitFor(() => {
      expect(mockJoinFamily).toHaveBeenCalledTimes(2);
    });
    expect(mockJoinFamily).toHaveBeenNthCalledWith(
      2,
      FAMILY_ID,
      USER_ID,
      expect.objectContaining({ verifySecret: OTP, recovery: BoolFlag.TRUE }),
    );

    // Back on the form with the landing explanation; nobody is logged in.
    const message = await screen.findByText(
      RECOVERY_NOT_MEMBER_LANDING_MESSAGE,
    );
    expect(message.textContent).toBe(RECOVERY_NOT_MEMBER_LANDING_MESSAGE);
    expect(
      screen.queryByText(JOIN_BLOCKED_MESSAGES.get("RECOVERY_NOT_MEMBER")!),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("輸入驗證碼")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("6 位數驗證碼"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("同步碼")).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();

    // The second submit is the user's explicit re-join: no recovery flag.
    mockJoinFamily.mockResolvedValueOnce({
      data: { ok: true, authToken: "tok-new" },
    });
    await submitAndVerify();

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
    expect(mockJoinFamily).toHaveBeenCalledTimes(3);
    const [familyId, userId, opts] = mockJoinFamily.mock.calls[2];
    expect([familyId, userId]).toEqual([FAMILY_ID, USER_ID]);
    expect(opts).toMatchObject({ verifySecret: OTP });
    expect(opts).not.toHaveProperty("recovery");
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        familyId: FAMILY_ID,
        authToken: "tok-new",
      }),
    );
  });

  it("logs a still-listed member back in through the recovery re-login and clears the marker", async () => {
    await renderForcedLogout();
    mockJoinFamily.mockResolvedValueOnce({
      data: { ok: true, authToken: "tok-again" },
    });

    await submitAndVerify();

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
    expect(mockJoinFamily).toHaveBeenNthCalledWith(
      2,
      FAMILY_ID,
      USER_ID,
      expect.objectContaining({ verifySecret: OTP, recovery: BoolFlag.TRUE }),
    );
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, authToken: "tok-again" }),
    );
    expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
  });
});
