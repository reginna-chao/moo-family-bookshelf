import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { describe, it, expect } from "vitest";
import { defaultHook, jsonRes } from "../../src/utils/openapi";
import {
  FamilyIdParam,
  FamilyMemberParams,
  RequestIdParam,
  ShareTokenParam,
  UserIdParam,
  UserShelfParams,
  paramErrorFor,
} from "../../src/schemas/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * `defaultHook` is driven here through a SYNTHETIC OpenAPIHono app whose
 * schemas can fail, one route per validation target, so every branch is
 * reachable in isolation.
 *
 * Through the real routes only the `param` branch is reachable today: since
 * #227 every route declares tagged path-param schemas (`schemas/common.ts`)
 * and the hook answers their registry copy — that end-to-end contract is
 * pinned by `tests/integration/paramValidation.test.ts`. No real route
 * declares a body / query / header schema: request bodies are validated by the
 * handlers BY DESIGN (#239 decided against moving them into the schemas), so
 * the other branches are exercised only here. The last two describe blocks
 * cover the tag lookup: the production param schemas map to their registry
 * copy, and an unregistered tag falls back to INVALID_PARAMS.
 */

// Distinctive value placed in every failing field: it must never come back.
const SENTINEL = "SENTINEL_7f3a9c_reflect";

// Production copy — `validationErrorFor` in src/utils/openapi.ts. Not
// exported; these literals ARE the API contract, keep them in sync.
const INVALID_FIELDS = {
  code: "INVALID_FIELDS",
  message: "Request body fields are invalid",
};
const INVALID_PARAMS = {
  code: "INVALID_PARAMS",
  message: "Path parameters are invalid",
};
const INVALID_QUERY = {
  code: "INVALID_QUERY",
  message: "Query parameters are invalid",
};
const INVALID_REQUEST = {
  code: "INVALID_REQUEST",
  message: "Request is invalid",
};

const DIGITS = /^[0-9]+$/;
const HEX8 = /^[a-f0-9]{8}$/;

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook });

  app.openapi(
    createRoute({
      method: "post",
      path: "/body",
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/param/{id}",
      request: { params: z.object({ id: z.string().regex(HEX8) }) },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "param", value: c.req.valid("param") }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/query",
      request: { query: z.object({ q: z.string().regex(DIGITS) }) },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "query", value: c.req.valid("query") }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/header",
      request: { headers: z.object({ "x-probe": z.string().regex(DIGITS) }) },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "header", value: c.req.valid("header") }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/cookie",
      request: { cookies: z.object({ probe: z.string().regex(DIGITS) }) },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "cookie", value: c.req.valid("cookie") }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/form",
      request: {
        body: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: z.object({ n: z.string().regex(DIGITS) }),
            },
          },
        },
      },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "form", value: c.req.valid("form") }, 200),
  );

  // Two targets on one route: the code follows the part that FAILED, not
  // the route.
  app.openapi(
    createRoute({
      method: "post",
      path: "/mixed/{id}",
      request: {
        params: z.object({ id: z.string().regex(HEX8) }),
        body: {
          required: true,
          content: {
            "application/json": { schema: z.object({ n: z.number() }) },
          },
        },
      },
      responses: { 200: jsonRes("ok") },
    }),
    (c) =>
      c.json(
        {
          reached: "mixed",
          value: { ...c.req.valid("param"), ...c.req.valid("json") },
        },
        200,
      ),
  );

  return app;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const formPost = (n: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ n }).toString(),
});

interface FailureCase {
  name: string;
  path: string;
  init?: RequestInit;
  expected: { code: string; message: string };
}

const failureCases: FailureCase[] = [
  {
    name: "json body with a wrong field type",
    path: "/body",
    init: jsonPost({ n: SENTINEL }),
    expected: INVALID_FIELDS,
  },
  {
    name: "json body missing a required field",
    path: "/body",
    init: jsonPost({ other: SENTINEL }),
    expected: INVALID_FIELDS,
  },
  {
    name: "path param failing its regex",
    path: `/param/${SENTINEL}`,
    expected: INVALID_PARAMS,
  },
  {
    name: "query param failing its regex",
    path: `/query?q=${SENTINEL}`,
    expected: INVALID_QUERY,
  },
  {
    name: "query param missing",
    path: `/query?other=${SENTINEL}`,
    expected: INVALID_QUERY,
  },
  {
    name: "header failing its regex (fallback target)",
    path: "/header",
    init: { headers: { "x-probe": SENTINEL } },
    expected: INVALID_REQUEST,
  },
  {
    name: "cookie failing its regex (fallback target)",
    path: "/cookie",
    init: { headers: { Cookie: `probe=${SENTINEL}` } },
    expected: INVALID_REQUEST,
  },
  {
    name: "form body failing its regex (fallback target)",
    path: "/form",
    init: formPost(SENTINEL),
    expected: INVALID_REQUEST,
  },
  {
    name: "valid param + invalid json body on one route",
    path: "/mixed/abcdef01",
    init: jsonPost({ n: SENTINEL }),
    expected: INVALID_FIELDS,
  },
  {
    name: "invalid param + valid json body on one route",
    path: `/mixed/${SENTINEL}`,
    init: jsonPost({ n: 1 }),
    expected: INVALID_PARAMS,
  },
];

interface SuccessCase {
  name: string;
  path: string;
  init?: RequestInit;
  expected: { reached: string; value: unknown };
}

// Positive companions: the same routes with valid input reach the handler, so
// the failure rows above cannot pass because a route never matched.
const successCases: SuccessCase[] = [
  {
    name: "json body",
    path: "/body",
    init: jsonPost({ n: 42 }),
    expected: { reached: "json", value: { n: 42 } },
  },
  {
    name: "path param",
    path: "/param/abcdef01",
    expected: { reached: "param", value: { id: "abcdef01" } },
  },
  {
    name: "query param",
    path: "/query?q=123",
    expected: { reached: "query", value: { q: "123" } },
  },
  {
    name: "header",
    path: "/header",
    init: { headers: { "x-probe": "7" } },
    expected: { reached: "header", value: { "x-probe": "7" } },
  },
  {
    name: "cookie",
    path: "/cookie",
    init: { headers: { Cookie: "probe=9" } },
    expected: { reached: "cookie", value: { probe: "9" } },
  },
  {
    name: "form body",
    path: "/form",
    init: formPost("5"),
    expected: { reached: "form", value: { n: "5" } },
  },
  {
    name: "param + json body",
    path: "/mixed/abcdef01",
    init: jsonPost({ n: 3 }),
    expected: { reached: "mixed", value: { id: "abcdef01", n: 3 } },
  },
];

describe("defaultHook", () => {
  const app = buildApp();

  it.each(failureCases)(
    "answers $expected.code for a $name",
    async ({ path, init, expected }) => {
      const res = await app.request(path, init);

      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      // Exact envelope: code + message only, no zod issue list.
      expect(json).toEqual({ error: expected });
      expect(Object.keys(json)).toEqual(["error"]);
      expect(Object.keys(json.error).sort()).toEqual(["code", "message"]);
    },
  );

  it("no longer answers a body-field failure with INVALID_JSON", async () => {
    const res = await app.request("/body", jsonPost({ n: "not-a-number" }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).not.toBe("INVALID_JSON");
    expect(json.error.message).not.toBe("Request body must be valid JSON");
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it.each(failureCases)(
    "does not reflect the caller-supplied value for a $name",
    async ({ path, init }) => {
      const res = await app.request(path, init);

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("issues");
    },
  );

  it.each(successCases)(
    "lets valid input reach the handler ($name)",
    async ({ path, init, expected }) => {
      const res = await app.request(path, init);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    },
  );

  // Documents the note in the hook's JSDoc: an unparsable JSON body never
  // reaches `defaultHook`. Hono's validator throws HTTPException(400) before
  // zod runs, so it lands on the app's onError instead of becoming an
  // INVALID_FIELDS envelope. This synthetic app's onError is a stand-in; the
  // PRODUCTION onError maps that throw to 400 INVALID_JSON via `clientErrorFor`
  // (src/utils/errors.ts) — pinned in tests/integration/appOnError.test.ts.
  it("is bypassed by an unparsable JSON body (hono throws HTTPException 400)", async () => {
    const caveatApp = buildApp();
    const thrown: unknown[] = [];
    caveatApp.onError((err, c) => {
      thrown.push(err);
      return c.json({ caught: true }, 500);
    });

    const res = await caveatApp.request("/body", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ caught: true });
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(HTTPException);
    expect((thrown[0] as HTTPException).status).toBe(400);
  });
});

// ===========================================================================
// Tagged path params (#227)
// ===========================================================================

// Contract copy — the registry in src/schemas/common.ts (not exported). These
// are the pre-#227 handler responses; written out, not derived, so a reworded
// registry turns this red instead of passing by construction.
const FAMILY_ID_COPY = {
  code: "INVALID_FAMILY_ID",
  message: "Family ID format is invalid",
};
const USER_ID_COPY = {
  code: "INVALID_USER_ID",
  message: "userId format is invalid",
};
const SHELF_ID_COPY = {
  code: "INVALID_SHELF_ID",
  message: "shelfId format is invalid",
};
const REQUEST_ID_COPY = {
  code: "INVALID_REQUEST_ID",
  message: "Request ID format is invalid",
};
const TOKEN_COPY = {
  code: "INVALID_TOKEN",
  message: "Invalid share token format",
};

const VALID_FAMILY_ID = "abcd-1234";
const VALID_USER_ID = "a".repeat(64);
const VALID_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const VALID_SHARE_TOKEN = "b".repeat(32);

/**
 * Tags that are NOT registered codes. `constructor` / `__proto__` /
 * `toString` / `hasOwnProperty` / `valueOf` live on every object's prototype
 * chain, so a plain `in` or bracket lookup would "find" them; the rest belong
 * to other targets or differ from a registered code only by case / whitespace.
 */
const UNREGISTERED_TAGS = [
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "INVALID_PARAMS",
  "INVALID_FIELDS",
  "INVALID_JSON",
  "invalid_family_id",
  "INVALID_FAMILY_ID ",
  "",
];

function buildTaggedApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook });
  const mount = (path: string, params: z.ZodObject) =>
    app.openapi(
      createRoute({
        method: "get",
        path,
        request: { params },
        responses: { 200: jsonRes("ok") },
      }),
      (c) => c.json({ reached: path }, 200),
    );

  mount("/fam/{id}", FamilyIdParam);
  mount("/user/{id}", UserIdParam);
  mount("/member/{id}/{uid}", FamilyMemberParams);
  mount("/shelf/{id}/{shelfId}", UserShelfParams);
  mount("/req/{requestId}", RequestIdParam);
  mount("/tok/{shareToken}", ShareTokenParam);
  UNREGISTERED_TAGS.forEach((tag, i) =>
    mount(
      `/tag${i}/{id}`,
      z.object({ id: z.string().regex(HEX8, { error: tag }) }),
    ),
  );

  // A production tagged schema used on the QUERY target: the tag must be
  // ignored there — only a `param` failure is looked up in the registry.
  app.openapi(
    createRoute({
      method: "get",
      path: "/query-tagged",
      request: { query: FamilyIdParam },
      responses: { 200: jsonRes("ok") },
    }),
    (c) => c.json({ reached: "query-tagged" }, 200),
  );
  return app;
}

interface TaggedCase {
  name: string;
  path: string;
  expected: { code: string; message: string };
}

const taggedCases: TaggedCase[] = [
  {
    name: "FamilyIdParam",
    path: `/fam/${SENTINEL}`,
    expected: FAMILY_ID_COPY,
  },
  { name: "UserIdParam", path: `/user/${SENTINEL}`, expected: USER_ID_COPY },
  {
    name: "FamilyMemberParams, bad id",
    path: `/member/${SENTINEL}/${VALID_USER_ID}`,
    expected: FAMILY_ID_COPY,
  },
  {
    name: "FamilyMemberParams, bad uid",
    path: `/member/${VALID_FAMILY_ID}/${SENTINEL}`,
    expected: USER_ID_COPY,
  },
  {
    name: "FamilyMemberParams, both bad (id is the first key)",
    path: `/member/${SENTINEL}/${SENTINEL}`,
    expected: FAMILY_ID_COPY,
  },
  {
    name: "UserShelfParams, bad id",
    path: `/shelf/${SENTINEL}/${VALID_UUID}`,
    expected: USER_ID_COPY,
  },
  {
    name: "UserShelfParams, bad shelfId",
    path: `/shelf/${VALID_USER_ID}/${SENTINEL}`,
    expected: SHELF_ID_COPY,
  },
  {
    name: "UserShelfParams, both bad (id is the first key)",
    path: `/shelf/${SENTINEL}/${SENTINEL}`,
    expected: USER_ID_COPY,
  },
  {
    name: "RequestIdParam",
    path: `/req/${SENTINEL}`,
    expected: REQUEST_ID_COPY,
  },
  { name: "ShareTokenParam", path: `/tok/${SENTINEL}`, expected: TOKEN_COPY },
  ...UNREGISTERED_TAGS.map((tag, i) => ({
    name: `a param schema tagged ${JSON.stringify(tag)}`,
    path: `/tag${i}/${SENTINEL}`,
    expected: INVALID_PARAMS,
  })),
  {
    name: "a tagged schema on the query target",
    path: `/query-tagged?id=${SENTINEL}`,
    expected: INVALID_QUERY,
  },
];

describe("defaultHook — tagged path params", () => {
  const app = buildTaggedApp();

  it.each(taggedCases)("$name ⇒ $expected.code", async ({ path, expected }) => {
    const res = await app.request(path);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: expected });
    expect(text).not.toContain(SENTINEL);
  });

  it.each([
    `/fam/${VALID_FAMILY_ID}`,
    `/user/${VALID_USER_ID}`,
    `/member/${VALID_FAMILY_ID}/${VALID_USER_ID}`,
    `/shelf/${VALID_USER_ID}/${VALID_UUID}`,
    `/shelf/${VALID_USER_ID}/${VALID_UUID.toUpperCase()}`,
    `/req/${VALID_UUID}`,
    `/req/${VALID_UUID.toUpperCase()}`,
    `/tok/${VALID_SHARE_TOKEN}`,
    "/tag0/abcdef01",
    `/query-tagged?id=${VALID_FAMILY_ID}`,
  ])("lets %s reach the handler", async (path) => {
    const res = await app.request(path);

    expect(res.status).toBe(200);
  });
});

describe("paramErrorFor", () => {
  it.each([
    ["INVALID_FAMILY_ID", FAMILY_ID_COPY],
    ["INVALID_USER_ID", USER_ID_COPY],
    ["INVALID_SHELF_ID", SHELF_ID_COPY],
    ["INVALID_REQUEST_ID", REQUEST_ID_COPY],
    ["INVALID_TOKEN", TOKEN_COPY],
  ])("maps the registered tag %s to its copy", (tag, expected) => {
    expect(paramErrorFor(tag)).toEqual(expected);
  });

  it.each(UNREGISTERED_TAGS)(
    "returns null for the unregistered tag %j",
    (tag) => {
      expect(paramErrorFor(tag)).toBeNull();
    },
  );
});
