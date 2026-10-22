import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";

/**
 * `GET /api/version` is a token-less server probe (issue #356).
 *
 * `authMiddleware` is mounted on every `/api/*` route, so the version route only
 * answers an unauthenticated caller because `isPublicRoute` lists it. Before the
 * fix it answered 401. Only GET is public: any other method on the same path
 * still goes through the auth gate. Requests run against a production-shaped env
 * (no DEV_MODE, the four Rate Limiting bindings a deployed Worker carries).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
});

function prodEnv() {
  return { KV: kv, ...rateLimitBindings() };
}

describe("GET /api/version", () => {
  it("answers 200 with the version payload without an Authorization header", async () => {
    const res = await app.request("/api/version", { method: "GET" }, prodEnv());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(typeof json.data.apiVersion).toBe("number");
    expect(typeof json.data.serverVersion).toBe("string");
  });
});

describe("POST /api/version", () => {
  it("stays protected and answers 401 UNAUTHORIZED without a token", async () => {
    const res = await app.request(
      "/api/version",
      { method: "POST" },
      prodEnv(),
    );
    expect(res.status).toBe(401);

    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });
});
