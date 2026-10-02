/**
 * useSessionApiClient — one ApiClient per login session (#256).
 *
 * Every assertion is made on what the client actually SENDS: `fetch` is the
 * only mock, and the `Authorization` header of a real `ApiClient` request is the
 * observable. The regression case models the failure order from PR #260's
 * review: on logout the family-shelf prefs controller flushes a pending change
 * from a passive-effect cleanup (`useFamilyShelfPrefs` → `detach()`), which runs
 * AFTER the parent's layout effect — so the instance that subtree captured must
 * keep its old token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, useEffect } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { useSessionApiClient } from "@/hooks/useSessionApiClient";
import type { AuthState } from "@/hooks/useAuth";
import type { ApiClient } from "@/api/client";

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const SESSION_A: AuthState = {
  userId: USER_A,
  familyId: "fam-a",
  authToken: "token-a",
};

const mockFetch = vi.fn();

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { books: [] } }),
  };
}

/** Authorization header of the n-th fetch (default: the latest). */
function authHeaderOfCall(index = -1): string | undefined {
  const init = mockFetch.mock.calls.at(index)?.[1] as
    { headers: Record<string, string> } | undefined;
  if (!init) throw new Error("no fetch was made");
  return init.headers["Authorization"];
}

/** Send one authenticated request through `client`, return its header. */
async function authHeaderSentBy(
  client: ApiClient,
): Promise<string | undefined> {
  await client.getPersonalBooks(USER_A);
  return authHeaderOfCall();
}

function renderSession(initial: AuthState | null, refresher = vi.fn()) {
  return renderHook(
    ({ auth }: { auth: AuthState | null }) =>
      useSessionApiClient(auth, refresher),
    { initialProps: { auth: initial } },
  );
}

describe("useSessionApiClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the same instance across a token swap within a session and sends the new token", async () => {
    const { result, rerender } = renderSession(SESSION_A);
    const first = result.current;
    expect(await authHeaderSentBy(first)).toBe("Bearer token-a");

    rerender({ auth: { ...SESSION_A, authToken: "token-a2" } });

    expect(result.current).toBe(first);
    expect(await authHeaderSentBy(first)).toBe("Bearer token-a2");
  });

  it("on logout returns a new instance and leaves the old one authenticating for an unmounting child's cleanup flush", async () => {
    const refresher = vi.fn();
    const pending: Promise<unknown>[] = [];
    const seen: ApiClient[] = [];

    // Stands in for useFamilyShelfPrefs: flushes through the client it captured
    // from a passive-effect cleanup when it unmounts.
    function PrefsConsumer({ client }: { client: ApiClient }) {
      useEffect(() => {
        return () => {
          pending.push(client.getPersonalBooks(USER_A));
        };
      }, [client]);
      return null;
    }
    function Harness({ auth }: { auth: AuthState | null }) {
      const client = useSessionApiClient(auth, refresher);
      seen.push(client);
      return auth ? createElement(PrefsConsumer, { client }) : null;
    }

    const view = render(createElement(Harness, { auth: SESSION_A }));
    const sessionClient = seen.at(-1)!;

    // Logout on the default server: apiHost is undefined before and after.
    await act(async () => {
      view.rerender(createElement(Harness, { auth: null }));
    });
    await Promise.all(pending);

    // The flush the unmounting subtree sent still authenticates.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(authHeaderOfCall()).toBe("Bearer token-a");
    expect(seen.at(-1)).not.toBe(sessionClient);
    view.unmount();
  });

  it.each<[string, AuthState]>([
    ["userId", { ...SESSION_A, userId: USER_B }],
    ["familyId", { ...SESSION_A, familyId: "fam-other" }],
    ["apiHost", { ...SESSION_A, apiHost: "https://self-hosted.example.com" }],
  ])("returns a new instance when the %s changes", (_field, next) => {
    const { result, rerender } = renderSession(SESSION_A);
    const first = result.current;

    rerender({ auth: next });

    expect(result.current).not.toBe(first);
  });

  it("never carries the previous session's token into a new instance (logout, then login as another user)", async () => {
    const { result, rerender } = renderSession(SESSION_A);
    const clientA = result.current;

    rerender({ auth: null });
    const loggedOut = result.current;
    expect(loggedOut).not.toBe(clientA);
    expect(await authHeaderSentBy(loggedOut)).toBeUndefined();

    // QR entry: the session exists before its token has been acquired.
    const sessionB: AuthState = { userId: USER_B, familyId: "fam-b" };
    rerender({ auth: sessionB });
    const clientB = result.current;
    expect(clientB).not.toBe(clientA);
    expect(await authHeaderSentBy(clientB)).toBeUndefined();

    rerender({ auth: { ...sessionB, authToken: "token-b" } });
    expect(result.current).toBe(clientB);
    expect(await authHeaderSentBy(clientB)).toBe("Bearer token-b");
  });

  it("has the token on the client before a child's passive effect first runs", async () => {
    const refresher = vi.fn();
    const pending: Promise<unknown>[] = [];

    // Stands in for a page whose mount effect loads data through the client.
    function LoadOnMount({ client }: { client: ApiClient }) {
      useEffect(() => {
        pending.push(client.getPersonalBooks(USER_A));
      }, [client]);
      return null;
    }
    function Harness({ auth }: { auth: AuthState }) {
      const client = useSessionApiClient(auth, refresher);
      return createElement(LoadOnMount, { client });
    }

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(createElement(Harness, { auth: SESSION_A }));
    });
    await Promise.all(pending);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(authHeaderOfCall()).toBe("Bearer token-a");
    view.unmount();
  });
});
