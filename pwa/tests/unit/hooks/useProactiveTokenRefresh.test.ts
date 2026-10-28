import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCallback, useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import {
  PROACTIVE_REFRESH_THRESHOLD_MS,
  useProactiveTokenRefresh,
} from "@/hooks/useProactiveTokenRefresh";
import {
  USER_ID_KEY,
  namespacedKey,
  useAuth,
  type AuthState,
} from "@/hooks/useAuth";
import { recoveryJoinBlocked } from "@/hooks/recoveryJoinGate";
import {
  RECOVERY_COOLDOWN_UNTIL_KEY,
  getActiveRecoveryCooldown,
} from "@/utils/recoveryCooldown";
import { beginSelfDeparture } from "@/utils/selfDeparture";

/**
 * useProactiveTokenRefresh (PWA, #364): renew the auth token before it expires, so a user who opens
 * the PWA at least once a month never lands on the re-verification screen.
 *
 * Rules under test (docs/architecture.md → PWA 主動續期):
 *  - Check when the session starts and on every `visibilitychange`, and only while
 *    `document.visibilityState === "visible"`; no timers.
 *  - Renew when less than `PROACTIVE_REFRESH_THRESHOLD_MS` (30 days) is left, or when the session
 *    has no usable expiry (sessions saved before #364, a rotated token) — exactly one request.
 *  - The 429 recovery cooldown is NOT consulted (it only gates the recovery join); the user's own
 *    leave / delete in flight (`isSelfDepartureActive`) and an ended session are.
 *  - The request goes out on a throwaway client with no token refresher; any failure — error
 *    envelope, network error, thrown exception, unusable token — changes nothing, sends no join,
 *    and the next foreground check tries again.
 *  - The renewed token is written only while the session is still live AND still holds the token
 *    that was sent; the written session carries the response's expiry, or no `expiresAt` key.
 *  - ...and only while localStorage still holds that same session (`persistedSessionMatches`):
 *    another tab of the same account may have stored a newer token, family or server meanwhile.
 *  - One request in flight per tab; the effect depends on the session identity only, so a renewal
 *    that still grants less than 30 days renews once per check instead of looping.
 *
 * Harness. `useAuth` is REAL (its `login` writes localStorage and re-renders, exactly as in App),
 * wrapped in a stable `login` that also reports to the `onLogin` spy; `fetch` is the only network
 * mock, so the observables are the requests that leave and what lands in storage. `Date.now` is
 * pinned to `NOW` so the 30-day boundary is exact. `document.visibilityState` is overridden on the
 * instance and deleted again afterwards (jsdom reports "visible" by default).
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const FAMILY = "fam-renew";
const OLD_TOKEN = "1".repeat(64);
const NEW_TOKEN = "2".repeat(64);
const SWAPPED_TOKEN = "3".repeat(64);
const TOKEN_B = "4".repeat(64);
const TOKEN_B2 = "5".repeat(64);
const RENEWED_EXPIRES_AT = NOW + 90 * DAY;
const REFRESH_PATH = "/api/auth/refresh";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const mockFetch = vi.fn();
let visibility: DocumentVisibilityState = "visible";
/** Replies for the next refresh requests, in order; when empty, `defaultReply` answers. */
let queuedReplies: Array<() => Promise<FakeResponse>> = [];
let defaultReply: () => Promise<FakeResponse>;

function json(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function renewed(
  token = NEW_TOKEN,
  expiresAt: unknown = RENEWED_EXPIRES_AT,
): () => Promise<FakeResponse> {
  return () => Promise.resolve(json({ data: { token, expiresAt } }));
}

function deferredReply() {
  let release: (res: FakeResponse) => void = () => {};
  const reply = () =>
    new Promise<FakeResponse>((resolve) => {
      release = resolve;
    });
  return { reply, release: (res: FakeResponse) => release(res) };
}

const renewedBody = () =>
  json({ data: { token: NEW_TOKEN, expiresAt: RENEWED_EXPIRES_AT } });

function installFetchRouter(): void {
  mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === REFRESH_PATH) {
      const next = queuedReplies.shift() ?? defaultReply;
      return next();
    }
    throw new Error(`unexpected request ${init.method ?? "GET"} ${path}`);
  });
}

function callsTo(pathPart: string): unknown[][] {
  return mockFetch.mock.calls.filter(([url]) =>
    new URL(url as string).pathname.includes(pathPart),
  );
}

const refreshCount = (): number => callsTo(REFRESH_PATH).length;

function bearerOf(call: unknown[]): string | undefined {
  return (call[1] as { headers: Record<string, string> }).headers[
    "Authorization"
  ];
}

function seedSession(opts: {
  userId?: string;
  token?: string | null;
  expiresAt?: number | string;
  apiHost?: string;
}): void {
  const userId = opts.userId ?? USER_A;
  localStorage.setItem(USER_ID_KEY, userId);
  localStorage.setItem(namespacedKey(userId, "familyId"), FAMILY);
  if (opts.token !== null) {
    localStorage.setItem(
      namespacedKey(userId, "authToken"),
      opts.token ?? OLD_TOKEN,
    );
  }
  if (opts.apiHost) {
    localStorage.setItem(namespacedKey(userId, "apiHost"), opts.apiHost);
  }
  if (opts.expiresAt !== undefined) {
    localStorage.setItem(
      namespacedKey(userId, "tokenExpiresAt"),
      String(opts.expiresAt),
    );
  }
}

const storedToken = (userId = USER_A) =>
  localStorage.getItem(namespacedKey(userId, "authToken"));
const storedExpiry = (userId = USER_A) =>
  localStorage.getItem(namespacedKey(userId, "tokenExpiresAt"));

/** Let every pending promise chain (fetch → login → re-render → effect) settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setVisibility(next: DocumentVisibilityState): Promise<void> {
  visibility = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
}

/** Mount the hook the way App does: real `useAuth`, `authRef` mirroring the live session. */
async function renderApp(onLogin = vi.fn()) {
  const mount = () =>
    renderHook(() => {
      const authApi = useAuth();
      const realLogin = authApi.login;
      const login = useCallback(
        (data: AuthState) => {
          onLogin(data);
          realLogin(data);
        },
        [realLogin],
      );
      const authRef = useRef(authApi.auth);
      authRef.current = authApi.auth;
      useProactiveTokenRefresh({ auth: authApi.auth, authRef, login });
      return authApi;
    });
  let view!: ReturnType<typeof mount>;
  await act(async () => {
    view = mount();
  });
  await flush();
  return { ...view, onLogin };
}

describe("useProactiveTokenRefresh", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    queuedReplies = [];
    defaultReply = renewed();
    vi.stubGlobal("fetch", mockFetch);
    installFetchRouter();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("pins the threshold at 30 days", () => {
    expect(PROACTIVE_REFRESH_THRESHOLD_MS).toBe(30 * DAY);
  });

  describe("when the token has more than 30 days left", () => {
    it.each<{ label: string; expiresAt: number }>([
      { label: "90 days", expiresAt: NOW + 90 * DAY },
      { label: "31 days", expiresAt: NOW + 31 * DAY },
      {
        label: "exactly the threshold",
        expiresAt: NOW + PROACTIVE_REFRESH_THRESHOLD_MS,
      },
    ])(
      "sends nothing on mount or on returning to the foreground ($label)",
      async ({ expiresAt }) => {
        seedSession({ expiresAt });
        const { onLogin, unmount } = await renderApp();

        await setVisibility("hidden");
        await setVisibility("visible");
        await setVisibility("visible");

        expect(mockFetch).not.toHaveBeenCalled();
        expect(onLogin).not.toHaveBeenCalled();
        unmount();
      },
    );
  });

  describe("when the token needs renewing", () => {
    it.each<{ label: string; expiresAt?: number | string }>([
      {
        label: "1 ms under the threshold",
        expiresAt: NOW + PROACTIVE_REFRESH_THRESHOLD_MS - 1,
      },
      { label: "29 days left", expiresAt: NOW + 29 * DAY },
      { label: "already expired", expiresAt: NOW - DAY },
      { label: "no stored expiry" },
      { label: "an unusable stored expiry", expiresAt: "garbage" },
    ])("sends exactly one refresh on mount ($label)", async ({ expiresAt }) => {
      seedSession({ expiresAt });
      const { unmount } = await renderApp();

      expect(refreshCount()).toBe(1);
      unmount();
    });

    it("stores the renewed token and expiry for the same userId, familyId and apiHost", async () => {
      const apiHost = "https://self.example.com";
      seedSession({ expiresAt: NOW + 2 * DAY, apiHost });
      const { result, onLogin, unmount } = await renderApp();

      expect(refreshCount()).toBe(1);
      const [call] = callsTo(REFRESH_PATH);
      const init = call[1] as RequestInit;
      expect(call[0]).toBe(`${apiHost}${REFRESH_PATH}`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        userId: USER_A,
        familyId: FAMILY,
      });
      expect(bearerOf(call)).toBe(`Bearer ${OLD_TOKEN}`);

      const expected: AuthState = {
        userId: USER_A,
        familyId: FAMILY,
        apiHost,
        authToken: NEW_TOKEN,
        expiresAt: RENEWED_EXPIRES_AT,
      };
      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin).toHaveBeenCalledWith(expected);
      expect(result.current.auth).toEqual(expected);
      expect(storedToken()).toBe(NEW_TOKEN);
      expect(storedExpiry()).toBe(String(RENEWED_EXPIRES_AT));
      unmount();
    });

    it("still renews while a 429 recovery cooldown is active", async () => {
      localStorage.setItem(RECOVERY_COOLDOWN_UNTIL_KEY, String(NOW + 60_000));
      seedSession({});
      // Positive companion: the cooldown really is active, and it does block the recovery join.
      expect(getActiveRecoveryCooldown()).toBe(NOW + 60_000);
      const session = { userId: USER_A, familyId: FAMILY };
      expect(recoveryJoinBlocked(session, session)).toBe(true);

      const { onLogin, unmount } = await renderApp();

      expect(refreshCount()).toBe(1);
      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(storedToken()).toBe(NEW_TOKEN);
      unmount();
    });
  });

  describe("when the refresh fails", () => {
    const STALE_EXPIRY = NOW + DAY;

    it.each<{ label: string; reply: () => Promise<FakeResponse> }>([
      {
        label: "401 REFRESH_FAILED",
        reply: () =>
          Promise.resolve(
            json({ error: { code: "REFRESH_FAILED", message: "x" } }, 401),
          ),
      },
      {
        label: "429 RATE_LIMITED",
        reply: () =>
          Promise.resolve(
            json(
              { error: { code: "RATE_LIMITED", message: "x", retryAfter: 60 } },
              429,
            ),
          ),
      },
      {
        label: "a 500 without an envelope",
        reply: () => Promise.resolve(json({}, 500)),
      },
      {
        label: "a network error",
        reply: () => Promise.reject(new Error("offline")),
      },
      {
        label: "a body that is not JSON",
        reply: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new SyntaxError("bad json")),
          }),
      },
      {
        label: "an unusable token (INVALID_RESPONSE)",
        reply: renewed("test-auth-token-abc"),
      },
    ])(
      "keeps the session untouched, sends no join, and retries on the next foreground ($label)",
      async ({ reply }) => {
        queuedReplies = [reply];
        seedSession({ expiresAt: STALE_EXPIRY });
        const { result, onLogin, unmount } = await renderApp();

        expect(refreshCount()).toBe(1);
        expect(onLogin).not.toHaveBeenCalled();
        expect(result.current.auth).toEqual({
          userId: USER_A,
          familyId: FAMILY,
          authToken: OLD_TOKEN,
          expiresAt: STALE_EXPIRY,
        });
        expect(storedToken()).toBe(OLD_TOKEN);
        expect(storedExpiry()).toBe(String(STALE_EXPIRY));
        expect(localStorage.getItem(USER_ID_KEY)).toBe(USER_A);
        expect(callsTo("/join")).toHaveLength(0);
        expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBeNull();

        await setVisibility("visible");
        expect(refreshCount()).toBe(2);
        unmount();
      },
    );

    it("swallows a refresh that throws before anything is sent", async () => {
      seedSession({ userId: "not-a-hex-user-id" });
      const { result, onLogin, unmount } = await renderApp();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onLogin).not.toHaveBeenCalled();
      expect(result.current.auth?.authToken).toBe(OLD_TOKEN);
      unmount();
    });

    it("swallows a client that refuses the session's endpoint", async () => {
      const onLogin = vi.fn();
      const session: AuthState = {
        userId: USER_A,
        familyId: FAMILY,
        apiHost: "http://refused.example.com",
        authToken: OLD_TOKEN,
      };
      localStorage.setItem(USER_ID_KEY, USER_A);
      const { unmount } = renderHook(() => {
        const authRef = useRef<AuthState | null>(session);
        useProactiveTokenRefresh({ auth: session, authRef, login: onLogin });
      });
      await flush();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onLogin).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe("what the renewed session carries", () => {
    it.each<{ label: string; data: Record<string, unknown> }>([
      { label: "carries no expiry", data: { token: NEW_TOKEN } },
      {
        label: "carries an unusable expiry",
        data: { token: NEW_TOKEN, expiresAt: -1 },
      },
    ])("drops the old expiry when the response $label", async ({ data }) => {
      defaultReply = () => Promise.resolve(json({ data }));
      seedSession({ expiresAt: NOW + DAY });
      const { result, onLogin, unmount } = await renderApp();

      expect(onLogin).toHaveBeenCalledTimes(1);
      const written = onLogin.mock.calls[0][0] as AuthState;
      expect(written).toEqual({
        userId: USER_A,
        familyId: FAMILY,
        authToken: NEW_TOKEN,
      });
      expect(written).not.toHaveProperty("expiresAt");
      expect(result.current.auth).not.toHaveProperty("expiresAt");
      expect(storedExpiry()).toBeNull();
      expect(storedToken()).toBe(NEW_TOKEN);
      unmount();
    });

    it("renews only once per check when the server still grants less than 30 days", async () => {
      defaultReply = renewed(NEW_TOKEN, NOW + DAY);
      seedSession({});
      const { result, onLogin, unmount } = await renderApp();

      expect(refreshCount()).toBe(1);
      expect(onLogin).toHaveBeenCalledTimes(1);
      // The login re-rendered with the same identity and the short expiry; no second request.
      expect(result.current.auth?.expiresAt).toBe(NOW + DAY);
      await flush();
      await flush();
      expect(refreshCount()).toBe(1);

      // The next foreground check renews again, once.
      await setVisibility("visible");
      expect(refreshCount()).toBe(2);
      await flush();
      expect(refreshCount()).toBe(2);
      unmount();
    });

    it("leaves a token rotated within the session to the next foreground check", async () => {
      seedSession({ expiresAt: NOW + 90 * DAY });
      const { result, unmount } = await renderApp();
      expect(refreshCount()).toBe(0);

      // A pin change stores its token without an expiry (useRotatedTokenPersistence).
      await act(async () => {
        result.current.login({
          userId: USER_A,
          familyId: FAMILY,
          authToken: SWAPPED_TOKEN,
        });
      });
      await flush();
      expect(refreshCount()).toBe(0);

      await setVisibility("visible");
      expect(refreshCount()).toBe(1);
      expect(bearerOf(callsTo(REFRESH_PATH)[0])).toBe(
        `Bearer ${SWAPPED_TOKEN}`,
      );
      unmount();
    });
  });

  describe("a response that answers after the session moved on", () => {
    it("does not overwrite a token swapped in while the refresh was in flight", async () => {
      const pending = deferredReply();
      queuedReplies = [pending.reply];
      seedSession({});
      const { result, onLogin, unmount } = await renderApp();
      expect(refreshCount()).toBe(1);

      const swapped: AuthState = {
        userId: USER_A,
        familyId: FAMILY,
        authToken: SWAPPED_TOKEN,
      };
      await act(async () => {
        result.current.login(swapped);
      });
      await act(async () => {
        pending.release(renewedBody());
      });
      await flush();

      expect(onLogin).not.toHaveBeenCalled();
      expect(result.current.auth).toEqual(swapped);
      expect(storedToken()).toBe(SWAPPED_TOKEN);
      expect(storedExpiry()).toBeNull();
      expect(refreshCount()).toBe(1);
      unmount();
    });

    it.each<{
      label: string;
      endSession: (r: ReturnType<typeof useAuth>) => void;
      expectedUserIdKey: string | null;
    }>([
      {
        label: "the user logged out",
        endSession: (r) => r.logout(),
        expectedUserIdKey: null,
      },
      {
        label: "a logout already removed the stored user (state still lags)",
        endSession: () => localStorage.removeItem(USER_ID_KEY),
        expectedUserIdKey: null,
      },
      {
        label: "storage already names another user",
        endSession: () => localStorage.setItem(USER_ID_KEY, USER_B),
        expectedUserIdKey: USER_B,
      },
    ])(
      "writes nothing when $label meanwhile",
      async ({ endSession, expectedUserIdKey }) => {
        const pending = deferredReply();
        queuedReplies = [pending.reply];
        seedSession({});
        const { result, onLogin, unmount } = await renderApp();
        expect(refreshCount()).toBe(1);

        await act(async () => {
          endSession(result.current);
        });
        await act(async () => {
          pending.release(renewedBody());
        });
        await flush();

        expect(onLogin).not.toHaveBeenCalled();
        expect(localStorage.getItem(USER_ID_KEY)).toBe(expectedUserIdKey);
        expect(storedToken()).not.toBe(NEW_TOKEN);
        expect(storedExpiry()).toBeNull();
        unmount();
      },
    );

    it("checks the new session at once and keeps the old answer out of it", async () => {
      const pendingA = deferredReply();
      queuedReplies = [pendingA.reply, renewed(TOKEN_B2)];
      seedSession({});
      const { result, onLogin, unmount } = await renderApp();
      expect(refreshCount()).toBe(1);

      // Another user signs in while A's refresh is still in flight.
      await act(async () => {
        result.current.login({
          userId: USER_B,
          familyId: FAMILY,
          authToken: TOKEN_B,
        });
      });
      await flush();

      // B's own check was not held back by A's in-flight request.
      expect(refreshCount()).toBe(2);
      expect(bearerOf(callsTo(REFRESH_PATH)[1])).toBe(`Bearer ${TOKEN_B}`);
      expect(result.current.auth?.authToken).toBe(TOKEN_B2);

      await act(async () => {
        pendingA.release(renewedBody());
      });
      await flush();

      expect(result.current.auth).toEqual({
        userId: USER_B,
        familyId: FAMILY,
        authToken: TOKEN_B2,
        expiresAt: RENEWED_EXPIRES_AT,
      });
      expect(
        onLogin.mock.calls.some(([s]) => (s as AuthState).userId === USER_A),
      ).toBe(false);
      expect(storedToken(USER_A)).toBe(OLD_TOKEN);
      unmount();
    });

    it("writes nothing once the hook has unmounted", async () => {
      const pending = deferredReply();
      queuedReplies = [pending.reply];
      seedSession({});
      const { onLogin, unmount } = await renderApp();
      expect(refreshCount()).toBe(1);

      unmount();
      await act(async () => {
        pending.release(renewedBody());
      });
      await flush();

      expect(onLogin).not.toHaveBeenCalled();
      expect(storedToken()).toBe(OLD_TOKEN);
    });
  });

  describe("cross-tab guard", () => {
    const SELF_HOST = "https://self.example.com";
    const OTHER_HOST = "https://other.example.com";
    const OTHER_FAMILY = "fam-other-tab";

    /** Seed, mount, then let `otherTab` write localStorage directly while the refresh is pending. */
    async function answerAfterOtherTab(otherTab: () => void) {
      const pending = deferredReply();
      queuedReplies = [pending.reply];
      seedSession({ apiHost: SELF_HOST });
      const app = await renderApp();
      expect(refreshCount()).toBe(1);

      otherTab();
      await act(async () => {
        pending.release(renewedBody());
      });
      await flush();
      return app;
    }

    it("drops the response when another tab stored a newer token meanwhile", async () => {
      // A PIN / pattern change in another tab rotates the stored token (#378); this tab never sees it.
      const { result, onLogin, unmount } = await answerAfterOtherTab(() =>
        localStorage.setItem(namespacedKey(USER_A, "authToken"), SWAPPED_TOKEN),
      );

      expect(onLogin).not.toHaveBeenCalled();
      expect(result.current.auth?.authToken).toBe(OLD_TOKEN);
      expect(storedToken()).toBe(SWAPPED_TOKEN);
      expect(storedExpiry()).toBeNull();
      unmount();
    });

    it("does not write the old family or server back after another tab switched both", async () => {
      const { onLogin, unmount } = await answerAfterOtherTab(() => {
        localStorage.setItem(namespacedKey(USER_A, "familyId"), OTHER_FAMILY);
        localStorage.setItem(namespacedKey(USER_A, "apiHost"), OTHER_HOST);
      });

      expect(onLogin).not.toHaveBeenCalled();
      expect(localStorage.getItem(namespacedKey(USER_A, "familyId"))).toBe(
        OTHER_FAMILY,
      );
      expect(localStorage.getItem(namespacedKey(USER_A, "apiHost"))).toBe(
        OTHER_HOST,
      );
      expect(storedToken()).toBe(OLD_TOKEN);
      expect(storedExpiry()).toBeNull();
      unmount();
    });

    it("stores the renewed token and expiry when nothing changed in storage meanwhile", async () => {
      // Positive companion of the two cases above: same pending window, no other-tab write.
      const { result, onLogin, unmount } = await answerAfterOtherTab(() => {});

      const expected: AuthState = {
        userId: USER_A,
        familyId: FAMILY,
        apiHost: SELF_HOST,
        authToken: NEW_TOKEN,
        expiresAt: RENEWED_EXPIRES_AT,
      };
      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin).toHaveBeenCalledWith(expected);
      expect(result.current.auth).toEqual(expected);
      expect(storedToken()).toBe(NEW_TOKEN);
      expect(storedExpiry()).toBe(String(RENEWED_EXPIRES_AT));
      unmount();
    });
  });

  describe("when it checks", () => {
    it("waits for the app to become visible when it starts hidden", async () => {
      visibility = "hidden";
      seedSession({});
      const { onLogin, unmount } = await renderApp();
      expect(refreshCount()).toBe(0);

      await setVisibility("hidden");
      expect(refreshCount()).toBe(0);

      await setVisibility("visible");
      expect(refreshCount()).toBe(1);
      expect(onLogin).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("sends one request for overlapping checks", async () => {
      const pending = deferredReply();
      queuedReplies = [pending.reply];
      seedSession({});
      const { onLogin, unmount } = await renderApp();
      expect(refreshCount()).toBe(1);

      await setVisibility("visible");
      await setVisibility("visible");
      expect(refreshCount()).toBe(1);

      await act(async () => {
        pending.release(renewedBody());
      });
      await flush();
      expect(onLogin).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("stops listening for visibility changes after unmount", async () => {
      visibility = "hidden";
      seedSession({});
      const { unmount } = await renderApp();
      expect(refreshCount()).toBe(0);

      unmount();
      await setVisibility("visible");

      // Companion: "waits for the app to become visible" shows this same event sends while mounted.
      expect(refreshCount()).toBe(0);
    });

    it("sends nothing while the user's own leave or delete is in flight", async () => {
      const endDeparture = beginSelfDeparture();
      seedSession({});
      const { unmount } = await renderApp();

      await setVisibility("visible");
      expect(refreshCount()).toBe(0);

      // Positive companion: once the departure settles, the next foreground check renews.
      endDeparture();
      await setVisibility("visible");
      expect(refreshCount()).toBe(1);
      unmount();
    });

    it("leaves a session without a token to the auto-acquire path", async () => {
      seedSession({ token: null });
      const { unmount } = await renderApp();

      await setVisibility("visible");

      expect(mockFetch).not.toHaveBeenCalled();
      unmount();
    });
  });
});
