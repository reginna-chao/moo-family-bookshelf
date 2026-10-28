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
 * The join's failure branches are unchanged by the move and stay covered in
 * tests/component/App.test.tsx; `fetch` is the only mock here.
 */

const USER = "a".repeat(64);
const FAMILY = "fam-recovery";
const OLD_TOKEN = "1".repeat(64);
const NEW_TOKEN = "2".repeat(64);
const OLD_EXPIRES_AT = 1_700_000_000_000;
const NEW_EXPIRES_AT = 1_900_000_000_000;

const mockFetch = vi.fn();

function joinReply(data: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { ok: true, ...data } }),
  };
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
    return { auth: authApi.auth, join, client, landingError, onLogin };
  });
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
      token = await result.current.join();
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
        await result.current.join();
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
      await result.current.join();
    });
    // The swap really re-rendered with the new token.
    expect(result.current.auth?.authToken).toBe(NEW_TOKEN);
    expect(result.current.join).toBe(firstJoin);
    expect(result.current.client).toBe(firstClient);
    unmount();
  });
});
