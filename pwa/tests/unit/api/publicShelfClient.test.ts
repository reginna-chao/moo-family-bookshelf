import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiClient,
  ApiError,
  type PublicShelf,
  type PublicShelfData,
} from "@/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT = "https://api.example.com";
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

  beforeEach(() => {
    client = new ApiClient(ENDPOINT);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("deletePublicShelf", () => {
    it("resolves on a bodyless 204 without attempting to parse a body", async () => {
      mockFetch.mockResolvedValue(bodylessResponse(204));

      await expect(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      ).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledWith(
        `${ENDPOINT}/api/user/${USER_ID}/public-shelf/${SHELF_ID}`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it.each([{ status: 204, label: "No Content" }])(
      "treats a bodyless $status $label as a confirmed revocation",
      async ({ status }) => {
        mockFetch.mockResolvedValue(bodylessResponse(status));

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
        mockFetch.mockResolvedValue(bodylessResponse(status));

        const err = await captureRejection(
          client.deletePublicShelf(USER_ID, SHELF_ID),
        );

        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ code: "NETWORK_ERROR" });
      },
    );

    it("throws an ApiError carrying code and retryAfter when the server refuses (429)", async () => {
      mockFetch.mockResolvedValue(
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
        mockFetch.mockResolvedValue(
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
      mockFetch.mockResolvedValue(bodylessResponse(500));

      const err = await captureRejection(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "NETWORK_ERROR" });
    });

    it("throws an ApiError when fetch itself rejects", async () => {
      mockFetch.mockRejectedValue(new Error("Failed to fetch"));

      const err = await captureRejection(
        client.deletePublicShelf(USER_ID, SHELF_ID),
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "NETWORK_ERROR" });
    });
  });

  describe("JSON-bearing public-shelf endpoints", () => {
    it("returns the payload of a successful list response", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ data: { shelves: [SHELF] } }));

      await expect(client.listPublicShelves(USER_ID)).resolves.toEqual({
        shelves: [SHELF],
      });
    });

    it("throws EMPTY_RESPONSE when a 200 envelope carries neither data nor error", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));

      const err = await captureRejection(client.listPublicShelves(USER_ID));

      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: "EMPTY_RESPONSE" });
    });

    it("returns the updated shelf on a successful update", async () => {
      const updated = { ...SHELF, title: "新標題" };
      mockFetch.mockResolvedValue(jsonResponse({ data: { shelf: updated } }));

      await expect(
        client.updatePublicShelf(USER_ID, SHELF_ID, { title: "新標題" }),
      ).resolves.toEqual({ shelf: updated });
    });

    it("throws an ApiError with retryAfter when an update is rate-limited", async () => {
      mockFetch.mockResolvedValue(
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
      mockFetch.mockResolvedValue(
        jsonResponse(
          { error: { code: "MAX_SHELVES_REACHED", message: "limit reached" } },
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
        mockFetch.mockResolvedValue(
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

    it("throws an ApiError preserving the code when a token reset is refused", async () => {
      mockFetch.mockResolvedValue(
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

  /**
   * `throwOnError` is the single chokepoint every thrown `ApiError` passes
   * through, and both of its text inputs arrive via `readEnvelope`, which
   * bare-casts `response.json()` (src/api/client.ts). The endpoint is
   * user-configurable (the PWA adopts a sync code's `@host` too), so `code` and
   * `message` are `unknown` at runtime while the types call them `string`.
   *
   * That gap costs more than wording. `ApiError`'s constructor interpolates
   * both — `super(\`${code}: ${message}\`)` — so a value whose ToPrimitive
   * throws (`{ toString: null, valueOf: null }`, a shape `JSON.parse` really
   * can produce) used to raise a TypeError from INSIDE the constructor: no
   * `ApiError` was ever built, every caller's `instanceof ApiError` branch went
   * false, and the machine-readable `code` plus the 429 `retryAfter` the
   * back-off copy counts down from were lost with it.
   *
   * Mirrors extension/tests/unit/client.test.ts — the two clients keep
   * byte-identical fallbacks, and nothing else stops them from drifting.
   */
  describe("throwOnError — hostile envelope text", () => {
    /** Fallbacks as written at the production call site in src/api/client.ts. */
    const CODE_FALLBACK = "UNKNOWN_ERROR";
    const MESSAGE_FALLBACK = "請稍後再試";

    /**
     * Refuse the next request with `error` verbatim, then hand back whatever
     * the unwrapping method threw. `captureRejection`'s trailing throw keeps a
     * resolved call from passing vacuously.
     */
    async function captureThrown(
      error: Record<string, unknown>,
      status: number,
    ): Promise<unknown> {
      mockFetch.mockResolvedValue(jsonResponse({ error }, status));
      return captureRejection(client.listPublicShelves(USER_ID));
    }

    it.each([
      { name: "an object message", message: { zh: "壞掉了" } },
      { name: "an array message", message: ["壞掉了"] },
      // Degrades too: a blank or absent error is not a report — the page would
      // render "SHELF_NOT_FOUND: " and tell the user nothing.
      { name: "an empty-string message", message: "" },
      { name: "a null message", message: null },
    ])(
      "throws an ApiError with the local fallback copy and the code preserved for $name",
      async ({ message }) => {
        const err = await captureThrown(
          { code: "SHELF_NOT_FOUND", message },
          404,
        );

        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).rawMessage).toBe(MESSAGE_FALLBACK);
        // The code is what callers branch on — degrading the message must
        // never cost it.
        expect((err as ApiError).code).toBe("SHELF_NOT_FOUND");
        expect((err as ApiError).message).toBe(
          `SHELF_NOT_FOUND: ${MESSAGE_FALLBACK}`,
        );
      },
    );

    it("still throws an ApiError (not a TypeError) for a message that cannot be stringified", async () => {
      // The exact payload from review: nulling both `toString` and `valueOf`
      // makes ToPrimitive throw, so `new ApiError(code, message, …)` used to
      // die inside its own constructor. A TypeError is not an ApiError, so the
      // 429 branch that renders the localized back-off copy was skipped — and
      // that branch reads exactly the two fields asserted here, which is why
      // this pins them rather than the (degraded) wording.
      const err = await captureThrown(
        {
          code: "RATE_LIMITED",
          message: { toString: null, valueOf: null },
          retryAfter: 90,
        },
        429,
      );

      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as ApiError).code).toBe("RATE_LIMITED");
      expect((err as ApiError).retryAfter).toBe(90);
      expect((err as ApiError).rawMessage).toBe(MESSAGE_FALLBACK);
    });

    it("falls back to UNKNOWN_ERROR when the code itself is not a string", async () => {
      // `code` is interpolated first, so a hostile code kills construction just
      // as thoroughly as a hostile message. It must still land as a non-empty
      // string: `err.code === ""` would match no branch and read as "no code".
      const err = await captureThrown(
        {
          code: { toString: null, valueOf: null },
          message: "伺服器拒絕了這個請求",
        },
        500,
      );

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(CODE_FALLBACK);
      // A legitimate message still reaches the user even when the code is junk
      // — and its presence proves the envelope's own error was used, not the
      // client's `HTTP 500` stand-in for a missing error field.
      expect((err as ApiError).rawMessage).toBe("伺服器拒絕了這個請求");
      // Sanitizing must not launder provenance: this payload came off the wire,
      // so the UI may not render its text verbatim.
      expect((err as ApiError).synthesized).toBe(false);
    });

    it("passes a legitimate string code and message through unchanged", async () => {
      // Positive control: the guard must not over-degrade. Real server text
      // still reaches the user, the legacy "CODE: message" shape stays intact
      // for callers that read `message`, and `retryAfter` rides along.
      const err = await captureThrown(
        {
          code: "MAX_SHELVES_REACHED",
          message: "已達公開書櫃數量上限",
          retryAfter: 45,
        },
        409,
      );

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("MAX_SHELVES_REACHED");
      expect((err as ApiError).rawMessage).toBe("已達公開書櫃數量上限");
      expect((err as ApiError).message).toBe(
        "MAX_SHELVES_REACHED: 已達公開書櫃數量上限",
      );
      expect((err as ApiError).retryAfter).toBe(45);
    });
  });

  /**
   * The public snapshot read is the one refusal path that does NOT go through
   * `throwOnError`: it builds a plain `Error` and hangs `status` on it, because
   * PublicShelfPage switches on that number — 404 →「此公開書櫃不存在或已過期」,
   * 400 →「網址格式不正確」, anything else → the generic load error with a retry
   * button. If the envelope's text makes `new Error(...)` throw, the assignment
   * on the NEXT line never runs, so `status` is absent and an expired link is
   * reported as a transient failure the user is invited to retry forever.
   */
  describe("getPublicShelf — hostile envelope text", () => {
    const SHARE_TOKEN = "tok-abc";

    it("keeps the 404 status attached when the envelope message cannot be stringified", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "SHELF_NOT_FOUND",
              message: { toString: null, valueOf: null },
            },
          },
          404,
        ),
      );

      const err = await captureRejection(client.getPublicShelf(SHARE_TOKEN));

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
      // The property PublicShelfPage reads; without it the 404 screen is lost.
      expect((err as Error & { status?: number }).status).toBe(404);
      // The code half survives sanitizing, so the failure stays diagnosable.
      expect((err as Error).message).toContain("SHELF_NOT_FOUND");
    });

    it("still attaches the status when the envelope code cannot be stringified", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: { toString: null, valueOf: null },
              message: "網址格式不正確",
            },
          },
          400,
        ),
      );

      const err = await captureRejection(client.getPublicShelf(SHARE_TOKEN));

      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { status?: number }).status).toBe(400);
    });

    it("passes a legitimate refusal through with both halves and the status", async () => {
      // Positive control: a well-formed envelope is untouched.
      mockFetch.mockResolvedValue(
        jsonResponse(
          { error: { code: "SHELF_NOT_FOUND", message: "shelf not found" } },
          404,
        ),
      );

      const err = await captureRejection(client.getPublicShelf(SHARE_TOKEN));

      expect((err as Error).message).toBe("SHELF_NOT_FOUND: shelf not found");
      expect((err as Error & { status?: number }).status).toBe(404);
    });

    it("returns the snapshot untouched on a successful read", async () => {
      // Guards the other direction: the sanitize sits on the error branch only.
      const snapshot: PublicShelfData = {
        title: SHELF.title,
        books: [],
        createdAt: SHELF.createdAt,
        expiresAt: null,
      };
      mockFetch.mockResolvedValue(jsonResponse({ data: snapshot }));

      await expect(client.getPublicShelf(SHARE_TOKEN)).resolves.toEqual(
        snapshot,
      );
    });
  });
});
