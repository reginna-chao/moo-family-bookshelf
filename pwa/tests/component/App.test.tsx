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

// Keep the module's real exports (REMEMBER_SYNC_CODE_KEY, REMEMBERED_LOGOUT_KEY,
// namespacedKey, ...) so App's sync-code-remember branch reads/writes the same
// localStorage keys as production — only the hook itself is replaced.
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

// Mock pages. The stub renders `externalError` as visible text so tests can
// assert the copy App passes down — the copy itself lives in production
// App.tsx (TERMINAL_RECOVERY_ERRORS), so the assertion is production-anchored.
vi.mock("@/pages/LandingPage", () => ({
  LandingPage: ({
    onAuth,
    externalError,
  }: {
    onAuth: (data: unknown) => void;
    externalError?: string;
  }) => (
    <div data-testid="landing-page">
      {externalError ? <p>{externalError}</p> : null}
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
// The useAuth mock factory spreads the actual module, so these are the real
// production key literals, not mock copies (anti-drift: import from production).
import { REMEMBER_SYNC_CODE_KEY, REMEMBERED_LOGOUT_KEY } from "@/hooks/useAuth";
import { RECOVERY_COOLDOWN_UNTIL_KEY } from "@/utils/recoveryCooldown";
import { decodeSyncCode } from "@/crypto/syncCode";

/** localStorage keys this suite touches — cleared around every test. */
function clearSuiteStorageKeys() {
  localStorage.removeItem(RECOVERY_COOLDOWN_UNTIL_KEY);
  localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
  localStorage.removeItem(REMEMBER_SYNC_CODE_KEY);
}

describe("App", () => {
  beforeEach(() => {
    mockAuth = null;
    mockIsLoading = false;
    window.location.hash = "";
    clearSuiteStorageKeys();
    vi.clearAllMocks();
    mockJoinFamily.mockResolvedValue({ data: { authToken: "new-token" } });
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

  describe("acquireNewToken join failures", () => {
    // No authToken — every render triggers acquireNewToken via the
    // auto-acquire effect
    const AUTH_WITHOUT_TOKEN = {
      userId:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
    };

    it.each([
      {
        code: "FAMILY_FULL",
        copy: "家庭成員已達上限（每個家庭最多 2 位成員）",
      },
      { code: "FAMILY_NOT_FOUND", copy: "找不到這個家庭，家庭可能已被解散" },
      {
        code: "ALREADY_IN_FAMILY",
        copy: "此帳號已加入其他家庭，請先離開原本的家庭",
      },
    ])(
      "logs out and shows landing copy on terminal $code",
      async ({ code, copy }) => {
        mockJoinFamily.mockResolvedValueOnce({
          error: { code, message: "server text (never rendered)" },
        });
        // After logout, auth becomes null → LandingPage renders with externalError
        mockLogout.mockImplementationOnce(() => {
          mockAuth = null;
        });
        mockAuth = { ...AUTH_WITHOUT_TOKEN };

        await act(async () => {
          render(<App />);
        });

        await waitFor(() => {
          expect(mockLogout).toHaveBeenCalled();
        });
        expect(screen.getByTestId("landing-page")).toBeInTheDocument();
        expect(screen.getByText(copy)).toBeInTheDocument();
      },
    );

    it.each(["INVALID_TOKEN", "NETWORK_ERROR"])(
      "keeps the session on %s (no logout)",
      async (code) => {
        mockJoinFamily.mockResolvedValueOnce({
          error: { code, message: "transient failure" },
        });
        mockAuth = { ...AUTH_WITHOUT_TOKEN };

        await act(async () => {
          render(<App />);
        });

        expect(mockLogout).not.toHaveBeenCalled();
        expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
      },
    );

    it("keeps the session and writes a retryAfter cooldown on RATE_LIMITED", async () => {
      mockJoinFamily.mockResolvedValueOnce({
        error: { code: "RATE_LIMITED", message: "Too many", retryAfter: 60 },
      });
      mockAuth = { ...AUTH_WITHOUT_TOKEN };
      const before = Date.now();

      await act(async () => {
        render(<App />);
      });

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
      mockAuth = { ...AUTH_WITHOUT_TOKEN };

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
      mockAuth = { ...AUTH_WITHOUT_TOKEN };

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
      mockAuth = null;

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
      mockJoinFamily.mockResolvedValueOnce({
        error: { code, message: "Verification needed" },
      });
      mockLogout.mockImplementationOnce(() => {
        mockAuth = null;
      });
      mockAuth = { ...AUTH_WITHOUT_TOKEN };

      await act(async () => {
        render(<App />);
      });

      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalled();
      });
      // Real encodeSyncCode ran — assert the remembered value decodes back
      // to the session's familyId rather than pinning the format literal
      // here (the format is pinned by tests/unit/crypto/syncCode.test.ts).
      const remembered = localStorage.getItem(REMEMBERED_LOGOUT_KEY);
      expect(remembered).not.toBeNull();
      expect(decodeSyncCode(remembered as string).familyId).toBe("fam-001");
      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    });

    it("still logs out but does not remember the sync code when rememberSyncCode is off", async () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");
      mockJoinFamily.mockResolvedValueOnce({
        error: {
          code: "VERIFICATION_REQUIRED",
          message: "Verification needed",
        },
      });
      mockAuth = { ...AUTH_WITHOUT_TOKEN };

      await act(async () => {
        render(<App />);
      });

      await waitFor(() => {
        expect(mockLogout).toHaveBeenCalled();
      });
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });
  });
});
