import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";

// Mock the constants module so we don't depend on import.meta.env
vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

const MOCK_ENDPOINT = "https://test.workers.dev";

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

  describe("auth token management", () => {
    it("does not send Authorization header when no token is set", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBeUndefined();
    });

    it("sends Authorization header when token is set", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      client.setAuthToken("my-token");
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBe("Bearer my-token");
    });

    it("clears Authorization header when token set to null", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      client.setAuthToken("my-token");
      client.setAuthToken(null);
      await client.getPersonalBooks("user-1");

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
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

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
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
      expect(result.error).toEqual({ code: "UNKNOWN_ERROR", message: "HTTP 500" });
    });

    it("returns NETWORK_ERROR on fetch rejection", async () => {
      globalThis.fetch = mockFetchNetworkError("Connection refused");
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({ code: "NETWORK_ERROR", message: "Connection refused" });
    });

    it("returns generic NETWORK_ERROR for non-Error throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue("string error");
      const result = await client.getPersonalBooks("user-1");
      expect(result.error).toEqual({ code: "NETWORK_ERROR", message: "Network error" });
    });
  });

  describe("lookupUser", () => {
    it("sends POST to /api/auth/lookup with userId", async () => {
      globalThis.fetch = mockFetchSuccess({ existingFamilyId: null, memberCount: 0 });
      const userId = "a".repeat(64);
      const result = await client.lookupUser(userId);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/lookup"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(result.data).toEqual({ existingFamilyId: null, memberCount: 0 });
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
    it("sends PUT to /api/user/:id/books with encrypted payload", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.updatePersonalBooks("u1", "encrypted-data");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/u1/books`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ payload: "encrypted-data" }),
        }),
      );
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

    it("defaults displayName to empty string", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.createFamily("u1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family`,
        expect.objectContaining({
          body: JSON.stringify({ userId: "u1", displayName: "" }),
        }),
      );
    });
  });

  describe("joinFamily", () => {
    it("sends POST to /api/family/:id/join with userId", async () => {
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

    it("defaults displayName to empty string", async () => {
      globalThis.fetch = mockFetchSuccess({ familyId: "fam-1" });
      await client.joinFamily("fam-1", "u1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/family/fam-1/join`,
        expect.objectContaining({
          body: JSON.stringify({ userId: "u1", displayName: "" }),
        }),
      );
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
      const fetchMock = vi.fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
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
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const result = await client.getPersonalBooks("u1");
      expect(result.data).toEqual({ userId: "u1", books: [] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("returns 401 error when refresh fails and recovery fails", async () => {
      const fetchMock = vi.fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Invalid" } }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { code: "FAMILY_NOT_FOUND", message: "Not found" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const result = await client.getPersonalBooks("u1");
      expect(result.error?.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 error when no userId/familyId in storage", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
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
            json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
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
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1" };
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
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Removed" } }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { code: "FAMILY_NOT_FOUND", message: "Not found" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test" };
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
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Removed" } }),
        })
        // joinFamily recovery → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { code: "FAMILY_NOT_FOUND", message: "Not found" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test" };
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
      const fetchMock = vi.fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Token expired" } }),
        })
        // joinFamily recovery → success with new token
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
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
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test User" };
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
        expect.objectContaining({ authToken: "recovered-token", tokenExpiresAt: 9999999999 }),
      );
    });

    it("sends displayName in joinFamily recovery request", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Token expired" } }),
        })
        // joinFamily recovery → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
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
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "小明" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      await client.getPersonalBooks("u1");

      // The third fetch call is the joinFamily recovery
      const joinCall = fetchMock.mock.calls[2];
      expect(joinCall[0]).toBe(`${MOCK_ENDPOINT}/api/family/fam-1/join`);
      const joinBody = JSON.parse(joinCall[1].body as string);
      expect(joinBody).toEqual({ userId: "u1", displayName: "小明" });
    });

    it("does not attempt joinFamily recovery when familyId/userId missing from storage", async () => {
      let getCallCount = 0;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Removed" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          getCallCount++;
          // First call (for refresh): has userId/familyId
          // Second call (for recovery): missing familyId
          const result = getCallCount === 1
            ? { userId: "u1", familyId: "fam-1" }
            : { userId: "u1" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      const onFamilyRemoved = vi.fn();
      client.onFamilyRemoved = onFamilyRemoved;

      await client.getPersonalBooks("u1");

      // Only 2 fetch calls — no joinFamily attempt
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Should still call onFamilyRemoved since recovery was skipped
      expect(onFamilyRemoved).toHaveBeenCalledOnce();
    });

    it("attempts joinFamily recovery on non-REFRESH_FAILED errors (e.g. rate limit)", async () => {
      const fetchMock = vi.fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        // Refresh request → rate limited (429, not REFRESH_FAILED)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ error: { code: "RATE_LIMITED", message: "Too many requests" } }),
        })
        // joinFamily recovery → success with new token
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
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
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test" };
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

    it("clears token then family data on REFRESH_FAILED when recovery fails", async () => {
      const fetchMock = vi.fn()
        // Original request → 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "UNAUTHORIZED", message: "Expired" } }),
        })
        // Refresh request → REFRESH_FAILED
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "REFRESH_FAILED", message: "Removed" } }),
        })
        // joinFamily recovery attempt → fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { code: "FAMILY_NOT_FOUND", message: "Not found" } }),
        });
      globalThis.fetch = fetchMock;

      vi.mocked(chrome.storage.local.get).mockImplementation(
        (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
          const result = { userId: "u1", familyId: "fam-1", displayName: "Test" };
          if (typeof callback === "function") callback(result);
          return Promise.resolve(result) as unknown as void;
        },
      );

      await client.getPersonalBooks("u1");

      // First: clear only token
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        ["authToken", "tokenExpiresAt"],
      );
      // Then: clear family data after recovery fails
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        ["familyId", "encryptionKey"],
      );
    });
  });
});
