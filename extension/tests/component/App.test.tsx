import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "@/dialog/App";
import { ApiClient } from "@/api/client";
import { USER_ID_KEY, AUTH_TOKEN_KEY } from "@/constants";

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
  DialogFooter: () => (
    <div data-testid="dialog-footer">footer</div>
  ),
}));

vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

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
      if (options.userId) result[USER_ID_KEY] = options.userId;
      if (options.authToken) result[AUTH_TOKEN_KEY] = options.authToken;
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

  it("shows DialogFooter in onboarding view", async () => {
    setupChromeMessages({ familyId: null, userId: null });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("dialog-footer")).toBeInTheDocument();
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

  it("shows DialogFooter in main view", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1" });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("dialog-footer")).toBeInTheDocument();
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

    // Track hasCompletedInitialSetup state across mock calls
    const storageState: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.set).mockImplementation((items) => {
      Object.assign(storageState, items);
      return Promise.resolve();
    });
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result: Record<string, unknown> = {};
        const keyList = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(keys as Record<string, unknown>));
        for (const k of keyList) {
          if (k in storageState) result[k] = storageState[k];
        }
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // First join — first-time setup, defaults to personal-shelf
    fireEvent.click(screen.getByText("Mock Join"));
    await waitFor(() => {
      expect(screen.getByText("個人書櫃")).toBeInTheDocument();
    });

    // Switch to settings tab
    fireEvent.click(screen.getByText("設定"));

    // Leave family
    fireEvent.click(screen.getByText("Mock Leave"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // Re-join: hasCompletedInitialSetup is now true, should default to family-shelf
    fireEvent.click(screen.getByText("Mock Join"));
    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
    });

    // The family-shelf tab should be active (default after leave + re-join)
    const familyShelfButton = screen.getByText("家庭書櫃");
    expect(familyShelfButton).toHaveStyle({ fontWeight: 600 });
  });

  it("resets to onboarding when apiClient.onFamilyRemoved is called", async () => {
    // Capture the ApiClient instance created by App's useRef
    const instances: ApiClient[] = [];
    const OrigConstructor = ApiClient;
    const constructorSpy = vi.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@/api/client")) as any,
      "ApiClient",
    ).mockImplementation((...args: unknown[]) => {
      const instance = new OrigConstructor(...(args as [string?]));
      instances.push(instance);
      return instance;
    });

    setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
    });

    // The App should have created exactly one ApiClient instance
    expect(instances.length).toBeGreaterThan(0);
    const apiClient = instances[0];
    expect(apiClient.onFamilyRemoved).not.toBeNull();

    // Simulate ApiClient calling onFamilyRemoved (e.g., REFRESH_FAILED)
    await act(async () => {
      apiClient.onFamilyRemoved!();
    });

    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    constructorSpy.mockRestore();
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

  describe("lazy-mount tab panels", () => {
    it("mounts only FamilyShelf on initial render (default family-shelf tab)", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("family-shelf")).toBeInTheDocument();
      });

      // Other tab panels are not mounted until first visited.
      expect(screen.queryByTestId("personal-shelf")).not.toBeInTheDocument();
      expect(screen.queryByTestId("family-settings")).not.toBeInTheDocument();
    });

    it("mounts PersonalShelf only after its tab is first clicked", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByText("個人書櫃")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("personal-shelf")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("個人書櫃"));

      expect(screen.getByTestId("personal-shelf")).toBeInTheDocument();
    });

    it("mounts FamilySettings only after its tab is first clicked", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByText("設定")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("family-settings")).not.toBeInTheDocument();

      fireEvent.click(screen.getByText("設定"));

      expect(screen.getByTestId("family-settings")).toBeInTheDocument();
    });

    it("keeps a visited panel mounted after switching away and back", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByText("個人書櫃")).toBeInTheDocument();
      });

      // Visit personal-shelf (mounts it)
      fireEvent.click(screen.getByText("個人書櫃"));
      expect(screen.getByTestId("personal-shelf")).toBeInTheDocument();

      // Switch away to family-shelf
      fireEvent.click(screen.getByText("家庭書櫃"));
      // PersonalShelf wrapper stays mounted (display toggled, not unmounted)
      expect(screen.getByTestId("personal-shelf")).toBeInTheDocument();

      // Switch back
      fireEvent.click(screen.getByText("個人書櫃"));
      expect(screen.getByTestId("personal-shelf")).toBeInTheDocument();
    });

    it("a visited panel stays in the DOM but is hidden when inactive", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByText("個人書櫃")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("個人書櫃"));
      fireEvent.click(screen.getByText("家庭書櫃"));

      // The personal-shelf panel wrapper is hidden (display:none) while inactive.
      const personalPanel = document.getElementById("panel-personal-shelf");
      expect(personalPanel).not.toBeNull();
      expect(personalPanel!.style.display).toBe("none");
    });
  });

  describe("layout styles", () => {
    it("onboarding wrapper has flex column layout", async () => {
      setupChromeMessages({ familyId: null, userId: null });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("onboarding")).toBeInTheDocument();
      });

      const wrapper = screen.getByTestId("onboarding").parentElement!;
      expect(wrapper).toHaveStyle({
        display: "flex",
        flexDirection: "column",
      });
    });

    it("main view wrapper has flex column layout", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByRole("tablist")).toBeInTheDocument();
      });

      const wrapper = screen.getByRole("tablist").parentElement!;
      expect(wrapper).toHaveStyle({
        display: "flex",
        flexDirection: "column",
      });
    });

    it("content area uses flex growth instead of fixed max-height", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("family-shelf")).toBeInTheDocument();
      });

      const panelDiv = screen.getByTestId("family-shelf").parentElement!;
      const contentArea = panelDiv.parentElement!;
      expect(contentArea.style.overflowY).toBe("auto");
      expect(contentArea.style.maxHeight).toBe("");
    });
  });
});
