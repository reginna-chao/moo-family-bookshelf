/**
 * The PRODUCTION root `app.onError` (`src/index.ts`) driven by REAL hono
 * validation failures (#239).
 *
 * No production route declares a `request.body` schema — bodies are validated
 * by the handlers by design — so the two throws this mapping exists for
 * (`hono/validator`'s `HTTPException(400, "Malformed JSON in request body")`
 * and zod-openapi's media-type `HTTPException(415)`) are unreachable through
 * the real routes. This suite therefore MOUNTS a probe sub-app onto the
 * production `app` itself, under `/api/__probe`: the probe declares no
 * `onError` of its own, so hono routes every throw inside it to the parent's
 * handler — the exact one production ships — after the real `/api/*`
 * middleware chain (body-size check, KV-op counting, rate limit, auth).
 *
 * The mount only affects this file: Vitest isolates the module registry per
 * test file, so every other suite imports its own, probe-free `app`. It must
 * happen at module top level, before the first request builds the router.
 *
 * Pinned here:
 * - an unparsable JSON body ⇒ `400 INVALID_JSON`, byte-identical to the
 *   handlers' own answer — which also pins hono's verbatim validator message
 *   across upgrades (a reworded message degrades to `REQUEST_REJECTED`);
 * - a wrong / missing Content-Type ⇒ `415 UNSUPPORTED_MEDIA_TYPE`;
 * - a malformed multipart body ⇒ `400 REQUEST_REJECTED`, parser text dropped;
 * - any other thrown 4xx ⇒ its status + `REQUEST_REJECTED`, the exception's
 *   own message / Response never echoed;
 * - a 5xx `HTTPException` or a plain Error ⇒ logged + `500 INTERNAL_ERROR`;
 * - positive companions: valid bodies reach the handler.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { defaultHook, jsonRes } from "../../src/utils/openapi";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import { USER1 } from "../helpers/ids";

// Distinctive text placed in every thrown message / Response: never echoed.
const SENTINEL = "SENTINEL_9b2d_onerror_reflect";

// Contract copy — `clientErrorFor` (src/utils/errors.ts) and the fallback in
// `app.onError` (src/index.ts). Literals on purpose: they are the API contract.
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
const INTERNAL_ERROR = {
  code: "INTERNAL_ERROR",
  message: "Internal server error",
};
const INVALID_FIELDS = {
  code: "INVALID_FIELDS",
  message: "Request body fields are invalid",
};

// ===== Probe routes, mounted on the production app =====

const probe = new OpenAPIHono({ defaultHook });

probe.openapi(
  createRoute({
    method: "post",
    path: "/json",
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: z.object({ n: z.number() }) },
        },
      },
    },
    responses: { 200: jsonRes("ok") },
  }),
  (c) => c.json({ reached: "json", value: c.req.valid("json") }, 200),
);

probe.openapi(
  createRoute({
    method: "post",
    path: "/form",
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": { schema: z.object({ n: z.string() }) },
        },
      },
    },
    responses: { 200: jsonRes("ok") },
  }),
  (c) => c.json({ reached: "form", value: c.req.valid("form") }, 200),
);

probe.get("/throw/http/:status", (c) => {
  const status = Number(c.req.param("status")) as ContentfulStatusCode;
  // A caller-controlled Response rides along: onError must drop it too.
  throw new HTTPException(status, {
    message: SENTINEL,
    res: new Response(SENTINEL, { status, headers: { "X-Leak": SENTINEL } }),
  });
});

probe.get("/throw/plain", () => {
  throw new Error(SENTINEL);
});

app.route("/api/__probe", probe);

// ===== Helpers =====

const TOKEN = tokenFor(USER1);
let kv: KVNamespace;

beforeEach(async () => {
  kv = createMockKV();
  // `/api/__probe/*` is not a public route: the real auth middleware runs.
  await seedAuthToken(kv, USER1, { token: TOKEN });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function probeRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  return app.request(
    `/api/__probe${path}`,
    { ...init, headers },
    { KV: kv, DEV_MODE: "1" },
  );
}

function post(contentType: string | null, body: BodyInit): RequestInit {
  return {
    method: "POST",
    headers: contentType === null ? {} : { "Content-Type": contentType },
    body,
  };
}

/** Exact envelope: `{ error: { code, message } }` and nothing else. */
async function expectEnvelope(
  res: Response,
  status: number,
  expected: { code: string; message: string },
): Promise<string> {
  expect(res.status).toBe(status);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: expected });
  return text;
}

// ===== Declared JSON body =====

describe("app.onError — declared JSON body", () => {
  it("answers an unparsable body with 400 INVALID_JSON, not logged", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await probeRequest("/json", post("application/json", "{bad"));

    await expectEnvelope(res, 400, INVALID_JSON);
    // Still a normal response through the security-header middleware.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("answers byte-identically to a handler's own INVALID_JSON", async () => {
    // Handler-level parse failure on a real route (public-shelf create).
    const handlerRes = await app.request(
      `/api/user/${USER1}/public-shelf`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: "{bad",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    const probeRes = await probeRequest(
      "/json",
      post("application/json", "{bad"),
    );

    expect(probeRes.status).toBe(handlerRes.status);
    expect(await probeRes.text()).toBe(await handlerRes.text());
  });

  it.each([
    ["text/plain", "text/plain"],
    ["text/plain with a JSON-looking body", "text/plain;charset=UTF-8"],
    ["application/xml", "application/xml"],
  ])(
    "answers a %s body with 415 UNSUPPORTED_MEDIA_TYPE",
    async (_label, contentType) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await probeRequest(
        "/json",
        post(contentType, JSON.stringify({ n: 1 })),
      );

      await expectEnvelope(res, 415, UNSUPPORTED_MEDIA_TYPE);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it("answers a body sent with no Content-Type with 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    // A byte body: unlike a string, it gets no implicit text/plain header.
    const bytes = new TextEncoder().encode(JSON.stringify({ n: 1 }));
    const init = post(null, bytes);

    const res = await probeRequest("/json", init);

    await expectEnvelope(res, 415, UNSUPPORTED_MEDIA_TYPE);
  });

  it("leaves a parsable body with a bad field to defaultHook (INVALID_FIELDS)", async () => {
    const res = await probeRequest(
      "/json",
      post("application/json", JSON.stringify({ n: SENTINEL })),
    );

    const text = await expectEnvelope(res, 400, INVALID_FIELDS);
    expect(text).not.toContain(SENTINEL);
  });

  it.each(["application/json", "application/json; charset=utf-8"])(
    "lets a valid %s body reach the handler",
    async (contentType) => {
      const res = await probeRequest(
        "/json",
        post(contentType, JSON.stringify({ n: 7 })),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reached: "json", value: { n: 7 } });
    },
  );
});

// ===== Declared multipart body =====

describe("app.onError — declared multipart body", () => {
  it("answers a malformed multipart body with 400 REQUEST_REJECTED, parser text dropped", async () => {
    const res = await probeRequest(
      "/form",
      post("multipart/form-data; boundary=probe", `garbage ${SENTINEL}`),
    );

    const text = await expectEnvelope(res, 400, REQUEST_REJECTED);
    // hono appends the parser's own error text to its HTTPException message.
    expect(text).not.toContain("Malformed");
    expect(text).not.toContain("FormData");
    expect(text).not.toContain(SENTINEL);
  });

  it("lets a valid multipart body reach the handler", async () => {
    const form = new FormData();
    form.set("n", "5");

    const res = await probeRequest("/form", { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "form", value: { n: "5" } });
  });
});

// ===== Other thrown errors =====

describe("app.onError — other thrown errors", () => {
  it.each([401, 403, 404, 409, 422])(
    "answers a thrown HTTPException(%i) with its status + REQUEST_REJECTED",
    async (status) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await probeRequest(`/throw/http/${status}`);

      const text = await expectEnvelope(res, status, REQUEST_REJECTED);
      expect(text).not.toContain(SENTINEL);
      expect(res.headers.get("X-Leak")).toBeNull();
      expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it.each([500, 503])(
    "answers a thrown HTTPException(%i) with a logged 500 INTERNAL_ERROR",
    async (status) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await probeRequest(`/throw/http/${status}`);

      const text = await expectEnvelope(res, 500, INTERNAL_ERROR);
      expect(text).not.toContain(SENTINEL);
      expect(res.headers.get("X-Leak")).toBeNull();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0][0]).toBe("Unhandled error:");
      expect(errorLog.mock.calls[0][1]).toBeInstanceOf(HTTPException);
    },
  );

  it("answers a thrown plain Error with a logged 500 INTERNAL_ERROR", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await probeRequest("/throw/plain");

    const text = await expectEnvelope(res, 500, INTERNAL_ERROR);
    expect(text).not.toContain(SENTINEL);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toBe("Unhandled error:");
    expect((errorLog.mock.calls[0][1] as Error).message).toBe(SENTINEL);
  });
});
