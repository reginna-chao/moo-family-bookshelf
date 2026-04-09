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
  encodeSyncCode: vi.fn((data: { familyId: string; encryptionKey: string; apiHost?: string }) => {
    const base = `moo-${data.familyId}-${data.encryptionKey}`;
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

// Helper to set up localStorage with auth data (using namespaced keys)
function seedStorage(data: {
  userId?: string;
  familyId?: string;
  encryptionKey?: string;
  apiHost?: string;
}) {
  if (data.userId) {
    localStorage.setItem("moo:userId", data.userId);
    if (data.familyId)
      localStorage.setItem(namespacedKey(data.userId, "familyId"), data.familyId);
    if (data.encryptionKey)
      localStorage.setItem(namespacedKey(data.userId, "encryptionKey"), data.encryptionKey);
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
      expect(namespacedKey("user-1", "encryptionKey")).toBe("moo:user-1:encryptionKey");
    });
  });

  describe("localStorage session restore", () => {
    it("should restore auth when all required keys exist in localStorage", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
      });
      expect(result.current.isLoading).toBe(false);
    });

    it("should restore auth with apiHost when all keys exist", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.host.com",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toEqual({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.host.com",
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
      localStorage.setItem(namespacedKey("user-1", "encryptionKey"), "key-1");

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });

    it("should return null auth when encryptionKey is missing", () => {
      localStorage.setItem("moo:userId", "user-1");
      localStorage.setItem(namespacedKey("user-1", "familyId"), "fam-1");

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
        encryptionKey: "secretKey",
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
        encryptionKey: "secretKey",
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
      vi.stubGlobal("location", {
        search: "",
        hash: "#code=moo-fam99-secretKey%40custom.host&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app#code=moo-fam99-secretKey%40custom.host&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
        encryptionKey: "secretKey",
        apiHost: "custom.host",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe("moo-fam99-secretKey@custom.host");
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
        encryptionKey: "secretKey",
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
        encryptionKey: "secretKey",
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

  describe("#join= invite link parsing", () => {
    it("should set initialJoinFamilyId from #join= URL param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#join=abc1-def2",
        pathname: "/",
        href: "http://localhost/#join=abc1-def2",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.initialJoinFamilyId).toBe("abc1-def2");
      expect(result.current.initialSyncCode).toBe("");
      expect(result.current.auth).toBeNull();
    });

    it("should return empty initialJoinFamilyId when no #join= param", () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.initialJoinFamilyId).toBe("");
    });

    it("should clear URL when hash contains #join= param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#join=some-family-id",
        pathname: "/",
        href: "http://localhost/#join=some-family-id",
      });

      renderHook(() => useAuth());

      expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/");
    });

    it("should clear existing auth when #join= is present in URL", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      vi.stubGlobal("location", {
        search: "",
        hash: "#join=new-family-id",
        pathname: "/",
        href: "http://localhost/#join=new-family-id",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.initialJoinFamilyId).toBe("new-family-id");
    });
  });

  describe("login()", () => {
    it("should save to localStorage with namespaced keys and set auth", () => {
      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          encryptionKey: "key-new",
          apiHost: "api.example.com",
        });
      });

      expect(result.current.auth).toEqual({
        userId: "user-new",
        familyId: "fam-new",
        encryptionKey: "key-new",
        apiHost: "api.example.com",
      });
      expect(localStorage.getItem("moo:userId")).toBe("user-new");
      expect(localStorage.getItem(namespacedKey("user-new", "familyId"))).toBe("fam-new");
      expect(localStorage.getItem(namespacedKey("user-new", "encryptionKey"))).toBe("key-new");
      expect(localStorage.getItem(namespacedKey("user-new", "apiHost"))).toBe("api.example.com");
    });

    it("should remove apiHost from localStorage when not provided", () => {
      // Seed old data
      localStorage.setItem("moo:userId", "user-new");
      localStorage.setItem(namespacedKey("user-new", "apiHost"), "old-host.com");

      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          encryptionKey: "key-new",
        });
      });

      expect(localStorage.getItem(namespacedKey("user-new", "apiHost"))).toBeNull();
    });
  });

  describe("logout()", () => {
    it("should clear localStorage and set auth to null", () => {
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "host.com",
      });

      const { result } = renderHook(() => useAuth());

      // Verify auth was restored first
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "encryptionKey"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "apiHost"))).toBeNull();
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
          encryptionKey: "key-cycle",
        });
      });

      expect(result.current.auth).toEqual({
        userId: "user-cycle",
        familyId: "fam-cycle",
        encryptionKey: "key-cycle",
      });
      expect(localStorage.getItem("moo:userId")).toBe("user-cycle");

      // Logout
      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-cycle", "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-cycle", "encryptionKey"))).toBeNull();
    });
  });

  describe("remember sync code on logout", () => {
    it("should clear all auth keys and store sync code in REMEMBERED_LOGOUT_KEY when rememberSyncCode=1", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.host.com",
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
      expect(localStorage.getItem(namespacedKey("user-1", "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "encryptionKey"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "apiHost"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "authToken"))).toBeNull();
      // REMEMBERED_LOGOUT_KEY stores the sync code string
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe("moo-fam-1-key-1@custom.host.com");
    });

    it("should remember sync code when rememberSyncCode is not set (default to remember)", () => {
      // Don't set REMEMBER_SYNC_CODE_KEY at all — default is remember
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      expect(result.current.auth).toBeNull();
      // All auth keys should still be cleared
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "encryptionKey"))).toBeNull();
      // REMEMBERED_LOGOUT_KEY should be set (default is remember)
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe("moo-fam-1-key-1");
      // initialSyncCode should be set
      expect(result.current.initialSyncCode).toBe("moo-fam-1-key-1");
    });

    it("should NOT remember sync code when rememberSyncCode is explicitly set to 0", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "0");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
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
      localStorage.setItem(REMEMBERED_LOGOUT_KEY, "moo-fam-1-key-1@custom.host.com");

      const { result } = renderHook(() => useAuth());

      // Auth should NOT be set (no auth data in localStorage)
      expect(result.current.auth).toBeNull();
      // REMEMBERED_LOGOUT_KEY is NOT consumed by useAuth — LandingPage does that
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBe("moo-fam-1-key-1@custom.host.com");
    });

    it("should set initialSyncCode immediately on logout when remember is enabled", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
        apiHost: "custom.host.com",
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.logout();
      });

      // initialSyncCode should be set immediately (no refresh needed)
      expect(result.current.auth).toBeNull();
      expect(result.current.initialSyncCode).toBe("moo-fam-1-key-1@custom.host.com");
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
        encryptionKey: "key-1",
        apiHost: "custom.host.com",
      });

      const { result } = renderHook(() => useAuth());
      expect(result.current.auth).not.toBeNull();

      act(() => {
        result.current.forceLogout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "familyId"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "encryptionKey"))).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "apiHost"))).toBeNull();
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });

    it("should clear everything even with rememberSyncCode=1", () => {
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, "1");
      localStorage.setItem(REMEMBERED_LOGOUT_KEY, "moo-fam-1-key-1");
      seedStorage({
        userId: "user-1",
        familyId: "fam-1",
        encryptionKey: "key-1",
      });

      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.forceLogout();
      });

      expect(result.current.auth).toBeNull();
      expect(localStorage.getItem("moo:userId")).toBeNull();
      expect(localStorage.getItem(namespacedKey("user-1", "familyId"))).toBeNull();
      expect(localStorage.getItem(REMEMBER_SYNC_CODE_KEY)).toBeNull();
      expect(localStorage.getItem(REMEMBERED_LOGOUT_KEY)).toBeNull();
    });
  });
});
