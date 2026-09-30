/**
 * Path-param format validation, driven through the FULL app (#227).
 *
 * Before #227 every route handler checked its own path params with an
 * `isValid*` helper and answered `400 { code, message }` itself — 35 checks
 * over 28 routes. They now live in the route schemas (`schemas/common.ts`,
 * `taggedParam`), and `defaultHook` (`utils/openapi.ts`) maps the first failing
 * param's tag back to the SAME `{ code, message }`. This suite pins, for every
 * one of those 35 former sites:
 *
 * - the EXACT pre-#227 envelope (status + code + message, nothing else);
 * - that the failing value is never reflected;
 * - that the handler never ran — no KV read beyond the auth middleware's token
 *   read, no KV write, and no per-user rate-limit charge (KV counter OR native
 *   binding), so a malformed request cannot spend the caller's quota;
 * - the check ORDER on the seven two-param routes (the `id` code wins when both
 *   are malformed — zod reports issues in schema key order);
 * - that the global `authMiddleware` still answers 401 before any validator on
 *   a protected route;
 * - positive companions: well-formed params reach the handler.
 *
 * It also pins the issue's own failing check: the dev OpenAPI document now
 * carries a `pattern` for every path param.
 *
 * The expected copy below is written out as literals on purpose, NOT derived
 * from `paramErrorFor`: these pairs are the API contract clients already match
 * on, and a test built from the production registry would pass by construction
 * if the registry were reworded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { kvKeys } from "../../src/kv/schema";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { USER1 } from "../helpers/ids";
import { watchKvOps } from "../helpers/kvOps";
import {
  createRateLimitBindings,
  rateLimitBindings,
} from "../helpers/rateLimitBindings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Contract copy (pre-#227 handler responses — never reword)
// ===========================================================================

interface ErrorCopy {
  code: string;
  message: string;
}

const FAMILY_ID_COPY: ErrorCopy = {
  code: "INVALID_FAMILY_ID",
  message: "Family ID format is invalid",
};
const USER_ID_COPY: ErrorCopy = {
  code: "INVALID_USER_ID",
  message: "userId format is invalid",
};
const SHELF_ID_COPY: ErrorCopy = {
  code: "INVALID_SHELF_ID",
  message: "shelfId format is invalid",
};
const REQUEST_ID_COPY: ErrorCopy = {
  code: "INVALID_REQUEST_ID",
  message: "Request ID format is invalid",
};
const TOKEN_COPY: ErrorCopy = {
  code: "INVALID_TOKEN",
  message: "Invalid share token format",
};

const PARAM_CODES = [
  FAMILY_ID_COPY,
  USER_ID_COPY,
  SHELF_ID_COPY,
  REQUEST_ID_COPY,
  TOKEN_COPY,
].map((copy) => copy.code);

// ===========================================================================
// Param kinds and the route table
// ===========================================================================

/**
 * Distinctive malformed value: fails every param pattern (uppercase letters
 * and `_` fit none of them, not even the case-insensitive request-id one) and
 * must never come back in a response body.
 */
const SENTINEL = "SENTINEL_9c4e_Reflect";

type ParamKind = "family" | "user" | "shelf" | "request" | "token";

interface KindSpec {
  /** A well-formed value that passes the kind's pattern. */
  valid: string;
  copy: ErrorCopy;
}

const KINDS: Record<ParamKind, KindSpec> = {
  family: { valid: "abcd-1234", copy: FAMILY_ID_COPY },
  // The authenticated caller's own id, so owner-scoped routes do not stop at
  // an ownership check that would look like "validation passed" for free.
  user: { valid: USER1, copy: USER_ID_COPY },
  shelf: { valid: "0f8fad5b-d9cb-469f-a165-70867728950e", copy: SHELF_ID_COPY },
  request: {
    valid: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    copy: REQUEST_ID_COPY,
  },
  token: { valid: "c".repeat(32), copy: TOKEN_COPY },
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RouteSpec {
  method: Method;
  /** OpenAPI-style template, identical to the key in the OpenAPI document. */
  template: string;
  /** Path params IN SCHEMA KEY ORDER — the order the old handlers checked. */
  params: ReadonlyArray<{ name: string; kind: ParamKind }>;
  /** False only for the three public routes that carry a path param. */
  auth: boolean;
}

const FAMILY_ID = { name: "id", kind: "family" } as const;
const USER_ID = { name: "id", kind: "user" } as const;
const MEMBER_UID = { name: "uid", kind: "user" } as const;
const SHELF_ID = { name: "shelfId", kind: "shelf" } as const;

/** Every route that validates a path param — 28 routes, 35 former checks. */
const ROUTES: RouteSpec[] = [
  // bookshelf.ts
  {
    method: "GET",
    template: "/api/family/{id}/bookshelf",
    params: [FAMILY_ID],
    auth: true,
  },
  // borrow.ts
  {
    method: "POST",
    template: "/api/family/{id}/borrow",
    params: [FAMILY_ID],
    auth: true,
  },
  {
    method: "GET",
    template: "/api/family/{id}/borrow",
    params: [FAMILY_ID],
    auth: true,
  },
  {
    method: "PATCH",
    template: "/api/borrow/{requestId}",
    params: [{ name: "requestId", kind: "request" }],
    auth: true,
  },
  // family.ts
  {
    method: "POST",
    template: "/api/family/{id}/join",
    params: [FAMILY_ID],
    auth: false,
  },
  {
    method: "DELETE",
    template: "/api/family/{id}/member/{uid}",
    params: [FAMILY_ID, MEMBER_UID],
    auth: true,
  },
  {
    method: "DELETE",
    template: "/api/family/{id}/kicked/{uid}",
    params: [FAMILY_ID, MEMBER_UID],
    auth: true,
  },
  {
    method: "GET",
    template: "/api/family/{id}/members",
    params: [FAMILY_ID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/family/{id}/member/{uid}/displayName",
    params: [FAMILY_ID, MEMBER_UID],
    auth: true,
  },
  {
    method: "PATCH",
    template: "/api/family/{id}/member/{uid}",
    params: [FAMILY_ID, MEMBER_UID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/family/{id}/transfer",
    params: [FAMILY_ID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/family/{id}/endpoint",
    params: [FAMILY_ID],
    auth: true,
  },
  // publicShelf.ts
  {
    method: "GET",
    template: "/api/user/{id}/public-shelf",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "POST",
    template: "/api/user/{id}/public-shelf",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/user/{id}/public-shelf/{shelfId}",
    params: [USER_ID, SHELF_ID],
    auth: true,
  },
  {
    method: "POST",
    template: "/api/user/{id}/public-shelf/{shelfId}/reset-token",
    params: [USER_ID, SHELF_ID],
    auth: true,
  },
  {
    method: "DELETE",
    template: "/api/user/{id}/public-shelf/{shelfId}",
    params: [USER_ID, SHELF_ID],
    auth: true,
  },
  {
    method: "GET",
    template: "/api/public/{shareToken}",
    params: [{ name: "shareToken", kind: "token" }],
    auth: false,
  },
  // user.ts
  {
    method: "GET",
    template: "/api/user/{id}/books",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/user/{id}/books",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "PATCH",
    template: "/api/user/{id}/books",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "PUT",
    template: "/api/user/{id}/family-prefs",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "DELETE",
    template: "/api/user/{id}",
    params: [USER_ID],
    auth: true,
  },
  // verify.ts
  {
    method: "GET",
    template: "/api/user/{id}/verify",
    params: [USER_ID],
    auth: false,
  },
  {
    method: "PUT",
    template: "/api/user/{id}/verify",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "POST",
    template: "/api/user/{id}/verify/otp",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "POST",
    template: "/api/user/{id}/verify/prompted",
    params: [USER_ID],
    auth: true,
  },
  {
    method: "POST",
    template: "/api/user/{id}/qr-token",
    params: [USER_ID],
    auth: true,
  },
];

/** Fill a template; `overrides` replaces the named params' valid values. */
function fillPath(
  route: RouteSpec,
  overrides: Record<string, string> = {},
): string {
  let path = route.template;
  for (const { name, kind } of route.params) {
    path = path.replace(`{${name}}`, overrides[name] ?? KINDS[kind].valid);
  }
  return path;
}

interface MalformedRow {
  label: string;
  route: RouteSpec;
  path: string;
  expected: ErrorCopy;
}

/**
 * One row per former handler check: exactly ONE param malformed, the others
 * well-formed, so each row isolates the code of the param it names.
 */
const MALFORMED_ROWS: MalformedRow[] = ROUTES.flatMap((route) =>
  route.params.map(({ name, kind }) => ({
    label: `${route.method} ${route.template} (bad {${name}})`,
    route,
    path: fillPath(route, { [name]: SENTINEL }),
    expected: KINDS[kind].copy,
  })),
);

const MULTI_PARAM_ROUTES = ROUTES.filter((route) => route.params.length > 1);
const PROTECTED_ROWS = MALFORMED_ROWS.filter((row) => row.route.auth);
const PUBLIC_ROWS = MALFORMED_ROWS.filter((row) => !row.route.auth);

// ===========================================================================
// Request plumbing
// ===========================================================================

let ipCounter = 0;

interface Sent {
  res: Response;
  kv: KVNamespace;
  token: string;
  ops: ReturnType<typeof watchKvOps>;
  bindingCalls: ReturnType<typeof createRateLimitBindings>["calls"];
}

/**
 * Send one request against a fresh production-shaped env (no DEV_MODE, all
 * four Rate Limiting bindings stubbed and recorded), with USER1's token seeded
 * and the KV watcher installed AFTER seeding. `withToken: false` omits the
 * Authorization header entirely.
 */
async function send(
  method: Method,
  path: string,
  opts: { withToken: boolean; body?: string } = { withToken: true },
): Promise<Sent> {
  const kv = createMockKV();
  const token = await seedAuthToken(kv, USER1);
  const { bindings, calls } = createRateLimitBindings();
  const ops = watchKvOps(kv);

  ipCounter += 1;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": `10.227.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
  };
  if (opts.withToken) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "DELETE") init.body = opts.body ?? "{}";

  const res = await app.request(path, init, { KV: kv, ...bindings });
  return { res, kv, token, ops, bindingCalls: calls };
}

/** Per-user counter writes/charges — KV fallback keys AND binding keys. */
function perUserCharges(sent: Sent): string[] {
  const kvWrites = sent.ops
    .putKeys()
    .filter((key) => key.startsWith("ratelimit:user:"));
  const bindingKeys = sent.bindingCalls
    .map((call) => call.key)
    .filter((key) => key.startsWith("ratelimit:user:"));
  return [...kvWrites, ...bindingKeys];
}

// ===========================================================================
// Tests
// ===========================================================================

describe("path-param validation — route table", () => {
  it("covers all 35 former handler checks across 28 routes", () => {
    expect(ROUTES).toHaveLength(28);
    expect(MALFORMED_ROWS).toHaveLength(35);
    const byCode = (code: string) =>
      MALFORMED_ROWS.filter((row) => row.expected.code === code).length;
    expect(byCode("INVALID_FAMILY_ID")).toBe(11);
    expect(byCode("INVALID_USER_ID")).toBe(19);
    expect(byCode("INVALID_SHELF_ID")).toBe(3);
    expect(byCode("INVALID_REQUEST_ID")).toBe(1);
    expect(byCode("INVALID_TOKEN")).toBe(1);
  });
});

describe("malformed path param ⇒ the exact pre-#227 400", () => {
  it.each(MALFORMED_ROWS)(
    "$label ⇒ 400 $expected.code",
    async ({ route, path, expected }) => {
      const { res } = await send(route.method, path, {
        withToken: route.auth,
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      const json = JSON.parse(text) as Json;
      // Whole envelope: code + message only — no zod issue list, no extras.
      expect(json).toEqual({ error: expected });
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("issues");
    },
  );

  it.each(MALFORMED_ROWS)(
    "$label never reaches the handler and charges no per-user limit",
    async ({ route, path }) => {
      const sent = await send(route.method, path, { withToken: route.auth });

      expect(sent.res.status).toBe(400);
      // The only KV touch is the auth middleware resolving the token (none on
      // a public route); nothing is written anywhere.
      expect(sent.ops.getKeys()).toEqual(
        route.auth ? [kvKeys.authToken(sent.token)] : [],
      );
      expect(sent.ops.writeTrail()).toEqual([]);
      expect(perUserCharges(sent)).toEqual([]);
      // The per-IP tier still counted the request: the recorder is live.
      expect(sent.bindingCalls).toHaveLength(1);
    },
  );
});

describe("several malformed params ⇒ the FIRST schema key decides", () => {
  it.each(MULTI_PARAM_ROUTES)(
    "$method $template with every param malformed answers the {id} code",
    async (route) => {
      const allBad = Object.fromEntries(
        route.params.map(({ name }) => [name, SENTINEL]),
      );
      const { res } = await send(route.method, fillPath(route, allBad));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: KINDS[route.params[0].kind].copy,
      });
    },
  );

  it("covers both two-param shapes: family-member {id, uid} and user-shelf {id, shelfId}", () => {
    const shapes = MULTI_PARAM_ROUTES.map((route) =>
      route.params.map((p) => `${p.name}:${p.kind}`).join(","),
    );
    expect(new Set(shapes)).toEqual(
      new Set(["id:family,uid:user", "id:user,shelfId:shelf"]),
    );
  });
});

describe("auth middleware runs before param validation", () => {
  it.each(PROTECTED_ROWS)(
    "$label without a token ⇒ 401, not the param 400",
    async ({ route, path }) => {
      const { res } = await send(route.method, path, { withToken: false });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          code: "UNAUTHORIZED",
          message: "Authorization header required",
        },
      });
    },
  );

  it("leaves exactly the three public param routes unauthenticated", () => {
    expect(PUBLIC_ROWS.map((row) => row.label)).toEqual([
      "POST /api/family/{id}/join (bad {id})",
      "GET /api/public/{shareToken} (bad {shareToken})",
      "GET /api/user/{id}/verify (bad {id})",
    ]);
  });
});

describe("well-formed params reach the handler", () => {
  it.each(ROUTES)(
    "$method $template with valid params is not answered by the validator",
    async (route) => {
      const { res } = await send(route.method, fillPath(route), {
        withToken: route.auth,
      });

      const text = await res.text();
      const json = (text ? JSON.parse(text) : {}) as Json;
      // Whatever the handler decides (404, 403, body 400 …), it is not one of
      // the param codes — so the validator let the request through.
      expect(PARAM_CODES).not.toContain(json?.error?.code);
    },
  );

  it("GET /api/public/{shareToken} with a well-formed unknown token ⇒ 404 from the handler", async () => {
    const { res, ops } = await send("GET", `/api/public/${"c".repeat(32)}`, {
      withToken: false,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: "PUBLIC_SHELF_NOT_FOUND",
        message: "Public shelf not found or expired",
      },
    });
    expect(ops.getKeys()).toEqual([kvKeys.publicShelf("c".repeat(32))]);
  });

  it("PATCH /api/borrow/{requestId} accepts an UPPERCASE request id (case-insensitive pattern)", async () => {
    const upper = KINDS.request.valid.toUpperCase();
    const { res, ops } = await send("PATCH", `/api/borrow/${upper}`, {
      withToken: true,
      body: JSON.stringify({ status: 1 }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "REQUEST_NOT_FOUND", message: "Borrow request not found" },
    });
    // The handler looked the id up verbatim — it really got past validation.
    expect(ops.getKeys()).toContain(`borrow:${upper}`);
  });

  it("PUT /api/user/{id}/public-shelf/{shelfId} accepts an UPPERCASE shelf id", async () => {
    const upper = KINDS.shelf.valid.toUpperCase();
    const { res } = await send(
      "PUT",
      `/api/user/${USER1}/public-shelf/${upper}`,
    );

    const json = (await res.json()) as Json;
    expect(PARAM_CODES).not.toContain(json?.error?.code);
  });
});

describe("the per-user charge detector is live (positive companions)", () => {
  it("a valid hourly-scope request writes a ratelimit:user: KV counter", async () => {
    const sent = await send("POST", `/api/user/${USER1}/verify/prompted`);

    expect(sent.res.status).toBe(200);
    expect(perUserCharges(sent)).toEqual([
      expect.stringMatching(/^ratelimit:user:verify-write:/),
    ]);
  });

  it("a valid per-minute-scope request charges a ratelimit:user: binding key", async () => {
    const sent = await send(
      "GET",
      `/api/family/${KINDS.family.valid}/bookshelf`,
    );

    expect(perUserCharges(sent)).toEqual([`ratelimit:user:bookshelf:${USER1}`]);
  });
});

interface MatrixCase {
  kind: ParamKind;
  value: string;
  why: string;
}

/** Near-miss values per kind, driven through one representative route each. */
const MATRIX: MatrixCase[] = [
  { kind: "family", value: "ABCD-1234", why: "uppercase" },
  { kind: "family", value: "abcd1234", why: "no dash" },
  { kind: "family", value: "abc-12345", why: "dash misplaced" },
  { kind: "family", value: "abcd-12345", why: "too long" },
  { kind: "family", value: "abcd_1234", why: "underscore separator" },
  { kind: "user", value: "a".repeat(63), why: "63 hex chars" },
  { kind: "user", value: "a".repeat(65), why: "65 hex chars" },
  { kind: "user", value: "A".repeat(64), why: "uppercase hex" },
  { kind: "user", value: "g".repeat(64), why: "non-hex char" },
  {
    kind: "shelf",
    value: "0f8fad5b-d9cb-169f-a165-70867728950e",
    why: "UUID version 1",
  },
  {
    kind: "shelf",
    value: "0f8fad5b-d9cb-469f-c165-70867728950e",
    why: "wrong variant nibble",
  },
  {
    kind: "shelf",
    value: "0f8fad5bd9cb469fa16570867728950e",
    why: "no dashes",
  },
  {
    kind: "request",
    value: "7c9e6679-7425-50de-944b-e07fc1f90ae7",
    why: "UUID version 5",
  },
  { kind: "request", value: "not-a-uuid", why: "not a UUID" },
  { kind: "token", value: "c".repeat(31), why: "31 hex chars" },
  { kind: "token", value: "c".repeat(64), why: "64 hex chars" },
  { kind: "token", value: "C".repeat(32), why: "uppercase hex" },
];

/** The table entry for `"{METHOD} {template}"` — throws on a typo. */
function routeOf(key: string): RouteSpec {
  const route = ROUTES.find((r) => `${r.method} ${r.template}` === key);
  if (!route) throw new Error(`no route ${key} in the table`);
  return route;
}

const MATRIX_ROUTE: Record<ParamKind, { route: RouteSpec; param: string }> = {
  family: { route: routeOf("GET /api/family/{id}/members"), param: "id" },
  user: { route: routeOf("GET /api/user/{id}/books"), param: "id" },
  shelf: {
    route: routeOf("PUT /api/user/{id}/public-shelf/{shelfId}"),
    param: "shelfId",
  },
  request: {
    route: routeOf("PATCH /api/borrow/{requestId}"),
    param: "requestId",
  },
  token: {
    route: routeOf("GET /api/public/{shareToken}"),
    param: "shareToken",
  },
};

describe("near-miss values are rejected per param kind", () => {
  it.each(MATRIX)("$kind: $why ($value) ⇒ 400", async ({ kind, value }) => {
    const { route, param } = MATRIX_ROUTE[kind];
    const { res } = await send(
      route.method,
      fillPath(route, { [param]: value }),
      { withToken: route.auth },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: KINDS[kind].copy });
  });
});

// ===========================================================================
// OpenAPI document (#227's own failing check)
// ===========================================================================

async function fetchOpenApiDoc(): Promise<Json> {
  const res = await app.request(
    "/api/_openapi.json",
    { method: "GET" },
    { KV: createMockKV(), DEV_MODE: "1", ...rateLimitBindings() },
  );
  expect(res.status).toBe(200);
  return res.json();
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

describe("OpenAPI document describes every path-param format", () => {
  it("lists exactly the routes in this suite's table as the param-carrying operations", async () => {
    const doc = await fetchOpenApiDoc();
    const documented: string[] = [];
    for (const [path, item] of Object.entries<Json>(doc.paths)) {
      if (!path.includes("{")) continue;
      for (const method of HTTP_METHODS) {
        if (item[method]) documented.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(documented.sort()).toEqual(
      ROUTES.map((route) => `${route.method} ${route.template}`).sort(),
    );
  });

  it("gives the family {id} param a pattern (the issue's reproduction)", async () => {
    const doc = await fetchOpenApiDoc();
    const params = doc.paths["/api/family/{id}/members"].get
      .parameters as Json[];
    const id = params.find((p) => p.in === "path" && p.name === "id");

    expect(typeof id?.schema?.pattern).toBe("string");
    expect(id.required).toBe(true);
  });

  it.each(ROUTES)(
    "$method $template: every path param has a pattern matching its kind",
    async (route) => {
      const doc = await fetchOpenApiDoc();
      const op = doc.paths[route.template]?.[route.method.toLowerCase()];
      expect(op).toBeDefined();
      const pathParams = (op.parameters as Json[]).filter(
        (p) => p.in === "path",
      );

      expect(pathParams.map((p) => p.name).sort()).toEqual(
        route.params.map((p) => p.name).sort(),
      );
      for (const { name, kind } of route.params) {
        const param = pathParams.find((p) => p.name === name);
        const pattern: unknown = param?.schema?.pattern;
        expect(typeof pattern).toBe("string");
        // An OpenAPI `pattern` is a bare ECMA-262 source with no flags.
        // zod-to-openapi serializes a zod regex via `RegExp#toString()` and
        // strips only the slashes, so a FLAGGED RegExp leaks into the document
        // as `…$/i` — a pattern no value can ever match.
        expect(pattern).not.toMatch(/\/[dgimsuvy]*$/);
        // Behavioural check of the documented pattern rather than a pinned
        // literal: it must accept the kind's valid sample and reject the
        // sentinel.
        const re = new RegExp(pattern as string);
        expect(re.test(KINDS[kind].valid)).toBe(true);
        expect(re.test(SENTINEL)).toBe(false);
      }
    },
  );
});
