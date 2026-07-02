import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "@/dialog/App";
import { ApiClient } from "@/api/client";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
} from "@/constants";
import { MOBILE_MEDIA_QUERY } from "@/hooks/breakpoints";

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

// Production reads via promise-based `browser.runtime.sendMessage(msg)` and
// `browser.storage.{local,sync}.get(keys)` (webextension-polyfill). The mocks
// resolve the response/result Promise keyed by message type / storage key —
// there is no Chrome callback argument.
//
// IMPORTANT: the mount gate now resolves familyId via `readFamilyId()` (DIRECT
// storage.sync→local read), NOT via the `GET_FAMILY_ID` message. So familyId is
// seeded into BOTH storage areas here. The storage mocks are key-aware so
// `readFamilyId([FAMILY_ID_KEY])` and the App's `get([USER_ID_KEY, AUTH_TOKEN_KEY])`
// each get only the keys they ask for.
function pickKeys(
  store: Record<string, unknown>,
  keys: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keyList = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? [keys]
      : Object.keys(store);
  for (const k of keyList) {
    if (k in store) result[k as string] = store[k as string];
  }
  return result;
}

function setupChromeMessages(options: {
  familyId?: string | null;
  userId?: string | null;
  authToken?: string | null;
  apiEndpoint?: string | null;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
    (message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "GET_FAMILY_ID") {
        return Promise.resolve({ familyId: options.familyId ?? null });
      }
      if (msg.type === "GET_API_ENDPOINT") {
        return Promise.resolve({ apiEndpoint: options.apiEndpoint ?? null });
      }
      if (msg.type === "CLEAR_FAMILY_ID") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    },
  );

  const localStore: Record<string, unknown> = {};
  if (options.userId) localStore[USER_ID_KEY] = options.userId;
  if (options.authToken) localStore[AUTH_TOKEN_KEY] = options.authToken;
  if (options.familyId) localStore[FAMILY_ID_KEY] = options.familyId;

  const syncStore: Record<string, unknown> = {};
  if (options.familyId) syncStore[FAMILY_ID_KEY] = options.familyId;

  vi.mocked(chrome.storage.local.get).mockImplementation(((keys: unknown) =>
    Promise.resolve(pickKeys(localStore, keys))) as typeof chrome.storage.local.get);
  vi.mocked(chrome.storage.sync.get).mockImplementation(((keys: unknown) =>
    Promise.resolve(pickKeys(syncStore, keys))) as typeof chrome.storage.sync.get);
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
    // (promise-based browser.runtime.sendMessage — no Chrome callback arg).
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "GET_API_ENDPOINT",
    });
  });

  // Firefox MV3 non-persistent background event page sleeps, so
  // browser.runtime.sendMessage round-trips fail — but browser.storage.* stays
  // reliable. The mount gate must resolve familyId/userId from DIRECT storage
  // and NOT fall back to onboarding just because a message rejected.
  describe("Firefox sleeping-background gate", () => {
    // Seed familyId/userId/authToken DIRECTLY into storage (sync + local),
    // bypassing setupChromeMessages so we control the sendMessage rejection.
    function seedStorage(opts: {
      familyId?: string | null;
      userId?: string | null;
      authToken?: string | null;
    }) {
      const localStore: Record<string, unknown> = {};
      if (opts.userId) localStore[USER_ID_KEY] = opts.userId;
      if (opts.authToken) localStore[AUTH_TOKEN_KEY] = opts.authToken;
      if (opts.familyId) localStore[FAMILY_ID_KEY] = opts.familyId;
      const syncStore: Record<string, unknown> = {};
      if (opts.familyId) syncStore[FAMILY_ID_KEY] = opts.familyId;

      vi.mocked(chrome.storage.local.get).mockImplementation(((keys: unknown) =>
        Promise.resolve(pickKeys(localStore, keys))) as typeof chrome.storage.local.get);
      vi.mocked(chrome.storage.sync.get).mockImplementation(((keys: unknown) =>
        Promise.resolve(pickKeys(syncStore, keys))) as typeof chrome.storage.sync.get);
    }

    it("resolves to MAIN view when sendMessage REJECTS but storage has familyId+userId", async () => {
      // Every background message rejects (sleeping Firefox background).
      vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
        new Error("Could not establish connection. Receiving end does not exist."),
      );
      seedStorage({ familyId: "fam-ff", userId: "user-ff", authToken: "tok" });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
        expect(screen.getByText("個人書櫃")).toBeInTheDocument();
        expect(screen.getByText("設定")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    });

    it("resolves to onboarding when sendMessage rejects and storage has no familyId", async () => {
      vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
        new Error("Could not establish connection. Receiving end does not exist."),
      );
      seedStorage({ familyId: null, userId: null, authToken: null });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding")).toBeInTheDocument();
      });
    });

    it("a rejected GET_API_ENDPOINT does not block the main view", async () => {
      // Only GET_API_ENDPOINT rejects; storage still has familyId+userId.
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(
        (message: unknown) => {
          const msg = message as { type: string };
          if (msg.type === "GET_API_ENDPOINT") {
            return Promise.reject(new Error("background asleep"));
          }
          return Promise.resolve(undefined);
        },
      );
      seedStorage({ familyId: "fam-ff", userId: "user-ff", authToken: "tok" });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    });
  });

  // Firefox: CLEAR_FAMILY_ID message can fail (sleeping background), so leave
  // must also clear familyId + auth credentials DIRECTLY from storage.local.
  it("handleLeaveFamily removes credentials from storage.local even when CLEAR_FAMILY_ID message rejects", async () => {
    setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });
    // The CLEAR_FAMILY_ID message rejects (Firefox sleeping background). The
    // GET_* messages used at mount must still resolve so the main view renders.
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "CLEAR_FAMILY_ID") {
        return Promise.reject(new Error("background asleep"));
      }
      if (msg.type === "GET_API_ENDPOINT") {
        return Promise.resolve({ apiEndpoint: null });
      }
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("設定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("設定"));
    fireEvent.click(screen.getByText("Mock Leave"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
    });

    // Direct storage cleanup guarantees Unbind Isolation even with no background.
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      expect.arrayContaining([FAMILY_ID_KEY, AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY]),
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

  describe("mobile responsive tab row", () => {
    const originalMatchMedia = window.matchMedia;

    afterEach(() => {
      // Restore the desktop-default matchMedia stub so other tests are unaffected,
      // and reset the module registry mutated by the mobile case's dynamic import.
      window.matchMedia = originalMatchMedia;
      vi.resetModules();
    });

    it("uses desktop tab-row sizing when viewport is not mobile", async () => {
      // tests/setup.ts default stub reports matches:false for every query.
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      render(<App />);
      await waitFor(() => {
        expect(screen.getByRole("tablist")).toBeInTheDocument();
      });

      const nav = screen.getByRole("tablist");
      expect(nav.style.paddingRight).toBe("0px");

      const settingsTab = screen.getByRole("tab", { name: "設定" });
      expect(settingsTab).toHaveStyle({ padding: "12px 0", fontSize: "14px" });
    });

    it("reserves space for the close icon and tightens tabs on mobile", async () => {
      // useMediaQuery caches the MediaQueryList per query at module level, so the
      // mobile matchMedia mock must be in place before App's module graph reads it.
      // Reset modules + dynamic-import App so the fresh cache picks up the mobile MQL.
      vi.resetModules();

      const mobileMatchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === MOBILE_MEDIA_QUERY,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      window.matchMedia = mobileMatchMedia as unknown as typeof window.matchMedia;

      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });

      const { App: FreshApp } = await import("@/dialog/App");
      render(<FreshApp />);
      await waitFor(() => {
        expect(screen.getByRole("tablist")).toBeInTheDocument();
      });

      const nav = screen.getByRole("tablist");
      expect(nav.style.paddingRight).toBe("40px");

      const settingsTab = screen.getByRole("tab", { name: "設定" });
      expect(settingsTab).toHaveStyle({ padding: "8px 0", fontSize: "13px" });
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

  describe("onViewChange callback", () => {
    it("reports the onboarding view when no familyId", async () => {
      setupChromeMessages({ familyId: null, userId: null });
      const onViewChange = vi.fn();

      render(<App onViewChange={onViewChange} />);
      await waitFor(() => {
        expect(screen.getByTestId("onboarding")).toBeInTheDocument();
      });

      // The onViewChange effect can flush a tick after the view renders; wait for
      // it explicitly so CI parallel load cannot race the bare assertion (PR #60).
      await waitFor(() => {
        expect(onViewChange).toHaveBeenCalledWith("onboarding");
      });
    });

    it("reports the main view when familyId and userId exist", async () => {
      setupChromeMessages({ familyId: "fam-1", userId: "user-1", authToken: "tok" });
      const onViewChange = vi.fn();

      render(<App onViewChange={onViewChange} />);
      await waitFor(() => {
        expect(screen.getByText("家庭書櫃")).toBeInTheDocument();
      });

      // Same race guard as the onboarding case: wait for the callback to flush.
      await waitFor(() => {
        expect(onViewChange).toHaveBeenCalledWith("main");
      });
    });
  });
});
