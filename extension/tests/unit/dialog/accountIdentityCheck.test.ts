import { webcrypto } from "node:crypto";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";

/**
 * The "is the Readmoo account on this page the stored user?" check. Pinned here:
 *
 * checkAccountIdentity (issue #271) — the Dialog-open check:
 * - it NEVER rejects — every failure is `unknown`, so the boot cannot hang;
 * - only a `match` is remembered for the page load, keyed by the userId it
 *   confirmed (a `mismatch` / `unknown` must be checked again next time, and a
 *   confirmation for one user must never vouch for another);
 * - forgetAccountConfirmation drops it.
 *
 * verifyAccountIdentity (issue #277) — the pre-upload check every sync runs:
 * - it ALWAYS navigates, even when the cache holds a match (another tab sharing
 *   the cookies may have switched accounts since);
 * - it never rejects; a `match` refreshes the cache, anything else drops it so
 *   the next Dialog open checks afresh.
 *
 * Login-cookie veto (issue #277): after a `#/me` match, a `ReadmooNext.email`
 * cookie naming ANOTHER account turns it into `unknown` and drops the cache. It
 * only vetoes: never `mismatch`, never rescues a `#/me` mismatch, and an
 * unusable cookie never vetoes. It reaches checkAccountIdentity on a cache miss.
 *
 * Runs the real hash navigation, the real deriveUserId and jsdom's real cookie
 * jar; the scraper (the host page's DOM) is the only mock. "Navigated" is
 * observed as a scrape.
 */

vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn(),
  scrapeDisplayName: vi.fn(),
}));

import {
  checkAccountIdentity,
  verifyAccountIdentity,
  markAccountConfirmed,
  forgetAccountConfirmation,
  cachedIdentity,
} from "@/dialog/accountIdentityCheck";
import { NAV_SETTLE_MS } from "@/content/hashNavigation";
import { scrapeUserEmail, scrapeDisplayName } from "@/content/scraper";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import {
  setReadmooEmailCookie,
  setRawReadmooEmailCookie,
  clearReadmooEmailCookie,
} from "../../helpers/readmooEmailCookie";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const EMAIL_A = "account-a@example.com";
const EMAIL_B = "account-b@example.com";

let userA: string;
let userB: string;

beforeAll(async () => {
  userA = await deriveUserId(EMAIL_A);
  userB = await deriveUserId(EMAIL_B);
});

beforeEach(() => {
  vi.clearAllMocks();
  forgetAccountConfirmation();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setHash("#/library");
  // The page is logged in as account A unless a case says otherwise.
  vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_A);
  vi.mocked(scrapeDisplayName).mockReturnValue("A");
});

afterEach(() => {
  vi.useRealTimers();
  forgetAccountConfirmation();
  clearReadmooEmailCookie();
  setHash("");
});

/** Run one Dialog-open check through the hash-navigation settle delay. */
async function runCheck(
  storedUserId: string,
  signal?: AbortSignal,
): Promise<string> {
  const pending = checkAccountIdentity(storedUserId, signal);
  await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
  return pending;
}

/** Run one pre-upload verification through the settle delay. */
async function runVerify(storedUserId: string): Promise<string> {
  const pending = verifyAccountIdentity(storedUserId);
  await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
  return pending;
}

function setHash(hash: string): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${hash}`,
  );
}

/**
 * jsdom queues hashchange on a 0ms timer (bumped to 1ms when armed during a fake
 * tick); deliver it before counting timers.
 */
function deliverHashChanges(): void {
  vi.advanceTimersByTime(1);
}

/** Assert a Dialog-open check is served from the cache: no navigation at all. */
async function expectCachedMatch(storedUserId: string): Promise<void> {
  deliverHashChanges();
  const scrapesBefore = vi.mocked(scrapeUserEmail).mock.calls.length;

  const pending = checkAccountIdentity(storedUserId);
  expect(vi.getTimerCount()).toBe(0);
  expect(location.hash).toBe("#/library");
  await expect(pending).resolves.toBe("match");
  expect(scrapeUserEmail).toHaveBeenCalledTimes(scrapesBefore);
}

describe("checkAccountIdentity", () => {
  it("resolves match for the stored account and puts the page back", async () => {
    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/library");
  });

  it("resolves mismatch when another account is logged in", async () => {
    await expect(runCheck(userB)).resolves.toBe("mismatch");
  });

  it("remembers a match: the next check does not navigate", async () => {
    await runCheck(userA);
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    deliverHashChanges();

    const second = checkAccountIdentity(userA);
    // No settle timer armed and the page never left its hash.
    expect(vi.getTimerCount()).toBe(0);
    expect(location.hash).toBe("#/library");
    await expect(second).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
  });

  it("does not remember a mismatch", async () => {
    await expect(runCheck(userB)).resolves.toBe("mismatch");
    await expect(runCheck(userB)).resolves.toBe("mismatch");

    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
  });

  it("does not remember unknown: a later check can still confirm", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValueOnce(null);
    await expect(runCheck(userA)).resolves.toBe("unknown");

    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
  });

  it("never lets one user's confirmation vouch for another stored user", async () => {
    await expect(runCheck(userA)).resolves.toBe("match");

    // Same page (account A), a different stored user: checked afresh.
    await expect(runCheck(userB)).resolves.toBe("mismatch");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
  });

  it("forgets the confirmation on forgetAccountConfirmation", async () => {
    await runCheck(userA);

    forgetAccountConfirmation();
    vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_B);

    await expect(runCheck(userA)).resolves.toBe("mismatch");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
  });

  it("treats markAccountConfirmed as a match for that user only", async () => {
    markAccountConfirmed(userB);

    await expect(checkAccountIdentity(userB)).resolves.toBe("match");
    expect(scrapeUserEmail).not.toHaveBeenCalled();

    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
  });

  it("resolves unknown (never rejects) when the scrape throws", async () => {
    vi.mocked(scrapeUserEmail).mockImplementation(() => {
      throw new Error("profile panel changed");
    });

    await expect(runCheck(userA)).resolves.toBe("unknown");
    expect(location.hash).toBe("#/library");

    // Not cached: once the panel reads again, the account confirms.
    vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_A);
    await expect(runCheck(userA)).resolves.toBe("match");
  });

  it("resolves unknown (never rejects) when hashing fails", async () => {
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("no crypto"));

    try {
      await expect(runCheck(userA)).resolves.toBe("unknown");
    } finally {
      digest.mockRestore();
    }
  });

  it("resolves unknown when aborted mid-check, and caches nothing", async () => {
    const controller = new AbortController();

    const pending = checkAccountIdentity(userA, controller.signal);
    expect(location.hash).toBe("#/me");
    controller.abort();

    await expect(pending).resolves.toBe("unknown");
    expect(location.hash).toBe("#/library");
    deliverHashChanges();
    expect(vi.getTimerCount()).toBe(0);
    expect(scrapeUserEmail).not.toHaveBeenCalled();

    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
  });
});

describe("verifyAccountIdentity", () => {
  it("catches an account switch after a cached match and drops the cache (#277)", async () => {
    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();

    // Another tab switches the shared Readmoo login to account B.
    vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_B);

    await expect(runVerify(userA)).resolves.toBe("mismatch");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
    expect(location.hash).toBe("#/library");

    // The stale match is gone: the next Dialog-open check navigates again.
    await expect(runCheck(userA)).resolves.toBe("mismatch");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(3);
  });

  it("navigates even when the cache holds a match, and keeps it on a match", async () => {
    markAccountConfirmed(userA);

    const pending = verifyAccountIdentity(userA);
    expect(location.hash).toBe("#/me");
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);

    await expect(pending).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/library");
    await expectCachedMatch(userA);
  });

  it("records a match for the next Dialog-open check", async () => {
    await expect(runVerify(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();

    await expectCachedMatch(userA);
  });

  it.each([
    [
      "no email is on the profile panel",
      () => vi.mocked(scrapeUserEmail).mockReturnValueOnce(null),
    ],
    [
      "the scrape throws",
      () =>
        vi.mocked(scrapeUserEmail).mockImplementationOnce(() => {
          throw new Error("profile panel changed");
        }),
    ],
  ])(
    "resolves unknown and drops a cached match when %s",
    async (_case, breakScrape) => {
      await expect(runCheck(userA)).resolves.toBe("match");
      breakScrape();

      await expect(runVerify(userA)).resolves.toBe("unknown");
      expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
      expect(location.hash).toBe("#/library");

      // Cache dropped: the Dialog-open check navigates (and now confirms).
      await expect(runCheck(userA)).resolves.toBe("match");
      expect(scrapeUserEmail).toHaveBeenCalledTimes(3);
    },
  );

  it("resolves unknown when aborted, and drops a cached match", async () => {
    markAccountConfirmed(userA);
    const controller = new AbortController();

    const pending = verifyAccountIdentity(userA, controller.signal);
    expect(location.hash).toBe("#/me");
    controller.abort();

    await expect(pending).resolves.toBe("unknown");
    expect(location.hash).toBe("#/library");
    deliverHashChanges();
    expect(vi.getTimerCount()).toBe(0);
    expect(scrapeUserEmail).not.toHaveBeenCalled();

    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
  });

  it("vetoes a #/me match to unknown when the login cookie names another account, and drops the cache", async () => {
    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();

    // `#/me` still shows A (stale SPA profile), but the cookies moved on to B.
    setReadmooEmailCookie(EMAIL_B);

    await expect(runVerify(userA)).resolves.toBe("unknown");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
    expect(location.hash).toBe("#/library");

    // Cache dropped: the Dialog-open check navigates again (and, with the
    // cookie gone, confirms).
    clearReadmooEmailCookie();
    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(3);
  });

  it("keeps a #/me match and the cache when the login cookie names the stored account", async () => {
    setReadmooEmailCookie(EMAIL_A);

    await expect(runVerify(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/library");
    await expectCachedMatch(userA);
  });

  it("does not veto when the login cookie cannot be decoded", async () => {
    setRawReadmooEmailCookie("not-base64!!");
    expect(document.cookie).toContain("not-base64!!");

    await expect(runVerify(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    await expectCachedMatch(userA);
  });

  it("never lets the login cookie rescue a #/me mismatch", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_B);
    setReadmooEmailCookie(EMAIL_A);

    await expect(runVerify(userA)).resolves.toBe("mismatch");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/library");
  });

  it("applies the cookie veto to a Dialog-open check on a cache miss", async () => {
    setReadmooEmailCookie(EMAIL_B);

    await expect(runCheck(userA)).resolves.toBe("unknown");
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/library");

    // Nothing cached: once the cookie agrees again, the next open confirms.
    setReadmooEmailCookie(EMAIL_A);
    await expect(runCheck(userA)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
  });
});

/**
 * cachedIdentity (issue #284) — onboarding's hand-off to App: it reports the
 * latest verifyAccountIdentity `mismatch` for that userId only, never
 * navigates, and is cleared by any later result or reset. A remembered
 * mismatch never lets checkAccountIdentity skip the navigation.
 */
describe("cachedIdentity", () => {
  /** Page on account A, stored user B: the latest verify finds a mismatch. */
  async function rememberMismatchForB(): Promise<void> {
    await expect(runVerify(userB)).resolves.toBe("mismatch");
  }

  it("reports a verify mismatch for that userId only, without navigating", async () => {
    await rememberMismatchForB();
    deliverHashChanges();
    const scrapes = vi.mocked(scrapeUserEmail).mock.calls.length;

    expect(cachedIdentity(userB)).toBe("mismatch");
    expect(cachedIdentity(userA)).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
    expect(location.hash).toBe("#/library");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(scrapes);
  });

  it("reports unknown when nothing was checked, and match once confirmed", async () => {
    expect(cachedIdentity(userA)).toBe("unknown");

    await expect(runVerify(userA)).resolves.toBe("match");
    expect(cachedIdentity(userA)).toBe("match");
    expect(cachedIdentity(userB)).toBe("unknown");
  });

  it.each<[string, () => Promise<void> | void, "match" | "unknown"]>([
    [
      "a later verify for B resolves match (page switched to B)",
      async () => {
        vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_B);
        await expect(runVerify(userB)).resolves.toBe("match");
      },
      "match",
    ],
    [
      "a later verify for B resolves unknown",
      async () => {
        vi.mocked(scrapeUserEmail).mockReturnValueOnce(null);
        await expect(runVerify(userB)).resolves.toBe("unknown");
      },
      "unknown",
    ],
    [
      "a later verify for another user resolves match",
      async () => {
        await expect(runVerify(userA)).resolves.toBe("match");
      },
      "unknown",
    ],
    [
      "markAccountConfirmed runs for another user",
      () => markAccountConfirmed(userA),
      "unknown",
    ],
    [
      "forgetAccountConfirmation runs",
      () => forgetAccountConfirmation(),
      "unknown",
    ],
  ])("drops the remembered mismatch when %s", async (_case, then, expected) => {
    await rememberMismatchForB();
    expect(cachedIdentity(userB)).toBe("mismatch");

    await then();

    expect(cachedIdentity(userB)).toBe(expected);
  });

  it("never lets checkAccountIdentity return a remembered mismatch without navigating", async () => {
    await rememberMismatchForB();
    expect(scrapeUserEmail).toHaveBeenCalledOnce();

    // Account B logs in on the page: a fresh #/me read must see it.
    vi.mocked(scrapeUserEmail).mockReturnValue(EMAIL_B);

    await expect(runCheck(userB)).resolves.toBe("match");
    expect(scrapeUserEmail).toHaveBeenCalledTimes(2);
    expect(cachedIdentity(userB)).toBe("match");
  });
});
