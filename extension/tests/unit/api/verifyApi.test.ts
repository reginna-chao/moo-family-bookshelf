import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";

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

describe("ApiClient verification methods", () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
    client.setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getVerifyMethod", () => {
    it("calls GET /api/user/:id/verify", async () => {
      globalThis.fetch = mockFetchSuccess({ method: "pin", prompted: 0 });
      const result = await client.getVerifyMethod("user-123");

      expect(result.data).toEqual({ method: "pin", prompted: 0 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/user-123/verify`,
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
      );
    });

    it("returns error on failure", async () => {
      globalThis.fetch = mockFetchError("NOT_FOUND", "User not found", 404);
      const result = await client.getVerifyMethod("user-123");

      expect(result.error).toEqual({ code: "NOT_FOUND", message: "User not found" });
    });
  });

  describe("setVerifyMethod", () => {
    it("calls PUT /api/user/:id/verify with method and secret", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      const result = await client.setVerifyMethod("user-123", {
        method: "pin",
        secret: "1234",
      });

      expect(result.data).toEqual({ ok: true });
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/user/user-123/verify`);
      expect(call[1].method).toBe("PUT");
      expect(JSON.parse(call[1].body as string)).toEqual({ method: "pin", secret: "1234" });
    });

    it("calls PUT without secret for code method", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.setVerifyMethod("user-123", { method: "code" });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({ method: "code" });
    });

    it("returns error on failure", async () => {
      globalThis.fetch = mockFetchError("INVALID_METHOD", "Invalid method");
      const result = await client.setVerifyMethod("user-123", { method: "pin", secret: "12" });

      expect(result.error?.code).toBe("INVALID_METHOD");
    });
  });

  describe("generateOtp", () => {
    it("calls POST /api/user/:id/verify/otp", async () => {
      const mockData = { code: "482916", expiresAt: Date.now() + 300000 };
      globalThis.fetch = mockFetchSuccess(mockData);
      const result = await client.generateOtp("user-123");

      expect(result.data).toEqual(mockData);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/user/user-123/verify/otp`);
      expect(call[1].method).toBe("POST");
    });

    it("returns error on failure", async () => {
      globalThis.fetch = mockFetchError("METHOD_NOT_SET", "Set verify method first", 400);
      const result = await client.generateOtp("user-123");

      expect(result.error?.code).toBe("METHOD_NOT_SET");
    });
  });
});
