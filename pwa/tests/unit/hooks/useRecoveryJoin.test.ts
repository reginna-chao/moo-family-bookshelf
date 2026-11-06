import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCallback, useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { useRecoveryJoin } from "@/hooks/useRecoveryJoin";
import { useSessionApiClient } from "@/hooks/useSessionApiClient";
import {
  USER_ID_KEY,
  namespacedKey,
  useAuth,
  type AuthState,
} from "@/hooks/useAuth";
import { REAUTH_PENDING_KEY } from "@/utils/reauthPendingKey";

/**
 * useRecoveryJoin (PWA, #364): the silent recovery join moved out of App, now storing the token's
 * own expiry.
 *
 * Expiry. A successful join stores the RESPONSE's `expiresAt`; when the response carries none (or
 * an unusable one, which `joinFamily`'s credential check drops), the session has no `expiresAt` key
 * at all — never the old token's value, which would hide the new token's real lifetime from the
 * proactive renewal.
 *
 * Identity. The returned function is a `useCallback` over stable inputs (`authRef`, `login`,
 * `logout`, `setLandingError`), so it keeps one reference across re-renders and across the token
 * swap its own `login` causes. `useSessionApiClient` keys its `useMemo` on it: a new reference would
 * build a new ApiClient and reload every page (#256). The harness wires it exactly as App does, with
 * the real `useAuth`, and observes both the callback and the session client.
 *
 * Session binding. A client re-acquires a token only for the session it belongs to, and a session is
 * `userId` + `familyId` + `apiHost` (token and expiry do not count). The cases below keep a request
 * unanswered, replace the session, and only then answer 401: nothing may go out for the replaced
 * session, and the current session must stay exactly as it was. The join answers are real replies on
 * purpose, so a refresh that did run would change the session rather than just fail. The positive
 * control proves the same wiring does refresh while the session is still current.
 *
 * The join's failure branches are unchanged by the move and stay covered in
 * tests/component/App.test.tsx; `fetch` is the only mock here.
 */

const USER = "a".repeat(64);
const FAMILY = "fam-recovery";
const OLD_TOKEN = "1".repeat(64);
const NEW_TOKEN = "2".repeat(64);
const OLD_EXPIRES_AT = 1_700_000_000_000;
const NEW_EXPIRES_AT = 1_900_000_000_000;

const USER_B = "b".repeat(64);
const TOKEN_B = "3".repeat(64);
const HOST_A = "https://server-a.example.com";
const HOST_B = "https://server-b.example.com";
const SESSION_A: AuthState = {
  userId: USER,
  familyId: FAMILY,
  apiHost: HOST_A,
  authToken: OLD_TOKEN,
};
const NO_PREFS = { hidden: [], favorites: [] };
const PREFS_PATH = `/api/user/${USER}/family-prefs`;

const mockFetch = vi.fn();

function joinReply(data: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { ok: true, ...data } }),
  };
}

function errorReply(status: number, code: string) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message: code } }),
  };
}

function prefsReply() {
  return joinReply(NO_PREFS);
}

/** A fetch answer the test releases later. */
function deferredReply() {
  let resolve!: (reply: unknown) => void;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fetchCall(index: number) {
  return mockFetch.mock.calls.at(index) as [
    string,
    RequestInit & { headers: Record<string, string> },
  ];
}

function isJoinUrl(url: string): boolean {
  return new URL(url).pathname.endsWith("/join");
}

function seedSession(): void {
  localStorage.setItem(USER_ID_KEY, USER);
  localStorage.setItem(namespacedKey(USER, "familyId"), FAMILY);
  localStorage.setItem(namespacedKey(USER, "authToken"), OLD_TOKEN);
  localStorage.setItem(
    namespacedKey(USER, "tokenExpiresAt"),
    String(OLD_EXPIRES_AT),
  );
}

/** App's wiring: real `useAuth`, `authRef` mirroring the session, a `useState` setter. */
function renderRecovery(onLogin = vi.fn()) {
  return renderHook(() => {
    const authApi = useAuth();
    const realLogin = authApi.login;
    const login = useCallback(
      (data: AuthState) => {
        onLogin(data);
        realLogin(data);
      },
      [realLogin],
    );
    const [landingError, setLandingError] = useState("");
    const authRef = useRef(authApi.auth);
    authRef.current = authApi.auth;
    const join = useRecoveryJoin({
      authRef,
      login,
      logout: authApi.logout,
      setLandingError,
    });
    const client = useSessionApiClient(authApi.auth, join);
    return {
      auth: authApi.auth,
      login,
      logout: authApi.logout,
      join,
      client,
      landingError,
      onLogin,
    };
  });
}

/** Sends A's request, replaces A with `next`, and only then answers that request with a 401. */
async function answer401AfterReplacingSession(
  result: ReturnType<typeof renderRecovery>["result"],
  next: AuthState,
  joinAnswer: unknown,
) {
  act(() => {
    result.current.login(SESSION_A);
  });
  const clientA = result.current.client;
  const reply = deferredReply();
  mockFetch.mockImplementation((url: string) =>
    isJoinUrl(url) ? Promise.resolve(joinAnswer) : reply.promise,
  );
  const pending = clientA.updateFamilyPrefs(USER, NO_PREFS);

  act(() => {
    result.current.logout();
  });
  act(() => {
    result.current.login(next);
  });

  let response!: Awaited<typeof pending>;
  await act(async () => {
    reply.resolve(errorReply(401, "UNAUTHORIZED"));
    response = await pending;
  });
  return { clientA, response };
}

describe("useRecoveryJoin", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", mockFetch);
    seedSession();
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("stores the join response's token and expiry, flagged as a recovery join", async () => {
    mockFetch.mockResolvedValueOnce(
      joinReply({ authToken: NEW_TOKEN, expiresAt: NEW_EXPIRES_AT }),
    );
    const { result, unmount } = renderRecovery();
    expect(result.current.auth?.expiresAt).toBe(OLD_EXPIRES_AT);

    let token: string | null = null;
    await act(async () => {
      token = await result.current.join(result.current.auth!);
    });

    expect(token).toBe(NEW_TOKEN);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(new URL(url).pathname).toBe(`/api/family/${FAMILY}/join`);
    expect(JSON.parse(init.body as string)).toEqual({
      userId: USER,
      recovery: 1,
    });
    expect(init.headers["Authorization"]).toBe(`Bearer ${OLD_TOKEN}`);
    expect(result.current.onLogin).toHaveBeenCalledWith({
      userId: USER,
      familyId: FAMILY,
      authToken: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
    });
    expect(localStorage.getItem(namespacedKey(USER, "authToken"))).toBe(
      NEW_TOKEN,
    );
    expect(localStorage.getItem(namespacedKey(USER, "tokenExpiresAt"))).toBe(
      String(NEW_EXPIRES_AT),
    );
    unmount();
  });

  it.each<{ label: string; data: Record<string, unknown> }>([
    { label: "carries no expiry", data: { authToken: NEW_TOKEN } },
    {
      label: "carries an unusable expiry",
      data: { authToken: NEW_TOKEN, expiresAt: "soon" },
    },
  ])(
    "drops the old token's expiry when the join response $label",
    async ({ data }) => {
      mockFetch.mockResolvedValueOnce(joinReply(data));
      const { result, unmount } = renderRecovery();

      await act(async () => {
        await result.current.join(result.current.auth!);
      });

      const written = result.current.onLogin.mock.calls[0][0] as AuthState;
      expect(written).toEqual({
        userId: USER,
        familyId: FAMILY,
        authToken: NEW_TOKEN,
      });
      expect(written).not.toHaveProperty("expiresAt");
      expect(result.current.auth).not.toHaveProperty("expiresAt");
      expect(
        localStorage.getItem(namespacedKey(USER, "tokenExpiresAt")),
      ).toBeNull();
      unmount();
    },
  );

  it("keeps one callback and one session client across re-renders and its own token swap", async () => {
    mockFetch.mockResolvedValueOnce(
      joinReply({ authToken: NEW_TOKEN, expiresAt: NEW_EXPIRES_AT }),
    );
    const { result, rerender, unmount } = renderRecovery();
    const firstJoin = result.current.join;
    const firstClient = result.current.client;

    rerender();
    expect(result.current.join).toBe(firstJoin);

    await act(async () => {
      await result.current.join(result.current.auth!);
    });
    // The swap really re-rendered with the new token.
    expect(result.current.auth?.authToken).toBe(NEW_TOKEN);
    expect(result.current.join).toBe(firstJoin);
    expect(result.current.client).toBe(firstClient);
    unmount();
  });

  it("does not log a logged-out user back in when the old session's client gets a 401", async () => {
    const { result, unmount } = renderRecovery();
    const oldClient = result.current.client;

    act(() => {
      result.current.logout();
    });
    expect(result.current.auth).toBeNull();
    expect(result.current.client).not.toBe(oldClient);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: { code: "UNAUTHORIZED", message: "dead token" },
        }),
    });
    let errorCode: string | undefined;
    await act(async () => {
      const response = await oldClient.updateFamilyPrefs(USER, {
        hidden: [],
        favorites: [],
      });
      errorCode = response.error?.code;
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/user/${USER}/family-prefs`);
    expect(init.method).toBe("PUT");
    expect(errorCode).toBe("UNAUTHORIZED");
    expect(result.current.onLogin).not.toHaveBeenCalled();
    expect(result.current.auth).toBeNull();
    expect(localStorage.getItem(USER_ID_KEY)).toBeNull();
    unmount();
  });

  it.each<{ label: string; next: AuthState }>([
    {
      label: "apiHost",
      next: { ...SESSION_A, apiHost: HOST_B, authToken: TOKEN_B },
    },
    {
      label: "familyId",
      next: { ...SESSION_A, familyId: "fam-other", authToken: TOKEN_B },
    },
    {
      label: "userId",
      next: { ...SESSION_A, userId: USER_B, authToken: TOKEN_B },
    },
  ])(
    "does not refresh for a session that has been replaced by one with another $label",
    async ({ next }) => {
      const { result, unmount } = renderRecovery();

      const { clientA, response } = await answer401AfterReplacingSession(
        result,
        next,
        joinReply({ authToken: NEW_TOKEN, expiresAt: NEW_EXPIRES_AT }),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(response.error?.code).toBe("UNAUTHORIZED");
      expect(result.current.auth).toEqual(next);

      mockFetch.mockResolvedValueOnce(prefsReply());
      await clientA.updateFamilyPrefs(USER, NO_PREFS);
      expect(fetchCall(-1)[1].headers["Authorization"]).toBe(
        `Bearer ${OLD_TOKEN}`,
      );
      unmount();
    },
  );

  it("does not sign out the current session when a replaced session's request gets a 401", async () => {
    const { result, unmount } = renderRecovery();
    const next = { ...SESSION_A, apiHost: HOST_B, authToken: TOKEN_B };

    await answer401AfterReplacingSession(
      result,
      next,
      errorReply(403, "VERIFICATION_REQUIRED"),
    );

    expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    expect(result.current.auth).toEqual(next);
    expect(result.current.landingError).toBe("");
    unmount();
  });

  it("refreshes and resends through the same client while its session is current", async () => {
    const { result, unmount } = renderRecovery();
    act(() => {
      result.current.login(SESSION_A);
    });
    const clientA = result.current.client;
    mockFetch
      .mockResolvedValueOnce(errorReply(401, "UNAUTHORIZED"))
      .mockResolvedValueOnce(
        joinReply({ authToken: NEW_TOKEN, expiresAt: NEW_EXPIRES_AT }),
      )
      .mockResolvedValueOnce(prefsReply());

    let response!: Awaited<ReturnType<typeof clientA.updateFamilyPrefs>>;
    await act(async () => {
      response = await clientA.updateFamilyPrefs(USER, NO_PREFS);
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const joinUrl = new URL(fetchCall(1)[0]);
    expect(joinUrl.origin).toBe(HOST_A);
    expect(joinUrl.pathname).toBe(`/api/family/${FAMILY}/join`);
    const [resendUrl, resendInit] = fetchCall(2);
    expect(new URL(resendUrl).origin).toBe(HOST_A);
    expect(new URL(resendUrl).pathname).toBe(PREFS_PATH);
    expect(resendInit.headers["Authorization"]).toBe(`Bearer ${NEW_TOKEN}`);
    expect(response.error).toBeUndefined();
    expect(result.current.client).toBe(clientA);
    expect(result.current.auth).toEqual({
      ...SESSION_A,
      authToken: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
    });
    unmount();
  });
});
