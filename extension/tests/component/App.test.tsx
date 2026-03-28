import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "@/dialog/App";

// Mock all child components
vi.mock("@/dialog/Onboarding", () => ({
  Onboarding: ({ onFamilyJoined }: { onFamilyJoined: (id: string, userId: string) => void }) => (
    <div data-testid="onboarding">
      <button onClick={() => onFamilyJoined("fam-123", "user-456")}>
        Mock Join
      </button>
    </div>
  ),
}));

vi.mock("@/dialog/PersonalShelf", () => ({
  PersonalShelf: () => <div data-testid="personal-shelf">PersonalShelf</div>,
}));

vi.mock("@/dialog/FamilyShelf", () => ({
  FamilyShelf: () => <div data-testid="family-shelf">FamilyShelf</div>,
}));

vi.mock("@/dialog/FamilySettings", () => ({
  FamilySettings: ({ onLeave }: { onLeave: () => void }) => (
    <div data-testid="family-settings">
      <button onClick={onLeave}>Mock Leave</button>
    </div>
  ),
}));

vi.mock("@/dialog/DialogFooter", () => ({
  DialogFooter: ({ minimal }: { minimal?: boolean }) => (
    <div data-testid="dialog-footer">{minimal ? "minimal" : "full"}</div>
  ),
}));

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

type SendMessageCallback = (response: unknown) => void;

function setupChromeMessages(options: {
  familyId?: string | null;
  userId?: string | null;
  authToken?: string | null;
  apiEndpoint?: string | null;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
    (message: unknown, callback?: SendMessageCallback) => {
      const msg = message as { type: string };
      if (msg.type === "GET_FAMILY_ID" && callback) {
        callback({ familyId: options.familyId ?? null });
      }
      if (msg.type === "GET_API_ENDPOINT" && callback) {
        callback({ apiEndpoint: options.apiEndpoint ?? null });
      }
      if (msg.type === "CLEAR_FAMILY_ID" && callback) {
        callback(undefined);
      }
      return undefined as unknown as Promise<unknown>;
    },
  );

  vi.mocked(chrome.storage.local.get).mockImplementation(
    (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      if (options.userId) result.userId = options.userId;
      if (options.authToken) result.authToken = options.authToken;
      if (typeof callback === "function") callback(result);
      return Promise.resolve(result) as unknown as void;
    },
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    // Don't call any callbacks so the component stays in loading state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(() => {
      // Do not invoke callback — leave in loading state
      return undefined as unknown as Promise<unknown>;
    });

    render(<App />);
    expect(screen.getByText("載入中...")).toBeInTheDocument();
  });

  it("shows onboarding when no familyId", async () => {
    setupChromeMessages({ familyId: null, userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });
  });

  it("shows onboarding when familyId exists but no userId", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });
  });

  it("shows minimal DialogFooter in onboarding view", async () => {
    setupChromeMessages({ familyId: null, userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("dialog-footer")).toHaveTextContent("minimal");
    });
  });

  it("shows main view with tabs when familyId and userId exist", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
      expect(screen.getByText("個人書櫃")).toBeInTheDocument();
      expect(screen.getByText("設定")).toBeInTheDocument();
    });
  });

  it("shows full DialogFooter in main view", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("dialog-footer")).toHaveTextContent("full");
    });
  });

  it("defaults to family-shelf tab", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("family-shelf")).toBeInTheDocument();
    });
  });

  it("switches to personal-shelf tab on click", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("個人書櫃")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("個人書櫃"));

    // PersonalShelf tab content should be visible (display: block)
    expect(screen.getByTestId("personal-shelf")).toBeInTheDocument();
  });

  it("switches to settings tab on click", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("設定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("設定"));
    expect(screen.getByTestId("family-settings")).toBeInTheDocument();
  });

  it("handleFamilyJoined transitions from onboarding to main view", async () => {
    setupChromeMessages({ familyId: null, userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // After joining, the App needs familyId+userId to show main view.
    // The Onboarding mock calls onFamilyJoined("fam-123", "user-456")
    fireEvent.click(screen.getByText("Mock Join"));

    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
      expect(screen.getByText("個人書櫃")).toBeInTheDocument();
      expect(screen.getByText("設定")).toBeInTheDocument();
    });
  });

  it("handleLeaveFamily clears state and returns to onboarding", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("設定")).toBeInTheDocument();
    });

    // Go to settings tab and click leave
    fireEvent.click(screen.getByText("設定"));
    fireEvent.click(screen.getByText("Mock Leave"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // CLEAR_FAMILY_ID should have been sent
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "CLEAR_FAMILY_ID" },
    );
  });

  it("handleLeaveFamily resets active tab to family-shelf", async () => {
    setupChromeMessages({ familyId: null, userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // Join a family
    fireEvent.click(screen.getByText("Mock Join"));
    await waitFor(() => {
      expect(screen.getByText("設定")).toBeInTheDocument();
    });

    // Switch to settings tab
    fireEvent.click(screen.getByText("設定"));

    // Leave family
    fireEvent.click(screen.getByText("Mock Leave"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // Re-join: verify tab resets to family-shelf (default)
    // Re-setup chrome messages so re-join works
    fireEvent.click(screen.getByText("Mock Join"));
    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
    });

    // The family-shelf tab should be active (default after leave)
    const familyShelfButton = screen.getByText("家庭書櫃");
    expect(familyShelfButton).toHaveStyle({ fontWeight: 600 });
  });

  it("applies custom API endpoint from GET_API_ENDPOINT", async () => {
    setupChromeMessages({
      familyId: "fam-1",
      userId: "user-1",
      apiEndpoint: "https://custom.workers.dev",
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
    });

    // The component should have called sendMessage with GET_API_ENDPOINT
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "GET_API_ENDPOINT" },
      expect.any(Function),
    );
  });
});
