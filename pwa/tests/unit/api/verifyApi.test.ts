import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const USER_1 = "a".repeat(64);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

describe("ApiClient verification methods", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient("https://api.example.com");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getVerifyMethod", () => {
    it("should call GET /api/user/:id/verify", async () => {
      const responseData = {
        data: { method: "pin" as VerifyMethod },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(responseData));

      const result = await client.getVerifyMethod(USER_1);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/verify`);
      expect(result.data).toEqual({ method: "pin" });
    });

    it("should reject invalid userId", async () => {
      await expect(client.getVerifyMethod("invalid")).rejects.toThrow(
        "Invalid userId",
      );
    });
  });

  describe("getVerifyPrompted", () => {
    it("should call GET /api/user/:id/verify/prompted with the auth token", async () => {
      client.setAuthToken("test-token");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { prompted: 0 } }));

      const result = await client.getVerifyPrompted(USER_1);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/user/${USER_1}/verify/prompted`,
      );
      expect(init.method ?? "GET").toBe("GET");
      expect(init.headers["Authorization"]).toBe("Bearer test-token");
      expect(result).toEqual({ data: { prompted: 0 } });
    });

    it("should return the error envelope from a server without the route", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          404,
        ),
      );

      const result = await client.getVerifyPrompted(USER_1);

      expect(result.data).toBeUndefined();
      expect(result.error?.code).toBe("NOT_FOUND");
    });

    it.each(["invalid", "A".repeat(64), "a".repeat(63)])(
      "should reject the non-hex userId %s without a request",
      async (userId) => {
        await expect(client.getVerifyPrompted(userId)).rejects.toThrow(
          "Invalid userId",
        );
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );
  });

  describe("setVerifyMethod", () => {
    it("should call PUT /api/user/:id/verify with method and secret", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.setVerifyMethod(USER_1, {
        method: "pin",
        secret: "1234",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/verify`);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ method: "pin", secret: "1234" });
      expect(result.data).toEqual({ ok: true });
    });

    it("should call PUT without secret when not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.setVerifyMethod(USER_1, { method: "code" });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ method: "code" });
    });

    it("should reject invalid userId", async () => {
      await expect(
        client.setVerifyMethod("bad", { method: "none" }),
      ).rejects.toThrow("Invalid userId");
    });
  });

  describe("markVerifyPrompted", () => {
    it("should call POST /api/user/:id/verify/prompted", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.markVerifyPrompted(USER_1);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.example.com/api/user/${USER_1}/verify/prompted`,
      );
      expect(init.method).toBe("POST");
      expect(result.data).toEqual({ ok: true });
    });

    it("should reject invalid userId", async () => {
      await expect(client.markVerifyPrompted("bad")).rejects.toThrow(
        "Invalid userId",
      );
    });
  });

  describe("joinFamily with verifySecret", () => {
    it("should include verifySecret in request body when provided via opts", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_1, { verifySecret: "1234" });

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.userId).toBe(USER_1);
      expect(body.verifySecret).toBe("1234");
    });

    it("should not include verifySecret when opts not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_1);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.userId).toBe(USER_1);
      expect(body.verifySecret).toBeUndefined();
    });

    it("should not include verifySecret when opts is empty object", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_1, {});

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.verifySecret).toBeUndefined();
    });
  });
});
