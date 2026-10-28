import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";

/**
 * ApiClient.refreshAuthToken (PWA, #364): `POST /api/auth/refresh`, the call the proactive renewal
 * makes before the token expires.
 *
 * No token refresher on a 401. The request is sent with `isRetry = true`, so a 401 comes straight
 * back as the error envelope and NEVER reaches a registered `tokenRefresher` — on the session
 * client that refresher is the recovery join, which spends the sensitive join quota and can log
 * the user out. The positive companion (a plain GET on the same client DOES call the refresher on a
 * 401) proves the refresher was really wired, so the negative cannot pass vacuously.
 *
 * Response check. The token must be the 64-char lowercase hex the Worker issues, else the whole
 * response is `INVALID_RESPONSE` with no `data`; an unusable `expiresAt` is dropped from `data`
 * (no key at all), never passed through. An error envelope comes back unchanged.
 *
 * `fetch` is the only mock; the base URL is read through the transport's getter, so a later
 * `setEndpoint` is honoured by this call too.
 */

const mockFetch = vi.fn();

const USER = "a".repeat(64);
const FAMILY = "fam-refresh";
const OLD_TOKEN = "1".repeat(64);
const NEW_TOKEN = "0123456789abcdef".repeat(4);
const EXPIRES_AT = 1_900_000_000_000;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe("ApiClient.refreshAuthToken", () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new ApiClient("https://api.example.com");
    client.setAuthToken(OLD_TOKEN);
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
  });

  it("POSTs { userId, familyId } with the current token and returns the renewed credentials", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { token: NEW_TOKEN, expiresAt: EXPIRES_AT } }),
    );

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(res).toEqual({ data: { token: NEW_TOKEN, expiresAt: EXPIRES_AT } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.example.com/api/auth/refresh");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      userId: USER,
      familyId: FAMILY,
    });
    expect(init.headers["Authorization"]).toBe(`Bearer ${OLD_TOKEN}`);
  });

  it("sends the request to an endpoint set after construction", async () => {
    client.setEndpoint("https://self.example.com/");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { token: NEW_TOKEN, expiresAt: EXPIRES_AT } }),
    );

    await client.refreshAuthToken(USER, FAMILY);

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://self.example.com/api/auth/refresh",
    );
  });

  it("passes an error envelope through unchanged, with no data", async () => {
    const error = { code: "REFRESH_FAILED", message: "token expired" };
    mockFetch.mockResolvedValueOnce(jsonResponse({ error }, 401));

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(res).toEqual({ error });
    expect(res).not.toHaveProperty("data");
  });

  it("never hands a 401 to the registered token refresher", async () => {
    const refresher = vi.fn().mockResolvedValue(NEW_TOKEN);
    client.setTokenRefresher(refresher);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { code: "REFRESH_FAILED", message: "x" } }, 401),
    );

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(refresher).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.error?.code).toBe("REFRESH_FAILED");
  });

  /** Positive companion of the test above: the refresher IS wired on this client. */
  it("still lets an ordinary request on the same client use the refresher on a 401", async () => {
    const refresher = vi.fn().mockResolvedValue(NEW_TOKEN);
    client.setTokenRefresher(refresher);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHORIZED", message: "x" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { method: "none" } }));

    await client.getVerifyMethod(USER);

    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("returns UNKNOWN_ERROR for a failed response without an error envelope", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 503));

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(res).toEqual({
      error: { code: "UNKNOWN_ERROR", message: "HTTP 503" },
    });
  });

  it("returns NETWORK_ERROR when the request cannot be sent", async () => {
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(res).toEqual({
      error: { code: "NETWORK_ERROR", message: "offline" },
    });
  });

  it.each<{ label: string; data: Record<string, unknown> | null }>([
    { label: "no data at all", data: null },
    { label: "no token", data: { expiresAt: EXPIRES_AT } },
    { label: "an empty token", data: { token: "", expiresAt: EXPIRES_AT } },
    {
      label: "an uppercase token",
      data: { token: NEW_TOKEN.toUpperCase(), expiresAt: EXPIRES_AT },
    },
    {
      label: "a 63-char token",
      data: { token: NEW_TOKEN.slice(1), expiresAt: EXPIRES_AT },
    },
    { label: "a numeric token", data: { token: 12345, expiresAt: EXPIRES_AT } },
    {
      label: "the old non-hex test token",
      data: { token: "test-auth-token-abc", expiresAt: EXPIRES_AT },
    },
  ])("answers INVALID_RESPONSE, with no data, for $label", async ({ data }) => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(data === null ? {} : { data }),
    );

    const res = await client.refreshAuthToken(USER, FAMILY);

    expect(res).toEqual({
      error: {
        code: "INVALID_RESPONSE",
        message: "refresh response carried no usable token",
      },
    });
    expect(res).not.toHaveProperty("data");
  });

  it.each<{ label: string; expiresAt: unknown }>([
    { label: "missing", expiresAt: undefined },
    { label: "zero", expiresAt: 0 },
    { label: "negative", expiresAt: -1 },
    { label: "a string", expiresAt: String(EXPIRES_AT) },
    { label: "null", expiresAt: null },
    { label: "NaN", expiresAt: Number.NaN },
    { label: "Infinity", expiresAt: Number.POSITIVE_INFINITY },
  ])(
    "drops an expiry that is $label, keeping the token",
    async ({ expiresAt }) => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { token: NEW_TOKEN, expiresAt } }),
      );

      const res = await client.refreshAuthToken(USER, FAMILY);

      expect(res).toEqual({ data: { token: NEW_TOKEN } });
      expect(res.data).not.toHaveProperty("expiresAt");
    },
  );

  it("refuses a malformed userId before anything is sent", async () => {
    await expect(client.refreshAuthToken("not-hex", FAMILY)).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
