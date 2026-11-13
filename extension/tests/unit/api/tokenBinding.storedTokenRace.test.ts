import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { ApiClient } from "@/api/client";
import { STORED_SESSION_KEYS, storedTokenFor } from "@/api/tokenBinding";
import { applyStoredSession } from "@/dialog/applyStoredSession";
import { persistSwitchedFamilyEndpoint } from "@/storage/familyEndpointChoice";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  TOKEN_SERVER_KEY,
  USER_ID_KEY,
} from "@/constants";
import { fakeNetwork, ok, refused } from "../../helpers/fakeNetwork";

/**
 * A refreshed token written after another tab switched the family's server is
 * stored with the server that issued it, and no reader uses it on the new one.
 *
 * Everything on the refresh side is real: `ApiClient`, `ApiTransport`,
 * `doRefreshToken` and `storeIssuedToken`. Only `fetch` is faked, and storage is
 * the shared store-backed mock from `tests/setup.ts`.
 *
 * The interleaving: the refresh has already confirmed that storage still pairs
 * its server with the stored token (no await stands between that check and its
 * write), so the switch lands inside the write itself. `set` is overridden ONCE:
 * before the refresh's own items reach the store, the real
 * `persistSwitchedFamilyEndpoint` runs to completion (token keys removed, endpoint
 * written, token keys removed again), then the refresh's items are applied. That
 * is the storage another tab leaves behind when its write lands after the
 * switch's last removal: the new endpoint, plus a token issued by the old server.
 *
 * The reader is the boot read: one `get` of `STORED_SESSION_KEYS` handed to
 * `applyStoredSession`, exactly what `App` does. The companion case runs the
 * same refresh with no switch and shows that the same read does hand the token
 * to the client, so the negative case cannot pass because nothing is read.
 */

const NEW_SERVER = "https://new.example";
const USER = "1".repeat(64);
const FAMILY = "fam-1";
const OLD_TOKEN = "a".repeat(64);
const FRESH_TOKEN = "d".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;
const BOOKS_PATH = `/api/user/${USER}/books`;
const REFRESH_PATH = "/api/auth/refresh";

const OFFICIAL = new ApiClient(DEFAULT_API_ENDPOINT).getEndpoint();

/** The first books request gets a 401; the refresh issues FRESH_TOKEN; the rest succeed. */
function refreshingNetwork(): void {
  let answered = false;
  fakeNetwork((call) => {
    if (call.path === REFRESH_PATH) {
      return ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT });
    }
    if (call.path === BOOKS_PATH && !answered) {
      answered = true;
      return refused(401, "UNAUTHORIZED");
    }
    return ok({ userId: USER, books: [] });
  });
}

async function seedOfficialSession(): Promise<void> {
  await browser.storage.local.set({
    [USER_ID_KEY]: USER,
    [FAMILY_ID_KEY]: FAMILY,
    [AUTH_TOKEN_KEY]: OLD_TOKEN,
  });
}

async function bootRead(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get([...STORED_SESSION_KEYS])) as Record<
    string,
    unknown
  >;
}

describe("a refreshed token stored after a server switch", () => {
  const originalFetch = globalThis.fetch;
  const localSet = vi.mocked(browser.storage.local.set);
  const storeSet = localSet.getMockImplementation()!;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    localSet.mockImplementation(storeSet);
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
  });

  it("is stored with the official marker and not used on the new server", async () => {
    refreshingNetwork();
    await seedOfficialSession();
    const client = new ApiClient(DEFAULT_API_ENDPOINT);
    client.setAuthToken(OLD_TOKEN);
    let switched = false;
    localSet.mockImplementationOnce(async (items) => {
      await persistSwitchedFamilyEndpoint(NEW_SERVER);
      switched = true;
      await storeSet(items);
    });

    await client.getPersonalBooks(USER);

    expect(switched).toBe(true);
    const stored = await bootRead();
    expect(stored[AUTH_TOKEN_KEY]).toBe(FRESH_TOKEN);
    expect(stored[TOKEN_SERVER_KEY]).toBe("official");
    expect(stored[API_ENDPOINT_KEY]).toBe(NEW_SERVER);
    expect(storedTokenFor(stored)).toBeNull();

    const booted = new ApiClient(DEFAULT_API_ENDPOINT);
    const setAuthToken = vi.spyOn(booted, "setAuthToken");
    applyStoredSession(booted, stored);

    expect(booted.getEndpoint()).toBe(NEW_SERVER);
    expect(setAuthToken).not.toHaveBeenCalled();
  });

  it("is stored with the official marker and used when no switch happened", async () => {
    refreshingNetwork();
    await seedOfficialSession();
    const client = new ApiClient(DEFAULT_API_ENDPOINT);
    client.setAuthToken(OLD_TOKEN);

    await client.getPersonalBooks(USER);

    const stored = await bootRead();
    expect(stored[AUTH_TOKEN_KEY]).toBe(FRESH_TOKEN);
    expect(stored[TOKEN_SERVER_KEY]).toBe("official");
    expect(stored[API_ENDPOINT_KEY]).toBeUndefined();
    expect(storedTokenFor(stored)).toBe(FRESH_TOKEN);

    const booted = new ApiClient(DEFAULT_API_ENDPOINT);
    const setAuthToken = vi.spyOn(booted, "setAuthToken");
    applyStoredSession(booted, stored);

    expect(booted.getEndpoint()).toBe(OFFICIAL);
    expect(setAuthToken).toHaveBeenCalledWith(FRESH_TOKEN);
  });
});
