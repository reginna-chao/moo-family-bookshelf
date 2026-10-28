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
      expect(result.data).toStrictEqual({ method: "pin" });
    });

    it("should reject invalid userId", async () => {
      await expect(client.getVerifyMethod("invalid")).rejects.toThrow(
        "Invalid userId",
      );
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

    it.each(["pin", "pattern", "code", "none"])(
      "should keep the known method %s as exactly { method }",
      async (method) => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ data: { method, prompted: 0, extra: "x" } }),
        );

        const result = await client.getVerifyMethod(USER_1);

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
      "should turn $label into an INVALID_RESPONSE error with no data",
      async ({ data, leak }) => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data }));

        const result = await client.getVerifyMethod(USER_1);

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

    it("should pass a backend error envelope through unchanged without a warning", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "NOT_FOUND", message: "User not found" } },
          404,
        ),
      );

      const result = await client.getVerifyMethod(USER_1);

      expect(result).toStrictEqual({
        error: { code: "NOT_FOUND", message: "User not found" },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      { label: "an unknown method", method: "bogus" },
      { label: "a valid method", method: "pin" },
    ])(
      "should forward a 200 error alone, dropping $label sent beside it",
      async ({ method }) => {
        const error = { code: "X", message: "m" };
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error, data: { method } }),
        );

        const result = await client.getVerifyMethod(USER_1);

        expect(result).toStrictEqual({ error: { code: "X", message: "m" } });
        expect(result.error).toBe(error);
        expect("data" in result).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it("should still validate data sent beside error: null", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { method: "pattern", prompted: 1 }, error: null }),
      );

      const result = await client.getVerifyMethod(USER_1);

      expect(result.data).toStrictEqual({ method: "pattern" });
      expect(result.error).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should reject an unknown method sent beside error: null", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { method: "bogus" }, error: null }),
      );

      const result = await client.getVerifyMethod(USER_1);

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
      "should pass an envelope with $label through without a warning",
      async ({ body }) => {
        mockFetch.mockResolvedValueOnce(jsonResponse(body));

        const result = await client.getVerifyMethod(USER_1);

        expect(result).toStrictEqual(body);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );
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

  /** A new pin / pattern / code revokes the old token server-side (#378): the replacement must be on
   *  the client before the next request, and a malformed one must never be adopted. */
  describe("setVerifyMethod token rotation", () => {
    const OLD_TOKEN = "old-token";
    const ROTATED_TOKEN = "0123456789abcdef".repeat(4);
    const ROTATED_EXPIRY = 1_700_000_000_000;
    const WARN_PREFIX = /^\[issuedCredentials\]/;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      client.setAuthToken(OLD_TOKEN);
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    /** The PUT answers `putBody`; the follow-up markVerifyPrompted answers ok. */
    function mockPutThenPost(putBody: unknown) {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(putBody))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    }

    function authHeaderOfCall(index: number): string | undefined {
      const [, init] = mockFetch.mock.calls[index];
      return (init as { headers: Record<string, string> }).headers[
        "Authorization"
      ];
    }

    it.each(["pin", "pattern", "code"] as const)(
      "should send the rotated token on the next request after saving %s",
      async (method) => {
        mockPutThenPost({
          data: {
            method,
            prompted: 1,
            authToken: ROTATED_TOKEN,
            expiresAt: ROTATED_EXPIRY,
          },
        });

        const result = await client.setVerifyMethod(USER_1, {
          method,
          ...(method === "code" ? {} : { secret: "123456" }),
        });
        await client.markVerifyPrompted(USER_1);

        expect(result).toStrictEqual({
          data: {
            method,
            prompted: 1,
            authToken: ROTATED_TOKEN,
            expiresAt: ROTATED_EXPIRY,
          },
        });
        // The PUT itself still authenticates with the token it replaced.
        expect(authHeaderOfCall(0)).toBe(`Bearer ${OLD_TOKEN}`);
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
      "should keep the current token and drop $label as authToken",
      async ({ authToken, leak }) => {
        mockPutThenPost({ data: { method: "pin", prompted: 1, authToken } });

        const result = await client.setVerifyMethod(USER_1, {
          method: "pin",
          secret: "123456",
        });
        await client.markVerifyPrompted(USER_1);

        expect(result).toStrictEqual({ data: { method: "pin", prompted: 1 } });
        expect(authHeaderOfCall(1)).toBe(`Bearer ${OLD_TOKEN}`);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toMatch(WARN_PREFIX);
        if (leak !== undefined) {
          expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(leak);
        }
      },
    );

    it("should adopt a valid token but drop an unusable expiry beside it", async () => {
      mockPutThenPost({
        data: {
          method: "pattern",
          prompted: 1,
          authToken: ROTATED_TOKEN,
          expiresAt: "tomorrow",
        },
      });

      const result = await client.setVerifyMethod(USER_1, {
        method: "pattern",
        secret: "0,1,2,5",
      });
      await client.markVerifyPrompted(USER_1);

      expect(result).toStrictEqual({
        data: { method: "pattern", prompted: 1, authToken: ROTATED_TOKEN },
      });
      expect(authHeaderOfCall(1)).toBe(`Bearer ${ROTATED_TOKEN}`);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toMatch(WARN_PREFIX);
    });

    it("should keep the current token without a warning when none issues no token", async () => {
      mockPutThenPost({ data: { method: "none", prompted: 1 } });

      const result = await client.setVerifyMethod(USER_1, { method: "none" });
      await client.markVerifyPrompted(USER_1);

      expect(result).toStrictEqual({ data: { method: "none", prompted: 1 } });
      expect(authHeaderOfCall(1)).toBe(`Bearer ${OLD_TOKEN}`);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should adopt nothing from an error envelope that also carries a token", async () => {
      const body = {
        error: { code: "X", message: "m" },
        data: { method: "pin", prompted: 1, authToken: ROTATED_TOKEN },
      };
      mockPutThenPost(body);

      const result = await client.setVerifyMethod(USER_1, {
        method: "pin",
        secret: "123456",
      });
      await client.markVerifyPrompted(USER_1);

      expect(result).toStrictEqual(body);
      expect(authHeaderOfCall(1)).toBe(`Bearer ${OLD_TOKEN}`);
      expect(warnSpy).not.toHaveBeenCalled();
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

  /** A PIN / pattern account confirms the delete with its current secret (#396); others send no body. */
  describe("deleteAccount", () => {
    it("should send DELETE /api/user/:id with the current secret as a JSON body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      const result = await client.deleteAccount(USER_1, "123456");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}`);
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(init.body)).toStrictEqual({ currentSecret: "123456" });
      expect(result.data).toEqual({ ok: true });
    });

    it("should send no body when no current secret is given", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.deleteAccount(USER_1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.example.com/api/user/${USER_1}`);
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });

    it("should pass a VERIFICATION_FAILED envelope through to the caller", async () => {
      const envelope = {
        error: { code: "VERIFICATION_FAILED", message: "Verification failed" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(envelope, 403));

      const result = await client.deleteAccount(USER_1, "000000");

      expect(result.error?.code).toBe("VERIFICATION_FAILED");
    });

    it("should reject invalid userId before sending anything", async () => {
      await expect(client.deleteAccount("bad", "123456")).rejects.toThrow(
        "Invalid userId",
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("setVerifyMethod with currentSecret", () => {
    it("should send currentSecret and prompted beside the new method", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { method: "code" } }),
      );

      await client.setVerifyMethod(USER_1, {
        method: "code",
        currentSecret: "0,1,2,5",
        prompted: 1,
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toStrictEqual({
        method: "code",
        currentSecret: "0,1,2,5",
        prompted: 1,
      });
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
