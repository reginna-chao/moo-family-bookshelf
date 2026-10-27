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
      // A stale server still sends `prompted`; only `method` may reach the caller.
      globalThis.fetch = mockFetchSuccess({ method: "pin", prompted: 0 });
      const result = await client.getVerifyMethod("user-123");

      expect(result.data).toStrictEqual({ method: "pin" });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/user-123/verify`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    it("returns error on failure", async () => {
      globalThis.fetch = mockFetchError("NOT_FOUND", "User not found", 404);
      const result = await client.getVerifyMethod("user-123");

      expect(result.error).toEqual({
        code: "NOT_FOUND",
        message: "User not found",
      });
    });
  });

  describe("getVerifyMethod response validation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function mockFetchBody(body: unknown, status = 200) {
      return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      });
    }

    it.each(["pin", "pattern", "code", "none"])(
      "keeps the known method %s as exactly { method }",
      async (method) => {
        globalThis.fetch = mockFetchSuccess({
          method,
          prompted: 0,
          extra: "x",
        });
        const result = await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual({ data: { method } });
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it.each<{ label: string; data: unknown; leak?: string }>([
      { label: "an unknown method", data: { method: "bogus" }, leak: "bogus" },
      { label: "an upper-cased method", data: { method: "PIN" }, leak: "PIN" },
      { label: "a padded method", data: { method: " pin" }, leak: " pin" },
      { label: "a missing method", data: {} },
      { label: "a null method", data: { method: null } },
      { label: "a numeric method", data: { method: 1 } },
      {
        label: "a prototype key",
        data: { method: "__proto__" },
        leak: "__proto__",
      },
      {
        label: "an inherited name",
        data: { method: "toString" },
        leak: "toString",
      },
      {
        label: "a constructor key",
        data: { method: "constructor" },
        leak: "constructor",
      },
      { label: "a bare method string as data", data: "pin" },
      { label: "a number as data", data: 42 },
      { label: "a boolean as data", data: true },
      { label: "an array as data", data: [{ method: "pin" }] },
    ])(
      "turns $label into an INVALID_RESPONSE error with no data",
      async ({ data, leak }) => {
        globalThis.fetch = mockFetchSuccess(data);
        const result = await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual({
          error: {
            code: "INVALID_RESPONSE",
            message: "response is not a valid verify method",
          },
        });
        expect("data" in result).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toMatch(
          /^\[verifyValidation\]/,
        );
        if (leak !== undefined) {
          expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(leak);
        }
      },
    );

    it("passes a backend error envelope through unchanged without a warning", async () => {
      globalThis.fetch = mockFetchError("NOT_FOUND", "User not found", 404);
      const result = await client.getVerifyMethod("user-123");

      expect(result).toStrictEqual({
        error: { code: "NOT_FOUND", message: "User not found" },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      { label: "an unknown method", method: "bogus" },
      { label: "a valid method", method: "pin" },
    ])(
      "forwards a 200 error alone, dropping $label sent beside it",
      async ({ method }) => {
        const error = { code: "X", message: "m" };
        globalThis.fetch = mockFetchBody({ error, data: { method } });
        const result = await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual({ error: { code: "X", message: "m" } });
        expect(result.error).toBe(error);
        expect("data" in result).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it("still validates data sent beside error: null", async () => {
      globalThis.fetch = mockFetchBody({
        data: { method: "pattern", prompted: 1 },
        error: null,
      });
      const result = await client.getVerifyMethod("user-123");

      expect(result.data).toStrictEqual({ method: "pattern" });
      expect(result.error).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("rejects an unknown method sent beside error: null", async () => {
      globalThis.fetch = mockFetchBody({
        data: { method: "bogus" },
        error: null,
      });
      const result = await client.getVerifyMethod("user-123");

      expect(result).toStrictEqual({
        error: {
          code: "INVALID_RESPONSE",
          message: "response is not a valid verify method",
        },
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it.each<{ label: string; body: Record<string, unknown> }>([
      { label: "data: null", body: { data: null } },
      { label: "no data key", body: {} },
    ])(
      "passes an envelope with $label through without a warning",
      async ({ body }) => {
        globalThis.fetch = mockFetchBody(body);
        const result = await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual(body);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );
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
      expect(JSON.parse(call[1].body as string)).toEqual({
        method: "pin",
        secret: "1234",
      });
    });

    it("calls PUT without secret for code method", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.setVerifyMethod("user-123", { method: "code" });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({ method: "code" });
    });

    it("sends the current secret beside the new one (#396)", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.setVerifyMethod("user-123", {
        method: "pin",
        secret: "654321",
        currentSecret: "123456",
      });

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({
        method: "pin",
        secret: "654321",
        currentSecret: "123456",
      });
    });

    it("returns error on failure", async () => {
      globalThis.fetch = mockFetchError("INVALID_METHOD", "Invalid method");
      const result = await client.setVerifyMethod("user-123", {
        method: "pin",
        secret: "12",
      });

      expect(result.error?.code).toBe("INVALID_METHOD");
    });
  });

  /** A new pin / pattern / code revokes the old token server-side (#378): the replacement must be on
   *  the client before the next request, and a malformed one must never be adopted. */
  describe("setVerifyMethod token rotation", () => {
    const ROTATED_TOKEN = "0123456789abcdef".repeat(4);
    const ROTATED_EXPIRY = 1_700_000_000_000;
    const WARN_PREFIX = /^\[issuedCredentials\]/;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** The PUT answers `putBody`; the follow-up GET answers a plain verify method. */
    function mockPutThenGet(putBody: unknown) {
      return vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(putBody),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { method: "pin" } }),
        });
    }

    function authHeaderOfCall(index: number): string | undefined {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[
        index
      ];
      return (call[1] as { headers: Record<string, string> }).headers[
        "Authorization"
      ];
    }

    it.each(["pin", "pattern", "code"] as const)(
      "sends the rotated token on the next request after saving %s",
      async (method) => {
        globalThis.fetch = mockPutThenGet({
          data: {
            method,
            prompted: 1,
            authToken: ROTATED_TOKEN,
            expiresAt: ROTATED_EXPIRY,
          },
        });

        const result = await client.setVerifyMethod("user-123", {
          method,
          ...(method === "code" ? {} : { secret: "123456" }),
        });
        await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual({
          data: {
            method,
            prompted: 1,
            authToken: ROTATED_TOKEN,
            expiresAt: ROTATED_EXPIRY,
          },
        });
        // The PUT itself still authenticates with the token it replaced.
        expect(authHeaderOfCall(0)).toBe("Bearer test-token");
        expect(authHeaderOfCall(1)).toBe(`Bearer ${ROTATED_TOKEN}`);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it.each<{ label: string; authToken: unknown; leak?: string }>([
      { label: "a short string", authToken: "abc", leak: "abc" },
      {
        label: "upper-case hex",
        authToken: "ABCDEF0123456789".repeat(4),
        leak: "ABCDEF0123456789",
      },
      {
        label: "63 hex chars",
        authToken: "a".repeat(63),
        leak: "a".repeat(63),
      },
      { label: "a number", authToken: 42 },
      { label: "null", authToken: null },
      { label: "an object", authToken: { token: ROTATED_TOKEN } },
    ])(
      "keeps the current token and drops $label as authToken",
      async ({ authToken, leak }) => {
        globalThis.fetch = mockPutThenGet({
          data: { method: "pin", prompted: 1, authToken },
        });

        const result = await client.setVerifyMethod("user-123", {
          method: "pin",
          secret: "123456",
        });
        await client.getVerifyMethod("user-123");

        expect(result).toStrictEqual({ data: { method: "pin", prompted: 1 } });
        expect(authHeaderOfCall(1)).toBe("Bearer test-token");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toMatch(WARN_PREFIX);
        if (leak !== undefined) {
          expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(leak);
        }
      },
    );

    it("adopts a valid token but drops an unusable expiry beside it", async () => {
      globalThis.fetch = mockPutThenGet({
        data: {
          method: "pattern",
          prompted: 1,
          authToken: ROTATED_TOKEN,
          expiresAt: "tomorrow",
        },
      });

      const result = await client.setVerifyMethod("user-123", {
        method: "pattern",
        secret: "0125",
      });
      await client.getVerifyMethod("user-123");

      expect(result).toStrictEqual({
        data: { method: "pattern", prompted: 1, authToken: ROTATED_TOKEN },
      });
      expect(authHeaderOfCall(1)).toBe(`Bearer ${ROTATED_TOKEN}`);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toMatch(WARN_PREFIX);
    });

    it("keeps the current token without a warning when none issues no token", async () => {
      globalThis.fetch = mockPutThenGet({
        data: { method: "none", prompted: 1 },
      });

      const result = await client.setVerifyMethod("user-123", {
        method: "none",
      });
      await client.getVerifyMethod("user-123");

      expect(result).toStrictEqual({ data: { method: "none", prompted: 1 } });
      expect(authHeaderOfCall(1)).toBe("Bearer test-token");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("adopts nothing from an error envelope that also carries a token", async () => {
      const body = {
        error: { code: "X", message: "m" },
        data: { method: "pin", prompted: 1, authToken: ROTATED_TOKEN },
      };
      globalThis.fetch = mockPutThenGet(body);

      const result = await client.setVerifyMethod("user-123", {
        method: "pin",
        secret: "123456",
      });
      await client.getVerifyMethod("user-123");

      expect(result).toStrictEqual(body);
      expect(authHeaderOfCall(1)).toBe("Bearer test-token");
      expect(warnSpy).not.toHaveBeenCalled();
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
      globalThis.fetch = mockFetchError(
        "METHOD_NOT_SET",
        "Set verify method first",
        400,
      );
      const result = await client.generateOtp("user-123");

      expect(result.error?.code).toBe("METHOD_NOT_SET");
    });
  });

  /** A PIN / pattern account deletes with its current secret in the body (#396); without one the
   *  request carries no body at all, exactly as before. */
  describe("deleteAccount", () => {
    it("sends DELETE /api/user/:id with { currentSecret } when given", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      const result = await client.deleteAccount("user-123", "0,3,6,7");

      expect(result.data).toEqual({ ok: true });
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/user/user-123`);
      expect(call[1].method).toBe("DELETE");
      expect(JSON.parse(call[1].body as string)).toEqual({
        currentSecret: "0,3,6,7",
      });
    });

    it("sends no body when no secret is given", async () => {
      globalThis.fetch = mockFetchSuccess({ ok: true });
      await client.deleteAccount("user-123");

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/user/user-123`);
      expect(call[1].method).toBe("DELETE");
      expect(call[1].body).toBeUndefined();
    });

    it("passes a refused secret through as an error envelope", async () => {
      globalThis.fetch = mockFetchError("VERIFICATION_FAILED", "wrong", 403);
      const result = await client.deleteAccount("user-123", "000000");

      expect(result.error?.code).toBe("VERIFICATION_FAILED");
    });
  });
});
