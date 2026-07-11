import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import browser from "webextension-polyfill";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";

/**
 * Lifecycle tests for the content script's dialog open/close teardown.
 *
 * `toggleDialog`, `disposeDialogShell`, and `unmountDialogRoot` are module-private,
 * so we drive them the way production does: through the floating button's click
 * handler. The React root itself lives in a code-split module the content script
 * loads at runtime via `browser.runtime.getURL("content-dialog.js")` — an
 * external boundary we legitimately mock. We point `getURL` at `@/dialog/main`
 * (the aliased dialog module) and mock that module so `mountDialog` returns a
 * spy-backed unmount handle we can assert on.
 */

// Spy-backed dialog module. `mountDialog` returns the unmount handle the content
// script must retain and call on every close/teardown path.
const mockUnmount = vi.fn();
const mockMountDialog = vi.fn<
  (container: HTMLElement, options?: unknown) => () => void
>(() => mockUnmount);

vi.mock("@/dialog/main", () => ({
  mountDialog: (container: HTMLElement, options?: unknown) =>
    mockMountDialog(container, options),
}));

// Resolve page-ready immediately so the top-level init injects the floating
// button without waiting on Readmoo's spinner (kept real would risk the 5s
// fallback timeout). pageReady has its own dedicated unit tests.
vi.mock("@/content/pageReady", () => ({
  waitForPageReady: () => Promise.resolve(),
  PAGE_READY_TIMEOUT_MS: 5000,
}));

// Importing the content script runs its top-level init (injects the floating
// button + wires the click → toggleDialog handler). Static import so the
// vi.mock calls above are hoisted ahead of module evaluation.
import "@/content/index";

/** One macrotask hop. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Deterministically wait for the async open path (runtime dynamic import →
 * mountDialog) to reach the expected mount count. Polling avoids depending on a
 * fixed number of ticks, which is flaky when the import resolution latency
 * varies under a loaded full-suite run.
 */
async function waitForMountCount(count: number): Promise<void> {
  for (let i = 0; i < 100 && mockMountDialog.mock.calls.length < count; i++) {
    await tick();
  }
}

/**
 * Let a pending dynamic import settle when we expect NO mount (race-guard test).
 * A few ticks give the import ample time to resolve so a broken guard would be
 * caught; the race guard keeps the count at 0 regardless of when it resolves.
 */
const settle = async (): Promise<void> => {
  await tick();
  await tick();
  await tick();
};

function getButton(): HTMLElement {
  const btn = document.getElementById(MOO_ELEMENT_IDS.button);
  if (!btn) throw new Error("floating button was not injected by init");
  return btn;
}

function hostExists(): boolean {
  return document.getElementById(MOO_ELEMENT_IDS.host) !== null;
}

/**
 * Re-inject the floating button if a prior test's teardown removed it (the
 * context-invalidation path runs `cleanupMooFamilyUI`, which removes the button
 * too). A hashchange re-runs the content script's `waitAndInjectButton`; the
 * mocked `waitForPageReady` resolves immediately, so the button reappears within
 * a few ticks. No-op when the button is already present (injection is idempotent).
 */
async function ensureButtonInjected(): Promise<void> {
  if (document.getElementById(MOO_ELEMENT_IDS.button)) return;
  window.dispatchEvent(new Event("hashchange"));
  for (let i = 0; i < 100 && !document.getElementById(MOO_ELEMENT_IDS.button); i++) {
    await tick();
  }
}

const getURLMock = browser.runtime.getURL as unknown as ReturnType<typeof vi.fn>;

/** Restores a per-test `browser.runtime.id` getter spy; null when none active. */
let restoreContextValidity: (() => void) | null = null;

beforeAll(async () => {
  getURLMock.mockReturnValue("@/dialog/main");
  // Pre-warm the mocked dialog module into the runtime cache so the content
  // script's runtime dynamic import resolves promptly.
  await import("@/dialog/main");
  // Let the top-level init's async button injection settle before any test runs.
  await settle();
});

beforeEach(async () => {
  vi.clearAllMocks();
  // clearAllMocks wipes the return value set above — re-point getURL at the
  // aliased dialog module so the runtime dynamic import resolves to our mock.
  getURLMock.mockReturnValue("@/dialog/main");
  // A previous test may have torn the button out (context-invalidation path).
  await ensureButtonInjected();
});

afterEach(() => {
  // Restore any extension-context spy so the next test sees a valid context.
  restoreContextValidity?.();
  restoreContextValidity = null;
  // Ensure no dialog host leaks between tests (each test should close its own,
  // but guard against a failed assertion leaving one attached).
  document.getElementById(MOO_ELEMENT_IDS.host)?.remove();
});

describe("content script dialog lifecycle", () => {
  it("injects the floating button on init", () => {
    expect(getButton()).toBeInstanceOf(HTMLElement);
  });

  it("mounts the React root when the dialog is opened", async () => {
    getButton().click();
    await waitForMountCount(1);

    expect(hostExists()).toBe(true);
    expect(mockMountDialog).toHaveBeenCalledTimes(1);
    // The mount point handed to mountDialog is the shadow-tree root container.
    const mountArg = mockMountDialog.mock.calls[0][0];
    expect(mountArg.id).toBe(MOO_ELEMENT_IDS.root);

    // Clean up: close the dialog (synchronous teardown).
    getButton().click();
  });

  it("invokes the retained unmount handle and removes the host when closed", async () => {
    getButton().click();
    await waitForMountCount(1);

    // Toggle off — teardown runs synchronously in the click handler.
    getButton().click();

    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(hostExists()).toBe(false);
  });

  it("reopens without throwing and mounts a fresh root after a close", async () => {
    // First open + close.
    getButton().click();
    await waitForMountCount(1);
    getButton().click();
    expect(mockMountDialog).toHaveBeenCalledTimes(1);
    expect(mockUnmount).toHaveBeenCalledTimes(1);

    // Reopen — must not throw and must mount a second time.
    expect(() => getButton().click()).not.toThrow();
    await waitForMountCount(2);

    expect(hostExists()).toBe(true);
    expect(mockMountDialog).toHaveBeenCalledTimes(2);

    // Clean up.
    getButton().click();
  });

  it("does not mount when the dialog is closed before the dialog module finishes loading", async () => {
    // Open then immediately close, synchronously — the close runs before the
    // pending dynamic import resolves, detaching the mount point.
    getButton().click(); // open: host attached, module import pending
    getButton().click(); // close: disposeDialogShell removes the host
    expect(hostExists()).toBe(false);

    // Reliable "import resolved" signal instead of a fixed number of ticks:
    // the content script called `import("@/dialog/main")` during the open click
    // above, registering its `.then` race-guard callback. Awaiting the SAME
    // module here queues our continuation strictly after that one (microtask
    // FIFO), so once this resolves the guard has definitely run. If the import
    // had NOT resolved, this await would not resolve either — no false green.
    await import("@/dialog/main");
    await tick();

    // Guard skipped mounting because the mount point was detached.
    expect(mockMountDialog).not.toHaveBeenCalled();

    // Positive control: a clean open in the same test DOES mount — proving the
    // dynamic-import path is functional, so the assertion above reflects a real
    // guard skip and not a silently broken import that never mounts.
    getButton().click();
    await waitForMountCount(1);
    expect(mockMountDialog).toHaveBeenCalledTimes(1);
    getButton().click(); // cleanup close
  });

  it("tears down via teardownMooFamilyUI when the extension context is invalidated", async () => {
    // Open a real dialog first so there is a mounted root + host to tear down.
    getButton().click();
    await waitForMountCount(1);
    expect(hostExists()).toBe(true);

    // Simulate extension-context invalidation: isExtensionContextValid() reads
    // `browser.runtime.id`, so a getter returning undefined makes it false.
    const idSpy = vi
      .spyOn(browser.runtime, "id", "get")
      .mockReturnValue(undefined as unknown as string);
    restoreContextValidity = () => idSpy.mockRestore();

    // Clicking now hits toggleDialog's invalid-context guard → teardownMooFamilyUI,
    // which unmounts the root and runs cleanupMooFamilyUI (removes button + host).
    getButton().click();

    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(hostExists()).toBe(false);
    // cleanupMooFamilyUI also removes the floating button in this path.
    expect(document.getElementById(MOO_ELEMENT_IDS.button)).toBeNull();
    // (afterEach restores the context spy; the next beforeEach re-injects the button.)
  });

  it("survives an unmount-handle error during close without leaving the host attached", async () => {
    mockUnmount.mockImplementationOnce(() => {
      throw new Error("root already detached");
    });

    getButton().click();
    await waitForMountCount(1);

    // Closing must swallow the unmount error and still remove the host DOM.
    expect(() => getButton().click()).not.toThrow();

    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(hostExists()).toBe(false);
  });
});
