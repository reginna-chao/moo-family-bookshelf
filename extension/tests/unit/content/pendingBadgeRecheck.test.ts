/** @vitest-environment-options {"url": "https://next.readmoo.com/read/#/library"} */
import { webcrypto } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";
import { AUTH_TOKEN_KEY, FAMILY_ID_KEY, USER_ID_KEY } from "@/constants";
import {
  recheckBadgeAccount,
  recheckBadgeIfDialogOpen,
} from "@/content/pendingBorrowBadge";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import {
  setReadmooEmailCookie,
  clearReadmooEmailCookie,
} from "../../helpers/readmooEmailCookie";

/**
 * Offline badge re-check used while the Dialog is open (issue #280).
 *
 * `recheckBadgeAccount` must never send a request: it reads the stored userId
 * and family binding (familyId + authToken) and removes the badge unless the
 * binding is intact AND Readmoo's login cookie confirms that account — any
 * doubt (another account, no cookie, no userId, a binding cleared by leaving
 * the family, an unreadable store, a failed hash) removes it. `recheckBadgeIfDialogOpen` is the
 * hashchange gate: it claims the event (returns true, keeps the button) only
 * when the extension context is valid, the page is a Readmoo app path, and both
 * the floating button and the Dialog host are in the DOM; otherwise it returns
 * false and touches nothing, so the content script re-injects as before.
 *
 * The jsdom URL is next.readmoo.com/read/ so the app-path guard is exercised
 * against the real host rule; the "not an app path" case moves to the sign-in
 * path with history.replaceState and afterEach moves back. The userIds are the
 * REAL deriveUserId of the emails, so the cookie gate is not stubbed.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
  });
}

const BADGE_ID = `${MOO_ELEMENT_IDS.button}-badge`;
const APP_PATH = "/read/#/library";
const SIGNIN_PATH = "/zh-TW/auth/signin";

const OWNER_EMAIL = "owner@example.com";
const OTHER_EMAIL = "someone-else@example.com";
const OWNER_ID = await deriveUserId(OWNER_EMAIL);

type Mock = ReturnType<typeof vi.fn>;

const storageGet = browser.storage.local.get as unknown as Mock;
const originalFetch = globalThis.fetch;

let button: HTMLElement;
let host: HTMLElement;
let fetchSpy: Mock;
let restoreContextValidity: (() => void) | null = null;

function getBadge(): HTMLElement | null {
  return button.querySelector<HTMLElement>(`#${BADGE_ID}`);
}

/** A number left on the button (by the fetch or the Dialog's live count). */
function seedBadge(text = "9"): void {
  const badge = document.createElement("span");
  badge.id = BADGE_ID;
  badge.textContent = text;
  button.appendChild(badge);
}

beforeEach(async () => {
  vi.clearAllMocks();
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  button = document.createElement("button");
  button.id = MOO_ELEMENT_IDS.button;
  document.body.appendChild(button);
  host = document.createElement("div");
  host.id = MOO_ELEMENT_IDS.host;
  document.body.appendChild(host);
  seedBadge();
  setReadmooEmailCookie(OWNER_EMAIL);
  await browser.storage.local.clear();
  await browser.storage.local.set({
    [USER_ID_KEY]: OWNER_ID,
    [FAMILY_ID_KEY]: "fam-abc",
    [AUTH_TOKEN_KEY]: "tok-abc",
  });
  // The seeding calls above must not count as the code under test's reads.
  storageGet.mockClear();
});

afterEach(async () => {
  restoreContextValidity?.();
  restoreContextValidity = null;
  globalThis.fetch = originalFetch;
  clearReadmooEmailCookie();
  button.remove();
  host.remove();
  history.replaceState(null, "", APP_PATH);
  await browser.storage.local.clear();
});

describe("recheckBadgeAccount", () => {
  it("keeps the badge when the login cookie confirms the stored user", async () => {
    await expect(recheckBadgeAccount(button)).resolves.toBeUndefined();

    expect(getBadge()?.textContent).toBe("9");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads only the stored userId and family binding from storage", async () => {
    await recheckBadgeAccount(button);

    expect(storageGet).toHaveBeenCalledTimes(1);
    expect(storageGet).toHaveBeenCalledWith([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
    ]);
  });

  // Leaving the family (clearStoredFamilyBinding) drops familyId + authToken but keeps userId.
  it.each([
    { name: "familyId", keys: [FAMILY_ID_KEY] },
    { name: "authToken", keys: [AUTH_TOKEN_KEY] },
    { name: "familyId and authToken", keys: [FAMILY_ID_KEY, AUTH_TOKEN_KEY] },
  ])(
    "removes the badge without a request when leaving the family cleared $name, even though the cookie confirms the stored user",
    async ({ keys }) => {
      await browser.storage.local.remove(keys);

      await expect(recheckBadgeAccount(button)).resolves.toBeUndefined();

      expect(getBadge()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  const REMOVED_CASES: Array<{ name: string; arrange: () => Promise<void> }> = [
    {
      name: "another Readmoo account is logged in on the page",
      arrange: async () => setReadmooEmailCookie(OTHER_EMAIL),
    },
    {
      name: "the page has no login cookie",
      arrange: async () => clearReadmooEmailCookie(),
    },
    {
      name: "no userId is stored",
      arrange: async () => {
        await browser.storage.local.remove(USER_ID_KEY);
      },
    },
    {
      name: "the stored userId is an empty string",
      arrange: async () => {
        await browser.storage.local.set({ [USER_ID_KEY]: "" });
      },
    },
  ];

  it.each(REMOVED_CASES)(
    "removes the badge without a request when $name",
    async ({ arrange }) => {
      await arrange();

      await expect(recheckBadgeAccount(button)).resolves.toBeUndefined();

      expect(getBadge()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("removes the badge and resolves when the storage read rejects", async () => {
    storageGet.mockRejectedValueOnce(
      new Error("extension context invalidated"),
    );

    await expect(recheckBadgeAccount(button)).resolves.toBeUndefined();

    expect(getBadge()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removes the badge and resolves when hashing the cookie email fails", async () => {
    // The owner's own cookie: only the failed hash stands between it and a match.
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("no crypto"));

    try {
      await expect(recheckBadgeAccount(button)).resolves.toBeUndefined();
      expect(digest).toHaveBeenCalledOnce();
    } finally {
      digest.mockRestore();
    }
    expect(getBadge()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("recheckBadgeIfDialogOpen", () => {
  it("claims the hashchange and re-checks the badge offline when the Dialog is open", async () => {
    // Another account's cookie, so a re-check that actually ran shows up as removal.
    setReadmooEmailCookie(OTHER_EMAIL);

    expect(recheckBadgeIfDialogOpen()).toBe(true);

    // Same element kept in place, and the re-check started synchronously.
    expect(document.getElementById(MOO_ELEMENT_IDS.button)).toBe(button);
    expect(storageGet).toHaveBeenCalledWith([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
    ]);
    await vi.waitFor(() => expect(getBadge()).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const DECLINED_CASES: Array<{ name: string; arrange: () => void }> = [
    { name: "the Dialog host is absent", arrange: () => host.remove() },
    { name: "the floating button is absent", arrange: () => button.remove() },
    {
      name: "the page is not a Readmoo app path",
      arrange: () => history.replaceState(null, "", SIGNIN_PATH),
    },
    {
      name: "the extension context is invalid",
      arrange: () => {
        const idSpy = vi
          .spyOn(browser.runtime, "id", "get")
          .mockReturnValue(undefined as unknown as string);
        restoreContextValidity = () => idSpy.mockRestore();
      },
    },
  ];

  it.each(DECLINED_CASES)(
    "returns false and touches nothing when $name",
    ({ arrange }) => {
      // A re-check that wrongly ran would read storage synchronously.
      setReadmooEmailCookie(OTHER_EMAIL);
      arrange();

      expect(recheckBadgeIfDialogOpen()).toBe(false);

      expect(storageGet).not.toHaveBeenCalled();
      expect(getBadge()?.textContent).toBe("9");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
