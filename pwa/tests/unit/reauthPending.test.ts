/**
 * `pwa/src/utils/reauthPending.ts` — the "this session was ended by a forced
 * re-verification" marker (#266). The landing re-login reads it to decide
 * whether its join carries `recovery: 1`, so what matters here is WHICH
 * identities match a stored marker, that the stored value never exposes the
 * raw identity, and that a misbehaving localStorage can never throw out of it.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import {
  MARKER_HEX_CHARS,
  REAUTH_PENDING_KEY,
  clearReauthPending,
  isReauthPendingFor,
  markReauthPending,
  type ReauthIdentity,
} from "@/utils/reauthPending";
import { DEFAULT_API_ENDPOINT } from "@/constants";

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const CUSTOM_ENDPOINT = "https://custom.api.com";

const IDENTITY: ReauthIdentity = {
  familyId: "fam-001",
  userId: "abcdef0123456789".repeat(4),
};

/** An `@host` the client refuses: plain HTTP to a public host. */
const INVALID_HOST = "http://evil.example.com";

describe("reauthPending", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(REAUTH_PENDING_KEY);
  });

  describe("round trip", () => {
    it("matches the identity it was written for", async () => {
      await markReauthPending(IDENTITY);

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).not.toBeNull();
      await expect(isReauthPendingFor({ ...IDENTITY })).resolves.toBe(true);
    });

    it("reports no marker when nothing was written", async () => {
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });

    it("stops matching once cleared, and removes the key", async () => {
      await markReauthPending(IDENTITY);
      clearReauthPending();

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });

    it("keeps only the latest identity when written twice", async () => {
      const other = { ...IDENTITY, familyId: "fam-002" };
      await markReauthPending(IDENTITY);
      await markReauthPending(other);

      await expect(isReauthPendingFor(other)).resolves.toBe(true);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });
  });

  describe("identity matching", () => {
    it.each<[string, ReauthIdentity]>([
      ["another familyId", { ...IDENTITY, familyId: "fam-002" }],
      ["another userId", { ...IDENTITY, userId: "1".repeat(64) }],
      ["another server", { ...IDENTITY, apiHost: CUSTOM_ENDPOINT }],
    ])("does not match %s", async (_label, probe) => {
      await markReauthPending(IDENTITY);

      await expect(isReauthPendingFor(probe)).resolves.toBe(false);
    });

    // The stored session holds `apiHost` undefined for the default server,
    // while a sync code may spell that server out — both are one server.
    it.each<[string, string | undefined, string | undefined]>([
      [
        "absent vs the default endpoint spelled out",
        undefined,
        DEFAULT_API_ENDPOINT,
      ],
      [
        "absent vs the default endpoint with a trailing slash",
        undefined,
        `${DEFAULT_API_ENDPOINT}/`,
      ],
      [
        "the default endpoint spelled out vs absent",
        DEFAULT_API_ENDPOINT,
        undefined,
      ],
      ["an empty string vs absent", "", undefined],
      [
        "a custom endpoint vs its trailing-slash form",
        CUSTOM_ENDPOINT,
        `${CUSTOM_ENDPOINT}/`,
      ],
    ])("treats %s as the same server", async (_label, written, read) => {
      await markReauthPending({ ...IDENTITY, apiHost: written });

      await expect(
        isReauthPendingFor({ ...IDENTITY, apiHost: read }),
      ).resolves.toBe(true);
    });

    it("writes no marker for an endpoint the client would refuse", async () => {
      await markReauthPending({ ...IDENTITY, apiHost: INVALID_HOST });

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });

    it("never matches an endpoint the client would refuse", async () => {
      // Positive companion: the same identity on the default server matches.
      await markReauthPending(IDENTITY);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);

      await expect(
        isReauthPendingFor({ ...IDENTITY, apiHost: INVALID_HOST }),
      ).resolves.toBe(false);
      await expect(
        isReauthPendingFor({
          ...IDENTITY,
          apiHost: "https://user:pass@custom.api.com",
        }),
      ).resolves.toBe(false);
    });
  });

  describe("stored value", () => {
    // The length pin is the guard: a full 64-char digest can be brute-forced back to the familyId.
    it("is a truncated SHA-256 hex prefix that exposes none of the raw identity", async () => {
      const identity = {
        familyId: "fam-secret-77",
        userId: "fedcba9876543210".repeat(4),
        apiHost: "https://self-hosted.example.org",
      };
      await markReauthPending(identity);

      const stored = localStorage.getItem(REAUTH_PENDING_KEY);
      expect(MARKER_HEX_CHARS).toBe(4);
      expect(stored).toHaveLength(MARKER_HEX_CHARS);
      expect(stored).toMatch(/^[0-9a-f]+$/);
      expect(stored).not.toContain(identity.familyId);
      expect(stored).not.toContain(identity.userId);
      expect(stored).not.toContain("self-hosted");
      expect(stored).not.toContain("example.org");
    });

    it("does not match a stored value that is not this identity's digest", async () => {
      localStorage.setItem(REAUTH_PENDING_KEY, "garbage");

      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });
  });

  describe("a misbehaving localStorage", () => {
    it("resolves without throwing when the write is refused", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });

      await expect(markReauthPending(IDENTITY)).resolves.toBeUndefined();
    });

    it("reads as no marker when the read throws", async () => {
      await markReauthPending(IDENTITY);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });

      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });

    it("does not throw when the removal throws", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("denied");
      });

      expect(() => clearReauthPending()).not.toThrow();
    });

    it("writes nothing and matches nothing when hashing fails", async () => {
      vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(
        new Error("no crypto"),
      );

      await expect(markReauthPending(IDENTITY)).resolves.toBeUndefined();
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
      localStorage.setItem(REAUTH_PENDING_KEY, "a".repeat(64));
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });
  });
});
