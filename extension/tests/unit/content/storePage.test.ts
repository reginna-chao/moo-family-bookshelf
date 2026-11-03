import { webcrypto } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import {
  buildStorePageIndex,
  formatStoreChipText,
  formatStoreStaleText,
  STORE_INDEX_MAX_AGE_MS,
} from "moo-family-bookshelf-shared/storePage/index";
import {
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "@/constants";
import { STORE_CHIP_HOST_ID } from "@/content/storePage/chip";
import {
  clearReadmooEmailCookie,
  setRawReadmooEmailCookie,
  setReadmooEmailCookie,
} from "../../helpers/readmooEmailCookie";

/**
 * The Readmoo store-page content script (#313, `content-store.js`, src/content/storePage/): on
 * `/book/{id}` it shows 「{names} 已開放這本書」 right after the book title when EVERY condition holds —
 * a stored userId and familyId, the switch exactly `BoolFlag.TRUE`, the background's host-permission
 * mirror exactly `BoolFlag.TRUE` (a revoked permission leaves an injected script running), a valid
 * index built for that same userId AND familyId that lists the book, and Readmoo's login cookie
 * confirming the stored account (fail-closed: absent, undecodable or another account all hide the
 * chip). The entry runs on import, so each case sets the URL, resets the module registry and imports
 * `@/content/storePage/index` afresh.
 *
 * Page return: the login cookie can change in another tab with no storage change, so the script also
 * re-renders on `visibilitychange` (only when visible), `window` `focus` and `pageshow`. Every module
 * import adds those listeners to the shared jsdom `document` / `window`, so `beforeEach` spies on
 * `addEventListener` (calling through) and `afterEach` removes every listener the script added — a
 * leaked listener from one case would otherwise re-render inside the next.
 *
 * Stale index: once the index is older than `STORE_INDEX_MAX_AGE_DAYS` the chip shows the stale hint
 * instead of names — for ANY book, listed or not (the hint must not reveal what an old index says) —
 * and the login-cookie check still gates it.
 *
 * Closed Shadow Root: the chip lives in a closed root under the light-DOM host `#moo-store-chip-host`,
 * so `host.shadowRoot` is null. The tests reach the root by spying `Element.prototype.attachShadow`
 * (the spy calls through and records the real root) and matching `root.host` to the current host.
 *
 * Clock: the fixture indexes are built from `new Date()` at load time (fresh by construction) or from a
 * time one day past the age limit (stale), so the file never drifts as the calendar moves.
 *
 * Negative-case barrier: a "no chip" assertion is only meaningful once the render has finished, and the
 * cookie check hashes asynchronously. Each negative case therefore seeds a STRAY host with our id first:
 * a finished render with nothing to show removes it, so waiting for its removal is the barrier, and a
 * render that never ran (or bailed early) leaves it behind and fails the case.
 *
 * OWNER_ID is the REAL deriveUserId of OWNER_EMAIL, so the cookie gate runs end to end, not stubbed.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
  });
}

const OWNER_EMAIL = "owner@example.com";
const OTHER_EMAIL = "someone-else@example.com";
// Top-level await: the it.each tables below are built at collection time.
const OWNER_ID = await deriveUserId(OWNER_EMAIL);
const BOOK_ID = "210000000000001";
const OTHER_BOOK_ID = "210000000000002";
const DAY_MS = 24 * 60 * 60 * 1000;
// See the header → "Clock".
const NOW = new Date();
const STALE = new Date(NOW.getTime() - STORE_INDEX_MAX_AGE_MS - DAY_MS);

const FAMILY = "fam-1";

function indexFor(
  viewer: string,
  bookId = BOOK_ID,
  builtAt = NOW,
  familyId = FAMILY,
) {
  return buildStorePageIndex(
    [
      { userId: "user-2", displayName: "小明", books: [{ bookId }] },
      { userId: "user-3", displayName: "小華", books: [{ bookId }] },
    ],
    viewer,
    familyId,
    builtAt,
  );
}

const ELIGIBLE: Record<string, unknown> = {
  [USER_ID_KEY]: OWNER_ID,
  [FAMILY_ID_KEY]: FAMILY,
  [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
  [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.TRUE,
  [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID),
};

const EXPECTED_TEXT = formatStoreChipText(["小明", "小華"]);
const STALE_TEXT = formatStoreStaleText();

type ChangeListener = (
  changes: Record<string, unknown>,
  areaName: string,
) => void;

function spyAttachShadow() {
  return vi.spyOn(Element.prototype, "attachShadow");
}

let attachSpy: ReturnType<typeof spyAttachShadow>;

function mountStorePage(withTitle = true, withMetaBox = true): void {
  const title = withTitle
    ? `<h1 class="book-detail-title">測試書名</h1><div class="author">作者</div>`
    : `<div class="author">作者</div>`;
  document.body.innerHTML = withMetaBox
    ? `<div class="book-meta-box">${title}</div>`
    : title;
}

function host(): HTMLElement | null {
  return document.getElementById(STORE_CHIP_HOST_ID);
}

/** The closed root attached to `el`; see the header → "Closed Shadow Root". */
function rootOf(el: HTMLElement): ShadowRoot | null {
  for (const result of attachSpy.mock.results) {
    if (result.type === "return" && result.value.host === el) {
      return result.value;
    }
  }
  return null;
}

function chip(): HTMLElement | null {
  const current = host();
  if (!current) return null;
  return rootOf(current)?.querySelector<HTMLElement>(".moo-store-chip") ?? null;
}

/** A leftover host; see the header → "Negative-case barrier". */
function seedStrayHost(): void {
  const stray = document.createElement("div");
  stray.id = STORE_CHIP_HOST_ID;
  stray.textContent = "stale";
  document.querySelector(".book-meta-box")?.appendChild(stray);
}

async function runOn(pathname: string): Promise<void> {
  window.history.pushState({}, "", pathname);
  vi.resetModules();
  await import("@/content/storePage/index");
}

async function expectChipText(text: string): Promise<void> {
  await vi.waitFor(() => expect(chip()?.textContent).toBe(text));
}

async function expectNoChip(): Promise<void> {
  await vi.waitFor(() => expect(host()).toBeNull());
}

function storageListener(): ChangeListener {
  const spy = vi.mocked(browser.storage.onChanged.addListener);
  expect(spy).toHaveBeenCalledOnce();
  return spy.mock.calls[0][0] as unknown as ChangeListener;
}

/** Write `items` and fire the content script's listener with them, as the browser would. */
async function changeStorage(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items);
  const changes = Object.fromEntries(
    Object.entries(items).map(([key, value]) => [key, { newValue: value }]),
  );
  storageListener()(changes, "local");
}

function chipStyleInDocument(): boolean {
  return [...document.querySelectorAll("style")].some((style) =>
    style.textContent?.includes("moo-store-chip"),
  );
}

const PAGE_RETURN_EVENTS = ["visibilitychange", "focus", "pageshow"];

let docListenSpy: ReturnType<typeof spyDocumentListen>;
let winListenSpy: ReturnType<typeof spyWindowListen>;

function spyDocumentListen() {
  return vi.spyOn(document, "addEventListener");
}

function spyWindowListen() {
  return vi.spyOn(window, "addEventListener");
}

/** Types of the page-return listeners the script registered; see the header → "Page return". */
function pageReturnListenerTypes(): string[] {
  return [...docListenSpy.mock.calls, ...winListenSpy.mock.calls]
    .map(([type]) => type)
    .filter((type) => PAGE_RETURN_EVENTS.includes(type))
    .sort();
}

function removePageReturnListeners(): void {
  for (const [target, spy] of [
    [document, docListenSpy],
    [window, winListenSpy],
  ] as const) {
    for (const [type, listener, options] of spy.mock.calls) {
      if (!PAGE_RETURN_EVENTS.includes(type)) continue;
      target.removeEventListener(type, listener, options);
    }
    spy.mockRestore();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  attachSpy = spyAttachShadow();
  docListenSpy = spyDocumentListen();
  winListenSpy = spyWindowListen();
  await chrome.storage.local.clear();
  mountStorePage();
  setReadmooEmailCookie(OWNER_EMAIL);
});

afterEach(async () => {
  removePageReturnListeners();
  attachSpy.mockRestore();
  clearReadmooEmailCookie();
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/");
  await chrome.storage.local.clear();
});

describe("store-page chip", () => {
  it("names the family members sharing the book right after the title", async () => {
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}`);

    await expectChipText(EXPECTED_TEXT);
    expect(EXPECTED_TEXT).toBe("小明、小華 已開放這本書");
    const title = document.querySelector("h1.book-detail-title");
    expect(title?.nextElementSibling).toBe(host());
    expect(
      document.querySelectorAll(
        `h1.book-detail-title + #${STORE_CHIP_HOST_ID}`,
      ),
    ).toHaveLength(1);
    expect(chip()?.className).toBe("moo-store-chip");
    expect(document.querySelectorAll(`#${STORE_CHIP_HOST_ID}`)).toHaveLength(1);
  });

  it("keeps the chip in a closed shadow root, styles included", async () => {
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}`);
    await expectChipText(EXPECTED_TEXT);

    const current = host() as HTMLElement;
    expect(attachSpy).toHaveBeenCalledOnce();
    expect(attachSpy).toHaveBeenCalledWith({ mode: "closed" });
    expect(current.shadowRoot).toBeNull();
    // The light DOM holds neither the names nor the chip styles.
    expect(current.textContent).toBe("");
    expect(document.body.textContent).not.toContain("小明");
    expect(rootOf(current)?.querySelector("style")?.textContent).toContain(
      ".moo-store-chip",
    );
    expect(chipStyleInDocument()).toBe(false);
  });

  it("makes the chip text unselectable, so Selection.modify cannot read it out", async () => {
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}`);
    await expectChipText(EXPECTED_TEXT);

    const css =
      rootOf(host() as HTMLElement)?.querySelector("style")?.textContent ?? "";
    const chipRule = /\.moo-store-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    // The unprefixed property must stand on its own, not only inside -webkit-user-select.
    expect(chipRule).toMatch(/(^|[\s;])user-select:\s*none/);
    expect(chipRule).toMatch(/-webkit-user-select:\s*none/);
  });

  it("accepts a trailing slash on the book path", async () => {
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}/`);

    await expectChipText(EXPECTED_TEXT);
  });

  it("falls back to the end of the meta box when the title is missing", async () => {
    mountStorePage(false, true);
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}`);

    await expectChipText(EXPECTED_TEXT);
    expect(document.querySelector(".book-meta-box")?.lastElementChild).toBe(
      host(),
    );
  });

  it("shows nothing, without throwing, when neither title nor meta box exists", async () => {
    mountStorePage(false, false);
    await chrome.storage.local.set(ELIGIBLE);

    await runOn(`/book/${BOOK_ID}`);

    // The root is attached right before placing, so it marks a finished render.
    await vi.waitFor(() => expect(attachSpy).toHaveBeenCalled());
    expect(host()).toBeNull();
  });

  it("sets the names as text, never as markup", async () => {
    const hostile = `<img src=x onerror="alert(1)">`;
    await chrome.storage.local.set({
      ...ELIGIBLE,
      [STORE_PAGE_INDEX_KEY]: buildStorePageIndex(
        [
          {
            userId: "user-2",
            displayName: hostile,
            books: [{ bookId: BOOK_ID }],
          },
        ],
        OWNER_ID,
        FAMILY,
        NOW,
      ),
    });

    await runOn(`/book/${BOOK_ID}`);

    await expectChipText(formatStoreChipText([hostile]));
    expect(chip()?.querySelector("img")).toBeNull();
    expect(rootOf(host() as HTMLElement)?.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  // See the header → "Negative-case barrier".
  it.each<[string, () => void | Promise<void>]>([
    ["the login cookie is missing", () => clearReadmooEmailCookie()],
    ["the login cookie is undecodable", () => setRawReadmooEmailCookie("%%%")],
    [
      "the login cookie names another account",
      () => setReadmooEmailCookie(OTHER_EMAIL),
    ],
    [
      "the index was built for another user",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: indexFor("another-user"),
        }),
    ],
    [
      "a stale index was built for another user",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: indexFor("another-user", BOOK_ID, STALE),
        }),
    ],
    [
      "the switch is off",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE,
        }),
    ],
    [
      "the switch is a raw true",
      () => chrome.storage.local.set({ [STORE_PAGE_CHIP_ENABLED_KEY]: true }),
    ],
    [
      "the index does not list this book",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, OTHER_BOOK_ID),
        }),
    ],
    [
      "the index is malformed",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: { ...indexFor(OWNER_ID), version: 3 },
        }),
    ],
    [
      "the index is a version-1 index (no familyId)",
      () => {
        const v1: Record<string, unknown> = {
          ...indexFor(OWNER_ID),
          version: 1,
        };
        delete v1.familyId;
        return chrome.storage.local.set({ [STORE_PAGE_INDEX_KEY]: v1 });
      },
    ],
    [
      "the index was built for another family",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, BOOK_ID, NOW, "fam-2"),
        }),
    ],
    [
      "a stale index was built for another family",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, BOOK_ID, STALE, "fam-2"),
        }),
    ],
    [
      "the host-permission mirror is absent",
      () => chrome.storage.local.remove(STORE_PAGE_HOST_GRANTED_KEY),
    ],
    [
      "the host-permission mirror is FALSE",
      () =>
        chrome.storage.local.set({
          [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.FALSE,
        }),
    ],
    [
      "the host-permission mirror is a raw true",
      () => chrome.storage.local.set({ [STORE_PAGE_HOST_GRANTED_KEY]: true }),
    ],
    ["there is no family", () => chrome.storage.local.remove(FAMILY_ID_KEY)],
    ["there is no stored user", () => chrome.storage.local.remove(USER_ID_KEY)],
  ])("shows nothing when %s", async (_name, breakCondition) => {
    await chrome.storage.local.set(ELIGIBLE);
    await breakCondition();
    seedStrayHost();

    await runOn(`/book/${BOOK_ID}`);

    await expectNoChip();
  });

  it.each(["/book/abc", `/book/${BOOK_ID}.html`, `/books/${BOOK_ID}`, "/"])(
    "does nothing at all on %s",
    async (pathname) => {
      await chrome.storage.local.set(ELIGIBLE);

      await runOn(pathname);
      await new Promise((r) => setTimeout(r, 20));

      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(browser.storage.onChanged.addListener).not.toHaveBeenCalled();
      expect(pageReturnListenerTypes()).toEqual([]);
      expect(attachSpy).not.toHaveBeenCalled();
      expect(host()).toBeNull();
    },
  );

  // See the header → "Stale index".
  describe("stale index", () => {
    it.each<[string, string]>([
      ["listing this book", BOOK_ID],
      ["not listing this book", OTHER_BOOK_ID],
    ])(
      "shows the stale hint instead of names for an old index %s",
      async (_name, listedBook) => {
        await chrome.storage.local.set({
          ...ELIGIBLE,
          [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, listedBook, STALE),
        });

        await runOn(`/book/${BOOK_ID}`);

        await expectChipText(STALE_TEXT);
        expect(STALE_TEXT).toBe(
          "家人開放資料超過 30 天沒更新，打開家庭書櫃就會更新",
        );
        expect(chip()?.className).toBe("moo-store-chip moo-store-chip--stale");
        expect(document.querySelector("h1.book-detail-title + *")).toBe(host());
        expect(chip()?.textContent).not.toContain("小明");
      },
    );

    // See the header → "Negative-case barrier".
    it.each<[string, () => void]>([
      ["the login cookie is missing", () => clearReadmooEmailCookie()],
      [
        "the login cookie names another account",
        () => setReadmooEmailCookie(OTHER_EMAIL),
      ],
    ])("shows no stale hint when %s", async (_name, breakCookie) => {
      await chrome.storage.local.set({
        ...ELIGIBLE,
        [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, BOOK_ID, STALE),
      });
      breakCookie();
      seedStrayHost();

      await runOn(`/book/${BOOK_ID}`);

      await expectNoChip();
    });
  });

  describe("storage changes while the page is open", () => {
    it("removes the chip when the switch is turned off", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);

      await changeStorage({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE });

      await expectNoChip();
    });

    it("removes the chip when the host permission is revoked (mirror TRUE → FALSE)", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);

      await changeStorage({ [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.FALSE });

      await expectNoChip();
    });

    it("mounts a new host and root after the chip was removed", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      const first = host();
      await changeStorage({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE });
      await expectNoChip();

      await changeStorage({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });

      await expectChipText(EXPECTED_TEXT);
      expect(host()).not.toBe(first);
      expect(attachSpy).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll(`#${STORE_CHIP_HOST_ID}`)).toHaveLength(
        1,
      );
    });

    it("mounts a new host when the page dropped the old one", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      const first = host() as HTMLElement;
      first.remove();

      await changeStorage({ [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID) });

      await expectChipText(EXPECTED_TEXT);
      expect(host()).not.toBe(first);
      expect(attachSpy).toHaveBeenCalledTimes(2);
      expect(document.querySelector("h1.book-detail-title + *")).toBe(host());
    });

    it("adds the chip when the index arrives", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await chrome.storage.local.remove(STORE_PAGE_INDEX_KEY);
      seedStrayHost();
      await runOn(`/book/${BOOK_ID}`);
      await expectNoChip();

      await changeStorage({ [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID) });

      await expectChipText(EXPECTED_TEXT);
    });

    it("updates the names in place without adding a second host", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      const first = host();

      await changeStorage({
        [STORE_PAGE_INDEX_KEY]: buildStorePageIndex(
          [
            {
              userId: "user-4",
              displayName: "阿美",
              books: [{ bookId: BOOK_ID }],
            },
          ],
          OWNER_ID,
          FAMILY,
          NOW,
        ),
      });

      await expectChipText(formatStoreChipText(["阿美"]));
      expect(host()).toBe(first);
      expect(attachSpy).toHaveBeenCalledOnce();
      expect(document.querySelectorAll(`#${STORE_CHIP_HOST_ID}`)).toHaveLength(
        1,
      );
      expect(chipStyleInDocument()).toBe(false);
    });

    it("switches between names and the stale hint in the same host", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      const first = host();

      await changeStorage({
        [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID, BOOK_ID, STALE),
      });
      await expectChipText(STALE_TEXT);
      expect(chip()?.className).toBe("moo-store-chip moo-store-chip--stale");

      await changeStorage({ [STORE_PAGE_INDEX_KEY]: indexFor(OWNER_ID) });
      await expectChipText(EXPECTED_TEXT);
      expect(chip()?.className).toBe("moo-store-chip");
      expect(host()).toBe(first);
      expect(attachSpy).toHaveBeenCalledOnce();
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["an unrelated local key", { "moo:other": { newValue: 1 } }, "local"],
      [
        "a watched key in sync storage",
        { [STORE_PAGE_CHIP_ENABLED_KEY]: { newValue: 0 } },
        "sync",
      ],
    ])("ignores %s", async (_name, changes, area) => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      vi.mocked(chrome.storage.local.get).mockClear();

      storageListener()(changes, area);
      await new Promise((r) => setTimeout(r, 20));

      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(chip()?.textContent).toBe(EXPECTED_TEXT);
    });

    it("removes the chip once the extension context is gone", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      const runtime = browser.runtime as { id?: string };
      const id = runtime.id;

      try {
        runtime.id = undefined;
        storageListener()(
          { [STORE_PAGE_INDEX_KEY]: { newValue: null } },
          "local",
        );

        expect(host()).toBeNull();
      } finally {
        runtime.id = id;
      }
    });
  });

  // See the header → "Page return".
  describe("returning to the page", () => {
    function setVisibility(state: DocumentVisibilityState) {
      return vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue(state);
    }

    async function showChipThenSwitchAccount(): Promise<void> {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);
      setReadmooEmailCookie(OTHER_EMAIL);
    }

    it("listens for visibilitychange, focus and pageshow on a book page", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      await runOn(`/book/${BOOK_ID}`);
      await expectChipText(EXPECTED_TEXT);

      expect(pageReturnListenerTypes()).toEqual([
        "focus",
        "pageshow",
        "visibilitychange",
      ]);
      expect(docListenSpy).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );
      expect(winListenSpy).toHaveBeenCalledWith("focus", expect.any(Function));
      expect(winListenSpy).toHaveBeenCalledWith(
        "pageshow",
        expect.any(Function),
      );
    });

    it("removes the chip on visibilitychange to visible after an account switch in another tab", async () => {
      await showChipThenSwitchAccount();
      const visibility = setVisibility("visible");

      try {
        document.dispatchEvent(new Event("visibilitychange"));

        await expectNoChip();
      } finally {
        visibility.mockRestore();
      }
    });

    it.each(["focus", "pageshow"])(
      "removes the chip on window %s after an account switch in another tab",
      async (type) => {
        await showChipThenSwitchAccount();

        window.dispatchEvent(new Event(type));

        await expectNoChip();
      },
    );

    it("does not re-render on visibilitychange while the page is hidden", async () => {
      await showChipThenSwitchAccount();
      vi.mocked(chrome.storage.local.get).mockClear();
      const visibility = setVisibility("hidden");

      try {
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((r) => setTimeout(r, 20));

        expect(chrome.storage.local.get).not.toHaveBeenCalled();
        expect(chip()?.textContent).toBe(EXPECTED_TEXT);
      } finally {
        visibility.mockRestore();
      }
    });

    it("shows the chip on return once the cookie names the stored account again", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      setReadmooEmailCookie(OTHER_EMAIL);
      seedStrayHost();
      await runOn(`/book/${BOOK_ID}`);
      await expectNoChip();
      setReadmooEmailCookie(OWNER_EMAIL);

      window.dispatchEvent(new Event("focus"));

      await expectChipText(EXPECTED_TEXT);
    });

    it("still renders when registering the page listeners throws", async () => {
      await chrome.storage.local.set(ELIGIBLE);
      docListenSpy.mockImplementation((type, listener, options) => {
        if (type === "visibilitychange") throw new Error("context gone");
        EventTarget.prototype.addEventListener.call(
          document,
          type,
          listener,
          options,
        );
      });

      await expect(runOn(`/book/${BOOK_ID}`)).resolves.toBeUndefined();

      await expectChipText(EXPECTED_TEXT);
    });
  });
});
