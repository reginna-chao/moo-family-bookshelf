import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, BoolFlag, validateEndpointUrl } from "@/api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "@/constants";

// Mock the constants module to pin DEFAULT_API_ENDPOINT (avoids import.meta.env
// dependence) while keeping all real values — notably the storage-key constants
// that auth-refresh.ts imports.
vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

const MOCK_ENDPOINT = "https://test.workers.dev";

/**
 * Re-key a logical storage-read object to the production `moo:` keys, so the
 * mocked chrome.storage.local.get returns what auth-refresh.ts actually reads.
 */
const STORAGE_KEY_ALIAS: Record<string, string> = {
  userId: USER_ID_KEY,
  familyId: FAMILY_ID_KEY,
  authToken: AUTH_TOKEN_KEY,
  tokenExpiresAt: TOKEN_EXPIRES_AT_KEY,
};
function toStorageKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[STORAGE_KEY_ALIAS[k] ?? k] = v;
  }
  return out;
}

function mockFetchSuccess<T>(data: T, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
}

function mockFetchError(code: string, message: string, status = 400) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message } }),
  });
}

function mockFetchNetworkError(message = "Failed to fetch") {
  return vi.fn().mockRejectedValue(new Error(message));
}

describe("ApiClient", () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor and endpoint", () => {
    it("uses provided endpoint", () => {
      expect(client.getEndpoint()).toBe(MOCK_ENDPOINT);
    });

    it("falls back to DEFAULT_API_ENDPOINT when no URL provided", () => {
      const defaultClient = new ApiClient();
      expect(defaultClient.getEndpoint()).toBe("https://default.workers.dev");
    });

    it("strips trailing slashes from endpoint", () => {
      const c = new ApiClient("https://example.com///");
      expect(c.getEndpoint()).toBe("https://example.com");
    });

    it("setEndpoint updates the base URL", () => {
      client.setEndpoint("https://new.workers.dev/");
      expect(client.getEndpoint()).toBe("https://new.workers.dev");
    });
  });

  /**
   * The endpoint validator is the single gate between an attacker-supplied URL
   * (family record `apiEndpoint`, sync-code `@host`, settings input) and where
   * this device sends its auth token and full book list. Two duties:
   *   1. refuse unsafe values (scheme allowlist + no embedded credentials);
   *   2. return a CANONICAL string, so what gets stored / compared / displayed
   *      is exactly the origin the browser would resolve.
   */
  describe("validateEndpointUrl", () => {
    it.each([
      ["https://api.example.com", "https://api.example.com"],
      ["https://api.example.com/", "https://api.example.com"],
      ["http://localhost:8787", "http://localhost:8787"],
      ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
      ["http://192.168.1.100:3000", "http://192.168.1.100:3000"],
      ["http://10.0.0.5:8080", "http://10.0.0.5:8080"],
      ["http://172.16.0.1:8080", "http://172.16.0.1:8080"],
      ["http://mynas.local:8787", "http://mynas.local:8787"],
    ])("accepts %s", (input, expected) => {
      expect(validateEndpointUrl(input)).toBe(expected);
    });

    it.each([
      "http://evil.com",
      "ftp://files.example.com",
      "javascript:alert(1)",
      "not-a-url",
      "",
    ])("rejects %s", (input) => {
      expect(() => validateEndpointUrl(input)).toThrow();
    });

    /**
     * `https://real.example@evil.com` is a URL whose userinfo LOOKS like the
     * host: the browser fetches evil.com while the stored/displayed string reads
     * as real.example. There is no legitimate use for credentials in an API
     * endpoint, so the whole shape is refused rather than stripped.
     */
    describe("embedded credentials", () => {
      it.each([
        ["a host-shaped username", "https://real.example@evil.com"],
        ["a user:password pair", "https://user:pass@evil.com"],
        ["a password with no username", "https://:pass@evil.com"],
        ["credentials on a private-LAN HTTP URL", "http://user@192.168.1.5:87"],
      ])("rejects %s", (_label, input) => {
        expect(() => validateEndpointUrl(input)).toThrow(/credentials/i);
      });

      it("does not fall back to the real host it would have connected to", () => {
        // Returning "https://evil.com" would be honest but would silently
        // ACCEPT a URL the user believes points at real.example.
        expect(() =>
          validateEndpointUrl("https://real.example@evil.com"),
        ).toThrow();
      });
    });

    /**
     * Canonicalisation matters beyond tidiness: the same endpoint spelled two
     * ways must compare equal (endpoint-switch prompts, declined-value markers),
     * and the displayed host must be the resolved one.
     */
    describe("canonical form", () => {
      it.each([
        [
          "lowercases the host",
          "https://API.Example.COM",
          "https://api.example.com",
        ],
        [
          "converts an IDN host to punycode",
          "https://пример.example",
          "https://xn--e1afmkfd.example",
        ],
        [
          "leaves an already-punycode host alone",
          "https://xn--e1afmkfd.example",
          "https://xn--e1afmkfd.example",
        ],
        [
          "drops the default HTTPS port",
          "https://api.example.com:443",
          "https://api.example.com",
        ],
        [
          "drops the default HTTP port",
          "http://localhost:80",
          "http://localhost",
        ],
        [
          "keeps a non-default port",
          "https://api.example.com:8443",
          "https://api.example.com:8443",
        ],
        [
          "preserves a base path",
          "https://api.example.com/base",
          "https://api.example.com/base",
        ],
        [
          "strips a trailing slash from a base path",
          "https://api.example.com/base/",
          "https://api.example.com/base",
        ],
        [
          "strips repeated trailing slashes",
          "https://api.example.com/base///",
          "https://api.example.com/base",
        ],
        [
          "strips repeated trailing slashes from the root",
          "https://api.example.com///",
          "https://api.example.com",
        ],
        [
          "drops query and fragment",
          "https://api.example.com/base?token=x#frag",
          "https://api.example.com/base",
        ],
      ])("%s", (_label, input, expected) => {
        expect(validateEndpointUrl(input)).toBe(expected);
      });

      it("is idempotent — re-validating a canonical value returns it unchanged", () => {
        const once = validateEndpointUrl("https://API.Example.COM:443/base/");
        expect(once).toBe("https://api.example.com/base");
        expect(validateEndpointUrl(once)).toBe(once);
      });
    });

    it("setEndpoint stores the canonical form, not the caller's spelling", () => {
      const c = new ApiClient(MOCK_ENDPOINT);
      c.setEndpoint("https://API.Example.COM:443/base/");
      expect(c.getEndpoint()).toBe("https://api.example.com/base");
    });

    it("setEndpoint rejects a credential-bearing URL and keeps the previous endpoint", () => {
      const c = new ApiClient(MOCK_ENDPOINT);
      expect(() => c.setEndpoint("https://real.example@evil.com")).toThrow();
      expect(c.getEndpoint()).toBe(MOCK_ENDPOINT);
    });
  });

  describe("auth token management", () => {
    it("does not send Authorization header when no token is set", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBeUndefined();
    });

    it("sends Authorization header when token is set", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      client.setAuthToken("my-token");
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBe("Bearer my-token");
    });

    it("clears Authorization header when token set to null", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      client.setAuthToken("my-token");
      client.setAuthToken(null);
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBeUndefined();
    });
  });

  describe("request() — success handling", () => {
    it("returns data on successful response", async () => {
      globalThis.fetch = mockFetchSuccess({ userId: "abc" });
      const result = await client.getPersonalBooks("user-1");
      expect(result.data).toEqual({ userId: "abc" });
      expect(result.error).toBeUndefined();
    });

    it("sends Content-Type application/json", async () => {
      globalThis.fetch = mockFetchSuccess({});
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0][1].headers;
      expect(callHeaders["Content-Type"]).toBe("application/json");
    });
  });

  describe("request() — error handling", () => {
    it("returns error from API response on non-ok status", async () => {
      globalThis.fetch = mockFetchError("NOT_FOUND", "Not found", 404);
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({ code: "NOT_FOUND", message: "Not found" });
      expect(result.data).toBeUndefined();
    });

    it("returns UNKNOWN_ERROR when API response has no error field", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({
        code: "UNKNOWN_ERROR",
        message: "HTTP 500",
      });
    });

    it("returns NETWORK_ERROR on fetch rejection", async () => {
      globalThis.fetch = mockFetchNetworkError("Connection refused");
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({
        code: "NETWORK_ERROR",
        message: "Connection refused",
      });
    });

    it("returns generic NETWORK_ERROR for non-Error throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue("string error");
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({
        code: "NETWORK_ERROR",
        message: "Network error",
      });
    });
  });

  describe("lookupUser", () => {
    it("sends POST to /api/auth/lookup with userId", async () => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: null,
        memberCount: 0,
      });
      const userId = "a".repeat(64);
      const result = await client.lookupUser(userId);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/lookup"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.data).toEqual({ existingFamilyId: null, memberCount: 0 });
    });

    /**
     * The verification gate is opt-in per request. Self-hosted (BYO) Workers can
     * lag the Extension by releases, so a lookup WITHOUT a secret must stay
     * byte-identical to the pre-gate request — an unexpected extra field is what
     * a strict older backend would reject.
     */
    it.each([
      ["no options argument", undefined],
      ["an empty options object", {}],
      ["options without a secret", { verifySecret: undefined }],
    ])("omits verifySecret from the body given %s", async (_label, opts) => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: null,
        memberCount: 0,
      });
      const userId = "a".repeat(64);
      await client.lookupUser(userId, opts);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/auth/lookup`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId }),
        }),
      );
    });

    it("includes verifySecret in the body when supplied", async () => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: "fam-1",
        memberCount: 2,
      });
      const userId = "a".repeat(64);
      await client.lookupUser(userId, { verifySecret: "123456" });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body).toEqual({ userId, verifySecret: "123456" });
    });

    it("sends an empty-string secret rather than dropping it", async () => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: null,
        memberCount: 0,
      });
      const userId = "a".repeat(64);
      await client.lookupUser(userId, { verifySecret: "" });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      // The server must be the one to reject it (403), so the client cannot
      // silently downgrade the attempt into an un-authenticated lookup.
      expect(body).toEqual({ userId, verifySecret: "" });
    });

    it("surfaces requiresVerification from a withheld 200 payload", async () => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: null,
        memberCount: 0,
        requiresVerification: BoolFlag.TRUE,
      });
      const result = await client.lookupUser("a".repeat(64));

      expect(result.data).toEqual({
        existingFamilyId: null,
        memberCount: 0,
        requiresVerification: BoolFlag.TRUE,
      });
      expect(result.error).toBeUndefined();
    });

    it("surfaces a 429 lockout with its retryAfter through the envelope", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: {
              code: "VERIFICATION_LOCKED",
              message: "locked",
              retryAfter: 120,
            },
          }),
      });
      const result = await client.lookupUser("a".repeat(64), {
        verifySecret: "000000",
      });

      expect(result.error).toEqual({
        code: "VERIFICATION_LOCKED",
        message: "locked",
        retryAfter: 120,
      });
    });

    it("rejects a non-hex userId before issuing a request", async () => {
      globalThis.fetch = mockFetchSuccess({
        existingFamilyId: null,
        memberCount: 0,
      });
      await expect(client.lookupUser("invalid-id")).rejects.toThrow(
        "Invalid userId",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("getPersonalBooks", () => {
    it("sends GET to /api/user/:id/books", async () => {
      globalThis.fetch = mockFetchSuccess({ userId: "u1", books: [] });
      await client.getPersonalBooks("u1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/u1/books`,
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe("updatePersonalBooks", () => {
    it("sends PUT to /api/user/:id/books with PersonalBooks object", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      const personalBooks = {
        schemaVersion: 1,
        userId: "u1",
        displayName: "Test",
        books: [],
        lastUpdated: "2026-01-01T00:00:00.000Z",
      };
      await client.updatePersonalBooks("u1", personalBooks);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/u1/books`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(personalBooks),
        }),
      );
    });
  });

  describe("patchPersonalBooks", () => {
    it("sends PATCH to /api/user/:id/books with a { changes } body", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true, applied: 2 });
      const changes = [
        { bookId: "b1", isShared: BoolFlag.TRUE },
        { bookId: "b2", isShared: BoolFlag.FALSE },
      ];
      const result = await client.patchPersonalBooks("u1", changes);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/u1/books`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ changes }),
        }),
      );
      expect(result.data).toEqual({ ok: true, applied: 2 });
    });

    it("does not include a displayName in the PATCH body", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true, applied: 1 });
      await client.patchPersonalBooks("u1", [
        { bookId: "b1", isShared: BoolFlag.TRUE },
      ]);

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body).not.toHaveProperty("displayName");
      expect(Object.keys(body)).toEqual(["changes"]);
    });
  });

  describe("updateFamilyPrefs", () => {
    it("sends PUT to /api/user/:id/family-prefs with a { hidden, favorites } body", async () => {
      globalThis.fetch = mockFetchSuccess({
        ok: true,
        hidden: ["o1:b1"],
        favorites: [],
      });
      const userId = "a".repeat(64);
      const prefs = { hidden: ["o1:b1", "o2:b2"], favorites: ["o3:b3"] };
      await client.updateFamilyPrefs(userId, prefs);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/${userId}/family-prefs`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(prefs),
        }),
      );
    });

    it("unwraps the { data: { ok, hidden, favorites } } response envelope", async () => {
      globalThis.fetch = mockFetchSuccess({
        ok: true,
        hidden: ["o1:b1"],
        favorites: ["o3:b3"],
      });
      const userId = "a".repeat(64);
      const result = await client.updateFamilyPrefs(userId, {
        hidden: ["o1:b1"],
        favorites: ["o3:b3"],
      });
      expect(result.data).toEqual({
        ok: true,
        hidden: ["o1:b1"],
        favorites: ["o3:b3"],
      });
    });

    it("sends only the provided list (favorites-only update)", async () => {
      globalThis.fetch = mockFetchSuccess({
        ok: true,
        hidden: [],
        favorites: ["o3:b3"],
      });
      const userId = "a".repeat(64);
      await client.updateFamilyPrefs(userId, { favorites: ["o3:b3"] });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body).toEqual({ favorites: ["o3:b3"] });
    });

    it("sends empty lists as { hidden: [], favorites: [] }", async () => {
      globalThis.fetch = mockFetchSuccess({
        ok: true,
        hidden: [],
        favorites: [],
      });
      const userId = "a".repeat(64);
      await client.updateFamilyPrefs(userId, { hidden: [], favorites: [] });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body).toEqual({ hidden: [], favorites: [] });
    });

    it("rejects a non-hex userId before issuing a request", async () => {
      globalThis.fetch = mockFetchSuccess({
        ok: true,
        hidden: [],
        favorites: [],
      });
      await expect(
        client.updateFamilyPrefs("invalid-id", { hidden: ["o1:b1"] }),
      ).rejects.toThrow("Invalid userId");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("surfaces server error responses through the envelope", async () => {
      globalThis.fetch = mockFetchError("FORBIDDEN", "no access", 403);
      const userId = "a".repeat(64);
      const result = await client.updateFamilyPrefs(userId, {
        hidden: ["o1:b1"],
      });
      expect(result.error).toEqual({ code: "FORBIDDEN", message: "no access" });
    });
  });

  describe("createFamily", () => {
    it("sends POST to /api/family with userId and displayName", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1", "Alice");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "u1", displayName: "Alice" }),
        }),
      );
    });

    it("does not include keyFingerprint in request body", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1", "Alice");

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body.keyFingerprint).toBeUndefined();
    });

    it("defaults displayName to empty string when undefined", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1", undefined);

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body.displayName).toBe("");
    });

    /** Same BYO-backend contract as lookupUser: no secret ⇒ unchanged body. */
    it.each([
      ["no options argument", undefined],
      ["an empty options object", {}],
      ["options without a secret", { verifySecret: undefined }],
    ])("omits verifySecret from the body given %s", async (_label, opts) => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1", "Alice", opts);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "u1", displayName: "Alice" }),
        }),
      );
    });

    it("includes verifySecret in the body when supplied", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1", "Alice", { verifySecret: "123456" });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body).toEqual({
        userId: "u1",
        displayName: "Alice",
        verifySecret: "123456",
      });
    });

    it("surfaces a 403 verification refusal through the envelope", async () => {
      globalThis.fetch = mockFetchError(
        "VERIFICATION_REQUIRED",
        "需要驗證",
        403,
      );
      const result = await client.createFamily("u1", "Alice");

      expect(result.error).toEqual({
        code: "VERIFICATION_REQUIRED",
        message: "需要驗證",
      });
    });

    it("surfaces a 429 lockout with its retryAfter through the envelope", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: {
              code: "VERIFICATION_LOCKED",
              message: "locked",
              retryAfter: 90,
            },
          }),
      });
      const result = await client.createFamily("u1", "Alice", {
        verifySecret: "000000",
      });

      expect(result.error).toEqual({
        code: "VERIFICATION_LOCKED",
        message: "locked",
        retryAfter: 90,
      });
    });
  });

  describe("joinFamily", () => {
    it("sends POST to /api/family/:id/join with userId and displayName", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.joinFamily("fam-1", "u1", "Bob");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/join`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "u1", displayName: "Bob" }),
        }),
      );
    });

    it("defaults displayName to empty string when omitted", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.joinFamily("fam-1", "u1");

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body.displayName).toBe("");
    });

    it("includes verifySecret in body when opts.verifySecret is provided", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.joinFamily("fam-1", "u1", "Bob", { verifySecret: "1234" });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body.verifySecret).toBe("1234");
    });

    it("does not include keyFingerprint or verifySecret when opts is undefined", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.joinFamily("fam-1", "u1", "Bob");

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
          .body as string,
      );
      expect(body.keyFingerprint).toBeUndefined();
      expect(body.verifySecret).toBeUndefined();
    });
  });

  describe("leaveFamily", () => {
    it("sends DELETE to /api/family/:id/member/:uid", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.leaveFamily("fam-1", "u1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/member/u1`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("removeMember", () => {
    it("sends DELETE to /api/family/:id/member/:targetUserId", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.removeMember("fam-1", "target-u");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/member/target-u`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("transferOwnership", () => {
    it("sends PUT to /api/family/:id/transfer", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.transferOwnership("fam-1", "u1", "u2");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/transfer`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ userId: "u1", newOwnerId: "u2" }),
        }),
      );
    });
  });

  describe("getFamilyMembers", () => {
    it("sends GET to /api/family/:id/members", async () => {
      globalThis.fetch = mockFetchSuccess({ members: [] });
      await client.getFamilyMembers("fam-1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/members`,
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe("getFamilyBookshelf", () => {
    it("sends GET to /api/family/:id/bookshelf", async () => {
      globalThis.fetch = mockFetchSuccess({ members: [] });
      await client.getFamilyBookshelf("fam-1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/bookshelf`,
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe("updateDisplayName", () => {
    it("sends PUT to /api/family/:id/member/:uid/displayName", async () => {
      globalThis.fetch = mockFetchSuccess({ userId: "u1", displayName: "New" });
      await client.updateDisplayName("fam-1", "u1", "New");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/member/u1/displayName`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ displayName: "New" }),
        }),
      );
    });
  });

  describe("401 token refresh logic", () => {
    it("attempts token refresh on 401 and retries original request", async () => {
      // First call: 401, second call (refresh): success, third call (retry): success
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { token: "new-token" } }),
        })
        // Retry original request → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { userId: "u1", books: [] } }),
        });
      globalThis.fetch = fetchMock;

      // Set up chrome.storage.local.get to return userId and familyId
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({ userId: "u1", familyId: "fam-1" });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const result = await client.getPersonalBooks("u1");
      expect(result.data).toEqual({ userId: "u1", books: [] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("returns 401 error when refresh fails and recovery fails", async () => {
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Invalid" },
            }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: "FAMILY_NOT_FOUND", message: "Not found" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const result = await client.getPersonalBooks("u1");
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 error when no userId/familyId in storage", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { code: "UNAUTHORIZED", message: "Expired" },
          }),
      });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = {};
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const result = await client.getPersonalBooks("u1");
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("deduplicates concurrent refresh requests", async () => {
      let refreshCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/auth/refresh")) {
          refreshCallCount++;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { token: "new-token" } }),
          });
        }
        // All initial requests → 401
        if (refreshCallCount === 0) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () =>
              Promise.resolve({
                error: { code: "UNAUTHORIZED", message: "Expired" },
              }),
          });
        }
        // Retried requests → success
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { ok: true } }),
        });
      });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({ userId: "u1", familyId: "fam-1" });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      // Fire two concurrent requests that both get 401
      const [r1, r2] = await Promise.all([
        client.getPersonalBooks("u1"),
        client.getFamilyMembers("fam-1"),
      ]);

      // Only one refresh call should have been made
      expect(refreshCallCount).toBe(1);
      expect(r1.data).toEqual({ ok: true });
      expect(r2.data).toEqual({ ok: true });
    });

    it("calls onFamilyRemoved callback on REFRESH_FAILED when recovery fails", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Removed" },
            }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: "FAMILY_NOT_FOUND", message: "Not found" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const onFamilyRemoved = vi.fn();
      client.onFamilyRemoved = onFamilyRemoved;

      await client.getPersonalBooks("u1");

      expect(onFamilyRemoved).toHaveBeenCalledOnce();
    });

    it("does not throw when onFamilyRemoved is null on REFRESH_FAILED", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Removed" },
            }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: "FAMILY_NOT_FOUND", message: "Not found" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      client.onFamilyRemoved = null;

      // Should not throw
      const result = await client.getPersonalBooks("u1");
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("recovers via joinFamily on REFRESH_FAILED and retries original request", async () => {
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Token expired" },
            }),
        })
        // joinFamily recovery → success with new token
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                familyId: "fam-1",
                ownerId: "owner-1",
                members: [{ userId: "u1", displayName: "Test" }],
                maxMembers: 6,
                createdAt: "2026-01-01",
                authToken: "recovered-token",
                expiresAt: 9999999999,
              },
            }),
        })
        // Retry original request → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { userId: "u1", books: [] } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test User",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const onFamilyRemoved = vi.fn();
      client.onFamilyRemoved = onFamilyRemoved;

      const result = await client.getPersonalBooks("u1");

      // Recovery succeeded — original request retried successfully
      expect(result.data).toEqual({ userId: "u1", books: [] });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // onFamilyRemoved should NOT be called on successful recovery
      expect(onFamilyRemoved).not.toHaveBeenCalled();
      // New token should be stored
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          [AUTH_TOKEN_KEY]: "recovered-token",
          [TOKEN_EXPIRES_AT_KEY]: 9999999999,
        }),
      );
    });

    it("omits displayName from joinFamily recovery request so backend preserves existing member name", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Token expired" },
            }),
        })
        // joinFamily recovery → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                familyId: "fam-1",
                ownerId: "owner-1",
                members: [],
                maxMembers: 6,
                createdAt: "2026-01-01",
                authToken: "new-token",
              },
            }),
        })
        // Retry → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { ok: true } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "小明",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      await client.getPersonalBooks("u1");

      // The third fetch call is the joinFamily recovery
      const joinCall = fetchMock.mock.calls[2];
      expect(joinCall[0]).toBe(`${MOCK_ENDPOINT}/api/family/fam-1/join`);
      const joinBody = JSON.parse(joinCall[1].body as string);
      expect(joinBody.userId).toBe("u1");
      // Recovery must NOT send displayName — the backend should preserve the
      // existing member's name instead of having it overwritten by a default.
      expect(joinBody).not.toHaveProperty("displayName");
    });

    it("does not attempt joinFamily recovery when familyId/userId missing from storage", async () => {
      let getCallCount = 0;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Removed" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          getCallCount++;
          // First call (for refresh): has userId/familyId
          // Second call (for recovery): missing familyId
          const result =
            getCallCount === 1
              ? toStorageKeys({ userId: "u1", familyId: "fam-1" })
              : toStorageKeys({ userId: "u1" });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const onFamilyRemoved = vi.fn();
      client.onFamilyRemoved = onFamilyRemoved;

      await client.getPersonalBooks("u1");

      // Only 2 fetch calls — no joinFamily attempt
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Recovery was skipped with NO join error code (familyId missing), which
      // is a transient/unknown outcome — NOT a genuine "family gone". Per the
      // new contract (Invariant 2) family data must be left intact and
      // onFamilyRemoved must NOT fire on this path.
      expect(onFamilyRemoved).not.toHaveBeenCalled();
      expect(chrome.storage.local.remove).not.toHaveBeenCalledWith([
        FAMILY_ID_KEY,
      ]);
    });

    it("attempts joinFamily recovery on non-REFRESH_FAILED errors (e.g. rate limit)", async () => {
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → rate limited (429, not REFRESH_FAILED)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: () =>
            Promise.resolve({
              error: { code: "RATE_LIMITED", message: "Too many requests" },
            }),
        })
        // joinFamily recovery → success with new token
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                familyId: "fam-1",
                ownerId: "u1",
                members: [],
                maxMembers: 2,
                createdAt: "2026-01-01",
                authToken: "recovered-token",
                expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
              },
            }),
        })
        // Retried original request → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { userId: "u1", books: [] } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const onFamilyRemoved = vi.fn();
      client.onFamilyRemoved = onFamilyRemoved;

      const result = await client.getPersonalBooks("u1");

      // Should have recovered via joinFamily
      expect(result.data).toBeDefined();
      expect(onFamilyRemoved).not.toHaveBeenCalled();
      // 4 calls: original 401 → refresh 429 → joinFamily success → retry success
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not propagate a rejected FAMILY_REMOVED sendMessage when recovery fails", async () => {
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Removed" },
            }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: "FAMILY_NOT_FOUND", message: "Not found" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      // Simulate webextension-polyfill rejecting when no listener is active /
      // the context is invalidated. A synchronous try/catch cannot catch this;
      // the recovery-failure path must still resolve cleanly.
      vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(
        new Error(
          "Could not establish connection. Receiving end does not exist.",
        ),
      );

      const result = await client.getPersonalBooks("u1");

      // The rejected sendMessage must not propagate out of the refresh flow:
      // the original request still resolves to its 401 error envelope.
      expect(result.error?.code).toBe("UNAUTHORIZED");
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "FAMILY_REMOVED",
      });
    });

    it("clears token then family data on REFRESH_FAILED when recovery fails", async () => {
      const fetchMock = vi
        .fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Removed" },
            }),
        })
        // joinFamily recovery attempt → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              error: { code: "FAMILY_NOT_FOUND", message: "Not found" },
            }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (
          keys: unknown,
          callback?: (result: Record<string, unknown>) => void,
        ) => {
          const result = toStorageKeys({
            userId: "u1",
            familyId: "fam-1",
            displayName: "Test",
          });
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      await client.getPersonalBooks("u1");

      // First: clear only token
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        AUTH_TOKEN_KEY,
        TOKEN_EXPIRES_AT_KEY,
      ]);
      // Then: clear family data after recovery fails
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([FAMILY_ID_KEY]);
    });

    /**
     * When staged recovery is throttled by the worker (429 RATE_LIMITED), the
     * 401 path must NOT surface the raw English 401 — it returns a friendly,
     * localized RATE_LIMITED envelope so the UI can tell the user to retry later
     * (and must not prompt re-verification, which would fail anyway).
     */
    describe("rate-limited recovery", () => {
      /** 401 → refresh fails → join recovery is 429 RATE_LIMITED. */
      function mockRateLimitedRecovery(retryAfter?: number) {
        return (
          vi
            .fn()
            // Original request → 401
            .mockResolvedValueOnce({
              ok: false,
              status: 401,
              json: () =>
                Promise.resolve({
                  error: { code: "UNAUTHORIZED", message: "Expired" },
                }),
            })
            // Refresh request → REFRESH_FAILED
            .mockResolvedValueOnce({
              ok: false,
              status: 401,
              json: () =>
                Promise.resolve({
                  error: { code: "REFRESH_FAILED", message: "Token expired" },
                }),
            })
            // joinFamily recovery → 429 rate limited
            .mockResolvedValueOnce({
              ok: false,
              status: 429,
              json: () =>
                Promise.resolve({
                  error: {
                    code: "RATE_LIMITED",
                    message: "Too many requests",
                    ...(retryAfter !== undefined ? { retryAfter } : {}),
                  },
                }),
            })
        );
      }

      function seedMembership() {
        vi.mocked(chrome.storage.local.get).mockImplementation(
          (
            keys: unknown,
            callback?: (result: Record<string, unknown>) => void,
          ) => {
            const result = toStorageKeys({
              userId: "u1",
              familyId: "fam-1",
              displayName: "Test",
            });
            if (typeof callback === "function") callback(result);
            return Promise.resolve(result) as unknown as void;
          },
        );
      }

      it("returns a localized RATE_LIMITED envelope instead of the raw 401", async () => {
        globalThis.fetch = mockRateLimitedRecovery(120);
        seedMembership();

        const result = await client.getPersonalBooks("u1");

        expect(result.error?.code).toBe("RATE_LIMITED");
        // Localized (not the raw English 401 message) — contains Chinese and the
        // stable "稍後" substring; an approximate wait is appended when known.
        expect(result.error?.message).toMatch(/[一-鿿]/);
        expect(result.error?.message).toContain("稍後");
        expect(result.error?.message).toMatch(/分鐘後/);
        // No retry of the original request — it was never re-issued with a token.
        expect(
          globalThis.fetch as ReturnType<typeof vi.fn>,
        ).toHaveBeenCalledTimes(3);
      });

      it("still returns a localized RATE_LIMITED envelope when the 429 omits retryAfter", async () => {
        globalThis.fetch = mockRateLimitedRecovery();
        seedMembership();

        const result = await client.getPersonalBooks("u1");

        // A default cooldown is applied, so the envelope is still the localized
        // RATE_LIMITED copy; assert only the stable base substring (don't pin the
        // exact minute figure the fallback produces).
        expect(result.error?.code).toBe("RATE_LIMITED");
        expect(result.error?.message).toContain("稍後");
      });

      it("does not prompt re-verification (onReauthRequired) when rate-limited", async () => {
        globalThis.fetch = mockRateLimitedRecovery(60);
        seedMembership();

        const onReauthRequired = vi.fn();
        const onFamilyRemoved = vi.fn();
        client.onReauthRequired = onReauthRequired;
        client.onFamilyRemoved = onFamilyRemoved;

        const result = await client.getPersonalBooks("u1");

        expect(result.error?.code).toBe("RATE_LIMITED");
        expect(onReauthRequired).not.toHaveBeenCalled();
        expect(onFamilyRemoved).not.toHaveBeenCalled();
        // Family data must survive a rate-limited recovery (Invariant 2).
        expect(chrome.storage.local.remove).not.toHaveBeenCalledWith([
          FAMILY_ID_KEY,
        ]);
      });
    });

    /**
     * Reauth-pending latch: once a verification prompt has been raised (recovery
     * returned a VERIFICATION_* code), the client latches so a second 401 wave —
     * e.g. the dialog's second concurrent data fetch — does NOT fire silent
     * join-recovery again. This keeps a single dialog open to at most one
     * join-quota unit and stops the in-progress verification prompt from being
     * re-initialized (which would wipe the user's pattern/PIN input). The latch
     * releases only on a fresh non-null token or an explicit clearReauthPending().
     */
    describe("reauth-pending latch", () => {
      /** A 401 on the original protected request. */
      function resp401() {
        return {
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "UNAUTHORIZED", message: "Expired" },
            }),
        };
      }
      /** The refresh POST failing (dead token). */
      function respRefreshFailed() {
        return {
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({
              error: { code: "REFRESH_FAILED", message: "Token expired" },
            }),
        };
      }
      /** The recovery join demanding a PWA-login verification secret. */
      function respJoinVerification() {
        return {
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              error: { code: "VERIFICATION_REQUIRED", message: "verify" },
            }),
        };
      }

      function seedMembership() {
        vi.mocked(chrome.storage.local.get).mockImplementation(
          (
            keys: unknown,
            callback?: (result: Record<string, unknown>) => void,
          ) => {
            const result = toStorageKeys({
              userId: "u1",
              familyId: "fam-1",
              displayName: "Test",
            });
            if (typeof callback === "function") callback(result);
            return Promise.resolve(result) as unknown as void;
          },
        );
      }

      /** Count how many issued fetches targeted the /join recovery endpoint. */
      function joinRequestCount(fetchMock: ReturnType<typeof vi.fn>): number {
        return fetchMock.mock.calls.filter((call) =>
          String(call[0]).endsWith("/join"),
        ).length;
      }

      it("fires the onReauthRequired user callback once and joins once across two 401 waves", async () => {
        // Wave 1: 401 → refresh-fail → join(VERIFICATION_REQUIRED)  [latches]
        // Wave 2: 401 → refresh-fail                                [join skipped]
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification())
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed());
        globalThis.fetch = fetchMock;
        seedMembership();

        const onReauthRequired = vi.fn();
        client.onReauthRequired = onReauthRequired;

        await client.getPersonalBooks("u1");
        await client.getFamilyMembers("fam-1");

        // User callback fired exactly once despite two dead-token waves.
        expect(onReauthRequired).toHaveBeenCalledTimes(1);
        // Only one quota-sensitive join total (the second wave was suppressed).
        expect(joinRequestCount(fetchMock)).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(5);
      });

      it("forwards the blocking code and retryAfter to the onReauthRequired callback", async () => {
        // The prompt needs to know WHY recovery was blocked so a locked member
        // opens straight onto the countdown instead of a doomed input.
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce({
            ok: false,
            status: 429,
            json: () =>
              Promise.resolve({
                error: {
                  code: "VERIFICATION_LOCKED",
                  message: "locked",
                  retryAfter: 120,
                },
              }),
          });
        globalThis.fetch = fetchMock;
        seedMembership();

        const onReauthRequired = vi.fn();
        client.onReauthRequired = onReauthRequired;

        await client.getPersonalBooks("u1");

        expect(onReauthRequired).toHaveBeenCalledWith({
          errorCode: "VERIFICATION_LOCKED",
          retryAfter: 120,
        });
      });

      it("clears the latch on setAuthToken(<token>) so a later 401 wave joins again", async () => {
        // Wave 1 latches; setAuthToken("x") releases; Wave 2 re-attempts join.
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification())
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification());
        globalThis.fetch = fetchMock;
        seedMembership();

        const onReauthRequired = vi.fn();
        client.onReauthRequired = onReauthRequired;

        await client.getPersonalBooks("u1");
        // A fresh token means auth succeeded elsewhere — release the latch.
        client.setAuthToken("sometoken");
        await client.getFamilyMembers("fam-1");

        expect(onReauthRequired).toHaveBeenCalledTimes(2);
        expect(joinRequestCount(fetchMock)).toBe(2);
      });

      it("does NOT clear the latch on setAuthToken(null) — join stays suppressed", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification())
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed());
        globalThis.fetch = fetchMock;
        seedMembership();

        const onReauthRequired = vi.fn();
        client.onReauthRequired = onReauthRequired;

        await client.getPersonalBooks("u1");
        // A null token is set mid-failure by doRefreshToken; it must NOT release.
        client.setAuthToken(null);
        await client.getFamilyMembers("fam-1");

        expect(onReauthRequired).toHaveBeenCalledTimes(1);
        expect(joinRequestCount(fetchMock)).toBe(1);
      });

      it("clears the latch on clearReauthPending() so a later 401 wave joins again", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification())
          .mockResolvedValueOnce(resp401())
          .mockResolvedValueOnce(respRefreshFailed())
          .mockResolvedValueOnce(respJoinVerification());
        globalThis.fetch = fetchMock;
        seedMembership();

        const onReauthRequired = vi.fn();
        client.onReauthRequired = onReauthRequired;

        await client.getPersonalBooks("u1");
        // Explicit release (e.g. the user cancelled the re-verification prompt).
        client.clearReauthPending();
        await client.getFamilyMembers("fam-1");

        expect(onReauthRequired).toHaveBeenCalledTimes(2);
        expect(joinRequestCount(fetchMock)).toBe(2);
      });
    });
  });
});
