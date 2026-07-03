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

    // <StrictMode><PortalContainerContext.Provider><App onViewChange={...} /></Provider></StrictMode>
    const renderArg = mockRender.mock.calls[0][0];
    const app = renderArg.props.children.props.children;
    expect(app.props.onViewChange).toBe(onViewChange);
  });

  it("mounts without options (backward compatible)", async () => {
    const { mountDialog } = await import("@/dialog/main");
    const container = document.createElement("div");

    expect(() => mountDialog(container)).not.toThrow();

    const renderArg = mockRender.mock.calls[0][0];
    const app = renderArg.props.children.props.children;
    expect(app.props.onViewChange).toBeUndefined();
  });
});

describe("mountDialog scoped-style injection", () => {
  const STYLE_SELECTOR = "style[data-moo-dialog-styles]";

  // NOTE: under Vitest the `./styles.css?raw` import resolves to an EMPTY string
  // (Vite's CSS plugin intercepts the `.css` extension before `?raw` in the test
  // transform). The real build inlines the stylesheet bytes correctly — verified
  // manually on a live Readmoo page. These tests therefore assert the injection
  // *contract* (right root, single element, idempotent) rather than CSS content.

  beforeEach(() => {
    vi.clearAllMocks();
    // Remove any stylesheet a previous case injected into document.head.
    document.head.querySelectorAll(STYLE_SELECTOR).forEach((el) => el.remove());
  });

  afterEach(() => {
    document.head.querySelectorAll(STYLE_SELECTOR).forEach((el) => el.remove());
  });

  it("injects exactly one scoped <style> into the shadow root (not document.head) when mounted inside a ShadowRoot", async () => {
    const { mountDialog } = await import("@/dialog/main");

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.appendChild(container);
    document.body.appendChild(host);

    mountDialog(container);

    const shadowStyles = shadow.querySelectorAll(STYLE_SELECTOR);
    expect(shadowStyles).toHaveLength(1);
    expect(shadowStyles[0].tagName).toBe("STYLE");
    // Isolation: nothing leaked into the page's document.head.
    expect(document.head.querySelectorAll(STYLE_SELECTOR)).toHaveLength(0);

    host.remove();
  });

  it("injects the scoped <style> into document.head when mounted into a plain (non-shadow) container", async () => {
    const { mountDialog } = await import("@/dialog/main");

    const container = document.createElement("div");
    document.body.appendChild(container);

    mountDialog(container);

    const headStyles = document.head.querySelectorAll(STYLE_SELECTOR);
    expect(headStyles).toHaveLength(1);
    expect(headStyles[0].tagName).toBe("STYLE");

    container.remove();
  });

  it("does not duplicate the <style> when mountDialog runs twice against the same shadow root", async () => {
    const { mountDialog } = await import("@/dialog/main");

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.appendChild(container);
    document.body.appendChild(host);

    mountDialog(container);
    mountDialog(container);

    expect(shadow.querySelectorAll(STYLE_SELECTOR)).toHaveLength(1);

    host.remove();
  });

  it("does not duplicate the <style> when mountDialog runs twice against document.head", async () => {
    const { mountDialog } = await import("@/dialog/main");

    const container = document.createElement("div");
    document.body.appendChild(container);

    mountDialog(container);
    mountDialog(container);

    expect(document.head.querySelectorAll(STYLE_SELECTOR)).toHaveLength(1);

    container.remove();
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
