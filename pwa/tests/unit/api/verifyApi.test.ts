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
      const responseData = { data: { method: "pin" as VerifyMethod, prompted: 1 } };
      mockFetch.mockResolvedValueOnce(jsonResponse(responseData));

      const result = await client.getVerifyMethod(USER_1);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/verify`);
      expect(result.data).toEqual({ method: "pin", prompted: 1 });
    });

    it("should reject invalid userId", async () => {
      await expect(client.getVerifyMethod("invalid")).rejects.toThrow("Invalid userId");
    });
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
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}/verify/prompted`);
      expect(init.method).toBe("POST");
      expect(result.data).toEqual({ ok: true });
    });

    it("should reject invalid userId", async () => {
      await expect(client.markVerifyPrompted("bad")).rejects.toThrow("Invalid userId");
    });
  });

  describe("joinFamily with verifySecret", () => {
    it("should include verifySecret in request body when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_1, "1234");

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ userId: USER_1, verifySecret: "1234" });
    });

    it("should not include verifySecret when not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.joinFamily("fam-1", USER_1);

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ userId: USER_1 });
    });
  });
});
