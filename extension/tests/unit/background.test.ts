import { describe, it, expect, vi, beforeEach } from "vitest";
import browser, { type Runtime } from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  FAMILY_ID_KEY,
  USER_EMAIL_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_INDEX_KEY,
} from "@/constants";

/**
 * Tests for the background service worker message handlers.
 * Validates message dispatch (only OPEN_OPTIONS_PAGE is handled; familyId
 * messages were removed in #484) and the store-page chip wiring.
 *
 * Messaging contract (webextension-polyfill): the onMessage listener is an
 * async function that RETURNS a Promise resolving to the response object. There
 * is no Chrome `sendResponse` callback and no `return true`. These tests capture
 * the registered listener, invoke it with `(message, sender)`, and await the
 * returned Promise for the response. The capture casts its fn to the spy's own
 * (normalized) parameter type: the polyfill's addListener accepts the
 * OnMessageListener union, our promise-returning MessageListener is
 * structurally the async variant, and vitest's mockImplementation wants the
 * spy's signature rather than the raw polyfill type.
 *
 * Storage contract: production uses promise-based `browser.storage.*` (get/set/
 * remove resolve a Promise). The mock spies are shared with `chrome.*` (see
 * tests/setup.ts); this file views them through the `browser.*` namespace so the
 * promise-native polyfill types line up with production. Storage writes take a
 * single argument (no trailing callback). Storage reads/writes use the
 * `moo:`-prefixed key constants.
 *
 * Store-page chip (#313): `@/background/storePageScript` is mocked with a stable spy, so these cases
 * pin only the WIRING (which event re-runs the reconcile) and stay independent of the reconcile's own
 * async storage work — the synchronous `remove` count in "runtime.onInstalled" would otherwise depend
 * on microtask timing. The reconcile itself is covered by tests/unit/background/storePageScript.test.ts.
 */

const reconcileStorePageScript = vi.hoisted(() => vi.fn());
vi.mock("@/background/storePageScript", () => ({
  reconcileStorePageScript,
}));

type MessageListener = (
  message: unknown,
  sender: Runtime.MessageSender,
) => Promise<unknown> | undefined;

let listener: MessageListener;

function sendMessage(message: unknown): Promise<Record<string, unknown>> {
  return Promise.resolve(
    listener(message, {} as Runtime.MessageSender),
  ) as Promise<Record<string, unknown>>;
}

describe("background service worker", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset storage mocks to empty state (promise-based).
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue();
    vi.mocked(browser.storage.local.remove).mockResolvedValue();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue();
    vi.mocked(browser.storage.sync.remove).mockResolvedValue();
    reconcileStorePageScript.mockResolvedValue(undefined);

    // Capture the module's onMessage listener; the cast targets the spy's own
    // signature. See the header → "Messaging contract".
    const addListenerMock = vi.mocked(browser.runtime.onMessage.addListener);
    addListenerMock.mockImplementation(((fn: MessageListener) => {
      listener = fn;
    }) as Parameters<typeof addListenerMock.mockImplementation>[0]);

    // Side-effect import: registers onMessage listener
    await import("@/background/index");
  });

  describe("unhandled message types", () => {
    // Retired types (moved to direct storage.local access, or removed with no sender, #366),
    // non-object messages and prototype-chain names are all ignored by the listener.
    it.each<{ name: string; message: unknown }>([
      {
        name: "GET_AUTO_SYNC_INTERVAL",
        message: { type: "GET_AUTO_SYNC_INTERVAL" },
      },
      {
        name: "SET_AUTO_SYNC_INTERVAL",
        message: { type: "SET_AUTO_SYNC_INTERVAL", interval: "never" },
      },
      { name: "GET_SYNC_ARCHIVED", message: { type: "GET_SYNC_ARCHIVED" } },
      {
        name: "SET_SYNC_ARCHIVED",
        message: { type: "SET_SYNC_ARCHIVED", syncArchived: 1 },
      },
      {
        name: "GET_FLOATING_ICON_SIZE",
        message: { type: "GET_FLOATING_ICON_SIZE" },
      },
      {
        name: "SET_FLOATING_ICON_SIZE",
        message: { type: "SET_FLOATING_ICON_SIZE", size: "large" },
      },
      {
        name: "GET_BOOK_SORT",
        message: { type: "GET_BOOK_SORT", shelf: "family" },
      },
      {
        name: "SET_BOOK_SORT",
        message: {
          type: "SET_BOOK_SORT",
          shelf: "personal",
          sort: "title-asc",
        },
      },
      { name: "NOT_A_REAL_MESSAGE", message: { type: "NOT_A_REAL_MESSAGE" } },
      { name: "GET_FAMILY_ID (removed)", message: { type: "GET_FAMILY_ID" } },
      {
        name: "GET_API_ENDPOINT (removed)",
        message: { type: "GET_API_ENDPOINT" },
      },
      {
        name: "SET_API_ENDPOINT (removed), reverting",
        message: { type: "SET_API_ENDPOINT", apiEndpoint: null },
      },
      {
        name: "SET_API_ENDPOINT (removed), with a URL",
        message: {
          type: "SET_API_ENDPOINT",
          apiEndpoint: "https://custom.workers.dev",
        },
      },
      {
        name: "SET_SYNC_ERROR_BADGE (removed)",
        message: { type: "SET_SYNC_ERROR_BADGE" },
      },
      {
        name: "CLEAR_SYNC_ERROR_BADGE (removed)",
        message: { type: "CLEAR_SYNC_ERROR_BADGE" },
      },
      {
        name: "SET_FAMILY_ID (removed, #484)",
        message: { type: "SET_FAMILY_ID", familyId: "fam-late" },
      },
      {
        name: "CLEAR_FAMILY_ID (removed, #484)",
        message: { type: "CLEAR_FAMILY_ID" },
      },
      { name: "a null message", message: null },
      { name: "an undefined message", message: undefined },
      { name: "a string message", message: "SET_FAMILY_ID" },
      { name: "a number message", message: 42 },
      { name: "an object with no type", message: {} },
      { name: "a non-string type", message: { type: 42 } },
      { name: "the prototype name toString", message: { type: "toString" } },
      { name: "the prototype name __proto__", message: { type: "__proto__" } },
      {
        name: "the prototype name constructor",
        message: { type: "constructor" },
      },
    ])(
      "returns undefined for $name without throwing or touching storage",
      ({ message }) => {
        let response: unknown = "not called";
        expect(() => {
          response = listener(message, {} as Runtime.MessageSender);
        }).not.toThrow();

        expect(response).toBeUndefined();
        expect(browser.storage.local.get).not.toHaveBeenCalled();
        expect(browser.storage.local.set).not.toHaveBeenCalled();
        expect(browser.storage.local.remove).not.toHaveBeenCalled();
        expect(browser.storage.sync.set).not.toHaveBeenCalled();
        expect(browser.storage.sync.remove).not.toHaveBeenCalled();
      },
    );

    // Backs the table's "returns undefined" half: the listener still dispatches a registered type.
    // The storage spies' wiring is pinned by "runtime.onInstalled" → "purges both stored email keys".
    it("still answers a registered message type (positive companion)", async () => {
      const response = listener(
        { type: "OPEN_OPTIONS_PAGE" },
        {} as Runtime.MessageSender,
      );

      expect(response).toBeInstanceOf(Promise);
      await expect(response).resolves.toEqual({ ok: 1 });
      expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
    });
  });

  describe("runtime.onInstalled", () => {
    it("purges both stored email keys in one storage call (#359)", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const addListener = vi.mocked(browser.runtime.onInstalled.addListener);
        expect(addListener).toHaveBeenCalledOnce();
        const onInstalled = addListener.mock.calls[0][0] as () => void;
        expect(browser.storage.local.remove).not.toHaveBeenCalled();

        onInstalled();

        expect(browser.storage.local.remove).toHaveBeenCalledOnce();
        // "userEmail" is the legacy unprefixed key; production does not export it.
        expect(browser.storage.local.remove).toHaveBeenCalledWith([
          USER_EMAIL_KEY,
          "userEmail",
        ]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("also reconciles the store-page script (#313)", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const addListener = vi.mocked(browser.runtime.onInstalled.addListener);
        const onInstalled = addListener.mock.calls[0][0] as () => void;
        expect(reconcileStorePageScript).not.toHaveBeenCalled();

        onInstalled();

        expect(reconcileStorePageScript).toHaveBeenCalledOnce();
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // See the header → "Store-page chip".
  describe("store-page chip wiring (#313)", () => {
    /** The single listener background/index registered on `addListener`. */
    function onlyListener<T>(addListener: unknown): T {
      const spy = vi.mocked(addListener as (fn: T) => void);
      expect(spy).toHaveBeenCalledOnce();
      return spy.mock.calls[0][0];
    }

    it.each([
      ["runtime.onStartup", () => browser.runtime.onStartup.addListener],
      ["permissions.onAdded", () => browser.permissions.onAdded.addListener],
      [
        "permissions.onRemoved",
        () => browser.permissions.onRemoved.addListener,
      ],
    ])("re-runs the reconcile on %s", (_name, addListenerOf) => {
      const fire = onlyListener<() => void>(addListenerOf());
      expect(reconcileStorePageScript).not.toHaveBeenCalled();

      fire();

      expect(reconcileStorePageScript).toHaveBeenCalledOnce();
    });

    type ChangeListener = (
      changes: Record<string, unknown>,
      areaName: string,
    ) => void;

    it.each([
      [
        "the local switch key changes",
        { [STORE_PAGE_CHIP_ENABLED_KEY]: { newValue: BoolFlag.TRUE } },
      ],
      [
        "the local index is written",
        { [STORE_PAGE_INDEX_KEY]: { newValue: {} } },
      ],
      [
        "the switch is turned off (no newValue on the index side)",
        {
          [STORE_PAGE_CHIP_ENABLED_KEY]: {
            oldValue: BoolFlag.TRUE,
            newValue: BoolFlag.FALSE,
          },
        },
      ],
    ])("re-runs the reconcile once when %s", (_name, changes) => {
      const onChanged = onlyListener<ChangeListener>(
        browser.storage.onChanged.addListener,
      );

      onChanged(changes, "local");

      expect(reconcileStorePageScript).toHaveBeenCalledOnce();
    });

    it.each([
      [
        "an index removal (oldValue only)",
        { [STORE_PAGE_INDEX_KEY]: { oldValue: {} } },
        "local",
      ],
      [
        "an unrelated local key",
        { [FAMILY_ID_KEY]: { newValue: "fam-1" } },
        "local",
      ],
      [
        "the switch key in sync storage",
        { [STORE_PAGE_CHIP_ENABLED_KEY]: { newValue: BoolFlag.TRUE } },
        "sync",
      ],
      [
        "an index write in sync storage",
        { [STORE_PAGE_INDEX_KEY]: { newValue: {} } },
        "sync",
      ],
    ])("ignores %s", (_name, changes, area) => {
      const onChanged = onlyListener<ChangeListener>(
        browser.storage.onChanged.addListener,
      );

      onChanged(changes, area);

      expect(reconcileStorePageScript).not.toHaveBeenCalled();
    });

    it("opens the options page when the toolbar icon is clicked", () => {
      const onClicked = onlyListener<() => void>(
        browser.action.onClicked.addListener,
      );
      expect(browser.runtime.openOptionsPage).not.toHaveBeenCalled();

      onClicked();

      expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
    });

    it("answers OPEN_OPTIONS_PAGE by opening the options page", async () => {
      const response = await sendMessage({ type: "OPEN_OPTIONS_PAGE" });

      expect(response).toEqual({ ok: 1 });
      expect(browser.runtime.openOptionsPage).toHaveBeenCalledOnce();
      // The options page owns the permission prompt; the message itself grants nothing.
      expect(browser.permissions.request).not.toHaveBeenCalled();
    });
  });
});
