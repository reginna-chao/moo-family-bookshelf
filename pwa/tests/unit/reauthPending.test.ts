/**
 * `pwa/src/utils/reauthPending.ts` — the "this session was ended by a forced
 * re-verification" markers (#266). The landing re-login reads them to decide
 * whether its join carries `recovery: 1`, so what matters here is WHICH
 * identities match a stored marker, that one identity's mark or clear never
 * touches another's (a shared device holds several), that the stored value
 * never exposes the raw identity, and that a misbehaving localStorage can
 * never throw out of it.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import {
  MARKER_HEX_CHARS,
  MAX_PENDING_MARKERS,
  REAUTH_PENDING_KEY,
  clearReauthPending,
  clearReauthPendingFor,
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

/** A second identity sharing the device (another family and account). */
const OTHER: ReauthIdentity = {
  familyId: "fam-002",
  userId: "0123456789abcdef".repeat(4),
};

/** An `@host` the client refuses: plain HTTP to a public host. */
const INVALID_HOST = "http://evil.example.com";

/** One whole stored marker: exactly MARKER_HEX_CHARS lowercase hex chars. */
const ENTRY = new RegExp(`^[0-9a-f]{${MARKER_HEX_CHARS}}$`);

/** The stored value split into its entries (empty when the key is absent). */
function storedEntries(): string[] {
  const raw = localStorage.getItem(REAUTH_PENDING_KEY);
  return raw === null ? [] : raw.split(",");
}

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

    // Shared device: B's forced logout must not overwrite A's marker, or A's
    // later re-login joins without `recovery` and re-adds A to the family.
    it("keeps both identities pending when a second one is written", async () => {
      const other = { ...IDENTITY, familyId: "fam-002" };
      await markReauthPending(IDENTITY);
      await markReauthPending(other);

      await expect(isReauthPendingFor(other)).resolves.toBe(true);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);
      expect(storedEntries()).toHaveLength(2);
    });

    it("stores one entry when the same identity is written twice", async () => {
      await markReauthPending(IDENTITY);
      await markReauthPending({ ...IDENTITY });

      expect(storedEntries()).toHaveLength(1);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);
    });
  });

  describe("clearReauthPendingFor", () => {
    it("removes only its own identity, then the key once the set is empty", async () => {
      await markReauthPending(IDENTITY);
      await markReauthPending(OTHER);

      await clearReauthPendingFor(IDENTITY);

      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
      await expect(isReauthPendingFor(OTHER)).resolves.toBe(true);
      expect(storedEntries()).toHaveLength(1);

      await clearReauthPendingFor(OTHER);

      // An emptied set removes the key — never an empty string.
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });

    it("changes nothing for an identity that was never marked", async () => {
      await markReauthPending(IDENTITY);
      const before = localStorage.getItem(REAUTH_PENDING_KEY);

      await clearReauthPendingFor(OTHER);

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBe(before);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);
    });

    it("writes nothing when no marker is stored at all", async () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");

      await clearReauthPendingFor(IDENTITY);

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBeNull();
    });

    it("leaves every marker when hashing fails", async () => {
      await markReauthPending(IDENTITY);
      const before = localStorage.getItem(REAUTH_PENDING_KEY);
      vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(
        new Error("no crypto"),
      );

      await expect(clearReauthPendingFor(IDENTITY)).resolves.toBeUndefined();

      expect(localStorage.getItem(REAUTH_PENDING_KEY)).toBe(before);
    });
  });

  describe("cap", () => {
    // Fixtures `fam-cap-0..16` have pairwise distinct 16-bit digests (the
    // length assertion below would catch a collision); change them if not.
    const capped: ReauthIdentity[] = Array.from(
      { length: MAX_PENDING_MARKERS + 1 },
      (_, i) => ({ ...IDENTITY, familyId: `fam-cap-${i}` }),
    );

    it("keeps the newest MAX_PENDING_MARKERS identities, dropping the oldest", async () => {
      expect(MAX_PENDING_MARKERS).toBe(16);
      for (const id of capped) await markReauthPending(id);

      const entries = storedEntries();
      expect(entries).toHaveLength(MAX_PENDING_MARKERS);
      expect(new Set(entries).size).toBe(MAX_PENDING_MARKERS);
      await expect(isReauthPendingFor(capped[0])).resolves.toBe(false);
      for (const id of capped.slice(1)) {
        await expect(isReauthPendingFor(id)).resolves.toBe(true);
      }
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
    it("is comma-joined truncated SHA-256 hex prefixes that expose none of the raw identity", async () => {
      const identity = {
        familyId: "fam-secret-77",
        userId: "fedcba9876543210".repeat(4),
        apiHost: "https://self-hosted.example.org",
      };
      await markReauthPending(identity);
      await markReauthPending(OTHER);

      const stored = localStorage.getItem(REAUTH_PENDING_KEY);
      expect(MARKER_HEX_CHARS).toBe(4);
      const entries = storedEntries();
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry).toHaveLength(MARKER_HEX_CHARS);
        expect(entry).toMatch(ENTRY);
      }
      expect(stored).toHaveLength(2 * MARKER_HEX_CHARS + 1);
      expect(stored).not.toContain(identity.familyId);
      expect(stored).not.toContain(identity.userId);
      expect(stored).not.toContain(OTHER.familyId);
      expect(stored).not.toContain(OTHER.userId);
      expect(stored).not.toContain("self-hosted");
      expect(stored).not.toContain("example.org");
    });

    it("does not match a stored value that is not this identity's digest", async () => {
      localStorage.setItem(REAUTH_PENDING_KEY, "garbage");

      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);
    });

    it.each([
      ["a legacy full 64-char digest", "a".repeat(64)],
      ["free text", "garbage"],
      ["uppercase hex", "ABCD"],
      ["too long and too short entries", "12345,123"],
      ["empty entries", ",,"],
    ])(
      "ignores %s on read and drops it on the next mark",
      async (_label, raw) => {
        localStorage.setItem(REAUTH_PENDING_KEY, raw);
        await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(false);

        await markReauthPending(IDENTITY);

        const entries = storedEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(ENTRY);
        await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);
      },
    );

    it("keeps a valid entry stored next to garbage", async () => {
      await markReauthPending(OTHER);
      const valid = localStorage.getItem(REAUTH_PENDING_KEY);
      localStorage.setItem(REAUTH_PENDING_KEY, `garbage,${valid},ABCD`);

      await markReauthPending(IDENTITY);

      expect(storedEntries()).toHaveLength(2);
      expect(storedEntries()[0]).toBe(valid);
      await expect(isReauthPendingFor(OTHER)).resolves.toBe(true);
      await expect(isReauthPendingFor(IDENTITY)).resolves.toBe(true);
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

    // Writing over markers it could not read would drop other identities'.
    it("writes nothing on mark when the read throws", async () => {
      await markReauthPending(OTHER);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");

      await expect(markReauthPending(IDENTITY)).resolves.toBeUndefined();

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await expect(isReauthPendingFor(OTHER)).resolves.toBe(true);
    });

    it("resolves without throwing or writing on clear when the read throws", async () => {
      await markReauthPending(IDENTITY);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");

      await expect(clearReauthPendingFor(IDENTITY)).resolves.toBeUndefined();

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
    });

    it.each<[string, "setItem" | "removeItem", ReauthIdentity[]]>([
      ["the rewrite of a shrunk set", "setItem", [IDENTITY, OTHER]],
      ["the removal of an emptied set", "removeItem", [IDENTITY]],
    ])(
      "resolves without throwing on clear when %s is refused",
      async (_label, method, seeded) => {
        for (const id of seeded) await markReauthPending(id);
        const refused = vi
          .spyOn(Storage.prototype, method)
          .mockImplementation(() => {
            throw new Error("denied");
          });

        await expect(clearReauthPendingFor(IDENTITY)).resolves.toBeUndefined();

        // The refused call really was the path taken.
        expect(refused).toHaveBeenCalled();
      },
    );

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
