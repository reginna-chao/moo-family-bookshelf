import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, BoolFlag, validateEndpointUrl } from "@/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Valid 64-char hex userId for tests
const USER_1 = "a".repeat(64);
const USER_2 = "b".repeat(64);
const USER_TARGET = "c".repeat(64);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

describe("ApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient("https://api.example.com");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor and endpoint management", () => {
    it("should strip trailing slashes from the API URL", () => {
      const c = new ApiClient("https://api.example.com///");
      expect(c.getEndpoint()).toBe("https://api.example.com");
    });

    it("should allow setting endpoint after construction", () => {
      client.setEndpoint("https://new-api.example.com/");
      expect(client.getEndpoint()).toBe("https://new-api.example.com");
    });
  });

  /**
   * `validateEndpointUrl` now lives in `shared/` so the PWA and the Extension
   * enforce byte-identical rules — the PWA adopts a sync code's `@host` too, so
   * a weaker copy here would undo the whole check. These tests pin the PWA's
   * side of that contract: what it accepts, what it refuses, and the exact
   * canonical string it hands to the ApiClient.
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
     * `https://real.example@evil.com` is fetched from evil.com while the string
     * READS as real.example — everything before the `@` is userinfo. A sync
     * code is shared as plain text, so this is the cheapest way to make a
     * member's auth token and full book list go somewhere they never agreed to.
     */
    it.each([
      ["a bare userinfo masquerade", "https://real.example@evil.com"],
      ["user:password credentials", "https://user:pass@evil.com"],
      ["an empty password", "https://user:@evil.com"],
      ["an empty username with a password", "https://:pass@evil.com"],
      [
        "credentials on an otherwise private host",
        "https://user:pass@localhost:8787",
      ],
    ])("rejects %s", (_label, input) => {
      expect(() => validateEndpointUrl(input)).toThrow();
    });

    it("names credentials as the reason, so the refusal is debuggable", () => {
      expect(() =>
        validateEndpointUrl("https://real.example@evil.com"),
      ).toThrow(/credentials/i);
    });

    /**
     * The return value is what gets stored, compared against the family
     * record's endpoint, and shown in the `@host` disclosure note. Two
     * spellings of one endpoint must therefore collapse to one string, or the
     * PWA and the Extension will disagree about whether they are "the same"
     * server.
     */
    it.each([
      [
        "a trailing slash",
        "https://api.example.com/",
        "https://api.example.com",
      ],
      [
        "repeated trailing slashes",
        "https://api.example.com///",
        "https://api.example.com",
      ],
      [
        "an upper-case host",
        "https://API.Example.COM",
        "https://api.example.com",
      ],
      [
        "an explicit default port",
        "https://api.example.com:443",
        "https://api.example.com",
      ],
      [
        "a non-default port, kept",
        "https://api.example.com:8443",
        "https://api.example.com:8443",
      ],
      [
        "a sub-path, kept",
        "https://api.example.com/moo",
        "https://api.example.com/moo",
      ],
      [
        "a sub-path with a trailing slash",
        "https://api.example.com/moo/",
        "https://api.example.com/moo",
      ],
      [
        "an IDN host, folded to punycode",
        "https://пример.example",
        "https://xn--e1afmkfd.example",
      ],
      [
        "a query string and fragment, both dropped",
        "https://api.example.com/moo?a=1#frag",
        "https://api.example.com/moo",
      ],
    ])("canonicalizes %s", (_label, input, expected) => {
      expect(validateEndpointUrl(input)).toBe(expected);
    });

    it("is idempotent — canonicalizing a canonical value changes nothing", () => {
      const once = validateEndpointUrl("https://API.Example.COM:443/moo/");
      expect(validateEndpointUrl(once)).toBe(once);
    });

    it("is what the ApiClient actually stores", () => {
      const c = new ApiClient("https://API.Example.COM:443/moo/");

      // The client must not keep a spelling of its own: everything that later
      // compares endpoints (family-record switch, sync code) assumes this.
      expect(c.getEndpoint()).toBe(
        validateEndpointUrl("https://API.Example.COM:443/moo/"),
      );
      expect(c.getEndpoint()).toBe("https://api.example.com/moo");
    });

    it("refuses a credential-bearing endpoint at ApiClient construction", () => {
      expect(() => new ApiClient("https://real.example@evil.com")).toThrow();
    });

    it("refuses a credential-bearing endpoint at setEndpoint, leaving the old one in place", () => {
      const c = new ApiClient("https://api.example.com");

      expect(() => c.setEndpoint("https://real.example@evil.com")).toThrow();
      // Throws before assigning, so the endpoint already trusted still stands.
      expect(c.getEndpoint()).toBe("https://api.example.com");
    });
  });

  describe("userId validation", () => {
    it("should reject non-hex userId", async () => {
      await expect(client.getPersonalBooks("invalid-id")).rejects.toThrow(
        "Invalid userId",
      );
    });

    it("should reject userId shorter than 64 chars", async () => {
      await expect(client.getPersonalBooks("aabb")).rejects.toThrow(
        "Invalid userId",
      );
    });

    it("should accept valid 64-char hex userId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { userId: USER_1, books: [] } }),
      );
      const result = await client.getPersonalBooks(USER_1);
      expect(result.data).toBeDefined();
    });
  });

  describe("getPersonalBooks", () => {
    it("should call GET /api/user/:id/books", async () => {
      const responseData = {
        data: {
          userId: USER_1,
          displayName: "Alice",
          books: [],
          lastUpdated: "2026-01-01T00:00:00Z",
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(responseData));

      const result = await client.getPersonalBooks(USER_1);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/books`);
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(result).toEqual(responseData);
    });
  });

  describe("updatePersonalBooks", () => {
    it("should call PUT /api/user/:id/books with PersonalBooks object", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const personalBooks = {
        schemaVersion: 1,
        userId: USER_1,
        displayName: "Alice",
        books: [],
        lastUpdated: "2026-01-01T00:00:00Z",
      };
      const result = await client.updatePersonalBooks(USER_1, personalBooks);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/books`);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual(personalBooks);
      expect(result.data).toEqual({ ok: true });
    });
  });

  describe("patchPersonalBooks", () => {
    it("should call PATCH /api/user/:id/books with a { changes } body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true, applied: 2 } }),
      );

      const changes = [
        { bookId: "b1", isShared: BoolFlag.TRUE },
        { bookId: "b2", isShared: BoolFlag.FALSE },
      ];
      const result = await client.patchPersonalBooks(USER_1, changes);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/books`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ changes });
      expect(result.data).toEqual({ ok: true, applied: 2 });
    });

    it("should not include a displayName in the PATCH body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true, applied: 1 } }),
      );

      await client.patchPersonalBooks(USER_1, [
        { bookId: "b1", isShared: BoolFlag.TRUE },
      ]);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty("displayName");
      expect(Object.keys(body)).toEqual(["changes"]);
    });

    it("should reject invalid userId", async () => {
      await expect(
        client.patchPersonalBooks("invalid-id", [
          { bookId: "b1", isShared: BoolFlag.TRUE },
        ]),
      ).rejects.toThrow("Invalid userId");
    });
  });

  describe("updateFamilyPrefs", () => {
    it("should call PUT /api/user/:id/family-prefs with a { hidden, favorites } body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: { ok: true, hidden: ["o1:b1"], favorites: ["o3:b3"] },
        }),
      );

      const prefs = { hidden: ["o1:b1", "o2:b2"], favorites: ["o3:b3"] };
      const result = await client.updateFamilyPrefs(USER_1, prefs);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/user/${USER_1}/family-prefs`,
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual(prefs);
      expect(result.data).toEqual({
        ok: true,
        hidden: ["o1:b1"],
        favorites: ["o3:b3"],
      });
    });

    it("should send only the provided list (favorites-only update)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true, hidden: [], favorites: ["o3:b3"] } }),
      );

      await client.updateFamilyPrefs(USER_1, { favorites: ["o3:b3"] });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ favorites: ["o3:b3"] });
    });

    it("should send empty lists as { hidden: [], favorites: [] }", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true, hidden: [], favorites: [] } }),
      );

      await client.updateFamilyPrefs(USER_1, { hidden: [], favorites: [] });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ hidden: [], favorites: [] });
    });

    it("should reject invalid userId", async () => {
      await expect(
        client.updateFamilyPrefs("invalid-id", { hidden: ["o1:b1"] }),
      ).rejects.toThrow("Invalid userId");
    });
  });

  describe("createFamily", () => {
    it("should call POST /api/family with userId only when no displayName", async () => {
      const familyData = {
        familyId: "fam-1",
        ownerId: USER_1,
        members: [USER_1],
        maxMembers: 6,
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: familyData }));

      const result = await client.createFamily(USER_1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.userId).toBe(USER_1);
      expect(body.displayName).toBe("");
      expect(result.data).toEqual(familyData);
    });

    it("should include displayName when provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { familyId: "fam-1" } }),
      );

      await client.createFamily(USER_1, "Alice");

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.displayName).toBe("Alice");
    });

    it("should reject invalid userId", async () => {
      await expect(client.createFamily("invalid")).rejects.toThrow(
        "Invalid userId",
      );
    });
  });

  describe("joinFamily", () => {
    it("should call POST /api/family/:id/join with userId when no opts", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.joinFamily("fam-1", USER_2);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/join");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.userId).toBe(USER_2);
      expect(result.data).toEqual({ ok: true });
    });

    it("should not include verifySecret when opts is empty", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_2, {});

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.verifySecret).toBeUndefined();
    });

    it("should include verifySecret in body when opts.verifySecret is provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_2, { verifySecret: "9999" });

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.verifySecret).toBe("9999");
    });

    it("should reject invalid userId", async () => {
      await expect(client.joinFamily("fam-1", "bad-id")).rejects.toThrow(
        "Invalid userId",
      );
    });
  });

  describe("leaveFamily", () => {
    it("should call DELETE /api/family/:id/member/:uid", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.leaveFamily("fam-1", USER_2);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/family/fam-1/member/${USER_2}`,
      );
      expect(init.method).toBe("DELETE");
      expect(result.data).toEqual({ ok: true });
    });
  });

  describe("removeMember", () => {
    it("should call DELETE /api/family/:id/member/:uid", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.removeMember("fam-1", USER_TARGET);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/family/fam-1/member/${USER_TARGET}`,
      );
      expect(init.method).toBe("DELETE");
    });
  });

  /**
   * Lifts the 6-hour `kicked:` tombstone a removal leaves behind, so the removed
   * member's sync code works again. It must hit the `kicked` collection —
   * `/member/` is the REMOVAL endpoint, so a wrong path would be a destructive
   * no-op the UI still reports as success.
   */
  describe("unkickMember", () => {
    it("should call DELETE /api/family/:id/kicked/:uid", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { cleared: BoolFlag.TRUE } }),
      );

      const result = await client.unkickMember("fam-1", USER_TARGET);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/family/fam-1/kicked/${USER_TARGET}`,
      );
      expect(init.method).toBe("DELETE");
      expect(result.data).toEqual({ cleared: BoolFlag.TRUE });
    });

    it("should reject a malformed targetUserId before reaching the network", async () => {
      await expect(client.unkickMember("fam-1", "not-a-user")).rejects.toThrow(
        "Invalid targetUserId",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should surface an owner-only refusal through the error envelope", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "NOT_OWNER", message: "只有管理者可以操作" } },
          403,
        ),
      );

      const result = await client.unkickMember("fam-1", USER_TARGET);

      expect(result.error).toEqual({
        code: "NOT_OWNER",
        message: "只有管理者可以操作",
      });
      expect(result.data).toBeUndefined();
    });
  });

  describe("transferOwnership", () => {
    it("should call PUT /api/family/:id/transfer with userId and newOwnerId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.transferOwnership("fam-1", USER_1, USER_2);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/transfer");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({
        userId: USER_1,
        newOwnerId: USER_2,
      });
    });
  });

  describe("getFamilyMembers", () => {
    it("should call GET /api/family/:id/members", async () => {
      // Well-formed member objects: the client rebuilds `data.members` at the
      // API boundary, so only a valid list comes back verbatim, and it always
      // emits `apiEndpoint` (`null` when the payload omits it). The malformed
      // cases live in `tests/unit/api/member-client.test.ts`.
      const familyData = {
        familyId: "fam-1",
        ownerId: USER_1,
        members: [
          { userId: USER_1, displayName: "Alice" },
          { userId: USER_2, displayName: "Bob" },
        ],
        maxMembers: 6,
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: familyData }));

      const result = await client.getFamilyMembers("fam-1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/members");
      expect(result.data).toEqual({ ...familyData, apiEndpoint: null });
    });
  });

  describe("getFamilyBookshelf", () => {
    it("should call GET /api/family/:id/bookshelf", async () => {
      const bookshelfData = {
        members: [
          {
            userId: USER_1,
            displayName: "Alice",
            books: [
              {
                bookId: "b1",
                title: "Book One",
                author: "Author",
                isbn: "978-0000000000",
                coverUrl: "https://example.com/cover.jpg",
                readmooUrl: "https://readmoo.com/book/b1",
                // Kept complete on purpose: the client sanitizes this payload
                // on the way out (`sanitizeFamilyBookshelfText`), which
                // materializes any declared text field the fixture omits, and
                // the assertion below stays a strict `toEqual`.
                category: "文學小說",
                isShared: BoolFlag.TRUE,
              },
            ],
          },
        ],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: bookshelfData }));

      const result = await client.getFamilyBookshelf("fam-1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/bookshelf");
      expect(result.data).toEqual(bookshelfData);
    });
  });

  describe("lookupUser", () => {
    it("should call POST /api/auth/lookup with userId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { existingFamilyId: null, memberCount: 0 } }),
      );

      const userId = "a".repeat(64);
      const result = await client.lookupUser(userId);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/auth/lookup");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ userId });
      expect(result.data).toEqual({ existingFamilyId: null, memberCount: 0 });
    });

    it("should reject invalid userId", async () => {
      await expect(client.lookupUser("invalid-id")).rejects.toThrow(
        "Invalid userId",
      );
    });

    // Mirrors extension/tests/unit/client.test.ts — the PWA has no call site for
    // the verification gate yet, so this is the only thing stopping the two
    // client contracts from drifting.
    it("should include verifySecret in the body only when supplied", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { existingFamilyId: "fam-1", memberCount: 2 } }),
      );

      const userId = "a".repeat(64);
      await client.lookupUser(userId, { verifySecret: "123456" });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ userId, verifySecret: "123456" });
    });
  });

  describe("updateDisplayName", () => {
    it("should call PUT /api/family/:id/member/:uid/displayName", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.updateDisplayName(
        "fam-1",
        USER_1,
        "New Name",
      );

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/family/fam-1/member/${USER_1}/displayName`,
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ displayName: "New Name" });
      expect(result.data).toEqual({ ok: true });
    });

    it("should reject invalid userId", async () => {
      await expect(
        client.updateDisplayName("fam-1", "invalid", "Name"),
      ).rejects.toThrow("Invalid userId");
    });
  });

  describe("auth token management", () => {
    it("should include Authorization header when auth token is set", async () => {
      client.setAuthToken("test-token-123");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));

      await client.getPersonalBooks(USER_1);

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Authorization"]).toBe("Bearer test-token-123");
    });

    it("should not include Authorization header when no token set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));

      await client.getPersonalBooks(USER_1);

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Authorization"]).toBeUndefined();
    });

    it("should retry with new token on 401 when refresher is set", async () => {
      client.setAuthToken("old-token");
      client.setTokenRefresher(async () => "new-token");

      // First call returns 401
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "expired" } },
          401,
        ),
      );
      // Retry with new token succeeds
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { payload: "encrypted" } }),
      );

      const result = await client.getPersonalBooks(USER_1);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second call should use new token
      const [, retryInit] = mockFetch.mock.calls[1];
      expect(retryInit.headers["Authorization"]).toBe("Bearer new-token");
      /**
       * `toMatchObject`, not `toEqual`: `getPersonalBooks` runs its payload
       * through `sanitizePersonalBooksText`, which materializes the record's
       * declared text fields, so this stand-in payload comes back carrying them
       * as `""`. That coercion has its own coverage in
       * `tests/unit/api/sanitizeEnvelope.test.ts`; this test is about the retry
       * mechanics, so it pins only the field it supplied.
       */
      expect(result.data).toMatchObject({ payload: "encrypted" });
    });

    it("should not retry on 401 when no refresher is set", async () => {
      client.setAuthToken("old-token");
      // No refresher set

      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "expired" } },
          401,
        ),
      );

      const result = await client.getPersonalBooks(USER_1);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("should not retry more than once on 401", async () => {
      client.setAuthToken("old-token");
      client.setTokenRefresher(async () => "new-token");

      // Both calls return 401
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "expired" } },
          401,
        ),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "still expired" } },
          401,
        ),
      );

      const result = await client.getPersonalBooks(USER_1);

      // Should only retry once
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("should return error when token refresh returns null", async () => {
      client.setAuthToken("old-token");
      client.setTokenRefresher(async () => null);

      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "expired" } },
          401,
        ),
      );

      const result = await client.getPersonalBooks(USER_1);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });
  });

  describe("error handling", () => {
    it("should return error for non-OK HTTP response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "NOT_FOUND", message: "User not found" } },
          404,
        ),
      );

      const result = await client.getPersonalBooks(USER_1);

      expect(result.error).toEqual({
        code: "NOT_FOUND",
        message: "User not found",
      });
      expect(result.data).toBeUndefined();
    });

    it("should return UNKNOWN_ERROR when server response has no error field", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      const result = await client.getPersonalBooks(USER_1);

      expect(result.error).toEqual({
        code: "UNKNOWN_ERROR",
        message: "HTTP 500",
      });
    });

    it("should return NETWORK_ERROR when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await client.getPersonalBooks(USER_1);

      expect(result.error).toEqual({
        code: "NETWORK_ERROR",
        message: "Failed to fetch",
      });
    });

    it("should return NETWORK_ERROR with generic message for non-Error throw", async () => {
      mockFetch.mockRejectedValueOnce("something went wrong");

      const result = await client.getPersonalBooks(USER_1);

      expect(result.error).toEqual({
        code: "NETWORK_ERROR",
        message: "Network error",
      });
    });
  });
});
