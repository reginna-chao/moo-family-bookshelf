import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Valid 64-char hex userId for tests
const USER_1 = "a".repeat(64);
const USER_2 = "b".repeat(64);
const USER_TARGET = "c".repeat(64);
const USER_CALLER = "d".repeat(64);

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
    it("should call PUT /api/user/:id/books with encrypted payload", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true } }),
      );

      const result = await client.updatePersonalBooks(USER_1, "encrypted-data");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/books`);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ payload: "encrypted-data" });
      expect(result.data).toEqual({ ok: true });
    });
  });

  describe("createFamily", () => {
    it("should call POST /api/family with userId", async () => {
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
      expect(JSON.parse(init.body)).toEqual({ userId: USER_1 });
      expect(result.data).toEqual(familyData);
    });
  });

  describe("joinFamily", () => {
    it("should call POST /api/family/:id/join with userId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true } }),
      );

      const result = await client.joinFamily("fam-1", USER_2);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/join");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ userId: USER_2 });
      expect(result.data).toEqual({ ok: true });
    });
  });

  describe("leaveFamily", () => {
    it("should call DELETE /api/family/:id/member/:uid", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true } }),
      );

      const result = await client.leaveFamily("fam-1", USER_2);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/family/fam-1/member/${USER_2}`);
      expect(init.method).toBe("DELETE");
      expect(result.data).toEqual({ ok: true });
    });
  });

  describe("removeMember", () => {
    it("should call DELETE with caller userId as query param", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true } }),
      );

      await client.removeMember("fam-1", USER_TARGET, USER_CALLER);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/family/fam-1/member/${USER_TARGET}?userId=${USER_CALLER}`,
      );
      expect(init.method).toBe("DELETE");
    });
  });

  describe("transferOwnership", () => {
    it("should call PUT /api/family/:id/transfer with userId and newOwnerId", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { ok: true } }),
      );

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
      const familyData = {
        familyId: "fam-1",
        ownerId: USER_1,
        members: [USER_1, USER_2],
        maxMembers: 6,
        createdAt: "2026-01-01T00:00:00Z",
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: familyData }));

      const result = await client.getFamilyMembers("fam-1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/api/family/fam-1/members");
      expect(result.data).toEqual(familyData);
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
                isShared: 1,
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
