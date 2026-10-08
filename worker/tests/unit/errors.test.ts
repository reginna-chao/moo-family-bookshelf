import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, it, expect } from "vitest";
import { clientErrorFor, jsonError } from "../../src/utils/errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const testApp = new Hono();

// Legacy call shape — no options argument at all.
testApp.get("/plain", (c) =>
  jsonError(c, 403, "VERIFICATION_REQUIRED", "此帳號需要驗證才能登入"),
);

// Call shape used by the join handler: an options object whose `retryAfter`
// is undefined for every error except VERIFICATION_LOCKED.
testApp.get("/optional", (c) => {
  const raw = c.req.query("retryAfter");
  const retryAfter = raw === undefined ? undefined : Number(raw);
  return jsonError(c, 429, "VERIFICATION_LOCKED", "驗證已鎖定，請稍後再試", {
    retryAfter,
  });
});

describe("jsonError", () => {
  it("should return the bare code/message envelope when no options are passed", async () => {
    const res = await testApp.request("/plain");

    expect(res.status).toBe(403);
    expect(res.headers.get("Retry-After")).toBeNull();

    const json = (await res.json()) as Json;
    expect(json).toEqual({
      error: {
        code: "VERIFICATION_REQUIRED",
        message: "此帳號需要驗證才能登入",
      },
    });
    expect(Object.keys(json.error).sort()).toEqual(["code", "message"]);
  });

  it("should treat an explicitly undefined retryAfter as omitted", async () => {
    const res = await testApp.request("/optional");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();

    const json = (await res.json()) as Json;
    expect(json).toEqual({
      error: {
        code: "VERIFICATION_LOCKED",
        message: "驗證已鎖定，請稍後再試",
      },
    });
    expect("retryAfter" in json.error).toBe(false);
  });

  it.each([1, 2, 42, 900])(
    "should expose retryAfter=%i in both the body and the Retry-After header",
    async (seconds) => {
      const res = await testApp.request(`/optional?retryAfter=${seconds}`);

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe(String(seconds));

      const json = (await res.json()) as Json;
      expect(json.error.retryAfter).toBe(seconds);
      expect(json.error.code).toBe("VERIFICATION_LOCKED");
      expect(json.error.message).toBe("驗證已鎖定，請稍後再試");
      expect(json.error.retryAfter).toBe(
        Number(res.headers.get("Retry-After")),
      );
    },
  );
});

// --- clientErrorFor — root onError classification (#239) ---

// Distinctive text placed in every thrown message: it must never come back.
const SENTINEL = "SENTINEL_c41e_parser_detail";

// Contract copy of the `clientErrorFor` literals (src/utils/errors.ts), written out, not derived:
// INVALID_JSON must stay byte-identical to the handlers' unparsable-body answer clients match on.
const INVALID_JSON = {
  code: "INVALID_JSON",
  message: "Request body must be valid JSON",
};
const UNSUPPORTED_MEDIA_TYPE = {
  code: "UNSUPPORTED_MEDIA_TYPE",
  message: "Request Content-Type is not supported",
};
const REQUEST_REJECTED = {
  code: "REQUEST_REJECTED",
  message: "Request was rejected",
};

/** hono/validator's exact message for an unparsable declared json body. */
const HONO_MALFORMED_JSON = "Malformed JSON in request body";

/** `HTTPException` with an arbitrary runtime status (out-of-type ones too). */
function httpError(status: number, message?: string): HTTPException {
  return new HTTPException(
    status as ContentfulStatusCode,
    message === undefined ? undefined : { message },
  );
}

interface ClientErrorCase {
  name: string;
  err: Error;
  expected: { status: number; code: string; message: string } | null;
}

const clientErrorCases: ClientErrorCase[] = [
  {
    name: "hono's exact malformed-JSON 400",
    err: httpError(400, HONO_MALFORMED_JSON),
    expected: { status: 400, ...INVALID_JSON },
  },
  {
    name: "a reworded malformed-JSON 400 (trailing period)",
    err: httpError(400, `${HONO_MALFORMED_JSON}.`),
    expected: { status: 400, ...REQUEST_REJECTED },
  },
  {
    name: "a reworded malformed-JSON 400 (different case)",
    err: httpError(400, HONO_MALFORMED_JSON.toLowerCase()),
    expected: { status: 400, ...REQUEST_REJECTED },
  },
  {
    name: "a FormData parse 400 carrying the parser's own text",
    err: httpError(400, `Malformed FormData request. ${SENTINEL}`),
    expected: { status: 400, ...REQUEST_REJECTED },
  },
  {
    name: "a 400 with no message",
    err: httpError(400),
    expected: { status: 400, ...REQUEST_REJECTED },
  },
  {
    name: "zod-openapi's 415 media-type rejection",
    err: httpError(415, "Unsupported Media Type"),
    expected: { status: 415, ...UNSUPPORTED_MEDIA_TYPE },
  },
  {
    name: "a 415 whose message is the malformed-JSON text (status decides)",
    err: httpError(415, HONO_MALFORMED_JSON),
    expected: { status: 415, ...UNSUPPORTED_MEDIA_TYPE },
  },
  {
    name: "a 401",
    err: httpError(401, SENTINEL),
    expected: { status: 401, ...REQUEST_REJECTED },
  },
  {
    name: "a 403",
    err: httpError(403, SENTINEL),
    expected: { status: 403, ...REQUEST_REJECTED },
  },
  {
    name: "a 404",
    err: httpError(404, SENTINEL),
    expected: { status: 404, ...REQUEST_REJECTED },
  },
  {
    name: "a 404 whose message is the malformed-JSON text (status decides)",
    err: httpError(404, HONO_MALFORMED_JSON),
    expected: { status: 404, ...REQUEST_REJECTED },
  },
  {
    name: "a 413",
    err: httpError(413, SENTINEL),
    expected: { status: 413, ...REQUEST_REJECTED },
  },
  {
    name: "a 429",
    err: httpError(429, SENTINEL),
    expected: { status: 429, ...REQUEST_REJECTED },
  },
  {
    name: "a 499 (top of the client range)",
    err: httpError(499, SENTINEL),
    expected: { status: 499, ...REQUEST_REJECTED },
  },
  {
    name: "a 399 (below the client range)",
    err: httpError(399, SENTINEL),
    expected: null,
  },
  {
    name: "a 500 HTTPException",
    err: httpError(500, SENTINEL),
    expected: null,
  },
  {
    name: "a 503 HTTPException",
    err: httpError(503, SENTINEL),
    expected: null,
  },
  {
    name: "a plain Error carrying the malformed-JSON text",
    err: new Error(HONO_MALFORMED_JSON),
    expected: null,
  },
  {
    name: "a TypeError",
    err: new TypeError(SENTINEL),
    expected: null,
  },
  {
    name: "an Error duck-typed with status 400 (not an HTTPException)",
    err: Object.assign(new Error(HONO_MALFORMED_JSON), { status: 400 }),
    expected: null,
  },
];

describe("clientErrorFor", () => {
  it.each(clientErrorCases)("maps $name", ({ err, expected }) => {
    expect(clientErrorFor(err)).toEqual(expected);
  });

  it.each(clientErrorCases.filter(({ expected }) => expected !== null))(
    "never echoes the thrown message for $name",
    ({ err }) => {
      const serialized = JSON.stringify(clientErrorFor(err));

      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("Malformed");
      expect(Object.keys(clientErrorFor(err) ?? {}).sort()).toEqual([
        "code",
        "message",
        "status",
      ]);
    },
  );
});
