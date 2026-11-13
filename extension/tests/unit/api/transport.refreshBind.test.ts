import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import { doRefreshToken } from "@/api/auth-refresh";
import { callsTo, fakeNetwork, ok, refused } from "../../helpers/fakeNetwork";

/**
 * The token a refresh hands to `deps.setAuthToken` is bound only to the server
 * the refresh started on, and not at all once that session has ended.
 *
 * `doRefreshToken` is replaced (every other export of `auth-refresh` stays real)
 * so the test decides exactly when the transport's `setAuthToken` callback runs:
 * after `deps.beginSession()`, and either after the client moved to another
 * server or with the client still in place. This reaches an ordering the real
 * refresh guards against with its storage re-read, so what is pinned here is the
 * transport's own binding, independent of that re-read.
 *
 * Everything else is real: `ApiClient`, `ApiTransport` and `TokenSession`. Only
 * `fetch` is faked; every recorded call keeps its origin and bearer token.
 *
 * The companion case (no move) shows that the stand-in is the refresh the
 * transport runs and that its `setAuthToken` does bind, so the no-header
 * assertion cannot pass because the callback never reached the client.
 */

vi.mock("@/api/auth-refresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/auth-refresh")>();
  return { ...actual, doRefreshToken: vi.fn() };
});

const OLD_SERVER = "https://old.example";
const NEW_SERVER = "https://new.example";
const USER = "1".repeat(64);
const OLD_TOKEN = "a".repeat(64);
const REFRESHED = "t";
const BOOKS_PATH = `/api/user/${USER}/books`;

type RefreshDeps = Parameters<typeof doRefreshToken>[0];

/** The first books request on OLD_SERVER gets a 401; everything else succeeds. */
function network() {
  let answered = false;
  return fakeNetwork((call) => {
    if (call.origin === OLD_SERVER && call.path === BOOKS_PATH && !answered) {
      answered = true;
      return refused(401, "UNAUTHORIZED");
    }
    return ok({ userId: USER, books: [] });
  });
}

/** The stand-in refresh: begin the session, optionally move the client, then hand over a token. */
function refreshThat(move: (() => void) | null): void {
  vi.mocked(doRefreshToken).mockImplementation(async (deps: RefreshDeps) => {
    deps.beginSession();
    move?.();
    deps.setAuthToken(REFRESHED);
    return { refreshed: false };
  });
}

describe("ApiTransport refresh token binding", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.mocked(doRefreshToken).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not bind a refresh's token to the server the client moved to", async () => {
    const calls = network();
    const client = new ApiClient(OLD_SERVER);
    client.setAuthToken(OLD_TOKEN);
    refreshThat(() => client.setEndpoint(NEW_SERVER));

    const first = await client.getPersonalBooks(USER);
    await client.getPersonalBooks(USER);

    expect(doRefreshToken).toHaveBeenCalledTimes(1);
    expect(first.error?.code).toBe("UNAUTHORIZED");
    const onNewServer = callsTo(calls, NEW_SERVER);
    expect(onNewServer).toHaveLength(1);
    expect(onNewServer[0].token).toBeUndefined();
  });

  it("binds nothing once the refresh's session ended, even after a move back to its server", async () => {
    const calls = network();
    const client = new ApiClient(OLD_SERVER);
    client.setAuthToken(OLD_TOKEN);
    refreshThat(() => {
      client.setEndpoint(NEW_SERVER);
      client.setEndpoint(OLD_SERVER);
    });

    const first = await client.getPersonalBooks(USER);
    await client.getPersonalBooks(USER);

    expect(doRefreshToken).toHaveBeenCalledTimes(1);
    expect(first.error?.code).toBe("UNAUTHORIZED");
    const onOldServer = callsTo(calls, OLD_SERVER);
    expect(onOldServer.map(({ token }) => token)).toEqual([
      OLD_TOKEN,
      OLD_TOKEN,
    ]);
    expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
  });

  it("binds a refresh's token to its own server when the client stayed put", async () => {
    const calls = network();
    const client = new ApiClient(OLD_SERVER);
    client.setAuthToken(OLD_TOKEN);
    refreshThat(null);

    await client.getPersonalBooks(USER);
    await client.getPersonalBooks(USER);

    expect(doRefreshToken).toHaveBeenCalledTimes(1);
    const onOldServer = callsTo(calls, OLD_SERVER);
    expect(onOldServer.map(({ token }) => token)).toEqual([
      OLD_TOKEN,
      REFRESHED,
      REFRESHED,
    ]);
  });
});
