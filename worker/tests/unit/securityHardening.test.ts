import { describe, it, expect, beforeEach } from "vitest";
import app, { isAllowedOrigin } from "../../src/index";
import { isPublicRoute, isSensitivePublicRoute } from "../../src/utils/routes";
import { createMockKV } from "../helpers/mockKv";
import { USER1, USER2, USER4, USER5, OWNER1, makeUserId } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  opts?: {
    body?: string;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts?.headers,
  };
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = opts.body;
  return app.request(path, init, { KV: kv });
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// B1: CORS Origin Validation
// ===========================================================================

describe("isAllowedOrigin", () => {
  const alwaysAllowed = [
    "https://read.readmoo.com",
    "https://readmoo.com",
    "https://store.readmoo.com",
    "https://moo-family-bookshelf.pages.dev",
    "https://abc123.moo-family-bookshelf.pages.dev",
    "https://moo-family-bookshelf-dev.pages.dev",
    "https://abc123.moo-family-bookshelf-dev.pages.dev",
    "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef",
  ];

  const disallowed = [
    "https://evil.com",
    "https://readmoo.com.evil.com",
    "https://notreadmoo.com",
    "http://readmoo.com",
    "https://read.readmoo.com:8080",
    "http://localhost:abc",
    "https://localhost:3000",
    "chrome-extension://",
    "",
    "null",
  ];

  it.each(alwaysAllowed)("should allow origin: %s", (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each(disallowed)("should deny origin: %s", (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it("should deny localhost in production (devMode=false)", () => {
    expect(isAllowedOrigin("http://localhost")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(false);
  });

  it("should allow localhost in dev mode (devMode=true)", () => {
    expect(isAllowedOrigin("http://localhost", true)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", true)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", true)).toBe(true);
  });

  it("should deny private IPs when devMode is false", () => {
    expect(isAllowedOrigin("http://192.168.1.100:5173")).toBe(false);
    expect(isAllowedOrigin("http://10.0.0.1:8787")).toBe(false);
    expect(isAllowedOrigin("http://172.16.0.1:3000")).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.100:5173", false)).toBe(false);
  });

  it("should allow 192.168.x.x (Class C) in dev mode", () => {
    expect(isAllowedOrigin("http://192.168.1.100:5173", true)).toBe(true);
    expect(isAllowedOrigin("http://192.168.0.1:8787", true)).toBe(true);
    expect(isAllowedOrigin("http://192.168.255.255", true)).toBe(true);
    expect(isAllowedOrigin("https://192.168.1.100:5173", true)).toBe(true);
  });

  it("should allow 10.x.x.x (Class A) in dev mode", () => {
    expect(isAllowedOrigin("http://10.0.0.1:5173", true)).toBe(true);
    expect(isAllowedOrigin("http://10.255.255.255:8787", true)).toBe(true);
    expect(isAllowedOrigin("http://10.1.2.3", true)).toBe(true);
    expect(isAllowedOrigin("https://10.0.0.1:3000", true)).toBe(true);
  });

  it("should allow 172.16.x.x–172.31.x.x (Class B) in dev mode", () => {
    expect(isAllowedOrigin("http://172.16.0.1:5173", true)).toBe(true);
    expect(isAllowedOrigin("http://172.31.255.255:8787", true)).toBe(true);
    expect(isAllowedOrigin("http://172.20.10.5", true)).toBe(true);
    expect(isAllowedOrigin("https://172.24.0.1:3000", true)).toBe(true);
  });

  it("should deny 172.x.x.x outside 16–31 range even in dev mode", () => {
    expect(isAllowedOrigin("http://172.15.0.1:5173", true)).toBe(false);
    expect(isAllowedOrigin("http://172.32.0.1:5173", true)).toBe(false);
  });

  it("should allow private IPs without port in dev mode", () => {
    expect(isAllowedOrigin("http://192.168.1.1", true)).toBe(true);
    expect(isAllowedOrigin("http://10.0.0.1", true)).toBe(true);
    expect(isAllowedOrigin("http://172.16.0.1", true)).toBe(true);
  });

  it("should allow https private IPs in dev mode (self-signed certs)", () => {
    expect(isAllowedOrigin("https://192.168.1.100:5173", true)).toBe(true);
    expect(isAllowedOrigin("https://10.0.0.1:8787", true)).toBe(true);
    expect(isAllowedOrigin("https://172.16.0.1:3000", true)).toBe(true);
  });
});

describe("CORS headers on responses", () => {
  it("should set Access-Control-Allow-Origin for allowed origins", async () => {
    const res = await request("GET", "/", {
      headers: { Origin: "https://read.readmoo.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://read.readmoo.com",
    );
  });

  it("should not set Access-Control-Allow-Origin for disallowed origins", async () => {
    const res = await request("GET", "/", {
      headers: { Origin: "https://evil.com" },
    });
    const corsHeader = res.headers.get("Access-Control-Allow-Origin");
    // Hono cors() sets empty string when origin callback returns ""
    expect(corsHeader === null || corsHeader === "").toBe(true);
  });
});

// ===========================================================================
// Shared isPublicRoute utility
// ===========================================================================

describe("isPublicRoute", () => {
  it("should match POST /api/family", () => {
    expect(isPublicRoute("POST", "/api/family")).toBe(true);
    expect(isPublicRoute("POST", "/api/family/")).toBe(true);
  });

  it("should match POST /api/family/:id/join", () => {
    expect(isPublicRoute("POST", "/api/family/abcd-1234/join")).toBe(true);
    expect(isPublicRoute("POST", "/api/family/abcd-1234/join/")).toBe(true);
  });

  it("should match POST /api/auth/lookup", () => {
    expect(isPublicRoute("POST", "/api/auth/lookup")).toBe(true);
    expect(isPublicRoute("POST", "/api/auth/lookup/")).toBe(true);
  });

  it("should NOT match POST /api/auth/refresh (now protected)", () => {
    expect(isPublicRoute("POST", "/api/auth/refresh")).toBe(false);
    expect(isPublicRoute("POST", "/api/auth/refresh/")).toBe(false);
  });

  it("should match GET /api/user/:id/verify (public, needed before login)", () => {
    expect(isPublicRoute("GET", "/api/user/abc123/verify")).toBe(true);
    expect(isPublicRoute("GET", "/api/user/abc123/verify/")).toBe(true);
  });

  it("should NOT match POST /api/user/:id/verify/prompted (now protected)", () => {
    expect(isPublicRoute("POST", "/api/user/abc123/verify/prompted")).toBe(false);
    expect(isPublicRoute("POST", "/api/user/abc123/verify/prompted/")).toBe(false);
  });

  it("should NOT match PUT /api/user/:id/verify (protected)", () => {
    expect(isPublicRoute("PUT", "/api/user/abc123/verify")).toBe(false);
  });

  it("should NOT match POST /api/user/:id/verify/otp (protected)", () => {
    expect(isPublicRoute("POST", "/api/user/abc123/verify/otp")).toBe(false);
  });

  it("should not match other methods or paths", () => {
    expect(isPublicRoute("GET", "/api/family")).toBe(false);
    expect(isPublicRoute("DELETE", "/api/family/abcd-1234/member/user1")).toBe(false);
    expect(isPublicRoute("GET", "/api/family/abcd-1234/members")).toBe(false);
    expect(isPublicRoute("PUT", "/api/user/test/books")).toBe(false);
  });
});

describe("isSensitivePublicRoute", () => {
  it("should match POST /api/family (create)", () => {
    expect(isSensitivePublicRoute("POST", "/api/family")).toBe(true);
    expect(isSensitivePublicRoute("POST", "/api/family/")).toBe(true);
  });

  it("should match POST /api/family/:id/join", () => {
    expect(isSensitivePublicRoute("POST", "/api/family/abcd-1234/join")).toBe(true);
  });

  it("should NOT match other public routes", () => {
    expect(isSensitivePublicRoute("POST", "/api/auth/lookup")).toBe(false);
    expect(isSensitivePublicRoute("GET", "/api/user/abc123/verify")).toBe(false);
  });

  it("should NOT match standard routes", () => {
    expect(isSensitivePublicRoute("GET", "/api/user/test/books")).toBe(false);
    expect(isSensitivePublicRoute("PUT", "/api/user/test/books")).toBe(false);
  });
});

// ===========================================================================
// B2: Request Body Size Limit
// ===========================================================================

describe("Request body size limit", () => {
  it("should return 413 when Content-Length exceeds 256KB", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
      headers: { "Content-Length": "300000" },
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(json.error.message).toBe("Request body exceeds 256KB limit");
  });

  it("should allow requests within the 256KB limit", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
      headers: { "Content-Length": "100" },
    });
    // Should pass through to the route handler (201 = family created)
    expect(res.status).toBe(201);
  });

  it("should allow requests without Content-Length header", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
    });
    // Should pass through
    expect(res.status).toBe(201);
  });

  it("should return 413 for Content-Length exactly at boundary (262145)", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
      headers: { "Content-Length": "262145" },
    });
    expect(res.status).toBe(413);
  });

  it("should allow Content-Length exactly at 262144 (256KB)", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
      headers: { "Content-Length": "262144" },
    });
    // Should pass to handler, not be rejected by size check
    expect(res.status).not.toBe(413);
  });

  it("should reject oversized body even without Content-Length header", async () => {
    const largeBody = "x".repeat(262145);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Explicitly omit Content-Length by using raw Request
    const req = new Request("http://localhost/api/family", {
      method: "POST",
      body: largeBody,
      headers,
    });
    // Remove Content-Length if the runtime auto-sets it
    req.headers.delete("Content-Length");
    const res = await app.request(req, undefined, { KV: kv });
    expect(res.status).toBe(413);
  });
});

// ===========================================================================
// B3: Rate Limit Tiers
// ===========================================================================

describe("Rate limit tiers", () => {
  it("should rate-limit sensitive route POST /api/family after 3 requests", async () => {
    // Send 3 requests — all should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request("POST", "/api/family", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
      expect(res.status).not.toBe(429);
    }
    // 4th request should be rate-limited
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER4 }),
    });
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");

    // 429 body carries a sane retryAfter back-off hint (seconds) within the
    // 60s bucket, consistent with the Retry-After header value.
    const retryAfterHeader = res.headers.get("Retry-After");
    expect(retryAfterHeader).toBeTruthy();
    expect(typeof json.error.retryAfter).toBe("number");
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(1);
    expect(json.error.retryAfter).toBeLessThanOrEqual(60);
    expect(json.error.retryAfter).toBe(parseInt(retryAfterHeader!, 10));
  });

  it("should rate-limit sensitive route POST /api/family/:id/join after 3 requests", async () => {
    // Create a family first (uses 1 of the sensitive budget)
    const createRes = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: OWNER1 }),
    });
    const family = (await createRes.json()) as Json;
    const familyId = family.data.familyId;

    // Use up remaining sensitive budget (we already used 1 for create)
    for (let i = 0; i < 2; i++) {
      await request("POST", `/api/family/${familyId}/join`, {
        body: JSON.stringify({ userId: makeUserId(100 + i) }),
      });
    }

    // 4th sensitive request should be rate-limited
    const res = await request("POST", `/api/family/${familyId}/join`, {
      body: JSON.stringify({ userId: USER5 }),
    });
    expect(res.status).toBe(429);
  });

  it("should use separate counters for sensitive, public, and standard routes", async () => {
    // Exhaust sensitive limit (3 requests)
    for (let i = 0; i < 3; i++) {
      await request("POST", "/api/family", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
    }

    // Public (non-sensitive) route should still work (separate counter)
    const lookupRes = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER2 }),
    });
    expect(lookupRes.status).not.toBe(429);

    // Standard route should still work (separate counter)
    const res = await request("GET", "/api/user/test/books");
    expect(res.status).toBe(401); // auth required, not 429
  });

  it("should rate-limit public (non-sensitive) routes after 10 requests", async () => {
    // POST /api/auth/lookup is public but not sensitive
    for (let i = 0; i < 10; i++) {
      const res = await request("POST", "/api/auth/lookup", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
      expect(res.status).not.toBe(429);
    }
    // 11th request should be rate-limited
    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER4 }),
    });
    expect(res.status).toBe(429);
  });

  it("should allow up to 60 requests on standard routes", async () => {
    // Standard routes need auth token — but we can verify the counter
    // by sending requests that fail auth (401) but still pass rate-limit.
    for (let i = 0; i < 60; i++) {
      const res = await request("GET", "/api/user/test/books");
      expect(res.status).toBe(401); // not 429
    }

    // 61st request should be rate-limited
    const res = await request("GET", "/api/user/test/books");
    expect(res.status).toBe(429);
  });
});

// ===========================================================================
// B4: Security Headers
// ===========================================================================

describe("Security headers", () => {
  it("should set security headers on health check response", async () => {
    const res = await request("GET", "/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
  });

  it("should set security headers on API error responses", async () => {
    const res = await request("GET", "/api/user/test/books");
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
  });

  it("should set security headers on 404 responses", async () => {
    const res = await request("GET", "/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("should set security headers on API success responses", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
  });
});

// ===========================================================================
// OPTIONS preflight short-circuit (regression guard)
// ===========================================================================

describe("OPTIONS preflight short-circuit", () => {
  const ALLOWED_ORIGIN = "https://readmoo.com";
  const DISALLOWED_ORIGIN = "https://evil.example.com";

  function optionsRequest(path: string, origin: string) {
    return request("OPTIONS", path, {
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });
  }

  it("should return 204 with full CORS headers for allowed origins", async () => {
    const res = await optionsRequest("/api/user/test/books", ALLOWED_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");

    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("content-type");
    expect(allowHeaders.toLowerCase()).toContain("authorization");

    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("should NOT trigger rate limit KV writes", async () => {
    // Fire a GET first to create a known rate limit counter
    await request("GET", "/api/user/test/books");
    const keysBefore = await kv.list();
    const rateLimitBefore = keysBefore.keys.filter(
      (k: { name: string }) => k.name.startsWith("ratelimit"),
    );
    const countsBefore = new Map<string, string | null>();
    for (const k of rateLimitBefore) {
      countsBefore.set(k.name, await kv.get(k.name));
    }

    // Fire OPTIONS
    await optionsRequest("/api/user/test/books", ALLOWED_ORIGIN);

    // Snapshot after — must be identical
    const keysAfter = await kv.list();
    const rateLimitAfter = keysAfter.keys.filter(
      (k: { name: string }) => k.name.startsWith("ratelimit"),
    );
    expect(rateLimitAfter.length).toBe(rateLimitBefore.length);
    for (const k of rateLimitAfter) {
      expect(await kv.get(k.name)).toBe(countsBefore.get(k.name));
    }
  });

  it("should not require Authorization header (auth middleware skipped)", async () => {
    // No Authorization header — should still get 204 (not 401)
    const res = await optionsRequest("/api/user/test/books", ALLOWED_ORIGIN);
    expect(res.status).toBe(204);
  });

  it("should not set Access-Control-Allow-Origin for disallowed origins", async () => {
    const res = await optionsRequest("/api/user/test/books", DISALLOWED_ORIGIN);
    const corsHeader = res.headers.get("Access-Control-Allow-Origin");
    expect(corsHeader === null || corsHeader === "").toBe(true);
  });
});
