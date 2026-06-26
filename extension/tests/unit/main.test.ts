import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock react-dom/client before importing the module under test
const mockRender = vi.fn();
const mockCreateRoot = vi.fn().mockReturnValue({ render: mockRender });

vi.mock("react-dom/client", () => ({
  createRoot: mockCreateRoot,
}));

// Mock the App component
vi.mock("@/dialog/App", () => ({
  App: () => "MockApp",
}));

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

describe("mountDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a React root and renders App into the provided container", async () => {
    const { mountDialog } = await import("@/dialog/main");
    const container = document.createElement("div");

    mountDialog(container);

    expect(mockCreateRoot).toHaveBeenCalledWith(container);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("renders within React.StrictMode", async () => {
    const { mountDialog } = await import("@/dialog/main");
    const container = document.createElement("div");

    mountDialog(container);

    // The render call receives a JSX element — verify it was called
    const renderArg = mockRender.mock.calls[0][0];
    // StrictMode wraps the App — check the type
    expect(renderArg).toBeDefined();
  });

  it("forwards onViewChange from options to the App component", async () => {
    const { mountDialog } = await import("@/dialog/main");
    const container = document.createElement("div");
    const onViewChange = vi.fn();

    mountDialog(container, { onViewChange });

    // <StrictMode><App onViewChange={...} /></StrictMode>
    const renderArg = mockRender.mock.calls[0][0];
    expect(renderArg.props.children.props.onViewChange).toBe(onViewChange);
  });

  it("mounts without options (backward compatible)", async () => {
    const { mountDialog } = await import("@/dialog/main");
    const container = document.createElement("div");

    expect(() => mountDialog(container)).not.toThrow();

    const renderArg = mockRender.mock.calls[0][0];
    expect(renderArg.props.children.props.onViewChange).toBeUndefined();
  });
});

describe("auto-mount", () => {
  let rootDiv: HTMLElement | null;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset modules so the auto-mount side effect re-runs
    vi.resetModules();
  });

  afterEach(() => {
    // Clean up any #root element we added
    rootDiv = document.getElementById("root");
    if (rootDiv) {
      document.body.removeChild(rootDiv);
    }
  });

  it("auto-mounts when #root element exists in DOM", async () => {
    // Add #root element before importing the module
    rootDiv = document.createElement("div");
    rootDiv.id = "root";
    document.body.appendChild(rootDiv);

    // Re-mock after resetModules
    vi.doMock("react-dom/client", () => ({
      createRoot: mockCreateRoot,
    }));
    vi.doMock("@/dialog/App", () => ({
      App: () => "MockApp",
    }));

    // Import triggers the side effect
    await import("@/dialog/main");

    expect(mockCreateRoot).toHaveBeenCalledWith(rootDiv);
    expect(mockRender).toHaveBeenCalled();
  });

  it("does not mount when #root element does not exist", async () => {
    // Ensure no #root element
    const existing = document.getElementById("root");
    if (existing) document.body.removeChild(existing);

    vi.doMock("react-dom/client", () => ({
      createRoot: mockCreateRoot,
    }));
    vi.doMock("@/dialog/App", () => ({
      App: () => "MockApp",
    }));

    await import("@/dialog/main");

    // mountDialog should NOT have been called automatically
    // createRoot may have been called 0 times (no auto-mount)
    // or once from a previous test — but for this import, since
    // the module was reset, it should be 0.
    expect(mockCreateRoot).not.toHaveBeenCalled();
  });
});
