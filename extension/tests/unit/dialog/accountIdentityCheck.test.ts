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
 * checkAccountIdentity (issue #271): the boot-time "is the Readmoo account on
 * this page the stored user?" check. Pinned here:
 *
 * - it NEVER rejects — every failure is `unknown`, so the boot cannot hang;
 * - only a `match` is remembered for the page load, keyed by the userId it
 *   confirmed (a `mismatch` / `unknown` must be checked again next time, and a
 *   confirmation for one user must never vouch for another);
 * - forgetAccountConfirmation drops it.
 *
 * Runs the real hash navigation and the real deriveUserId; the scraper (the
 * host page's DOM) is the only mock. "Navigated" is observed as a scrape.
 */

vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn(),
  scrapeDisplayName: vi.fn(),
}));

import {
  checkAccountIdentity,
  markAccountConfirmed,
  forgetAccountConfirmation,
} from "@/dialog/accountIdentityCheck";
import { NAV_SETTLE_MS } from "@/content/hashNavigation";
import { scrapeUserEmail, scrapeDisplayName } from "@/content/scraper";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";

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

/** Run one check through the hash-navigation settle delay. */
async function runCheck(
  storedUserId: string,
  signal?: AbortSignal,
): Promise<string> {
  const pending = checkAccountIdentity(storedUserId, signal);
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

describe("checkAccountIdentity", () => {
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
    setHash("");
  });

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
