import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRotatedTokenPersistence } from "@/hooks/useRotatedTokenPersistence";
import { USER_ID_KEY, type AuthState } from "@/hooks/useAuth";

/**
 * useRotatedTokenPersistence (#378): the callback App hands VerifySetupPrompt as `onTokenRotated`.
 * It persists the token a new pin / pattern / code rotated through `login`, but only into the session
 * that rendered it and only while that session is still live (`isLiveSession`, #258: same userId /
 * familyId / apiHost in `authRef`, and `USER_ID_KEY` still stored — a logout issued after an await
 * removes the key synchronously while React state lags a render behind). The App-level wiring with the
 * real `useAuth` is pinned in tests/component/App.verifyTokenRotation.test.tsx; this file walks the
 * live / not-live matrix with the real `isLiveSession`, `login` being the only test double.
 */

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const ROTATED_TOKEN = "0123456789abcdef".repeat(4);
const SESSION_A: AuthState = {
  userId: USER_A,
  familyId: "fam-a",
  apiHost: "https://self.example.com",
  authToken: "old-token",
};

function renderPersistence(
  auth: AuthState | null,
  current: AuthState | null,
  login = vi.fn(),
) {
  const authRef = { current };
  const { result, rerender } = renderHook(
    ({ session }: { session: AuthState | null }) =>
      useRotatedTokenPersistence(session, authRef, login),
    { initialProps: { session: auth } },
  );
  return { persist: result.current, result, rerender, authRef, login };
}

describe("useRotatedTokenPersistence", () => {
  beforeEach(() => {
    localStorage.setItem(USER_ID_KEY, USER_A);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("logs the live session in again with the rotated token and nothing else changed", () => {
    const { persist, login } = renderPersistence(SESSION_A, SESSION_A);

    persist(ROTATED_TOKEN);

    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith({
      ...SESSION_A,
      authToken: ROTATED_TOKEN,
    });
  });

  it("treats a session object carrying a newer token as the same live session", () => {
    // A 401 refresh swaps the token in state; the session is still the one that rendered.
    const { persist, login } = renderPersistence(SESSION_A, {
      ...SESSION_A,
      authToken: "refreshed-token",
    });

    persist(ROTATED_TOKEN);

    expect(login).toHaveBeenCalledWith({
      ...SESSION_A,
      authToken: ROTATED_TOKEN,
    });
  });

  it.each<{ label: string; current: AuthState | null; storedUserId?: string }>([
    { label: "the session has ended", current: null },
    {
      label: "another user is signed in",
      current: { ...SESSION_A, userId: USER_B },
    },
    {
      label: "the user moved to another family",
      current: { ...SESSION_A, familyId: "fam-b" },
    },
    {
      label: "the session now runs on another server",
      current: { ...SESSION_A, apiHost: "https://other.example.com" },
    },
    {
      label: "a logout already removed the stored user (state still lags)",
      current: SESSION_A,
      storedUserId: "",
    },
    {
      label: "storage already names another user",
      current: SESSION_A,
      storedUserId: USER_B,
    },
  ])("stores nothing when $label", ({ current, storedUserId }) => {
    if (storedUserId === "") localStorage.removeItem(USER_ID_KEY);
    else if (storedUserId) localStorage.setItem(USER_ID_KEY, storedUserId);
    const { persist, login } = renderPersistence(SESSION_A, current);

    persist(ROTATED_TOKEN);

    expect(login).not.toHaveBeenCalled();
  });

  it("stores nothing when it was created without a session", () => {
    const { persist, login } = renderPersistence(null, SESSION_A);

    persist(ROTATED_TOKEN);

    expect(login).not.toHaveBeenCalled();
  });

  it("keeps a callback from an earlier session bound to that session", () => {
    const {
      persist: staleForA,
      result,
      rerender,
      authRef,
      login,
    } = renderPersistence(SESSION_A, SESSION_A);
    const sessionB: AuthState = { userId: USER_B, familyId: "fam-b" };
    localStorage.setItem(USER_ID_KEY, USER_B);
    authRef.current = sessionB;
    rerender({ session: sessionB });

    staleForA(ROTATED_TOKEN);
    expect(login).not.toHaveBeenCalled();

    // Positive companion: the current render's callback does persist into session B.
    result.current(ROTATED_TOKEN);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith({
      ...sessionB,
      authToken: ROTATED_TOKEN,
    });
  });
});
