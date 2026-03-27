import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAuth } from "@/hooks/useAuth";

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

// Helper to set up localStorage with auth data
function seedStorage(data: {
  userId?: string;
  familyId?: string;
  encryptionKey?: string;
  apiHost?: string;
}) {
  if (data.userId) localStorage.setItem("moo:userId", data.userId);
  if (data.familyId) localStorage.setItem("moo:familyId", data.familyId);
  if (data.encryptionKey)
    localStorage.setItem("moo:encryptionKey", data.encryptionKey);
  if (data.apiHost) localStorage.setItem("moo:apiHost", data.apiHost);
}

describe("useAuth", () => {
  let replaceStateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    replaceStateSpy = vi.fn();
    vi.stubGlobal("location", {
      search: "",
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
      seedStorage({ familyId: "fam-1", encryptionKey: "key-1" });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("should return null auth when familyId is missing", () => {
      seedStorage({ userId: "user-1", encryptionKey: "key-1" });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });

    it("should return null auth when encryptionKey is missing", () => {
      seedStorage({ userId: "user-1", familyId: "fam-1" });

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
    it("should parse auth from URL params and set auth", () => {
      vi.stubGlobal("location", {
        search: "?code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?code=moo-fam99-secretKey&uid=user-abc",
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

    it("should parse auth with apiHost from URL params", () => {
      vi.stubGlobal("location", {
        search: "?code=moo-fam99-secretKey@custom.host&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?code=moo-fam99-secretKey@custom.host&uid=user-abc",
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

    it("should save parsed QR data to localStorage", () => {
      vi.stubGlobal("location", {
        search: "?code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?code=moo-fam99-secretKey&uid=user-abc",
      });
      mockDecodeSyncCode.mockReturnValue({
        familyId: "fam99",
        encryptionKey: "secretKey",
      });

      renderHook(() => useAuth());

      expect(localStorage.getItem("moo:userId")).toBe("user-abc");
      expect(localStorage.getItem("moo:familyId")).toBe("fam99");
      expect(localStorage.getItem("moo:encryptionKey")).toBe("secretKey");
    });

    it("should clear URL params via replaceState after parsing", () => {
      vi.stubGlobal("location", {
        search: "?code=moo-fam99-secretKey&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?code=moo-fam99-secretKey&uid=user-abc",
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
        search: "?code=invalid-code&uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?code=invalid-code&uid=user-abc",
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
        search: "?uid=user-abc",
        pathname: "/app",
        href: "http://localhost/app?uid=user-abc",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });

    it("should not crash when uid param is missing", () => {
      vi.stubGlobal("location", {
        search: "?code=moo-fam99-key",
        pathname: "/app",
        href: "http://localhost/app?code=moo-fam99-key",
      });

      const { result } = renderHook(() => useAuth());

      expect(result.current.auth).toBeNull();
    });
  });

  describe("login()", () => {
    it("should save to localStorage and set auth", () => {
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
      expect(localStorage.getItem("moo:familyId")).toBe("fam-new");
      expect(localStorage.getItem("moo:encryptionKey")).toBe("key-new");
      expect(localStorage.getItem("moo:apiHost")).toBe("api.example.com");
    });

    it("should remove apiHost from localStorage when not provided", () => {
      localStorage.setItem("moo:apiHost", "old-host.com");

      const { result } = renderHook(() => useAuth());

      act(() => {
        result.current.login({
          userId: "user-new",
          familyId: "fam-new",
          encryptionKey: "key-new",
        });
      });

      expect(localStorage.getItem("moo:apiHost")).toBeNull();
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
      expect(localStorage.getItem("moo:familyId")).toBeNull();
      expect(localStorage.getItem("moo:encryptionKey")).toBeNull();
      expect(localStorage.getItem("moo:apiHost")).toBeNull();
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
      expect(localStorage.getItem("moo:familyId")).toBeNull();
      expect(localStorage.getItem("moo:encryptionKey")).toBeNull();
    });
  });
});
