import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { ApiClient } from "@/api/client";
import {
  applyBootSession,
  applyManualEndpoint,
  applyStoredSession,
  BOOT_SESSION_KEYS,
} from "@/dialog/applyStoredSession";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  MANUAL_API_ENDPOINT_KEY,
  TOKEN_EXPIRES_AT_KEY,
  TOKEN_SERVER_KEY,
  USER_ID_KEY,
} from "@/constants";

/**
 * applyStoredSession (#456): the boot step that puts the stored endpoint and its
 * token on App's client. The two come from one storage read and go on together, or
 * neither does: a client that kept the official default while taking a self-hosted
 * token would send that token to the official server.
 *
 * applyManualEndpoint (#501): the no-family half of the same boot read. The family
 * endpoint (`moo:apiEndpoint`) and its token are family-scoped and must not reach
 * onboarding; only the operator-set `moo:manualApiEndpoint` may, and never with a
 * token. An unusable manual value is warned about and left in storage for the
 * operator — nothing is written or removed, and the client stays on the default.
 *
 * applyBootSession: App's single boot call, choosing between the two by whether a
 * family is bound. Its table feeds both branches the SAME storage (family endpoint,
 * token, token-server marker and manual endpoint), so a swapped or ignored
 * `familyBound` shows as the wrong server or a token where none may go.
 *
 * Real `ApiClient`, with `fetch` faked so "the official server got no token" is an
 * assertion on an actual request rather than on a spy. The removal of an unusable
 * pair is fire-and-forget in production, so the cases settle it with `drain`.
 */

const CUSTOM_ENDPOINT = "https://family.example";
const TOKEN = "a".repeat(64);
const USER = "1".repeat(64);

function fakeFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { books: [] } }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function sendAndCapture(
  client: ApiClient,
  fetchMock: ReturnType<typeof vi.fn>,
): Promise<{ url: string; authorization: string | undefined }> {
  await client.getPersonalBooks(USER);
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    RequestInit,
  ];
  return {
    url,
    authorization: (init.headers as Record<string, string>).Authorization,
  };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function readStored(key: string): Promise<unknown> {
  const stored = (await browser.storage.local.get([key])) as Record<
    string,
    unknown
  >;
  return stored[key];
}

describe("applyStoredSession", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await browser.storage.local.clear();
  });

  describe("a usable pair", () => {
    it("puts a stored endpoint and its token on the client", async () => {
      const fetchMock = fakeFetch();
      const client = new ApiClient();

      applyStoredSession(client, {
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        [AUTH_TOKEN_KEY]: TOKEN,
      });

      expect(client.getEndpoint()).toBe(CUSTOM_ENDPOINT);
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(CUSTOM_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("leaves the client on the official default, with its token, when no endpoint is stored", async () => {
      const fetchMock = fakeFetch();
      const client = new ApiClient();
      const setEndpoint = vi.spyOn(client, "setEndpoint");

      applyStoredSession(client, { [AUTH_TOKEN_KEY]: TOKEN });

      expect(setEndpoint).not.toHaveBeenCalled();
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(DEFAULT_API_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("stores the canonical spelling of the endpoint on the client", () => {
      const client = new ApiClient();

      applyStoredSession(client, { [API_ENDPOINT_KEY]: `${CUSTOM_ENDPOINT}/` });

      expect(client.getEndpoint()).toBe(CUSTOM_ENDPOINT);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["a number", 42],
      ["null", null],
    ])("sets no token when the stored one is %s", (_label, token) => {
      const client = new ApiClient();
      const setAuthToken = vi.spyOn(client, "setAuthToken");

      applyStoredSession(client, {
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        [AUTH_TOKEN_KEY]: token,
      });

      expect(client.getEndpoint()).toBe(CUSTOM_ENDPOINT);
      expect(setAuthToken).not.toHaveBeenCalled();
    });
  });

  describe("an unusable stored endpoint", () => {
    const UNUSABLE: Array<[string, unknown]> = [
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["embedded credentials", "https://real.example@evil.com"],
      ["not a URL", "not-a-url"],
      ["a blank string", "   "],
      ["a number", 42],
      ["null", null],
    ];

    async function bootOnUnusable(raw: unknown) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await browser.storage.local.set({
        [API_ENDPOINT_KEY]: raw,
        [AUTH_TOKEN_KEY]: TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 123,
      });
      vi.clearAllMocks();
      const client = new ApiClient();
      const setEndpoint = vi.spyOn(client, "setEndpoint");
      const setAuthToken = vi.spyOn(client, "setAuthToken");

      applyStoredSession(client, {
        [API_ENDPOINT_KEY]: raw,
        [AUTH_TOKEN_KEY]: TOKEN,
      });

      return { client, setEndpoint, setAuthToken };
    }

    it.each(UNUSABLE)(
      "puts neither on the client for %s, so the official server sees no token",
      async (_label, raw) => {
        const fetchMock = fakeFetch();

        const { client, setEndpoint, setAuthToken } = await bootOnUnusable(raw);
        await drain();

        expect(setEndpoint).not.toHaveBeenCalled();
        expect(setAuthToken).not.toHaveBeenCalled();
        const sent = await sendAndCapture(client, fetchMock);
        expect(sent.url.startsWith(DEFAULT_API_ENDPOINT)).toBe(true);
        expect(sent.authorization).toBeUndefined();
      },
    );

    it.each(UNUSABLE)(
      "removes the token first and then the endpoint for %s",
      async (_label, raw) => {
        await bootOnUnusable(raw);
        await drain();

        await expect(readStored(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
        await expect(readStored(TOKEN_EXPIRES_AT_KEY)).resolves.toBeUndefined();
        await expect(readStored(API_ENDPOINT_KEY)).resolves.toBeUndefined();
        const removals = vi
          .mocked(browser.storage.local.remove)
          .mock.calls.map(([keys]) => keys as string[]);
        const tokenRemoval = removals.findIndex((keys) =>
          keys.includes(AUTH_TOKEN_KEY),
        );
        const endpointRemoval = removals.findIndex((keys) =>
          keys.includes(API_ENDPOINT_KEY),
        );
        expect(tokenRemoval).toBeGreaterThanOrEqual(0);
        expect(endpointRemoval).toBeGreaterThan(tokenRemoval);
      },
    );

    it("survives a failed removal, with the client still holding no token", async () => {
      const fetchMock = fakeFetch();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = new ApiClient();

      expect(() =>
        applyStoredSession(client, {
          [API_ENDPOINT_KEY]: "http://evil.example.com",
          [AUTH_TOKEN_KEY]: TOKEN,
        }),
      ).not.toThrow();
      await drain();

      expect(warn).toHaveBeenCalledTimes(2);
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.authorization).toBeUndefined();
    });
  });
});

describe("BOOT_SESSION_KEYS", () => {
  it("asks for the user, the family endpoint with its token and the token's server, and the manual endpoint", () => {
    expect([...BOOT_SESSION_KEYS].sort()).toEqual(
      [
        USER_ID_KEY,
        AUTH_TOKEN_KEY,
        TOKEN_SERVER_KEY,
        API_ENDPOINT_KEY,
        MANUAL_API_ENDPOINT_KEY,
      ].sort(),
    );
  });
});

describe("applyBootSession", () => {
  const MANUAL_ENDPOINT = "https://manual.example";
  const OTHER_SERVER = "https://other.example";
  const originalFetch = globalThis.fetch;

  function bootStorage(marker: string): Record<string, unknown> {
    return {
      [USER_ID_KEY]: USER,
      [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
      [AUTH_TOKEN_KEY]: TOKEN,
      [TOKEN_SERVER_KEY]: marker,
      [MANUAL_API_ENDPOINT_KEY]: MANUAL_ENDPOINT,
    };
  }

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await browser.storage.local.clear();
  });

  it.each<[string, boolean, string, string, string | undefined]>([
    [
      "a bound family uses the family endpoint and its paired token",
      true,
      CUSTOM_ENDPOINT,
      CUSTOM_ENDPOINT,
      `Bearer ${TOKEN}`,
    ],
    [
      "a bound family drops a token another server issued",
      true,
      OTHER_SERVER,
      CUSTOM_ENDPOINT,
      undefined,
    ],
    [
      "no family uses only the manual endpoint, with no token",
      false,
      CUSTOM_ENDPOINT,
      MANUAL_ENDPOINT,
      undefined,
    ],
  ])(
    "%s",
    async (_label, familyBound, marker, expectedServer, expectedAuth) => {
      const fetchMock = fakeFetch();
      const client = new ApiClient();

      applyBootSession(client, bootStorage(marker), familyBound);

      expect(client.getEndpoint()).toBe(expectedServer);
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(expectedServer)).toBe(true);
      expect(sent.authorization).toBe(expectedAuth);
    },
  );
});

describe("applyManualEndpoint", () => {
  const MANUAL_ENDPOINT = "https://manual.example";
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await browser.storage.local.clear();
  });

  describe("no manual endpoint stored", () => {
    it.each<[string, Record<string, unknown>]>([
      ["nothing at all", {}],
      [
        "only the family endpoint and its token",
        { [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT, [AUTH_TOKEN_KEY]: TOKEN },
      ],
    ])("leaves the client untouched with %s", async (_label, stored) => {
      const fetchMock = fakeFetch();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = new ApiClient();
      const setEndpoint = vi.spyOn(client, "setEndpoint");
      const setAuthToken = vi.spyOn(client, "setAuthToken");

      applyManualEndpoint(client, stored);

      expect(setEndpoint).not.toHaveBeenCalled();
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(DEFAULT_API_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBeUndefined();
    });
  });

  describe("a usable manual endpoint", () => {
    it.each([
      ["an HTTPS host", MANUAL_ENDPOINT, MANUAL_ENDPOINT],
      ["a trailing slash", `${MANUAL_ENDPOINT}/`, MANUAL_ENDPOINT],
      ["surrounding blanks", `  ${MANUAL_ENDPOINT}  `, MANUAL_ENDPOINT],
      ["a local worker", "http://localhost:8787", "http://localhost:8787"],
    ])("points the client at %s", (_label, raw, expected) => {
      const client = new ApiClient();

      applyManualEndpoint(client, { [MANUAL_API_ENDPOINT_KEY]: raw });

      expect(client.getEndpoint()).toBe(expected);
    });

    it("sends to the manual server with no token", async () => {
      const fetchMock = fakeFetch();
      const client = new ApiClient();

      applyManualEndpoint(client, {
        [MANUAL_API_ENDPOINT_KEY]: MANUAL_ENDPOINT,
      });

      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(MANUAL_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBeUndefined();
    });

    // The family endpoint and its token are family-scoped; with no family they must not reach
    // onboarding even when a manual endpoint sits beside them (#501).
    it("applies only the manual endpoint when the family endpoint and its token are stored too", async () => {
      const fetchMock = fakeFetch();
      const client = new ApiClient();
      const setEndpoint = vi.spyOn(client, "setEndpoint");
      const setAuthToken = vi.spyOn(client, "setAuthToken");

      applyManualEndpoint(client, {
        [MANUAL_API_ENDPOINT_KEY]: MANUAL_ENDPOINT,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        [AUTH_TOKEN_KEY]: TOKEN,
      });

      expect(setEndpoint).toHaveBeenCalledTimes(1);
      expect(setEndpoint).toHaveBeenCalledWith(MANUAL_ENDPOINT);
      expect(setAuthToken).not.toHaveBeenCalled();
      const sent = await sendAndCapture(client, fetchMock);
      expect(sent.url.startsWith(MANUAL_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBeUndefined();
    });
  });

  describe("an unusable manual endpoint", () => {
    it.each<[string, unknown]>([
      ["a number", 42],
      ["null", null],
      ["an empty string", ""],
      ["a blank string", "   "],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["embedded credentials", "https://real.example@evil.com"],
      ["not a URL", "not-a-url"],
    ])(
      "keeps the official default for %s, warns, and leaves storage alone",
      async (_label, raw) => {
        const fetchMock = fakeFetch();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const client = new ApiClient();
        const setEndpoint = vi.spyOn(client, "setEndpoint");
        const setAuthToken = vi.spyOn(client, "setAuthToken");

        expect(() =>
          applyManualEndpoint(client, {
            [MANUAL_API_ENDPOINT_KEY]: raw,
            [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
            [AUTH_TOKEN_KEY]: TOKEN,
          }),
        ).not.toThrow();
        await drain();

        expect(setEndpoint).not.toHaveBeenCalled();
        expect(setAuthToken).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          "[App] Ignoring unusable manual API endpoint",
        );
        expect(browser.storage.local.remove).not.toHaveBeenCalled();
        expect(browser.storage.local.set).not.toHaveBeenCalled();
        const sent = await sendAndCapture(client, fetchMock);
        expect(sent.url.startsWith(DEFAULT_API_ENDPOINT)).toBe(true);
        expect(sent.authorization).toBeUndefined();
      },
    );
  });
});
