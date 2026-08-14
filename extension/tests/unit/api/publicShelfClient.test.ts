import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import {
  ApiError,
  AUTH_REFRESH_RATE_LIMITED,
  type PublicShelf,
} from "@/api/types";

// Pin DEFAULT_API_ENDPOINT (avoids import.meta.env dependence) while keeping
// every other real constant the client module imports.
vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

const MOCK_ENDPOINT = "https://test.workers.dev";
const USER_ID = "a".repeat(64);
const SHELF_ID = "shelf-1";

const SHELF: PublicShelf = {
  shelfId: SHELF_ID,
  shareToken: "tok-abc",
  title: "小明 的公開書櫃",
  expiresDays: 30,
  createdAt: 1_700_000_000_000,
  expiresAt: null,
  selectionMode: "all-shared",
};

/** A response whose body parses as JSON (the ordinary case). */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/**
 * A response with NO body. `json()` rejects exactly like the real `fetch` does
 * on an empty payload — that SyntaxError is what used to be laundered into a
 * NETWORK_ERROR envelope and then swallowed, so a 204 read as a failure and a
 * refused revocation read as a success.
 */
function bodylessResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
  };
}

/** The rejection reason, typed — `rejects.toThrow` cannot inspect fields. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("ApiClient public-shelf envelope handling", () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("deletePublicShelf", () => {
    it("resolves on a bodyless 204 without attempting to parse a body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(bodylessResponse(204));
      globalThis.fetch = fetchMock;

      await expect(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_ENDPOINT}/api/user/${USER_ID}/public-shelf/${SHELF_ID}`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it.each([{ status: 204, label: "No Content" }])(
      "treats a bodyless $status $label as a confirmed revocation",
      async ({ status }) => {
        globalThis.fetch = vi.fn().mockResolvedValue(bodylessResponse(status));

        await expect(
          client.deletePublicShelf(USER_ID, SHELF_ID),
        ).resolves.toBeUndefined();
      },
    );

    /**
     * Counter-case to the row above: the bodyless allowance is exactly 204, the
     * one status this API answers without a body. Every other empty response is
     * read as the parse failure it is, so a backend cannot have the dialog
     * report a link as closed by answering an empty body on a status the API
     * never returns. 304 lands here too — it is `!response.ok`, so its empty
     * body was never eligible for the success path either way.
     */
    it.each([
      { status: 205, label: "Reset Content" },
      { status: 304, label: "Not Modified" },
    ])(
      "fails closed on a bodyless $status $label instead of confirming the revocation",
      async ({ status }) => {
        globalThis.fetch = vi.fn().mockResolvedValue(bodylessResponse(status));

        const err = await captureRejection(
          client.deletePublicShelf(USER_ID, SHELF_ID),
        );

        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ code: "NETWORK_ERROR" });
      },
    );

    it("throws an ApiError carrying code and retryAfter when the server refuses (429)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "RATE_LIMITED",
              message: "too many requests",
              retryAfter: 45,
            },
          },
          429,
        ),
      );

      const err = await captureRejection(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfter: 45 });
      // The legacy "CODE: text" shape stays intact for existing callers.
      expect((err as ApiError).message).toBe("RATE_LIMITED: too many requests");
    });

    it.each([
      { status: 403, code: "FORBIDDEN", message: "not your shelf" },
      { status: 404, code: "SHELF_NOT_FOUND", message: "shelf not found" },
      { status: 500, code: "INTERNAL_ERROR", message: "kv write failed" },
    ])(
      "throws an ApiError preserving $code from a $status envelope",
      async ({ status, code, message }) => {
        globalThis.fetch = vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ error: { code, message } }, status),
          );

        const err = await captureRejection(
          client.deletePublicShelf(USER_ID, SHELF_ID),
        );

        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ code, retryAfter: undefined });
      },
    );

    it("still throws when a failing response carries no parseable body", async () => {
      // 500 is not bodyless by definition, so the parse failure stands — the
      // revocation must fail closed rather than resolve.
      globalThis.fetch = vi.fn().mockResolvedValue(bodylessResponse(500));

      const err = await captureRejection(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "NETWORK_ERROR" });
    });

    it("throws an ApiError when fetch itself rejects", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Failed to fetch"));

      const err = await captureRejection(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "NETWORK_ERROR" });
    });
  });

  describe("JSON-bearing public-shelf endpoints", () => {
    it("returns the payload of a successful list response", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: { shelves: [SHELF] } }));

      await expect(client.listPublicShelves(USER_ID)).resolves.toEqual({
        shelves: [SHELF],
      });
    });

    it("throws EMPTY_RESPONSE when a 200 envelope carries neither data nor error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      const err = await captureRejection(client.listPublicShelves(USER_ID));

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "EMPTY_RESPONSE" });
    });

    it("returns the updated shelf on a successful update", async () => {
      const updated = { ...SHELF, title: "新標題" };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: { shelf: updated } }));

      await expect(
        client.updatePublicShelf(USER_ID, SHELF_ID, { title: "新標題" }),
      ).resolves.toEqual({ shelf: updated });
    });

    it("throws an ApiError with retryAfter when an update is rate-limited", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "RATE_LIMITED",
              message: "too many requests",
              retryAfter: 90,
            },
          },
          429,
        ),
      );

      const err = await captureRejection(
        client.updatePublicShelf(USER_ID, SHELF_ID, { title: "新標題" }),
      );

      expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfter: 90 });
    });

    it("throws an ApiError preserving the code when creation is refused", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: { code: "MAX_SHELVES_REACHED", message: "limit reached" },
          },
          409,
        ),
      );

      const err = await captureRejection(
        client.createPublicShelf(USER_ID, { title: "書櫃", expiresDays: 30 }),
      );

      expect(err).toMatchObject({ code: "MAX_SHELVES_REACHED" });
    });

    /**
     * `retryAfter` crosses a trust boundary: a self-hosted (BYO) backend can put
     * anything in the envelope, and the value is rendered straight into the
     * back-off copy. Anything unusable must be dropped so the UI falls back to
     * its static wording instead of printing「NaN 秒」/「-1 秒」.
     */
    describe("retryAfter validation at the envelope boundary", () => {
      async function rejectWithRetryAfter(retryAfter: unknown) {
        globalThis.fetch = vi.fn().mockResolvedValue(
          jsonResponse(
            {
              error: {
                code: "RATE_LIMITED",
                message: "too many requests",
                retryAfter,
              },
            },
            429,
          ),
        );

        return captureRejection(
          client.updatePublicShelf(USER_ID, SHELF_ID, { title: "新標題" }),
        );
      }

      it.each([
        { name: "NaN", raw: NaN },
        { name: "a negative wait", raw: -1 },
        { name: "a numeric string", raw: "60" },
        { name: "Infinity", raw: Infinity },
        { name: "null", raw: null },
        { name: "an absent field", raw: undefined },
      ])("drops $name so the UI keeps its static wording", async ({ raw }) => {
        const err = await rejectWithRetryAfter(raw);

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).retryAfter).toBeUndefined();
      });

      it.each([
        { name: "floors a fractional wait", raw: 45.9, expected: 45 },
        { name: "keeps a whole-second wait", raw: 45, expected: 45 },
        { name: "keeps a zero wait", raw: 0, expected: 0 },
      ])("$name ($raw → $expected)", async ({ raw, expected }) => {
        const err = await rejectWithRetryAfter(raw);

        expect((err as ApiError).retryAfter).toBe(expected);
      });
    });

    /**
     * Provenance cannot cross the wire. `client.ts` marks the envelopes it
     * builds itself with a module-private Symbol, which `JSON.parse` can never
     * produce — so a self-hosted (BYO) or hostile backend that puts the
     * client-only AUTH_REFRESH_RATE_LIMITED code in a response body still yields
     * `synthesized: false`, and the dialog refuses to render its message
     * verbatim (see `tests/unit/dialog/publicShareMessages.test.ts`).
     */
    it("never marks a server-sent AUTH_REFRESH_RATE_LIMITED envelope as client-synthesized", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: AUTH_REFRESH_RATE_LIMITED,
              message: "任意惡意文案",
            },
          },
          429,
        ),
      );

      const err = await captureRejection(
        client.updatePublicShelf(USER_ID, SHELF_ID, { title: "新標題" }),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({
        code: AUTH_REFRESH_RATE_LIMITED,
        synthesized: false,
      });
    });

    it("throws an ApiError preserving the code when a token reset is refused", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { code: "SHELF_NOT_FOUND", message: "shelf not found" } },
            404,
          ),
        );

      const err = await captureRejection(
        client.resetPublicShelfToken(USER_ID, SHELF_ID),
      );

      expect(err).toMatchObject({ code: "SHELF_NOT_FOUND" });
    });
  });
});
