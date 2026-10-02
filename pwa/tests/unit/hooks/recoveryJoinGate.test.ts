import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recoveryJoinBlocked } from "@/hooks/recoveryJoinGate";
import { USER_ID_KEY, type AuthState } from "@/hooks/useAuth";
import { RECOVERY_COOLDOWN_UNTIL_KEY } from "@/utils/recoveryCooldown";
import {
  beginSelfDeparture,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";

/**
 * `recoveryJoinBlocked` decides whether App's silent recovery join may go out.
 * Each of its three reasons is driven through the real storage-backed helper it
 * consults — nothing here is mocked except a throwing `Storage` for the
 * fail-closed case — and each is paired with the all-clear baseline so a
 * reason that stopped blocking (or an all-clear that started) fails on its own.
 */

const SESSION: AuthState = {
  userId: "a".repeat(64),
  familyId: "fam-1",
  authToken: "token-1",
};

describe("recoveryJoinBlocked", () => {
  beforeEach(() => {
    localStorage.setItem(USER_ID_KEY, SESSION.userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(RECOVERY_COOLDOWN_UNTIL_KEY);
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it("lets the join through for a live session with nothing in the way", () => {
    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(false);
    // A fresh object for the same session is still the same session.
    expect(recoveryJoinBlocked({ ...SESSION }, SESSION)).toBe(false);
  });

  it("blocks while a 429 recovery cooldown is active", () => {
    localStorage.setItem(
      RECOVERY_COOLDOWN_UNTIL_KEY,
      String(Date.now() + 60_000),
    );

    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(true);
  });

  it("does not block on an expired cooldown", () => {
    localStorage.setItem(RECOVERY_COOLDOWN_UNTIL_KEY, String(Date.now() - 1));

    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(false);
  });

  it("blocks while this user's own departure is in flight (#263)", () => {
    const end = beginSelfDeparture();

    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(true);

    end();
    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(false);
  });

  it.each<[string, AuthState | null, string | null]>([
    ["the user logged out (no live session)", null, SESSION.userId],
    [
      "another user signed in",
      { ...SESSION, userId: "b".repeat(64) },
      SESSION.userId,
    ],
    [
      "the session moved to another family",
      { ...SESSION, familyId: "fam-2" },
      SESSION.userId,
    ],
    ["logout cleared storage before React re-rendered", SESSION, null],
  ])("blocks once the session has ended: %s", (_label, live, storedUserId) => {
    if (storedUserId === null) localStorage.removeItem(USER_ID_KEY);
    else localStorage.setItem(USER_ID_KEY, storedUserId);

    expect(recoveryJoinBlocked(live, SESSION)).toBe(true);
  });

  it("treats a throwing storage read as an ended session", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() => recoveryJoinBlocked(SESSION, SESSION)).not.toThrow();
    expect(recoveryJoinBlocked(SESSION, SESSION)).toBe(true);
  });
});
