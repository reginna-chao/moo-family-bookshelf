import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDepartureLogout } from "@/hooks/useDepartureLogout";
import { saveToStorage } from "@/hooks/authStorage";
import type { AuthState } from "@/hooks/useAuth";

/**
 * useDepartureLogout: the logout App runs after a successful leave / delete, bound to
 * the session that SENT the request. The response can land after this tab, or another tab of the
 * same browser, has moved on, so three outcomes are pinned:
 *  - this tab is still on the sending session and storage still holds it, or holds no session at
 *    all → the full logout (`logout` after a leave, `forceLogout` after a delete);
 *  - this tab is still on the sending session but storage holds ANOTHER session (another user, or
 *    the same user in another family / on another server) → only `dropSession`, and localStorage
 *    is left exactly as the other tab wrote it;
 *  - this tab already shows another session, or none → nothing at all.
 *
 * `logout` / `forceLogout` / `dropSession` are spies (they are `useAuth`'s, whose own behaviour is
 * tested in useAuth.test.ts); storage is the real jsdom localStorage, written through production's
 * `saveToStorage`. `authRef` is a plain object standing in for App's ref to the live session.
 */

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const SESSION_A: AuthState = {
  userId: USER_A,
  familyId: "fam-a",
  apiHost: "https://server-x.example.com",
  authToken: "token-a",
};
const SAME_USER_B_AT_Y: AuthState = {
  userId: USER_A,
  familyId: "fam-b",
  apiHost: "https://server-y.example.com",
  authToken: "token-b",
};

type Departure = "afterLeave" | "afterDelete";

function renderDeparture(
  auth: AuthState | null,
  live: AuthState | null = auth,
) {
  const authRef = { current: live };
  const logout = vi.fn();
  const forceLogout = vi.fn();
  const dropSession = vi.fn();
  const view = renderHook(
    ({ session }: { session: AuthState | null }) =>
      useDepartureLogout({
        auth: session,
        authRef,
        logout,
        forceLogout,
        dropSession,
      }),
    { initialProps: { session: auth } },
  );
  return { ...view, authRef, logout, forceLogout, dropSession };
}

function storageSnapshot(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    snapshot[key] = localStorage.getItem(key);
  }
  return snapshot;
}

describe("useDepartureLogout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe.each<{ departure: Departure; full: "logout" | "forceLogout" }>([
    { departure: "afterLeave", full: "logout" },
    { departure: "afterDelete", full: "forceLogout" },
  ])("$departure", ({ departure, full }) => {
    const other = full === "logout" ? "forceLogout" : "logout";

    it.each<{ label: string; live: AuthState }>([
      { label: "the sending session", live: SESSION_A },
      {
        label: "the sending session after a token swap",
        live: { ...SESSION_A, authToken: "token-a2" },
      },
    ])(
      `runs ${full} while this tab is on $label and storage still holds it`,
      ({ live }) => {
        saveToStorage(SESSION_A);
        const hooks = renderDeparture(SESSION_A, live);

        hooks.result.current[departure]();

        expect(hooks[full]).toHaveBeenCalledOnce();
        expect(hooks[other]).not.toHaveBeenCalled();
        expect(hooks.dropSession).not.toHaveBeenCalled();
      },
    );

    it(`runs ${full} when storage holds no session at all`, () => {
      const hooks = renderDeparture(SESSION_A);

      hooks.result.current[departure]();

      expect(hooks[full]).toHaveBeenCalledOnce();
      expect(hooks[other]).not.toHaveBeenCalled();
      expect(hooks.dropSession).not.toHaveBeenCalled();
    });

    it.each<{ label: string; stored: AuthState }>([
      {
        label: "the same user in another family and server",
        stored: SAME_USER_B_AT_Y,
      },
      {
        label: "the same user in another family",
        stored: { ...SESSION_A, familyId: "fam-b", authToken: "token-b" },
      },
      {
        label: "the same user on another server",
        stored: {
          ...SESSION_A,
          apiHost: "https://server-y.example.com",
          authToken: "token-b",
        },
      },
      { label: "another user", stored: { ...SESSION_A, userId: USER_B } },
    ])(
      "only drops this tab's session when storage holds $label",
      ({ stored }) => {
        saveToStorage(stored);
        localStorage.setItem("moo:rememberSyncCode", "1");
        const before = storageSnapshot();
        const hooks = renderDeparture(SESSION_A);

        hooks.result.current[departure]();

        expect(hooks.dropSession).toHaveBeenCalledOnce();
        expect(hooks.logout).not.toHaveBeenCalled();
        expect(hooks.forceLogout).not.toHaveBeenCalled();
        expect(storageSnapshot()).toEqual(before);
      },
    );

    it.each<{ label: string; live: AuthState | null }>([
      { label: "is logged out", live: null },
      { label: "shows another user", live: { ...SESSION_A, userId: USER_B } },
      {
        label: "shows the same user in another family",
        live: SAME_USER_B_AT_Y,
      },
    ])("does nothing once this tab $label", ({ live }) => {
      saveToStorage(SESSION_A);
      const hooks = renderDeparture(SESSION_A, live);

      hooks.result.current[departure]();

      expect(hooks.logout).not.toHaveBeenCalled();
      expect(hooks.forceLogout).not.toHaveBeenCalled();
      expect(hooks.dropSession).not.toHaveBeenCalled();
    });

    it("does nothing when created without a session", () => {
      const hooks = renderDeparture(null, SESSION_A);

      hooks.result.current[departure]();

      expect(hooks.logout).not.toHaveBeenCalled();
      expect(hooks.forceLogout).not.toHaveBeenCalled();
      expect(hooks.dropSession).not.toHaveBeenCalled();
    });

    it("keeps a callback from an earlier session bound to that session", () => {
      saveToStorage(SESSION_A);
      const hooks = renderDeparture(SESSION_A);
      const staleForA = hooks.result.current[departure];

      const sessionB: AuthState = { ...SESSION_A, userId: USER_B };
      saveToStorage(sessionB);
      hooks.authRef.current = sessionB;
      hooks.rerender({ session: sessionB });

      staleForA();
      expect(hooks[full]).not.toHaveBeenCalled();
      expect(hooks.dropSession).not.toHaveBeenCalled();

      // Positive companion: the current render's callback ends session B.
      hooks.result.current[departure]();
      expect(hooks[full]).toHaveBeenCalledOnce();
    });
  });
});
