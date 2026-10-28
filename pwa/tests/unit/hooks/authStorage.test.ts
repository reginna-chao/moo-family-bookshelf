import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clearSessionForInvite,
  loadFromStorage,
  persistedSessionMatches,
  saveToStorage,
} from "@/hooks/authStorage";
import {
  USER_ID_KEY,
  namespacedKey,
  useAuth,
  type AuthState,
} from "@/hooks/useAuth";

/**
 * authStorage (PWA, #364): the token expiry a session carries, persisted under the namespaced
 * `tokenExpiresAt` key next to `authToken`.
 *
 * Contract. `saveToStorage` writes `String(expiresAt)` only when the value is usable
 * (`isExpiresAt`: a finite epoch-ms number above 0) and REMOVES the key otherwise, so a login
 * without an expiry can never leave the previous token's expiry behind. `loadFromStorage` reads the
 * key back through the same check; a missing or unusable value means "no expiry", i.e. the session
 * object has no `expiresAt` key at all (the proactive refresh then renews once). Every way a
 * session ends — logout, forceLogout, an invite link — removes the key with the rest of the user's
 * keys.
 *
 * The storage functions are exercised directly for the value matrix; the round trip through the
 * real `useAuth` (login → reload → logout) pins that the hook really goes through them.
 */

const USER = "d".repeat(64);
const FAMILY = "fam-expiry";
const TOKEN = "e".repeat(64);
const EXPIRES_AT = 1_900_000_000_000;
const EXPIRY_KEY = namespacedKey(USER, "tokenExpiresAt");

const SESSION: AuthState = {
  userId: USER,
  familyId: FAMILY,
  authToken: TOKEN,
  expiresAt: EXPIRES_AT,
};

describe("authStorage token expiry", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("saveToStorage", () => {
    it("stores a usable expiry as its decimal string under the namespaced key", () => {
      saveToStorage(SESSION);

      expect(EXPIRY_KEY).toBe(`moo:${USER}:tokenExpiresAt`);
      expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));
    });

    it.each<{ label: string; expiresAt: unknown }>([
      { label: "absent", expiresAt: undefined },
      { label: "zero", expiresAt: 0 },
      { label: "negative", expiresAt: -1 },
      { label: "NaN", expiresAt: Number.NaN },
      { label: "Infinity", expiresAt: Number.POSITIVE_INFINITY },
      { label: "a numeric string", expiresAt: "1900000000000" },
    ])(
      "removes a previously stored expiry when the new one is $label",
      ({ expiresAt }) => {
        saveToStorage(SESSION);
        expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));

        const next = { ...SESSION, expiresAt } as AuthState;
        if (expiresAt === undefined) delete next.expiresAt;
        saveToStorage(next);

        expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();
        // The rest of the session is still written.
        expect(localStorage.getItem(namespacedKey(USER, "authToken"))).toBe(
          TOKEN,
        );
      },
    );
  });

  describe("loadFromStorage", () => {
    function seed(expiry?: string): void {
      localStorage.setItem(USER_ID_KEY, USER);
      localStorage.setItem(namespacedKey(USER, "familyId"), FAMILY);
      localStorage.setItem(namespacedKey(USER, "authToken"), TOKEN);
      if (expiry !== undefined) localStorage.setItem(EXPIRY_KEY, expiry);
    }

    it("reads a stored expiry back as a number", () => {
      seed(String(EXPIRES_AT));

      expect(loadFromStorage()).toEqual(SESSION);
    });

    it("restores a session without an expiry key as having none", () => {
      seed();

      const loaded = loadFromStorage();

      expect(loaded).toEqual({
        userId: USER,
        familyId: FAMILY,
        authToken: TOKEN,
      });
      expect(loaded).not.toHaveProperty("expiresAt");
    });

    it.each(["", "abc", "0", "-5", "NaN", "Infinity", "1e400"])(
      "treats the unusable stored value %j as no expiry, keeping the session",
      (raw) => {
        seed(raw);

        const loaded = loadFromStorage();

        expect(loaded).toEqual({
          userId: USER,
          familyId: FAMILY,
          authToken: TOKEN,
        });
        expect(loaded).not.toHaveProperty("expiresAt");
      },
    );
  });

  describe("through useAuth", () => {
    it("persists the expiry on login and restores it after a reload", () => {
      const first = renderHook(() => useAuth());
      act(() => {
        first.result.current.login(SESSION);
      });

      expect(first.result.current.auth).toEqual(SESSION);
      expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));
      first.unmount();

      const reloaded = renderHook(() => useAuth());
      expect(reloaded.result.current.auth).toEqual(SESSION);
      reloaded.unmount();
    });

    it("drops the stored expiry when a login carries none", () => {
      const { result, unmount } = renderHook(() => useAuth());
      act(() => {
        result.current.login(SESSION);
      });
      expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));

      const rotated: AuthState = {
        userId: USER,
        familyId: FAMILY,
        authToken: "f".repeat(64),
      };
      act(() => {
        result.current.login(rotated);
      });

      expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();
      expect(result.current.auth).not.toHaveProperty("expiresAt");
      unmount();
    });

    it.each<{ label: string; end: (r: ReturnType<typeof useAuth>) => void }>([
      { label: "logout()", end: (r) => r.logout() },
      { label: "forceLogout()", end: (r) => r.forceLogout() },
    ])("removes the stored expiry on $label", ({ end }) => {
      const { result, unmount } = renderHook(() => useAuth());
      act(() => {
        result.current.login(SESSION);
      });
      expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));

      act(() => {
        end(result.current);
      });

      expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();
      expect(localStorage.getItem(USER_ID_KEY)).toBeNull();
      unmount();
    });
  });

  it("removes the stored expiry when an invite link ends the session", () => {
    saveToStorage(SESSION);
    expect(localStorage.getItem(EXPIRY_KEY)).toBe(String(EXPIRES_AT));

    clearSessionForInvite();

    expect(localStorage.getItem(EXPIRY_KEY)).toBeNull();
    expect(localStorage.getItem(namespacedKey(USER, "authToken"))).toBeNull();
  });

  describe("persistedSessionMatches", () => {
    it("reports no match when reading localStorage throws", () => {
      saveToStorage(SESSION);
      // Positive companion: the same stored session matches while reads succeed.
      expect(persistedSessionMatches(SESSION)).toBe(true);

      const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new DOMException("denied", "SecurityError");
        });
      try {
        expect(persistedSessionMatches(SESSION)).toBe(false);
        expect(getItem).toHaveBeenCalled();
      } finally {
        getItem.mockRestore();
      }
    });
  });
});
