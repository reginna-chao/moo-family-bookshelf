import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Mock useAuth hook
const mockLogin = vi.fn();
const mockLogout = vi.fn();
let mockAuth: Record<string, unknown> | null = null;
let mockIsLoading = false;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    auth: mockAuth,
    isLoading: mockIsLoading,
    login: mockLogin,
    logout: mockLogout,
    initialSyncCode: "",
  }),
  namespacedKey: (userId: string, suffix: string) => `moo:${userId}:${suffix}`,
}));

// Mock API client using class syntax to ensure proper prototype chain
vi.mock("@/api/client", () => {
  class MockApiClient {
    setAuthToken = vi.fn();
    setTokenRefresher = vi.fn();
    getEndpoint = vi.fn().mockReturnValue("https://api.example.com");
    setEndpoint = vi.fn();
    joinFamily = vi.fn().mockResolvedValue({ data: { authToken: "new-token" } });
  }
  return { ApiClient: MockApiClient };
});

// Mock pages
vi.mock("@/pages/LandingPage", () => ({
  LandingPage: ({ onAuth }: { onAuth: (data: unknown) => void }) => (
    <div data-testid="landing-page">
      <button onClick={() => onAuth({ userId: "u1", familyId: "f1", encryptionKey: "k1" })}>
        Login
      </button>
    </div>
  ),
}));

vi.mock("@/pages/FamilyShelfPage", () => ({
  FamilyShelfPage: () => <div data-testid="family-shelf-page">Family Shelf</div>,
}));

vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: () => <div data-testid="personal-shelf-page">Personal Shelf</div>,
}));

vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page">Settings</div>,
}));

vi.mock("@/components/InstallPrompt", () => ({
  InstallPrompt: () => null,
}));

import App from "@/App";

describe("App", () => {
  beforeEach(() => {
    mockAuth = null;
    mockIsLoading = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      familyId: "fam-001",
      encryptionKey: "key-123",
      apiHost: "https://api.example.com",
      authToken: "token-123",
    };
    render(<App />);

    // Default page is family shelf
    expect(screen.getByTestId("family-shelf-page")).toBeInTheDocument();
    // Navigation bar visible
    expect(screen.getByRole("navigation", { name: "主要導覽" })).toBeInTheDocument();
  });

  it("navigates between tabs", async () => {
    mockAuth = {
      userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
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
      userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
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
      userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
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
});
