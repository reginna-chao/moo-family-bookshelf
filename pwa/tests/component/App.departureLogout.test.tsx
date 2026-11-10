import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

/**
 * PWA App: the logout after a successful leave / delete is bound to the session that SENT the
 * request.
 *
 * Why App-level: the leave / delete hooks keep running after SettingsPage unmounts, so a response
 * can land after the user logged out and signed in again — or after another tab moved storage to a
 * different session. App hands SettingsPage `departureLogout.afterLeave` / `.afterDelete`
 * (`useDepartureLogout`), which only end the session the request was sent from; another session's
 * storage (and, on delete, its remembered-sync-code preference and re-verification marker) is kept.
 *
 * Harness: `useAuth` and `ApiClient` are REAL and `fetch` is the only network mock, so the
 * observables are what production keeps in localStorage and what it renders (landing page vs the
 * signed-in nav). SettingsPage is the real page with its leave / logout / delete sections; only the
 * three unrelated sections (personal, family, about) are stubbed. The LandingPage stub's button
 * signs in the session in `nextLogin` through App's real `onAuth`. Sessions carry a far expiry so
 * the proactive renewal (#364) sends nothing, and the verify-setup prompt is stubbed out.
 *
 * Sessions: A@X is the session the request is sent from; B@Y is the SAME user in another family on
 * another server, which a userId-only comparison cannot tell apart from A@X.
 */

vi.mock("@/pages/LandingPage", () => ({
  LandingPage: ({ onAuth }: { onAuth: (data: unknown) => void }) => (
    <div data-testid="landing-page">
      <button type="button" onClick={() => onAuth(nextLogin)}>
        stub-login
      </button>
    </div>
  ),
}));
vi.mock("@/pages/FamilyShelfPage", () => ({
  FamilyShelfPage: () => <div data-testid="family-shelf-page" />,
}));
vi.mock("@/pages/PersonalShelfPage", () => ({
  PersonalShelfPage: () => <div data-testid="personal-shelf-page" />,
}));
vi.mock("@/components/SettingsPersonalSection", () => ({
  SettingsPersonalSection: () => null,
}));
vi.mock("@/components/SettingsFamilySection", () => ({
  SettingsFamilySection: () => null,
}));
vi.mock("@/components/SettingsAboutSection", () => ({
  SettingsAboutSection: () => null,
}));
vi.mock("@/components/VerifySetupPrompt", () => ({
  VerifySetupPrompt: () => null,
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
import {
  REMEMBER_SYNC_CODE_KEY,
  USER_ID_KEY,
  namespacedKey,
  type AuthState,
} from "@/hooks/useAuth";
import { saveToStorage } from "@/hooks/authStorage";
import { REAUTH_PENDING_KEY } from "@/utils/reauthPendingKey";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/utils/selfDeparture";

const USER = "c".repeat(64);
const EXPIRES_AT = Date.now() + 90 * 86_400_000;
const HOST_X = "https://server-x.example.com";
const SESSION_A_AT_X: AuthState = {
  userId: USER,
  familyId: "fam-a",
  apiHost: HOST_X,
  authToken: "1".repeat(64),
  expiresAt: EXPIRES_AT,
};
const SESSION_B_AT_Y: AuthState = {
  userId: USER,
  familyId: "fam-b",
  apiHost: "https://server-y.example.com",
  authToken: "2".repeat(64),
  expiresAt: EXPIRES_AT,
};
const LEAVE_PATH = `/api/family/${SESSION_A_AT_X.familyId}/member/${USER}`;
const DELETE_PATH = `/api/user/${USER}`;
const MARKER = "abcd";

/** What the LandingPage stub signs in. */
let nextLogin: AuthState = SESSION_B_AT_Y;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const mockFetch = vi.fn();
let releaseDeparture: (res: FakeResponse) => void = () => {};

function json(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const OK = () => json({ data: { ok: true } });
const MEMBER_NOT_FOUND = () =>
  json({ error: { code: "MEMBER_NOT_FOUND", message: "gone" } }, 404);

/** Holds the leave / delete DELETE until the test releases it; answers the verify-method read. */
function installFetchRouter(): void {
  mockFetch.mockImplementation((url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    if (key === `DELETE ${LEAVE_PATH}` || key === `DELETE ${DELETE_PATH}`) {
      return new Promise<FakeResponse>((resolve) => {
        releaseDeparture = resolve;
      });
    }
    if (key === `GET /api/user/${USER}/verify`) {
      return Promise.resolve(json({ data: { method: "none" } }));
    }
    return Promise.reject(new Error(`unexpected request ${key}`));
  });
}

function departureRequests(): unknown[][] {
  return mockFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit).method === "DELETE",
  );
}

/** Every key in localStorage with its value, minus the in-flight departure guard, which the
 *  release itself ends (#263). */
function storageSnapshot(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key !== SELF_DEPARTURE_UNTIL_KEY) {
      snapshot[key] = localStorage.getItem(key);
    }
  }
  return snapshot;
}

function expectStorageHolds(session: AuthState): void {
  expect(localStorage.getItem(USER_ID_KEY)).toBe(session.userId);
  for (const key of ["familyId", "apiHost", "authToken"] as const) {
    expect(localStorage.getItem(namespacedKey(session.userId, key))).toBe(
      session[key] ?? null,
    );
  }
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Render App on the stored session at Settings and wait until its effects have run. */
async function renderSettings(): Promise<void> {
  window.history.replaceState(null, "", "/#settings");
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByRole("button", { name: "離開家庭" })).toBeInTheDocument();
}

async function sendLeave(): Promise<void> {
  await click("離開家庭");
  await click("確定離開");
  expect(departureRequests()).toHaveLength(1);
}

async function sendDelete(): Promise<void> {
  await click("移除帳戶");
  await click("確定移除");
  expect(departureRequests()).toHaveLength(1);
}

/** In this tab: 登出, then sign in `nextLogin` from the landing page. */
async function logOutAndSignInAgain(): Promise<void> {
  await click("登出");
  await click("確定登出");
  expect(screen.getByTestId("landing-page")).toBeInTheDocument();
  await click("stub-login");
  expect(screen.queryByTestId("landing-page")).not.toBeInTheDocument();
  expectStorageHolds(SESSION_B_AT_Y);
}

async function release(answer: () => FakeResponse): Promise<void> {
  await act(async () => {
    releaseDeparture(answer());
  });
  await act(async () => {});
}

describe("App: a late leave / delete response ends only the session that sent it", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    nextLogin = SESSION_B_AT_Y;
    vi.stubGlobal("fetch", mockFetch);
    installFetchRouter();
    saveToStorage(SESSION_A_AT_X);
    // Keeps the first-run PwaCreateNotice overlay out of the way.
    localStorage.setItem(namespacedKey(USER, "pwaNoticeShown"), "1");
  });

  afterEach(() => {
    mockFetch.mockReset();
    releaseDeparture = () => {};
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  describe("leave family", () => {
    it.each([
      { label: "succeeds", answer: OK },
      { label: "answers MEMBER_NOT_FOUND", answer: MEMBER_NOT_FOUND },
    ])(
      "keeps B@Y signed in when the leave $label after logout and a new login",
      async ({ answer }) => {
        await renderSettings();
        await sendLeave();
        await logOutAndSignInAgain();
        const before = storageSnapshot();

        await release(answer);

        expect(storageSnapshot()).toEqual(before);
        expectStorageHolds(SESSION_B_AT_Y);
        expect(screen.queryByTestId("landing-page")).not.toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "設定" }),
        ).toBeInTheDocument();
      },
    );

    it("ends only this tab's screen when another tab moved storage to B@Y meanwhile", async () => {
      await renderSettings();
      await sendLeave();
      saveToStorage(SESSION_B_AT_Y);
      const before = storageSnapshot();

      await release(OK);

      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(storageSnapshot()).toEqual(before);
      expectStorageHolds(SESSION_B_AT_Y);
    });

    it("clears storage after a successful leave when the stored host carries a trailing slash", async () => {
      localStorage.setItem(namespacedKey(USER, "apiHost"), `${HOST_X}/`);
      await renderSettings();
      await sendLeave();
      expect(new URL(departureRequests()[0][0] as string).origin).toBe(HOST_X);

      await release(OK);

      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(localStorage.getItem(USER_ID_KEY)).toBeNull();
      expect(localStorage.getItem(namespacedKey(USER, "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey(USER, "apiHost"))).toBeNull();
    });
  });

  describe("delete account", () => {
    beforeEach(() => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");
      localStorage.setItem(REAUTH_PENDING_KEY, MARKER);
    });

    it("keeps B@Y, the remember-sync-code preference and the re-verification marker after logout and a new login", async () => {
      await renderSettings();
      await sendDelete();
      await logOutAndSignInAgain();
      const before = storageSnapshot();

      await release(OK);

      expect(storageSnapshot()).toEqual(before);
      expectStorageHolds(SESSION_B_AT_Y);
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBe("0");
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBe(MARKER);
      expect(screen.queryByTestId("landing-page")).not.toBeInTheDocument();
    });

    it("ends only this tab's screen when another tab moved storage to B@Y meanwhile", async () => {
      await renderSettings();
      await sendDelete();
      saveToStorage(SESSION_B_AT_Y);
      const before = storageSnapshot();

      await release(OK);

      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(storageSnapshot()).toEqual(before);
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBe("0");
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBe(MARKER);
    });

    // Positive companion: with nothing moved, the delete still clears everything.
    it("clears the session, the preference and the marker when nothing moved meanwhile", async () => {
      await renderSettings();
      await sendDelete();

      await release(OK);

      expect(screen.getByTestId("landing-page")).toBeInTheDocument();
      expect(localStorage.getItem(USER_ID_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBeNull();
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });
  });
});
