import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAuth, namespacedKey } from "@/hooks/useAuth";

// Mock decodeSyncCode
vi.mock("@/crypto/syncCode", () => ({
  decodeSyncCode: vi.fn(),
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

  describe("QR Code URL parsing", () => {
    it("should parse auth from URL fragment and set auth", () => {
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
      expect(result.current.auth).toEqual({
        userId: "user-abc",
        familyId: "fam99",
        encryptionKey: "secretKey",
        apiHost: undefined,
      });
      expect(result.current.isLoading).toBe(false);
    });

    it("should parse auth with apiHost from URL fragment", () => {
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

      expect(result.current.auth).toEqual({
        userId: "user-abc",
        familyId: "fam99",
        encryptionKey: "secretKey",
        apiHost: "custom.host",
      });
    });

    it("should save parsed QR data to localStorage with namespaced keys", () => {
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

      expect(localStorage.getItem("moo:userId")).toBe("user-abc");
      expect(localStorage.getItem(namespacedKey("user-abc", "familyId"))).toBe("fam99");
      expect(localStorage.getItem(namespacedKey("user-abc", "encryptionKey"))).toBe("secretKey");
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

  describe("#family= invite link parsing", () => {
    it("should set initialSyncCode from #family= URL param", () => {
      vi.stubGlobal("location", {
        search: "",
        hash: "#family=moo-abc1-def2-secretKey",
        pathname: "/",
        href: "http://localhost/#family=moo-abc1-def2-secretKey",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.initialSyncCode).toBe("moo-abc1-def2-secretKey");
      expect(result.current.auth).toBeNull();
    });

    it("should return empty initialSyncCode when no #family= param", () => {
      const { result } = renderHook(() => useAuth());

      expect(result.current.initialSyncCode).toBe("");
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
});
