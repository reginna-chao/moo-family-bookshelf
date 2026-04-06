import { describe, it, expect, beforeEach } from "vitest";
import app, { isAllowedOrigin } from "../../src/index";
import { isPublicRoute } from "../../src/utils/routes";
import { createMockKV } from "../helpers/mockKv";

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

  it("should match POST /api/auth/refresh (public, uses membership as auth)", () => {
    expect(isPublicRoute("POST", "/api/auth/refresh")).toBe(true);
    expect(isPublicRoute("POST", "/api/auth/refresh/")).toBe(true);
  });

  it("should not match other methods or paths", () => {
    expect(isPublicRoute("GET", "/api/family")).toBe(false);
    expect(isPublicRoute("DELETE", "/api/family/abcd-1234/member/user1")).toBe(false);
    expect(isPublicRoute("GET", "/api/family/abcd-1234/members")).toBe(false);
    expect(isPublicRoute("PUT", "/api/user/test/books")).toBe(false);
  });
});

// ===========================================================================
// B2: Request Body Size Limit
// ===========================================================================

describe("Request body size limit", () => {
  it("should return 413 when Content-Length exceeds 256KB", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user1" }),
      headers: { "Content-Length": "300000" },
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(json.error.message).toBe("Request body exceeds 256KB limit");
  });

  it("should allow requests within the 256KB limit", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user1" }),
      headers: { "Content-Length": "100" },
    });
    // Should pass through to the route handler (201 = family created)
    expect(res.status).toBe(201);
  });

  it("should allow requests without Content-Length header", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user1" }),
    });
    // Should pass through
    expect(res.status).toBe(201);
  });

  it("should return 413 for Content-Length exactly at boundary (262145)", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user1" }),
      headers: { "Content-Length": "262145" },
    });
    expect(res.status).toBe(413);
  });

  it("should allow Content-Length exactly at 262144 (256KB)", async () => {
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user1" }),
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
  it("should rate-limit public route POST /api/family after 10 requests", async () => {
    // Send 10 requests — all should succeed
    for (let i = 0; i < 10; i++) {
      const res = await request("POST", "/api/family", {
        body: JSON.stringify({ userId: `user${i}` }),
      });
      expect(res.status).not.toBe(429);
    }
    // 11th request should be rate-limited
    const res = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "user_extra" }),
    });
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
  });

  it("should rate-limit public route POST /api/family/:id/join after 10 requests", async () => {
    // Create a family first
    const createRes = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: "owner" }),
    });
    const family = (await createRes.json()) as Json;
    const familyId = family.data.familyId;

    // Use up remaining public route budget (we already used 1 for create)
    for (let i = 0; i < 9; i++) {
      await request("POST", `/api/family/${familyId}/join`, {
        body: JSON.stringify({ userId: `joiner${i}` }),
      });
    }

    // 11th public request should be rate-limited
    const res = await request("POST", `/api/family/${familyId}/join`, {
      body: JSON.stringify({ userId: "joiner_extra" }),
    });
    expect(res.status).toBe(429);
  });

  it("should use separate counters for public and standard routes", async () => {
    // Exhaust public limit (10 requests)
    for (let i = 0; i < 10; i++) {
      await request("POST", "/api/family", {
        body: JSON.stringify({ userId: `user${i}` }),
      });
    }

    // Standard route should still work (uses a different counter)
    // GET /api/user/:id/books is a protected route — needs auth, but will
    // get 401, not 429. This proves the standard counter isn't exhausted.
    const res = await request("GET", "/api/user/test/books");
    expect(res.status).toBe(401); // auth required, not 429
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
      body: JSON.stringify({ userId: "user1" }),
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
