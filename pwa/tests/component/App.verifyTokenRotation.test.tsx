import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";

/**
 * PWA App: persisting the auth token a new pin / pattern / code rotated (#378).
 *
 * Why App-level: the server revokes the account's shared token the moment it switches the
 * verification method, and answers with the replacement. The session client adopts it at once
 * (pinned in tests/unit/api/verifyApi.test.ts), but the SESSION — React state plus the namespaced
 * `authToken` localStorage key — still holds the dead one until App persists it, and the next reload
 * or recovery join would start from that dead token and log the user out. The wiring under test is
 * App → VerifySetupPrompt (`onTokenRotated`) → `useRotatedTokenPersistence` → `useAuth().login`.
 *
 * Harness: unlike App.test.tsx and App.reauthRelogin.test.tsx, `useAuth` and `ApiClient` are REAL
 * here, and `fetch` is the only network mock, so the observables are what production writes and
 * sends: the namespaced `authToken` key in localStorage and the requests that leave, with their
 * `Authorization` header. The save is a single PUT that carries `prompted: 1` and no follow-up POST
 * (#399). Pages, the family-data provider, InstallPrompt and VersionWarning are stubbed out; the
 * SettingsPage stub exposes `onLogout` as a button so a test can end the session mid-save.
 *
 * Proactive renewal (#364): the seeded session has no `tokenExpiresAt`, so App sends one
 * `POST /api/auth/refresh` on mount. The router answers it the way the Worker does — the SAME token
 * it was sent, with a 90-day expiry — so the session keeps `OLD_TOKEN` and the save still carries
 * `Bearer ${OLD_TOKEN}`. A rotated token's expiry is not passed up, so rotation clears the key.
 *
 * Late callback (#258): the persist callback is bound to the session that rendered it. A save that
 * answers after the user logged out must not write the rotated token back — that would recreate the
 * stored session (USER_ID_KEY included) and log the user back in on the next load. The positive
 * companion is the first case, which observes the same key being written while the session is live.
 */

vi.mock("@/pages/LandingPage", () => ({
  LandingPage: () => <div data-testid="landing-page" />,
}));
vi.mock("@/pages/FamilyShelfPage", () => ({
  FamilyShelfPage: () => <div data-testid="family-shelf-page" />,
}));
vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: () => <div data-testid="personal-shelf-page" />,
}));
vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: ({ onLogout }: { onLogout: () => void }) => (
    <button type="button" onClick={onLogout}>
      stub-logout
    </button>
  ),
}));
vi.mock("@/components/InstallPrompt", () => ({ InstallPrompt: () => null }));
vi.mock("@/components/VersionWarning", () => ({ VersionWarning: () => null }));
vi.mock("@/hooks/useFamilyData", () => ({
  FamilyDataProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useFamilyData: () => ({
    hasBookshelfUpdates: false,
    markBookshelfSeen: vi.fn(),
    incomingPendingCount: 0,
  }),
}));

import React from "react";
import App from "@/App";
import { USER_ID_KEY, namespacedKey } from "@/hooks/useAuth";

const USER_ID = "c".repeat(64);
const FAMILY_ID = "fam-rotation";
const OLD_TOKEN = "1".repeat(64);
const ROTATED_TOKEN = "0123456789abcdef".repeat(4);
const TOKEN_KEY = namespacedKey(USER_ID, "authToken");
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;
const PROMPTED_PATH = `${VERIFY_PATH}/prompted`;
const REFRESH_PATH = "/api/auth/refresh";
const EXPIRY_KEY = namespacedKey(USER_ID, "tokenExpiresAt");
/** Expiry the refresh route grants. See the header → "Proactive renewal". */
const RENEWED_EXPIRES_AT = Date.now() + 90 * 86_400_000;

interface SentRequest {
  method: string;
  authorization: string | undefined;
}

const mockFetch = vi.fn();
let sent: Map<string, SentRequest>;
let answerPut: () => Promise<unknown>;

function json(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function routeKey(url: string, method: string): string {
  return `${method} ${new URL(url).pathname}`;
}

/** Answers the prompt's two verify calls (GET prompted + PUT) and records each one as it is sent.
 *  A stray POST /verify/prompted is still answered, so it lands in `sent` instead of throwing (#399). */
function installFetchRouter() {
  mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const key = routeKey(url, method);
    sent.set(key, {
      method,
      authorization: (init.headers as Record<string, string>)["Authorization"],
    });
    if (key === `GET ${PROMPTED_PATH}`) return json({ data: { prompted: 0 } });
    if (key === `PUT ${VERIFY_PATH}`) return json(await answerPut());
    if (key === `POST ${PROMPTED_PATH}`) return json({ data: { ok: true } });
    if (key === `POST ${REFRESH_PATH}`) {
      return json({
        data: { token: OLD_TOKEN, expiresAt: RENEWED_EXPIRES_AT },
      });
    }
    throw new Error(`unexpected request ${key}`);
  });
}

function rotatedAnswer() {
  return {
    data: {
      method: "code",
      prompted: 0,
      authToken: ROTATED_TOKEN,
      expiresAt: 1_700_000_000_000,
    },
  };
}

function seedStoredSession(): void {
  localStorage.setItem(USER_ID_KEY, USER_ID);
  localStorage.setItem(namespacedKey(USER_ID, "familyId"), FAMILY_ID);
  localStorage.setItem(TOKEN_KEY, OLD_TOKEN);
  // Keeps the first-run PwaCreateNotice overlay out of the way.
  localStorage.setItem(namespacedKey(USER_ID, "pwaNoticeShown"), "1");
}

/** Render App on the stored session and wait until the verify-setup prompt is up. */
async function renderPromptOpen() {
  render(<App />);
  await screen.findByText("設定登入驗證");
  // `findBy*` is not an effect-flush barrier; `act` is (.claude/rules/test.md → Anti-Drift Rules).
  await act(async () => {});
}

describe("App verify-method token rotation", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    sent = new Map();
    answerPut = () => Promise.resolve(rotatedAnswer());
    vi.stubGlobal("fetch", mockFetch);
    installFetchRouter();
    seedStoredSession();
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("persists the rotated token into the stored session before the prompt closes", async () => {
    await renderPromptOpen();

    await act(async () => {
      fireEvent.click(screen.getByText("隨機驗證碼"));
    });
    await waitFor(() => {
      expect(screen.queryByText("設定登入驗證")).not.toBeInTheDocument();
    });

    // The save itself still authenticated with the token it replaced.
    expect(sent.get(`PUT ${VERIFY_PATH}`)?.authorization).toBe(
      `Bearer ${OLD_TOKEN}`,
    );
    // The save is the only write: no follow-up POST /verify/prompted (#399).
    expect(sent.has(`POST ${PROMPTED_PATH}`)).toBe(false);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(ROTATED_TOKEN);
    expect(localStorage.getItem(USER_ID_KEY)).toBe(USER_ID);
    expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
  });

  it("renews a stored session that has no expiry exactly once on mount (#364)", async () => {
    expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();

    await renderPromptOpen();

    const refreshes = mockFetch.mock.calls.filter(
      ([url, init]) =>
        routeKey(url as string, (init as RequestInit).method ?? "GET") ===
        `POST ${REFRESH_PATH}`,
    );
    expect(refreshes).toHaveLength(1);
    expect(sent.get(`POST ${REFRESH_PATH}`)?.authorization).toBe(
      `Bearer ${OLD_TOKEN}`,
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBe(OLD_TOKEN);
    expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(RENEWED_EXPIRES_AT));
  });

  it("drops the stored expiry once a rotated token replaces the session's token (#364)", async () => {
    await renderPromptOpen();
    // Positive companion: the mount renewal stored an expiry for the old token.
    expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(RENEWED_EXPIRES_AT));

    await act(async () => {
      fireEvent.click(screen.getByText("隨機驗證碼"));
    });
    await waitFor(() => {
      expect(screen.queryByText("設定登入驗證")).not.toBeInTheDocument();
    });

    expect(localStorage.getItem(TOKEN_KEY)).toBe(ROTATED_TOKEN);
    expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();
  });

  it("keeps the stored token when the save issues none", async () => {
    answerPut = () =>
      Promise.resolve({ data: { method: "code", prompted: 0 } });
    await renderPromptOpen();

    await act(async () => {
      fireEvent.click(screen.getByText("隨機驗證碼"));
    });
    await waitFor(() => {
      expect(screen.queryByText("設定登入驗證")).not.toBeInTheDocument();
    });

    expect(localStorage.getItem(TOKEN_KEY)).toBe(OLD_TOKEN);
  });

  it("writes nothing when the save answers after the user logged out", async () => {
    let releasePut: (body: unknown) => void = () => {};
    answerPut = () =>
      new Promise((resolve) => {
        releasePut = resolve;
      });
    await renderPromptOpen();

    await act(async () => {
      fireEvent.click(screen.getByText("隨機驗證碼"));
    });
    expect(sent.has(`PUT ${VERIFY_PATH}`)).toBe(true);

    // Log out through the real useAuth while the save is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    await act(async () => {
      fireEvent.click(screen.getByText("stub-logout"));
    });
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    expect(localStorage.getItem(USER_ID_KEY)).toBeNull();

    await act(async () => {
      releasePut(rotatedAnswer());
    });
    // The save's tail runs inside the act above; one more empty `act` flushes what it scheduled,
    // so the late callback has had its chance to write.
    await act(async () => {});

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_ID_KEY)).toBeNull();
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
  });
});
