import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";

// Mock useAuth hook
const mockLogin = vi.fn();
const mockLogout = vi.fn();
const mockForceLogout = vi.fn();
let mockAuth: Record<string, unknown> | null = null;
let mockIsLoading = false;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    auth: mockAuth,
    isLoading: mockIsLoading,
    login: mockLogin,
    logout: mockLogout,
    forceLogout: mockForceLogout,
    initialSyncCode: "",
    qrUserId: "",
  }),
  namespacedKey: (userId: string, suffix: string) => `moo:${userId}:${suffix}`,
}));

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

// Mock pages.
// LandingPage is a pass-through for `externalError`: it renders whatever App
// hands it verbatim, so the involuntary-logout tests below assert on the copy
// produced by JOIN_BLOCKED_MESSAGES in `pwa/src/utils/joinErrorMessages.ts`
// rather than on a string invented here.
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

vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: () => (
    <div data-testid="personal-shelf-page">Personal Shelf</div>
  ),
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

describe("App", () => {
  beforeEach(() => {
    mockAuth = null;
    mockIsLoading = false;
    window.location.hash = "";
    vi.clearAllMocks();
    mockJoinFamily.mockResolvedValue({ data: { authToken: "new-token" } });
  });

  afterEach(async () => {
    // Flush pending async effects (token acquisition, etc.) before cleanup
    await act(async () => {});
    vi.restoreAllMocks();
  });

  it("preserves page hash on refresh (does not redirect to family-shelf)", () => {
    // Simulate: user was on personal-shelf, then refreshed the page.
    // On refresh, hash is #personal-shelf and auth restores from localStorage.
    window.location.hash = "#personal-shelf";

    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    };
    render(<App />);

    // Should stay on personal-shelf, not redirect to family-shelf
    expect(screen.getByTestId("personal-shelf-page")).toBeInTheDocument();
    expect(screen.queryByTestId("family-shelf-page")).not.toBeInTheDocument();
  });

  it("preserves settings page hash on refresh", () => {
    window.location.hash = "#settings";

    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    };
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
    mockAuth = null;
    render(<App />);
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
  });

  it("shows main view with navigation when authenticated", () => {
    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      apiHost: "https://api.example.com",
      authToken: "token-123",
    };
    render(<App />);

    // Default page is family shelf
    expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    // Navigation bar visible
    expect(
      screen.getByRole("navigation", { name: "主要導覽" }),
    ).toBeInTheDocument();
  });

  it("navigates between tabs", async () => {
    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    };
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
    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      authToken: "token-123",
    };
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
    mockAuth = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      // No authToken — triggers acquireNewToken
    };

    await act(async () => {
      render(<App />);
    });

    // After token acquisition completes, should show main view
    await waitFor(() => {
      expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    });
  });

  /**
   * Token-recovery join failures. All of them log the user out; what differs is
   * whether the landing page EXPLAINS why instead of showing a bare login form.
   * The copy asserted here is produced by JOIN_BLOCKED_MESSAGES in
   * `pwa/src/utils/joinErrorMessages.ts` (App looks it up with `.get`) and
   * merely echoed by the LandingPage mock, so editing a production string fails
   * these tests — deliberately verbatim, as that module's own doc comment
   * promises. Do not swap the literals for an import of the map: that would
   * make the assertion follow whatever the map says and stop pinning the copy.
   */
  describe("acquireNewToken join failures", () => {
    /**
     * Render with a token-less auth (the auto-acquire effect fires
     * acquireNewToken) and a join stubbed to fail with `code`. logout() is wired
     * to actually drop auth, which is what lets the landing page render.
     */
    async function renderWithFailedJoin(code: string): Promise<void> {
      mockJoinFamily.mockResolvedValueOnce({
        error: { code, message: `stub ${code}` },
      });
      mockLogout.mockImplementationOnce(() => {
        mockAuth = null;
      });
      mockAuth = {
        userId:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        familyId: "fam-001",
        encryptionKey: "key-123",
        // No authToken — triggers acquireNewToken via auto-acquire effect
      };

      await act(async () => {
        render(<App />);
      });

      await waitFor(() => {
        expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      });
    }

    it("logs out without a landing message on a non-terminal join error", async () => {
      await renderWithFailedJoin("INVALID_TOKEN");

      expect(mockLogout).toHaveBeenCalled();
      // Retrying can still succeed, so there is nothing to explain.
      expect(
        screen.queryByTestId("landing-external-error"),
      ).not.toBeInTheDocument();
    });

    it("logs out and explains FAMILY_FULL on the landing page", async () => {
      await renderWithFailedJoin("FAMILY_FULL");

      expect(mockLogout).toHaveBeenCalled();
      expect(screen.getByTestId("landing-external-error")).toHaveTextContent(
        "家庭成員已達上限（每個家庭最多 2 位成員）",
      );
    });

    /**
     * The owner removed this member, so the server's kicked tombstone refuses
     * the recovery join. Explaining it is what stops the user from staring at a
     * login form wondering why their session evaporated.
     */
    it("logs out and explains MEMBER_REMOVED on the landing page", async () => {
      await renderWithFailedJoin("MEMBER_REMOVED");

      expect(mockLogout).toHaveBeenCalled();
      expect(screen.getByTestId("landing-external-error")).toHaveTextContent(
        "你已被家庭管理者移出，已為你登出",
      );
    });

    /**
     * `error.code` arrives straight off the wire from a backend that may be
     * self-hosted, buggy, or hostile, so a code naming an `Object.prototype`
     * member is a reachable input. Looked up in a Map it is simply an unknown
     * code — nothing to explain, log the user out — i.e. it must behave exactly
     * like INVALID_TOKEN above.
     *
     * Regression guard for the object-literal table this Map replaced, where
     * the lookup answered off the prototype chain: `__proto__` returned
     * `Object.prototype`, and rendering that object as a React child took the
     * whole PWA down (there is no ErrorBoundary); the function-valued members
     * (`toString` / `constructor` / `valueOf` / `hasOwnProperty`) reached
     * `setLandingError`, which treats a function as a state UPDATER — so they
     * either threw inside the state update or put the updater's return value on
     * screen as the "reason" for the logout.
     *
     * The render itself is the crash assertion — `renderWithFailedJoin` renders
     * inside `act`, so a React child error surfaces as a test failure there.
     */
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

        // Same outcome as any other non-terminal code: logged out, nothing to
        // explain — and, critically, the app is still standing.
        expect(mockLogout).toHaveBeenCalled();
        expect(
          screen.queryByTestId("landing-external-error"),
        ).not.toBeInTheDocument();
      },
    );
  });
});
