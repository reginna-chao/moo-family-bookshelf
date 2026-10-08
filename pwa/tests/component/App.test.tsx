import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  renderHook,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";

/**
 * PWA App: routing between landing and signed-in pages, the ApiClient lifecycle, and the token
 * refresher's recovery join (acquireNewToken) — its failures, a session change mid-join, and the
 * user's own leave in flight.
 *
 * Session mirror: setMockSession sets the session the mocked useAuth returns AND mirrors production's
 * synchronous storage write — login stores USER_ID_KEY, logout removes it. App's #258 guard
 * (`isLiveSession`) reads that key after the recovery join, so the two must never disagree outside a
 * test that splits them on purpose. Production logout() / forceLogout() drop the stored session, and
 * mirroring that is what lets LandingPage render on the branches that DO log out; the mocks are
 * registered per test, after vi.clearAllMocks() (afterEach's vi.restoreAllMocks() wipes them), so no
 * implementation leaks between tests.
 *
 * Terminal codes: TERMINAL_CODES are the codes JOIN_BLOCKED_MESSAGES marks terminal — retrying the
 * recovery join cannot succeed, so the stored session really is unrecoverable and the logout is
 * earned. They are spelled out rather than derived from the map, so a NEW terminal code cannot ship
 * without a rendered case (see the tripwire next to them).
 *
 * Terminal failure: App logs out AND hands LandingPage a reason, instead of dropping the user at a bare
 * login form wondering why the session evaporated. MEMBER_REMOVED is the sharpest case — the owner
 * removed this member, so the server's kicked tombstone refuses the recovery join. The mocked
 * LandingPage is a pass-through for `externalError` (it renders whatever App hands it verbatim), and
 * the expected copy is read from JOIN_BLOCKED_MESSAGES in `pwa/src/utils/joinErrorMessages.ts`, the
 * very map App looks the code up in (with `.get`), so the assertion is production-anchored end to
 * end: the code must resolve to THAT entry and reach the render site. The wording itself is
 * additionally pinned verbatim on the manual-join side by `pwa/tests/component/LandingPage.test.tsx`.
 *
 * Prototype-chain codes: `error.code` arrives straight off the wire from a backend that may be
 * self-hosted, buggy, or hostile, so a code naming an `Object.prototype` member is a reachable input.
 * Looked up in a Map it is simply an unknown code — nothing to explain, session kept — i.e. it must
 * behave exactly like INVALID_TOKEN. Regression guard for the object-literal table this Map replaced,
 * where the lookup answered off the prototype chain: `__proto__` returned `Object.prototype`, and
 * rendering that object as a React child took the whole PWA down (there is no ErrorBoundary); the
 * function-valued members (`toString` / `constructor` / `valueOf` / `hasOwnProperty`) reached
 * `setLandingError`, which treats a function as a state UPDATER — so they either threw inside the
 * state update or put the updater's return value on screen as the "reason" for a logout that was
 * never earned. The render itself is the crash assertion — `renderWithFailedJoin` renders inside
 * `act`, so a React child error surfaces as a test failure there.
 *
 * Session change mid-join (#258): a 401 refresh awaits the recovery join. If the session ends
 * (logout) or switches (another user) while that join is in flight, its result belongs to a session
 * that no longer exists: a success must not re-login the old session, and a terminal failure must not
 * log out — or explain a logout to — the session that replaced it. The same-session success path is
 * pinned by "keeps the same ApiClient instance when a 401 refresh stores a new token". The window
 * `isSameSession` alone misses: a logout issued after an await (leave family / delete account) removes
 * USER_ID_KEY synchronously, but React re-renders one task later, so `authRef` still holds session A
 * when the join answers; its positive companion (key present → login runs) is that same test.
 *
 * Own leave in flight (#263 REGRESSION): the server can revoke the user's token before it answers
 * their own "leave family" request, so another request of theirs 401s while the leave is in flight —
 * and App's silent recovery join then re-added them to the family they were leaving. The real
 * `useLeaveFamily` drives the leave (its request held pending), and the refresher App registered on
 * the session client is the path ApiClient takes on that 401. Review S1: the guarded leave 401s, its
 * unguarded resend 401s too, and the recovery join that 401 triggers needs re-verification;
 * ApiClient is mocked here, so the resend stub runs the registered refresher itself, mirroring
 * `doRequest`'s 401 branch (refresher → null → the 401 envelope comes back).
 */

// Mock useAuth hook
const mockLogin = vi.fn();
const mockLogout = vi.fn();
const mockForceLogout = vi.fn();
let mockAuth: Record<string, unknown> | null = null;
let mockIsLoading = false;

// Keep the module's real exports (REMEMBER_SYNC_CODE_KEY, REMEMBERED_LOGOUT_KEY, namespacedKey, ...)
// so App's sync-code-remember branch uses production's localStorage keys; only the hook is replaced.
vi.mock("@/hooks/useAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAuth")>();
  return {
    ...actual,
    useAuth: () => ({
      auth: mockAuth,
      isLoading: mockIsLoading,
      login: mockLogin,
      logout: mockLogout,
      forceLogout: mockForceLogout,
      initialSyncCode: "",
      qrUserId: "",
      qrToken: "",
    }),
  };
});

// Shared mock for joinFamily — can be overridden per test
const mockJoinFamily = vi
  .fn()
  .mockResolvedValue({ data: { authToken: "new-token" } });

// Mock API client using class syntax to ensure proper prototype chain
vi.mock("@/api/client", () => {
  class MockApiClient {
    setAuthToken = vi.fn();
    setTokenRefresher = vi.fn();
    getEndpoint = vi.fn().mockReturnValue("https://api.example.com");
    setEndpoint = vi.fn();
    joinFamily = mockJoinFamily;
    getVerifyMethod = vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 1 } });
    setVerifyMethod = vi.fn().mockResolvedValue({ data: { ok: true } });
    markVerifyPrompted = vi.fn().mockResolvedValue({ data: { ok: true } });
  }
  return { ApiClient: MockApiClient };
});

// Mock pages. LandingPage passes `externalError` through verbatim, so terminal-failure tests assert
// on JOIN_BLOCKED_MESSAGES' copy, not an invented string. See the header → "Terminal failure".
vi.mock("@/pages/LandingPage", () => ({
  LandingPage: ({
    onAuth,
    externalError,
  }: {
    onAuth: (data: unknown) => void;
    externalError?: string;
  }) => (
    <div data-testid="landing-page">
      {externalError ? (
        <p data-testid="landing-external-error">{externalError}</p>
      ) : null}
      <button
        onClick={() =>
          onAuth({ userId: "u1", familyId: "f1", encryptionKey: "k1" })
        }
      >
        Login
      </button>
    </div>
  ),
}));

vi.mock("@/pages/FamilyShelfPage", () => ({
  FamilyShelfPage: () => (
    <div data-testid="family-shelf-page">Family Shelf</div>
  ),
}));

// Every apiClient prop PersonalShelfPage renders with, in order — the real
// page keys its book load on `[apiClient]`, so a new identity means a reload.
const personalShelfClients: unknown[] = [];

vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: ({ apiClient }: { apiClient: unknown }) => {
    personalShelfClients.push(apiClient);
    return <div data-testid="personal-shelf-page">Personal Shelf</div>;
  },
}));

vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page">Settings</div>,
}));

vi.mock("@/components/InstallPrompt", () => ({
  InstallPrompt: () => null,
}));

vi.mock("@/components/VersionWarning", () => ({
  VersionWarning: () => null,
}));

vi.mock("@/hooks/useFamilyData", () => ({
  FamilyDataProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useFamilyData: () => ({
    members: [],
    ownerId: "",
    membersState: "ready",
    membersError: "",
    familyEndpoint: undefined,
    bookshelfMembers: [],
    bookshelfState: "ready",
    bookshelfError: "",
    refreshMembers: vi.fn(),
    refreshBookshelf: vi.fn(),
    updateMemberDisplayName: vi.fn(),
    updatedBookIds: new Set(),
    hasBookshelfUpdates: false,
    markBookshelfSeen: vi.fn(),
  }),
}));

import React from "react";
import App from "@/App";
// The useAuth mock factory spreads the actual module, so these are the real
// production key literals, not mock copies (anti-drift: import from production).
import {
  REMEMBER_SYNC_CODE_KEY,
  REMEMBERED_LOGOUT_KEY,
  USER_ID_KEY,
} from "@/hooks/useAuth";
import { RECOVERY_COOLDOWN_UNTIL_KEY } from "@/utils/recoveryCooldown";
import {
  REAUTH_PENDING_KEY,
  isReauthPendingFor,
  markReauthPending,
} from "@/utils/reauthPending";
import { decodeSyncCode } from "@/crypto/syncCode";
// The terminal-failure copy under test is production's own — App resolves it from this map with
// `.get`, so the assertions cannot drift from `pwa/src/utils/joinErrorMessages.ts`.
import {
  JOIN_BLOCKED_MESSAGES,
  REVERIFY_LOGOUT_MESSAGE,
} from "@/utils/joinErrorMessages";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { useLeaveFamily } from "@/hooks/useLeaveFamily";
import {
  isSelfDepartureActive,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";
import type { ApiClient } from "@/api/client";

/** localStorage keys this suite touches — cleared around every test. */
function clearSuiteStorageKeys() {
  localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  localStorage.removeItem(RECOVERY_COOLDOWN_UNTIL_KEY);
  localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
  localStorage.removeItem(REMEMBER_SYNC_CODE_KEY);
  localStorage.removeItem(USER_ID_KEY);
  localStorage.removeItem(REAUTH_PENDING_KEY);
}

/** Set the session the mocked useAuth returns AND mirror production's synchronous USER_ID_KEY write.
 *  See the header → "Session mirror". */
function setMockSession(next: Record<string, unknown> | null): void {
  mockAuth = next;
  if (next) {
    localStorage.setItem(USER_ID_KEY, next.userId as string);
  } else {
    localStorage.removeItem(USER_ID_KEY);
  }
}

describe("App", () => {
  beforeEach(() => {
    setMockSession(null);
    mockIsLoading = false;
    window.location.hash = "";
    clearSuiteStorageKeys();
    personalShelfClients.length = 0;
    vi.clearAllMocks();
    mockJoinFamily.mockResolvedValue({ data: { authToken: "new-token" } });
    // Production logout() / forceLogout() drop the stored session; registered per test so no
    // implementation leaks between tests. See the header → "Session mirror".
    mockLogout.mockImplementation(() => setMockSession(null));
    mockForceLogout.mockImplementation(() => setMockSession(null));
  });

  afterEach(async () => {
    // Flush pending async effects (token acquisition, etc.) before cleanup
    await act(async () => {});
    vi.restoreAllMocks();
    clearSuiteStorageKeys();
  });

  it("preserves page hash on refresh (does not redirect to family-shelf)", () => {
    // Simulate: user was on personal-shelf, then refreshed the page.
    // On refresh, hash is #personal-shelf and auth restores from localStorage.
    window.location.hash = "#personal-shelf";

    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    });
    render(<App />);

    // Should stay on personal-shelf, not redirect to family-shelf
    expect(screen.getByTestId("personal-shelf-page")).toBeInTheDocument();
    expect(screen.queryByTestId("family-shelf-page")).not.toBeInTheDocument();
  });

  it("preserves settings page hash on refresh", () => {
    window.location.hash = "#settings";

    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    });
    render(<App />);

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("family-shelf-page")).not.toBeInTheDocument();
  });

  it("shows loading state when isLoading is true", () => {
    mockIsLoading = true;
    render(<App />);
    expect(screen.getByText("載入中...")).toBeInTheDocument();
  });

  it("shows landing page when not authenticated", () => {
    setMockSession(null);
    render(<App />);
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
  });

  it("shows main view with navigation when authenticated", () => {
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      apiHost: "https://api.example.com",
      authToken: "token-123",
    });
    render(<App />);

    // Default page is family shelf
    expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    // Navigation bar visible
    expect(
      screen.getByRole("navigation", { name: "主要導覽" }),
    ).toBeInTheDocument();
  });

  it("navigates between tabs", async () => {
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    });
    render(<App />);

    // Default: family shelf
    expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();

    // Navigate to personal shelf
    fireEvent.click(screen.getByRole("button", { name: "個人書櫃" }));
    expect(screen.getByTestId("personal-shelf-page")).toBeInTheDocument();
    expect(screen.queryByTestId("family-shelf-page")).not.toBeInTheDocument();

    // Navigate to settings
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("personal-shelf-page")).not.toBeInTheDocument();

    // Navigate back to family shelf
    fireEvent.click(screen.getByRole("button", { name: "家庭書櫃" }));
    expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
  });

  it("highlights current tab with aria-current", () => {
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    });
    render(<App />);

    const familyBtn = screen.getByRole("button", { name: "家庭書櫃" });
    const personalBtn = screen.getByRole("button", { name: "個人書櫃" });

    expect(familyBtn).toHaveAttribute("aria-current", "page");
    expect(personalBtn).not.toHaveAttribute("aria-current");

    fireEvent.click(personalBtn);
    expect(personalBtn).toHaveAttribute("aria-current", "page");
    expect(familyBtn).not.toHaveAttribute("aria-current");
  });

  it("auto-acquires token when auth exists but authToken is missing", async () => {
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      // No authToken — triggers acquireNewToken
    });

    await act(async () => {
      render(<App />);
    });

    // After token acquisition completes, should show main view
    await waitFor(() => {
      expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    });
    // The acquired token was really stored for this session, not dropped.
    expect(mockJoinFamily).toHaveBeenCalledTimes(1);
    // A silent recovery join is flagged, so the server can refuse a user who is
    // no longer listed (#263) instead of re-adding them.
    expect(mockJoinFamily).toHaveBeenCalledWith(
      "fam-001",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      { recovery: BoolFlag.TRUE },
    );
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        familyId: "fam-001",
        authToken: "new-token",
      }),
    );
  });

  /** #256: a 401 refresh stores a new token via `login`; swapping the ApiClient would re-run every
   *  `[apiClient]`-keyed load and wipe unsaved share toggles, so the token moves onto the SAME instance. */
  it("keeps the same ApiClient instance when a 401 refresh stores a new token", async () => {
    window.location.hash = "#personal-shelf";
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "old-token",
    });
    // Production login() stores the new session; mirror it for the rerender.
    mockLogin.mockImplementation((next: Record<string, unknown>) => {
      setMockSession(next);
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<App />);
    });
    const before = personalShelfClients.at(-1) as {
      setAuthToken: ReturnType<typeof vi.fn>;
      setTokenRefresher: ReturnType<typeof vi.fn>;
    };
    expect(before).toBeDefined();

    // Run the refresher App registered — the path ApiClient takes on a 401.
    const refresh = before.setTokenRefresher.mock.calls[0][0] as () => Promise<
      string | null
    >;
    await act(async () => {
      await expect(refresh()).resolves.toBe("new-token");
    });
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: "new-token" }),
    );
    const rendersBefore = personalShelfClients.length;
    await act(async () => {
      view.rerender(<App />);
    });

    // The page really re-rendered with the new session, and got the same client.
    expect(personalShelfClients.length).toBeGreaterThan(rendersBefore);
    expect(personalShelfClients.at(-1)).toBe(before);
    expect(before.setAuthToken).toHaveBeenLastCalledWith("new-token");
  });

  /** PR #260 review: nulling the session client's token on logout sent the family-shelf prefs unmount
   *  flush unauthenticated. The pages' client keeps its token; the logged-out view gets its own. */
  it("does not clear the token on the ApiClient the pages held when the user logs out", async () => {
    window.location.hash = "#personal-shelf";
    setMockSession({
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    });

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<App />);
    });
    const held = personalShelfClients.at(-1) as {
      setAuthToken: ReturnType<typeof vi.fn>;
    };
    expect(held.setAuthToken).toHaveBeenCalledWith("token-123");

    setMockSession(null);
    await act(async () => {
      view.rerender(<App />);
    });

    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    expect(held.setAuthToken).not.toHaveBeenCalledWith(null);
  });

  describe("acquireNewToken join failures", () => {
    // No authToken — every render triggers acquireNewToken via the
    // auto-acquire effect
    const AUTH_WITHOUT_TOKEN = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
    };

    /** The codes JOIN_BLOCKED_MESSAGES marks terminal, spelled out so a new one cannot ship without a
     *  rendered case (tripwire below). See the header → "Terminal codes". */
    const TERMINAL_CODES = [
      "FAMILY_FULL",
      "MEMBER_REMOVED",
      "FAMILY_NOT_FOUND",
      "ALREADY_IN_FAMILY",
      // #263: a recovery join from a user no longer listed in the family.
      "RECOVERY_NOT_MEMBER",
    ];

    /** Render with a token-less auth (the auto-acquire effect fires acquireNewToken) and the recovery join
     *  failing with `code`; `errorExtras` carries envelope fields only some branches read (`retryAfter`). */
    async function renderWithFailedJoin(
      code: string,
      errorExtras: Record<string, unknown> = {},
    ): Promise<void> {
      mockJoinFamily.mockResolvedValueOnce({
        error: { code, message: `stub ${code}`, ...errorExtras },
      });
      setMockSession({ ...AUTH_WITHOUT_TOKEN });

      await act(async () => {
        render(<App />);
      });

      // The stubbed failure must really have been consumed; otherwise a
      // "no logout" assertion downstream would pass for the wrong reason.
      expect(mockJoinFamily).toHaveBeenCalled();
    }

    it("covers every code JOIN_BLOCKED_MESSAGES treats as terminal", () => {
      // Tripwire: a new entry in the production map without a case below would
      // otherwise ship an unexercised logout branch.
      expect([...JOIN_BLOCKED_MESSAGES.keys()].sort()).toEqual(
        [...TERMINAL_CODES].sort(),
      );
    });

    /** Terminal failure: App logs out AND hands LandingPage the reason from JOIN_BLOCKED_MESSAGES
     *  (production-anchored end to end). See the header → "Terminal failure". */
    it.each(TERMINAL_CODES)(
      "logs out and explains %s on the landing page",
      async (code) => {
        const expected = JOIN_BLOCKED_MESSAGES.get(code);
        expect(expected).toBeDefined();

        await renderWithFailedJoin(code);

        await waitFor(() => {
          expect(mockLogout).toHaveBeenCalled();
        });
        expect(screen.getByTestId("landing-page")).toBeInTheDocument();
        expect(screen.getByTestId("landing-external-error")).toHaveTextContent(
          expected as string,
        );
      },
    );

    /** Anything neither terminal nor a verification failure KEEPS the session (security-ux Invariant 2): a
     *  dropped connection or an unknown code is no reason to drop the user's data — a retry can succeed. */
    it.each(["INVALID_TOKEN", "NETWORK_ERROR"])(
      "keeps the session on %s (no logout, no landing message)",
      async (code) => {
        await renderWithFailedJoin(code);

        expect(mockLogout).not.toHaveBeenCalled();
        expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
        expect(
          screen.queryByTestId("landing-external-error"),
        ).not.toBeInTheDocument();
      },
    );

    /** A code naming an `Object.prototype` member is just an unknown code (session kept, like
     *  INVALID_TOKEN); the render is the crash assertion. See the header → "Prototype-chain codes". */
    const PROTOTYPE_CHAIN_CODES = [
      "__proto__",
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
    ];

    it.each(PROTOTYPE_CHAIN_CODES)(
      "treats the prototype-chain code %s as an ordinary unknown code",
      async (code) => {
        await renderWithFailedJoin(code);

        // Same outcome as any other unknown code: session kept, nothing to
        // explain — and, critically, the app is still standing.
        expect(mockLogout).not.toHaveBeenCalled();
        expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
        expect(
          screen.queryByTestId("landing-external-error"),
        ).not.toBeInTheDocument();
      },
    );

    it("keeps the session and writes a retryAfter cooldown on RATE_LIMITED", async () => {
      const before = Date.now();

      await renderWithFailedJoin("RATE_LIMITED", { retryAfter: 60 });

      expect(mockLogout).not.toHaveBeenCalled();
      expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();

      const stored = localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY);
      expect(stored).not.toBeNull();
      const deadline = Number(stored);
      expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    it("skips the recovery join entirely while a cooldown is active", async () => {
      localStorage.setItem(
        RECOVERY_COOLDOWN_UNTIL_KEY,
        String(Date.now() + 60_000),
      );
      setMockSession({ ...AUTH_WITHOUT_TOKEN });

      await act(async () => {
        render(<App />);
      });

      expect(mockJoinFamily).not.toHaveBeenCalled();
      expect(mockLogout).not.toHaveBeenCalled();
      expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    });

    it("removes a leftover cooldown key on successful silent recovery", async () => {
      // Expired — an ACTIVE deadline would gate the join before it could run.
      localStorage.setItem(
        RECOVERY_COOLDOWN_UNTIL_KEY,
        String(Date.now() - 1000),
      );
      setMockSession({ ...AUTH_WITHOUT_TOKEN });

      // Default mockJoinFamily resolves { data: { authToken: "new-token" } }
      await act(async () => {
        render(<App />);
      });

      expect(mockJoinFamily).toHaveBeenCalled();
      // Production success path calls clearRecoveryCooldown() — the stale key
      // must be gone, not merely inactive.
      expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBeNull();
    });

    it("clears a leftover cooldown on successful manual login (onAuth)", async () => {
      localStorage.setItem(
        RECOVERY_COOLDOWN_UNTIL_KEY,
        String(Date.now() + 60_000),
      );
      setMockSession(null);

      await act(async () => {
        render(<App />);
      });
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Login" }));

      expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBeNull();
      expect(mockLogin).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", familyId: "f1" }),
      );
    });

    it.each([
      "VERIFICATION_REQUIRED",
      "VERIFICATION_FAILED",
      "VERIFICATION_LOCKED",
    ])("logs out and remembers the sync code on %s", async (code) => {
      await renderWithFailedJoin(code);

      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalled();
      });
      // Real encodeSyncCode ran — assert the remembered value decodes back to the session's familyId
      // instead of pinning the format literal (pinned by tests/unit/crypto/syncCode.test.ts).
      const remembered = localStorage.getItem(REMEMBERED_LOGOUT_KEY);
      expect(remembered).not.toBeNull();
      expect(decodeSyncCode(remembered as string).familyId).toBe("fam-001");
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      // #263: a reason, so this forced logout cannot pass for a finished leave.
      // Exact equality — the literal is pinned in joinErrorMessages.test.ts.
      expect(screen.getByTestId("landing-external-error").textContent).toBe(
        REVERIFY_LOGOUT_MESSAGE,
      );
    });

    it("clears the re-verify message once the user logs in again (onAuth)", async () => {
      mockLogin.mockImplementation((next: Record<string, unknown>) => {
        setMockSession(next);
      });
      mockJoinFamily.mockResolvedValueOnce({
        error: { code: "VERIFICATION_REQUIRED", message: "stub" },
      });
      setMockSession({ ...AUTH_WITHOUT_TOKEN });
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<App />);
      });
      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalledTimes(1);
      });
      // Positive companion: the message really was on screen before the login.
      expect(screen.getByTestId("landing-external-error").textContent).toBe(
        REVERIFY_LOGOUT_MESSAGE,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Login" }));
      });
      expect(mockLogin).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", familyId: "f1" }),
      );
      expect(screen.queryByTestId("landing-page")).not.toBeInTheDocument();

      // A later, voluntary logout must not resurface the stale reason.
      setMockSession(null);
      await act(async () => {
        view.rerender(<App />);
      });
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(
        screen.queryByTestId("landing-external-error"),
      ).not.toBeInTheDocument();
    });

    /** #266: forced re-verification marks THIS identity, so the landing re-login sends `recovery: 1` and the
     *  server refuses a user who left on another device. The write is awaited after `logout()` (waitFor). */
    it.each([
      "VERIFICATION_REQUIRED",
      "VERIFICATION_FAILED",
      "VERIFICATION_LOCKED",
    ])(
      "marks the session identity for a recovery re-login on %s",
      async (code) => {
        await renderWithFailedJoin(code);

        await waitFor(() => {
          expect(localStorage.getItem(REAUTH_PENDING_KEY)).not.toBeNull();
        });
        // The stored session has no apiHost: the default server.
        await expect(
          isReauthPendingFor({
            familyId: AUTH_WITHOUT_TOKEN.familyId,
            userId: AUTH_WITHOUT_TOKEN.userId,
          }),
        ).resolves.toBe(true);
      },
    );

    // #266 review: on a shared device a second account's forced logout must
    // ADD its marker, not overwrite the one already waiting for re-login.
    it("keeps an earlier identity's marker when this session is marked", async () => {
      const earlier = { familyId: "fam-earlier", userId: "1".repeat(64) };
      await markReauthPending(earlier);
      await expect(isReauthPendingFor(earlier)).resolves.toBe(true);

      await renderWithFailedJoin("VERIFICATION_REQUIRED");

      const session = {
        familyId: AUTH_WITHOUT_TOKEN.familyId,
        userId: AUTH_WITHOUT_TOKEN.userId,
      };
      await waitFor(async () => {
        expect(await isReauthPendingFor(session)).toBe(true);
      });
      await expect(isReauthPendingFor(earlier)).resolves.toBe(true);
    });

    it("marks the identity even when rememberSyncCode is off", async () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");

      await renderWithFailedJoin("VERIFICATION_REQUIRED");

      await waitFor(() => {
        expect(localStorage.getItem(REAUTH_PENDING_KEY)).not.toBeNull();
      });
    });

    /** Only the verification branch writes the marker: a terminal code explains itself, a kept session
     *  never reaches the landing page. Positive companion (same key, same render path): the case above. */
    it.each([
      ...TERMINAL_CODES,
      "INVALID_TOKEN",
      "NETWORK_ERROR",
      "RATE_LIMITED",
    ])("does not mark a recovery re-login on %s", async (code) => {
      await renderWithFailedJoin(code);
      // Room for an async digest + write to land, had one been started.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });

    it("still logs out but does not remember the sync code when rememberSyncCode is off", async () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");

      await renderWithFailedJoin("VERIFICATION_REQUIRED");

      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalled();
      });
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });
  });

  /** #258: a recovery join answering after the session ended or switched must neither re-login the old
   *  session nor log out its replacement. See the header → "Session change mid-join". */
  describe("acquireNewToken when the session changes mid-join", () => {
    const SESSION_A = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "old-token",
    };

    type JoinResult = Record<string, unknown>;
    let resolveJoin!: (result: JoinResult) => void;

    beforeEach(() => {
      window.location.hash = "#personal-shelf";
      mockJoinFamily.mockImplementationOnce(
        () =>
          new Promise<JoinResult>((resolve) => {
            resolveJoin = resolve;
          }),
      );
    });

    /** Render session A, start the refresher App registered on its client (the path ApiClient takes
     *  on a 401) and leave the join pending. */
    async function renderWithPendingRefresh() {
      setMockSession({ ...SESSION_A });
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<App />);
      });
      const client = personalShelfClients.at(-1) as {
        setTokenRefresher: ReturnType<typeof vi.fn>;
      };
      const refresh = client.setTokenRefresher.mock
        .calls[0][0] as () => Promise<string | null>;
      const pending = refresh();
      // The deferred join must really be the one in flight, for a session whose
      // id is stored — else the guard would drop the result for the wrong reason.
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(USER_ID_KEY)).toBe(SESSION_A.userId);
      return { view, pending };
    }

    it("does not log the session back in when the user logged out before the join succeeded", async () => {
      const { view, pending } = await renderWithPendingRefresh();

      // Production logout(): the session is gone before the join answers.
      setMockSession(null);
      await act(async () => {
        view.rerender(<App />);
      });
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();

      await act(async () => {
        resolveJoin({ data: { authToken: "new" } });
        await expect(pending).resolves.toBeNull();
      });

      expect(mockLogin).not.toHaveBeenCalled();
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    });

    /** The window `isSameSession` alone misses: USER_ID_KEY is gone but `authRef` still holds session A
     *  until React re-renders. See the header → "Session change mid-join". */
    it("does not log the session back in when logout cleared storage but has not re-rendered yet", async () => {
      const { pending } = await renderWithPendingRefresh();

      // What production logout() does synchronously — no rerender, mockAuth
      // (and so App's authRef) is still session A.
      localStorage.removeItem(USER_ID_KEY);
      expect(mockAuth).toMatchObject({ userId: SESSION_A.userId });

      await act(async () => {
        resolveJoin({ data: { authToken: "new" } });
        await expect(pending).resolves.toBeNull();
      });

      expect(mockLogin).not.toHaveBeenCalled();
    });

    it("does not log out or explain a logout to a different user who signed in before the join failed", async () => {
      const code = "MEMBER_REMOVED";
      expect(JOIN_BLOCKED_MESSAGES.get(code)).toBeDefined();
      const { view, pending } = await renderWithPendingRefresh();

      // Session A ended and user B signed in while A's join was in flight.
      setMockSession({
        ...SESSION_A,
        userId:
          "1111111111111111111111111111111111111111111111111111111111111111",
        authToken: "token-b",
      });
      await act(async () => {
        view.rerender(<App />);
      });

      await act(async () => {
        resolveJoin({ error: { code, message: `stub ${code}` } });
        await expect(pending).resolves.toBeNull();
      });

      expect(mockLogout).not.toHaveBeenCalled();
      expect(screen.getByTestId("personal-shelf-page")).toBeInTheDocument();

      // When B later logs out on their own, A's stale reason must not appear.
      setMockSession(null);
      await act(async () => {
        view.rerender(<App />);
      });
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(
        screen.queryByTestId("landing-external-error"),
      ).not.toBeInTheDocument();
    });
  });

  /** #263 REGRESSION: a 401 during the user's own leave must not let the silent recovery join re-add
   *  them to the family they are leaving. See the header → "Own leave in flight". */
  describe("acquireNewToken while the user's own leave is in flight (#263)", () => {
    const SESSION = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "old-token",
    };

    type LeaveRes = { data?: { ok: boolean }; error?: Record<string, unknown> };

    async function renderWithPendingLeave() {
      window.location.hash = "#personal-shelf";
      setMockSession({ ...SESSION });
      await act(async () => {
        render(<App />);
      });
      const client = personalShelfClients.at(-1) as {
        setTokenRefresher: ReturnType<typeof vi.fn>;
      };
      const refresh = client.setTokenRefresher.mock
        .calls[0][0] as () => Promise<string | null>;

      let resolveLeave!: (res: LeaveRes) => void;
      const leaveFamily = vi.fn(
        () =>
          new Promise<LeaveRes>((resolve) => {
            resolveLeave = resolve;
          }),
      );
      const flow = renderHook(() =>
        useLeaveFamily({
          familyId: SESSION.familyId,
          userId: SESSION.userId,
          apiClient: { leaveFamily } as unknown as ApiClient,
          onLogout: mockLogout,
        }),
      );
      let leaving!: Promise<void>;
      act(() => {
        leaving = flow.result.current.handleLeave();
      });
      // The leave really is in flight, guarded, for a session still stored.
      expect(leaveFamily).toHaveBeenCalledTimes(1);
      expect(isSelfDepartureActive()).toBe(true);
      expect(localStorage.getItem(USER_ID_KEY)).toBe(SESSION.userId);
      return { refresh, resolveLeave, leaving, flow };
    }

    it("does not send a recovery join while the leave request is pending", async () => {
      const { refresh, resolveLeave, leaving } = await renderWithPendingLeave();

      await act(async () => {
        await expect(refresh()).resolves.toBeNull();
      });

      expect(mockJoinFamily).not.toHaveBeenCalled();
      expect(mockLogin).not.toHaveBeenCalled();

      // The leave lands: the user is logged out and the mark is gone.
      await act(async () => {
        resolveLeave({ data: { ok: true } });
        await leaving;
      });
      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(isSelfDepartureActive()).toBe(false);
    });

    /** Positive companion: the null above came from the departure mark, not a refresher that never joins;
     *  a REFUSED leave keeps the session, and the next refresh joins again — flagged as recovery. */
    it("joins again, flagged as recovery, once a refused leave has settled", async () => {
      const { refresh, resolveLeave, leaving, flow } =
        await renderWithPendingLeave();

      await act(async () => {
        await expect(refresh()).resolves.toBeNull();
      });
      expect(mockJoinFamily).not.toHaveBeenCalled();

      await act(async () => {
        resolveLeave({
          error: { code: "OWNER_CANNOT_LEAVE", message: "owner" },
        });
        await leaving;
      });
      expect(flow.result.current.leaveError).toBe(
        "管理者必須先轉移管理權才能離開家庭",
      );
      expect(mockLogout).not.toHaveBeenCalled();
      expect(isSelfDepartureActive()).toBe(false);

      await act(async () => {
        await expect(refresh()).resolves.toBe("new-token");
      });
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(mockJoinFamily).toHaveBeenCalledWith(
        SESSION.familyId,
        SESSION.userId,
        { recovery: BoolFlag.TRUE },
      );
    });

    /** Review S1: leave and resend both 401 and the triggered recovery join needs re-verification; the
     *  resend stub runs the refresher itself. See the header → "Own leave in flight". */
    it("explains the logout when the leave's recovery join needs re-verification", async () => {
      window.location.hash = "#personal-shelf";
      setMockSession({ ...SESSION });
      await act(async () => {
        render(<App />);
      });
      const client = personalShelfClients.at(-1) as {
        setTokenRefresher: ReturnType<typeof vi.fn>;
      };
      const refresh = client.setTokenRefresher.mock
        .calls[0][0] as () => Promise<string | null>;
      mockJoinFamily.mockResolvedValueOnce({
        error: { code: "VERIFICATION_REQUIRED", message: "stub" },
      });
      const unauthorized = {
        error: { code: "UNAUTHORIZED", message: "Invalid token" },
      };
      const markDuringSend: boolean[] = [];
      const leaveFamily = vi
        .fn<() => Promise<LeaveRes>>()
        .mockImplementationOnce(async () => {
          markDuringSend.push(isSelfDepartureActive());
          return unauthorized;
        })
        .mockImplementationOnce(async () => {
          markDuringSend.push(isSelfDepartureActive());
          const token = await refresh();
          return token ? { data: { ok: true } } : unauthorized;
        });
      const flow = renderHook(() =>
        useLeaveFamily({
          familyId: SESSION.familyId,
          userId: SESSION.userId,
          apiClient: { leaveFamily } as unknown as ApiClient,
          onLogout: mockLogout,
        }),
      );

      await act(async () => {
        await flow.result.current.handleLeave();
      });

      // First send guarded, resend unguarded — so the join really was sent.
      expect(markDuringSend).toEqual([true, false]);
      expect(mockJoinFamily).toHaveBeenCalledTimes(1);
      expect(mockJoinFamily).toHaveBeenCalledWith(
        SESSION.familyId,
        SESSION.userId,
        { recovery: BoolFlag.TRUE },
      );
      // Logged out once, by App, with a reason — not a silent "leave done".
      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(screen.getByTestId("landing-external-error").textContent).toBe(
        REVERIFY_LOGOUT_MESSAGE,
      );
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).not.toBeNull();
      expect(isSelfDepartureActive()).toBe(false);
    });
  });
});
