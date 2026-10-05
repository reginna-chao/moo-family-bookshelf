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
 * tryScrapeAndCacheEmail (issue #271): visiting Readmoo's `#/me` page caches
 * the profile's email + display name — but those keys describe the STORED user
 * (DISPLAY_NAME_KEY is uploaded with that user's books), so a different Readmoo
 * account visiting in the same browser profile must write nothing.
 *
 * Real hashing and the setup.ts storage mock; the scraper (host-page DOM) is
 * mocked. The comparison awaits a real crypto digest, so "nothing was written"
 * is only asserted once that digest has settled (see settleCachePass).
 */

vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn(),
  scrapeDisplayName: vi.fn(),
}));

import { tryScrapeAndCacheEmail } from "@/content/profileCache";
import { scrapeUserEmail, scrapeDisplayName } from "@/content/scraper";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { USER_ID_KEY, USER_EMAIL_KEY, DISPLAY_NAME_KEY } from "@/constants";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const PAGE_EMAIL = "page-account@example.com";
const PROFILE_DELAY_MS = 1000;

function setHash(hash: string): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${hash}`,
  );
}

let digests: Promise<ArrayBuffer>[] = [];

/** Fire the delayed scrape, then wait for the whole async cache pass to end. */
async function runCachePass(expectHashing: boolean): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  tryScrapeAndCacheEmail();
  vi.advanceTimersByTime(PROFILE_DELAY_MS);
  vi.useRealTimers();
  await settleCachePass(expectHashing);
}

async function settleCachePass(expectHashing: boolean): Promise<void> {
  await vi.waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
  if (expectHashing) {
    await vi.waitFor(() => expect(digests.length).toBeGreaterThan(0));
    await Promise.all(digests);
  }
  // Everything after the digest is microtasks; one macrotask drains them.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("tryScrapeAndCacheEmail", () => {
  let digestSpy: { mockRestore: () => void } | null = null;

  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
    setHash("#/me");
    vi.mocked(scrapeUserEmail).mockReturnValue(PAGE_EMAIL);
    vi.mocked(scrapeDisplayName).mockReturnValue("Page Account");

    // Record every digest so a test can wait for the comparison to finish.
    digests = [];
    const subtle = globalThis.crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    digestSpy = vi
      .spyOn(subtle, "digest")
      .mockImplementation((algorithm, data) => {
        const pending = realDigest(algorithm, data);
        digests.push(pending);
        return pending;
      });
  });

  afterEach(async () => {
    vi.useRealTimers();
    digestSpy?.mockRestore();
    digestSpy = null;
    await chrome.storage.local.clear();
    setHash("");
  });

  it("does not write when a different account is stored", async () => {
    const storedUserId = await deriveUserId("stored-owner@example.com");
    await chrome.storage.local.set({
      [USER_ID_KEY]: storedUserId,
      [USER_EMAIL_KEY]: "stored-owner@example.com",
      [DISPLAY_NAME_KEY]: "Stored Owner",
    });
    vi.mocked(chrome.storage.local.set).mockClear();
    digests = [];

    await runCachePass(true);

    // The comparison really ran on the page's email...
    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(digests).toHaveLength(1);
    // ...and nothing about the stored user was overwritten.
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get([
      USER_EMAIL_KEY,
      DISPLAY_NAME_KEY,
    ]);
    expect(stored).toEqual({
      [USER_EMAIL_KEY]: "stored-owner@example.com",
      [DISPLAY_NAME_KEY]: "Stored Owner",
    });
  });

  it("writes email and display name when the stored account is this one", async () => {
    await chrome.storage.local.set({
      [USER_ID_KEY]: await deriveUserId(PAGE_EMAIL),
    });
    vi.mocked(chrome.storage.local.set).mockClear();
    digests = [];

    await runCachePass(true);

    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [USER_EMAIL_KEY]: PAGE_EMAIL,
      [DISPLAY_NAME_KEY]: "Page Account",
    });
  });

  it("writes email and display name when no account is stored yet", async () => {
    await runCachePass(false);

    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [USER_EMAIL_KEY]: PAGE_EMAIL,
      [DISPLAY_NAME_KEY]: "Page Account",
    });
  });

  it("writes nothing when the profile panel shows no email", async () => {
    vi.mocked(scrapeUserEmail).mockReturnValue(null);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    tryScrapeAndCacheEmail();
    vi.advanceTimersByTime(PROFILE_DELAY_MS);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scrapeUserEmail).toHaveBeenCalledOnce();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("schedules nothing off the #/me page", () => {
    setHash("#/library");
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    tryScrapeAndCacheEmail();

    expect(vi.getTimerCount()).toBe(0);
  });
});
