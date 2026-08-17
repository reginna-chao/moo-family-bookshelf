import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useAuth,
  namespacedKey,
  REMEMBER_SYNC_CODE_KEY,
  REMEMBERED_LOGOUT_KEY,
} from "@/hooks/useAuth";

// Mock syncCode module
vi.mock("@/crypto/syncCode", () => ({
  decodeSyncCode: vi.fn(),
  encodeSyncCode: vi.fn((data: { familyId: string; apiHost?: string }) => {
    const base = `moo-${data.familyId}`;
    return data.apiHost ? `${base}@${data.apiHost}` : base;
  }),
  SyncCodeError: class SyncCodeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SyncCodeError";
    }
  },
}));

import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";
const mockDecodeSyncCode = vi.mocked(decodeSyncCode);

/**
 * A stored `apiHost` is fed straight into `new ApiClient(...)`, so useAuth now
 * runs it through the SAME validation the join paths use. Fixtures therefore
 * carry full, adoptable endpoint URLs — a bare host is not something the app
 * can ever hold, and seeding one would test a state that cannot exist.
 */
const CUSTOM_HOST = "https://custom.host.com";

// Helper to set up localStorage with auth data (using namespaced keys)
function seedStorage(data: {
  userId?: string;
  familyId?: string;
  apiHost?: string;
}) {
  if (data.userId) {
    localStorage.setItem("moo:userId", data.userId);
    if (data.familyId)
      localStorage.setItem(
        namespacedKey(data.userId, "familyId"),
        data.familyId,
      );
    if (data.apiHost)
      localStorage.setItem(namespacedKey(data.userId, "apiHost"), data.apiHost);
  }
}

describe("useAuth", () => {
  let replaceStateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    replaceStateSpy = vi.fn();
    vi.stubGlobal("location", {
      search: "",
      hash: "",
      pathname: "/",
      href: "http://localhost/",
    });
    vi.stubGlobal("history", {
      replaceState: replaceStateSpy,
    });
    mockDecodeSyncCode.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("namespacedKey", () => {
    it("should build namespaced key with userId", () => {
      expect(namespacedKey("user-1", "familyId")).toBe("moo:user-1:familyId");
      expect(namespacedKey("user-1", "apiHost")).toBe("moo:user-1:apiHost");
    });
  });

  describe("localStorage session restore", () => {
    it("should restore auth when all required keys exist in localStorage", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
      });
      expect(result.current.isLoading).toBe(false);
    });

    it("should restore auth with apiHost when all keys exist", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });
    });

    it("should restore the CANONICAL form of a stored endpoint", () => {
      // A build that predated canonicalisation could have written this spelling;
      // the restored session must match what the ApiClient would actually use.
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: "https://CUSTOM.Host.com:443/api/",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: "https://custom.host.com/api",
      });
    });
  });

  /**
   * A stored endpoint is handed to `new ApiClient(apiHost)` inside a `useMemo`
   * at the top of the tree. The hardened validator throws on values an older
   * build happily persisted (embedded credentials, plain HTTP on a public
   * host), and a throw there takes the WHOLE app down — a white screen the user
   * cannot recover from without clearing site data.
   *
   * So a stored endpoint the client would now refuse is treated as "no
   * session": the user lands on the login form and re-enters a sync code.
   */
  describe("a stored endpoint the client now refuses", () => {
    it.each([
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      ["a bare host with no scheme", "custom.host.com"],
    ])("drops the session rather than restoring %s", (_label, apiHost) => {
      seedStorage({ userId: "user-1", familyId: "fam-1", apiHost });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("still restores the session when the stored endpoint is safe", () => {
      // The guard must be specific to a refusal, not a blanket "apiHost means
      // no session".
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: "http://localhost:8787",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: "http://localhost:8787",
      });
    });
  });

  describe("localStorage missing keys", () => {
    it("should return null auth when userId is missing", () => {
      // Without userId, namespaced keys can't be found
      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("should return null auth when familyId is missing", () => {
      localStorage.setItem("moo:userId", "user-1");

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });

    it("should return null auth when localStorage is empty", () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("clearUrlParams (page hash preservation)", () => {
    it("should NOT clear URL when hash is a known page routing hash", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#family-shelf",
        pathname: "/",
        href: "http://localhost/#family-shelf",
      });

      renderHook(() => useAuth());

      // replaceState should NOT be called — page hash should be preserved
      expect(replaceStateSpy).not.toHaveBeenCalled();
    });

    it("should NOT clear URL when hash is #personal-shelf", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#personal-shelf",
        pathname: "/",
        href: "http://localhost/#personal-shelf",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).not.toHaveBeenCalled();
    });

    it("should NOT clear URL when hash is #settings", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#settings",
        pathname: "/",
        href: "http://localhost/#settings",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).not.toHaveBeenCalled();
    });

    it("should clear URL when hash contains auth params (key=value format)", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/app");
    });

    it("should clear URL when search params are present", () => {
      vi.stubGlobal("location", {
        search: "?foo=bar",
        hash: "",
        pathname: "/",
        href: "http://localhost/?foo=bar",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/");
    });

    it("should NOT clear URL when both hash and search are empty", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "",
        pathname: "/",
        href: "http://localhost/",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("QR Code URL parsing", () => {
    it("should set initialSyncCode and qrUserId instead of auto-logging in", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      const { result } = renderHook(() => useAuth());

      expect(mockDecodeSyncCode).toHaveBeenCalledWith("moo-fam99-secretKey");
      // Should NOT auto-login — routes through LandingPage verification flow
      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe("moo-fam99-secretKey");
      expect(result.current.qrUserId).toBe("user-abc");
      expect(result.current.isLoading).toBe(false);
    });

    it("should set initialSyncCode and qrUserId with apiHost URL", () => {
      // The @host segment is a full endpoint URL, so it arrives percent-encoded
      // in the fragment — exactly as the Extension's QR generator writes it.
      const hash =
        "#code=moo-fam99-secretKey%40https%3A%2F%2Fcustom.host&uid=user-abc";
      vi.stubGlobal("location", {
        search: "",
        hash,
        pathname: "/app",
        href: `http://localhost/app${hash}`,
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
        apiHost: "https://custom.host",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe(
        "moo-fam99-secretKey@https://custom.host",
      );
      expect(result.current.qrUserId).toBe("user-abc");
    });

    it("should NOT save QR data to localStorage (deferred to LandingPage login)", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      renderHook(() => useAuth());

      expect(localStorage.getItem("moo:userId")).toBeNull();
    });

    it("should clear URL fragment via replaceState after parsing", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/app");
    });
  });

  describe("QR Code invalid code", () => {
    it("should not crash and auth stays null when sync code is invalid", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=invalid-code&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=invalid-code&uid=user-abc",
      });
      mockDecodeSyncCode.mockImplementation(() => {
        throw new SyncCodeError("Invalid sync code format");
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("should not crash when code param is missing", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#uid=user-abc",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });

    it("should not crash when uid param is missing", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-key",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-key",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });
  });

  describe("#invite= invite link parsing", () => {
    it("should set initialSyncCode from #invite= URL param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#invite=moo-abc1-def2-key123",
        pathname: "/",
        href: "http://localhost/#invite=moo-abc1-def2-key123",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "abc1-def2",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.initialSyncCode).toBe("moo-abc1-def2-key123");
      expect(result.current.auth).toBeNull();
    });

    it("should return empty initialSyncCode when no #invite= param", () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.initialSyncCode).toBe("");
    });

    it("should clear URL when hash contains #invite= param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#invite=moo-fam1-key1",
        pathname: "/",
        href: "http://localhost/#invite=moo-fam1-key1",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam1",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/");
    });

    it("should clear existing auth when #invite= is present in URL", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
      });

      vi.stubGlobal("location", {
        search: "",
        hash: "#invite=moo-new-family-newkey",
        pathname: "/",
        href: "http://localhost/#invite=moo-new-family-newkey",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "new-family",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe("moo-new-family-newkey");
    });

    it("should ignore invalid sync code in #invite= param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#invite=bad-code",
        pathname: "/",
        href: "http://localhost/#invite=bad-code",
      });
      mockDecodeSyncCode.mockImplementation(() => {
        throw new Error("Invalid sync code");
      });

      const { result } = renderHook(() => useAuth());

      // Invalid sync code should be ignored
      expect(result.current.initialSyncCode).toBe("");
      expect(result.current.auth).toBeNull();
    });
  });

  describe("login()", () => {
    it("should save to localStorage with namespaced keys and set auth", () => {
      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost: "https://api.example.com",
        });
      });

      expect(result.current.auth).toEqual({
        userId: "user-new",
        familyId: "fam-new",
        apiHost: "https://api.example.com",
      });
      expect(localStorage.getItem("moo:userId")).toBe("user-new");
      expect(localStorage.getItem(namespacedKey("user-new", "familyId"))).toBe(
        "fam-new",
      );
      expect(localStorage.getItem(namespacedKey("user-new", "apiHost"))).toBe(
        "https://api.example.com",
      );
    });

    it("should remove apiHost from localStorage when not provided", () => {
      // Seed old data
      localStorage.setItem("moo:userId", "user-new");
      localStorage.setItem(
        namespacedKey("user-new", "apiHost"),
        "https://old-host.com",
      );

      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
        });
      });

      expect(
        localStorage.getItem(namespacedKey("user-new", "apiHost")),
      ).toBeNull();
    });

    /**
     * ALL-OR-NOTHING behind LandingPage's own guards: whatever reaches
     * `login()`, an endpoint the ApiClient would refuse must not start a
     * session AT ALL. Keeping the rest of the session was the worse half-state:
     * `new ApiClient(auth.apiHost)` at the top of the tree throws on the raw
     * value (white screen), and after a reload the session would silently come
     * back against the DEFAULT endpoint — a family's books fetched from, and a
     * remembered sync code rebuilt for, a server nobody chose.
     */
    it.each([
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a bare host with no scheme", "api.example.com"],
    ])("should create no session at all for %s", (_label, apiHost) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost,
        });
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-new", "familyId")),
      ).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-new", "apiHost")),
      ).toBeNull();
      // The refusal is silent to the user, so the log is the only trace of it.
      expect(warn).toHaveBeenCalled();
    });

    it("should leave an existing session untouched when the new endpoint is refused", () => {
      // What is already stored passed the same validation when it was written,
      // so it is a safe address. A login this hook never accepted is no reason
      // to tear down the session the user still has.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      seedStorage({
        userId: "user-old",
        familyId: "fam-old",
        apiHost: CUSTOM_HOST,
      });
      const restored = {
        userId: "user-old",
        familyId: "fam-old",
        apiHost: CUSTOM_HOST,
      };

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).toEqual(restored);

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost: "https://real.example@evil.com",
        });
      });

      expect(result.current.auth).toEqual(restored);
      expect(localStorage.getItem("moo:userId")).toBe("user-old");
      expect(localStorage.getItem(namespacedKey("user-old", "apiHost"))).toBe(
        CUSTOM_HOST,
      );
      // …and no half-written session for the refused login either.
      expect(
        localStorage.getItem(namespacedKey("user-new", "familyId")),
      ).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it("should persist the CANONICAL endpoint, not the caller's spelling", () => {
      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost: "https://API.Example.com:443/v1/",
        });
      });

      // Same form the Extension stores for this endpoint, so a sync code built
      // from either app names the same server.
      expect(localStorage.getItem(namespacedKey("user-new", "apiHost"))).toBe(
        "https://api.example.com/v1",
      );
    });

    it("should hold the CANONICAL endpoint in state as well", () => {
      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost: "https://API.Example.com:443/v1/",
        });
      });

      // The live session drives `new ApiClient(auth.apiHost)`; a raw spelling
      // here would talk to the same server through a different string than the
      // one stored — and diverge from it after a reload.
      expect(result.current.auth).toEqual({
        userId: "user-new",
        familyId: "fam-new",
        apiHost: "https://api.example.com/v1",
      });
    });

    it("should restore the very same session after a reload", () => {
      const first = renderHook(() => useAuth());

      act(() => {
        first.result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          apiHost: "https://API.Example.com:443/v1/",
        });
      });
      const beforeReload = first.result.current.auth;
      first.unmount();

      const reloaded = renderHook(() => useAuth());

      expect(reloaded.result.current.auth).toEqual(beforeReload);
      reloaded.unmount();
    });
  });

  describe("logout()", () => {
    it("should clear localStorage and set auth to null", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });

      const { result } = renderHook(() => useAuth());

      // Verify auth was restored first
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "familyId")),
      ).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "apiHost")),
      ).toBeNull();
    });
  });

  describe("login() then logout()", () => {
    it("should complete full login/logout cycle", () => {
      const { result } = renderHook(() => useAuth());

      // Initially null
      expect(result.current.auth).toBeNull();

      // Login
      act(() => {
        result.current.login({
          userId: "user-cycle",
          familyId: "fam-cycle",
        });
      });

      expect(result.current.auth).toEqual({
        userId: "user-cycle",
        familyId: "fam-cycle",
      });
      expect(localStorage.getItem("moo:userId")).toBe("user-cycle");

      // Logout
      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-cycle", "familyId")),
      ).toBeNull();
    });
  });

  describe("remember sync code on logout", () => {
    it("should clear all auth keys and store sync code in REMEMBERED_LOGOUT_KEY when rememberSyncCode=1", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });
      // Also set authToken
      localStorage.setItem(namespacedKey("user-1", "authToken"), "tok-abc");

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      // ALL auth keys cleared (including identity keys)
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "familyId")),
      ).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "apiHost")),
      ).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "authToken")),
      ).toBeNull();
      // REMEMBERED_LOGOUT_KEY stores the sync code string
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe(
        `moo-fam-1@${CUSTOM_HOST}`,
      );
    });

    it("should remember sync code when rememberSyncCode is not set (default to remember)", () => {
      // Don't set REMEMBER_SYNC_CODE_KEY at all — default is remember
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      // All auth keys should still be cleared
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "familyId")),
      ).toBeNull();
      // REMEMBERED_LOGOUT_KEY should be set (default is remember)
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe("moo-fam-1");
      // initialSyncCode should be set
      expect(result.current.initialSyncCode).toBe("moo-fam-1");
    });

    it("should NOT remember sync code when rememberSyncCode is explicitly set to 0", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      // REMEMBERED_LOGOUT_KEY should NOT be set
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
      // initialSyncCode should remain empty
      expect(result.current.initialSyncCode).toBe("");
    });

    it("should not auto-login when REMEMBERED_LOGOUT_KEY is present (LandingPage reads it)", () => {
      // REMEMBERED_LOGOUT_KEY stores the sync code but useAuth does NOT consume it.
      // LandingPage reads it directly. useAuth just ensures no auto-login.
      localStorage.setItem(
        REMEMBERED_LOGOUT_KEY,
        `moo-fam-1-key-1@${CUSTOM_HOST}`,
      );

      const { result } = renderHook(() => useAuth());

      // Auth should NOT be set (no auth data in localStorage)
      expect(result.current.auth).toBeNull();
      // REMEMBERED_LOGOUT_KEY is NOT consumed by useAuth — LandingPage does that
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe(
        `moo-fam-1-key-1@${CUSTOM_HOST}`,
      );
    });

    it("should set initialSyncCode immediately on logout when remember is enabled", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      // initialSyncCode should be set immediately (no refresh needed)
      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe(`moo-fam-1@${CUSTOM_HOST}`);
    });

    it("should clear qrUserId on logout to prevent auto-re-login", () => {
      // Simulate: user logged in via QR code, then logs out.
      // qrUserId must be cleared so the QR auto-login effect doesn't re-trigger.
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      const { result } = renderHook(() => useAuth());

      // QR params should be set
      expect(result.current.qrUserId).toBe("user-abc");
      expect(result.current.initialSyncCode).toBe("moo-fam99-secretKey");

      // Simulate login then logout
      act(() => {
        result.current.login({
          userId: "user-abc",
          familyId: "fam99",
        });
      });
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      // qrUserId must be cleared
      expect(result.current.auth).toBeNull();
      expect(result.current.qrUserId).toBe("");
    });

    it("should not auto-login on second refresh after remembered logout", () => {
      // After remembered logout, REMEMBERED_LOGOUT_KEY has the sync code
      // but all auth data is cleared. Simulate a second refresh where
      // REMEMBERED_LOGOUT_KEY was already consumed on first refresh.
      // No auth data remains, so no auto-login should occur.

      // localStorage is empty — no userId, no familyId, nothing
      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("forceLogout()", () => {
    it("should clear everything including rememberSyncCode", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        apiHost: CUSTOM_HOST,
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.forceLogout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "familyId")),
      ).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "apiHost")),
      ).toBeNull();
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });

    it("should clear qrUserId and initialSyncCode on forceLogout", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
      });

      const { result } = renderHook(() => useAuth());

      // QR params should be set
      expect(result.current.qrUserId).toBe("user-abc");
      expect(result.current.initialSyncCode).toBe("moo-fam99-secretKey");

      act(() => {
        result.current.forceLogout();
      });

      // All transient state must be cleared
      expect(result.current.qrUserId).toBe("");
      expect(result.current.initialSyncCode).toBe("");
    });

    it("should clear everything even with rememberSyncCode=1", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      localStorage.setItem(REMEMBERED_LOGOUT_KEY, "moo-fam-1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
      });

      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.forceLogout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(
        localStorage.getItem(namespacedKey("user-1", "familyId")),
      ).toBeNull();
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });
  });
});
