/** @vitest-environment-options {"url": "https://next.readmoo.com/read/#/library"} */
import { webcrypto } from "node:crypto";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import browser from "webextension-polyfill";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  FAMILY_ID_KEY,
  USER_ID_KEY,
} from "@/constants";
import { BorrowStatus } from "@/api/types";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import {
  setReadmooEmailCookie,
  clearReadmooEmailCookie,
} from "../../helpers/readmooEmailCookie";

/**
 * Regression test for issue #280: a hash trip while the Dialog is open (its own
 * `#/me` account check, a book sync) must not re-inject the floating button or
 * re-fetch `GET /api/family/:id/borrow` for the pending-borrow badge.
 *
 * Harness mirrors `dialogTeardown.test.ts`: the content script entry is
 * imported for real (top-level init + hashchange listener), page-ready resolves
 * immediately, and the code-split dialog module is the aliased `@/dialog/main`
 * replaced by a spy. `fetch` is the only network boundary and is mocked; the
 * login-cookie gate runs the REAL deriveUserId over a real jsdom cookie.
 *
 * Each test starts with a fresh, badged button: storage + the owner's cookie
 * are seeded, then a Dialog-closed hashchange re-injects (the pre-#280 path,
 * which still applies with the Dialog closed) and fetches the count once.
 *
 * Barrier for "no request was sent": a pass-through spy on
 * `crypto.subtle.digest` exposes every userId hash. Both the new offline
 * re-check and the old re-inject path hash the cookie email before deciding,
 * and the old path's fetch follows its hash within microtasks — so once two
 * hashes have settled plus a macrotask hop, a fetch the old code would send
 * has been sent. Verified red against the pre-fix listener (see run report).
 *
 * `tryScrapeAndCacheEmail` arms a 1s timer on `#/me`; the timers created during
 * a dispatch are captured and cleared in afterEach so none outlives its test.
 * The content script's window/storage listeners are module-level; they die
 * with this file's isolated jsdom environment.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
  });
}

const mockUnmount = vi.fn();
const mockMountDialog = vi.fn<
  (container: HTMLElement, options?: unknown) => () => void
>(() => mockUnmount);

vi.mock("@/dialog/main", () => ({
  mountDialog: (container: HTMLElement, options?: unknown) =>
    mockMountDialog(container, options),
}));

vi.mock("@/content/pageReady", () => ({
  waitForPageReady: () => Promise.resolve(),
  PAGE_READY_TIMEOUT_MS: 5000,
}));

// Static import so the vi.mock calls above are hoisted ahead of evaluation.
import "@/content/index";

const BADGE_ID = `${MOO_ELEMENT_IDS.button}-badge`;
const LIBRARY_PATH = "/read/#/library";
const ME_PATH = "/read/#/me";

const OWNER_EMAIL = "owner@example.com";
const OTHER_EMAIL = "someone-else@example.com";
const OWNER_ID = await deriveUserId(OWNER_EMAIL);
const FAMILY_ID = "fam-abc";
const ENDPOINT = "https://test.workers.dev";
const BORROW_URL = `${ENDPOINT}/api/family/${FAMILY_ID}/borrow`;

const WAIT = { timeout: 10_000, interval: 10 };

type Mock = ReturnType<typeof vi.fn>;

const getURLMock = browser.runtime.getURL as unknown as Mock;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

let fetchSpy: Mock;
let digestSpy: MockInstance<SubtleCrypto["digest"]>;
let pendingTimers: ReturnType<typeof setTimeout>[] = [];

const tick = (): Promise<void> => new Promise((r) => originalSetTimeout(r, 0));

function getButton(): HTMLElement | null {
  return document.getElementById(MOO_ELEMENT_IDS.button);
}

function getBadgeText(): string | null {
  return getButton()?.querySelector(`#${BADGE_ID}`)?.textContent ?? null;
}

function borrowFetchCount(): number {
  return fetchSpy.mock.calls.filter(([url]) => url === BORROW_URL).length;
}

/** Navigate within the SPA and fire hashchange; captures timers it arms. */
function navigateTo(path: string): void {
  history.replaceState(null, "", path);
  const timerSpy = vi.spyOn(globalThis, "setTimeout");
  try {
    window.dispatchEvent(new Event("hashchange"));
    for (const result of timerSpy.mock.results) {
      if (result.type === "return") pendingTimers.push(result.value);
    }
  } finally {
    timerSpy.mockRestore();
  }
}

/** Wait until `count` userId hashes have run and settled, then one hop. */
async function settleHashes(count: number): Promise<void> {
  await vi.waitFor(
    () => expect(digestSpy.mock.calls.length).toBeGreaterThanOrEqual(count),
    WAIT,
  );
  await Promise.allSettled(
    digestSpy.mock.results.map((r) => r.value as Promise<unknown>),
  );
  await tick();
  await tick();
}

async function openDialog(): Promise<void> {
  getButton()?.click();
  await vi.waitFor(
    () => expect(mockMountDialog).toHaveBeenCalledTimes(1),
    WAIT,
  );
  expect(document.getElementById(MOO_ELEMENT_IDS.host)).not.toBeNull();
}

beforeAll(async () => {
  getURLMock.mockReturnValue("@/dialog/main");
  // Pre-warm the mocked dialog module so the runtime dynamic import resolves promptly.
  await import("@/dialog/main");
});

beforeEach(async () => {
  vi.clearAllMocks();
  getURLMock.mockReturnValue("@/dialog/main");
  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: [
          {
            requestId: "req-1",
            familyId: FAMILY_ID,
            borrowerId: "borrower",
            borrowerName: "Bob",
            ownerId: OWNER_ID,
            bookId: "book-1",
            bookTitle: "The Test Book",
            bookAuthor: "Author A",
            bookCoverUrl: "https://example.com/cover.jpg",
            status: BorrowStatus.PENDING,
            createdAt: "2026-08-01T00:00:00Z",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  setReadmooEmailCookie(OWNER_EMAIL);
  await browser.storage.local.clear();
  await browser.storage.local.set({
    [USER_ID_KEY]: OWNER_ID,
    [FAMILY_ID_KEY]: FAMILY_ID,
    [AUTH_TOKEN_KEY]: "token-xyz",
    [API_ENDPOINT_KEY]: ENDPOINT,
  });
  // Dialog closed: re-inject and fetch the count once (pre-#280 path).
  navigateTo(LIBRARY_PATH);
  await vi.waitFor(() => expect(getBadgeText()).toBe("1"), WAIT);
  expect(borrowFetchCount()).toBe(1);
  digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
});

afterEach(async () => {
  digestSpy.mockRestore();
  // Close the Dialog through its own toggle, then let a pending import settle.
  if (document.getElementById(MOO_ELEMENT_IDS.host)) getButton()?.click();
  await vi.dynamicImportSettled();
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers = [];
  globalThis.fetch = originalFetch;
  clearReadmooEmailCookie();
  await browser.storage.local.clear();
  history.replaceState(null, "", LIBRARY_PATH);
});

describe("content script hashchange while the Dialog is open (issue #280)", () => {
  it("keeps the button and badge and sends no borrow request across a #/me trip", async () => {
    const button = getButton();
    await openDialog();
    const before = borrowFetchCount();

    navigateTo(ME_PATH);
    navigateTo(LIBRARY_PATH);
    await settleHashes(2);

    expect(borrowFetchCount()).toBe(before);
    expect(getButton()).toBe(button);
    expect(
      document.querySelectorAll(`#${MOO_ELEMENT_IDS.button}`),
    ).toHaveLength(1);
    expect(getBadgeText()).toBe("1");
  });

  it("removes the badge without a request when the page account switched during the trip", async () => {
    const button = getButton();
    await openDialog();
    const before = borrowFetchCount();

    setReadmooEmailCookie(OTHER_EMAIL);
    navigateTo(ME_PATH);
    navigateTo(LIBRARY_PATH);
    await settleHashes(2);

    expect(borrowFetchCount()).toBe(before);
    expect(getButton()).toBe(button);
    expect(getBadgeText()).toBeNull();
  });
});

describe("content script hashchange while the Dialog is closed", () => {
  it("re-injects the button and fetches the badge count again", async () => {
    const button = getButton();
    expect(document.getElementById(MOO_ELEMENT_IDS.host)).toBeNull();

    navigateTo(ME_PATH);

    await vi.waitFor(() => expect(borrowFetchCount()).toBe(2), WAIT);
    await vi.waitFor(() => expect(getBadgeText()).toBe("1"), WAIT);
    expect(getButton()).not.toBeNull();
    expect(getButton()).not.toBe(button);
  });
});
