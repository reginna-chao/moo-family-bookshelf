import { describe, it, expect, beforeEach } from "vitest";
import app, { isAllowedOrigin } from "../../src/index";
import {
  isPublicRoute,
  isSensitivePublicRoute,
  sensitiveBucketFor,
} from "../../src/utils/routes";
import { rateLimitBucketFor } from "../../src/middleware/rateLimit";
import { createMockKV } from "../helpers/mockKv";
import {
  USER1,
  USER2,
  USER3,
  USER4,
  USER5,
  OWNER1,
  makeUserId,
} from "../helpers/ids";

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

// Content script 實際執行的書櫃站：read = 舊站，next = 新站。
// 成對釘住，避免日後收緊 subdomain regex 時無聲失效。新增書櫃站時只改這裡。
const BOOKSHELF_ORIGINS = [
  "https://read.readmoo.com",
  "https://next.readmoo.com",
];

describe("isAllowedOrigin", () => {
  const alwaysAllowed = [
    ...BOOKSHELF_ORIGINS,
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
    "https://next.readmoo.com.evil.com",
    "http://next.readmoo.com",
    "https://next.readmoo.com:8080",
    // 多層子網域：釘住 subdomain 字元類 [a-zA-Z0-9-] 不含 "."
    "https://sub.next.readmoo.com",
    // 同字首不同 TLD：釘住 regex 尾端的 $ 錨點
    "https://next.readmoo.com.tw",
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
  // 每個書櫃站都必須拿到自己的 Access-Control-Allow-Origin 回填
  it.each(BOOKSHELF_ORIGINS)(
    "should set Access-Control-Allow-Origin for allowed origin: %s",
    async (origin) => {
      const res = await request("GET", "/", {
        headers: { Origin: origin },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    },
  );

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
    expect(isPublicRoute("POST", "/api/user/abc123/verify/prompted")).toBe(
      false,
    );
    expect(isPublicRoute("POST", "/api/user/abc123/verify/prompted/")).toBe(
      false,
    );
  });

  it("should NOT match PUT /api/user/:id/verify (protected)", () => {
    expect(isPublicRoute("PUT", "/api/user/abc123/verify")).toBe(false);
  });

  it("should NOT match POST /api/user/:id/verify/otp (protected)", () => {
    expect(isPublicRoute("POST", "/api/user/abc123/verify/otp")).toBe(false);
  });

  it("should not match other methods or paths", () => {
    expect(isPublicRoute("GET", "/api/family")).toBe(false);
    expect(isPublicRoute("DELETE", "/api/family/abcd-1234/member/user1")).toBe(
      false,
    );
    expect(isPublicRoute("GET", "/api/family/abcd-1234/members")).toBe(false);
    expect(isPublicRoute("PUT", "/api/user/test/books")).toBe(false);
  });
});

// ===========================================================================
// Sensitive-tier classification + bucket split
//
// Every sensitive route carries the SAME per-minute limit, but `/api/auth/lookup`
// counts in its OWN bucket so that a verified account's onboarding (two lookups —
// the no-secret probe, then the retry carrying the secret — plus one create/join)
// cannot exhaust its own budget. `sensitiveBucketFor` owns the classification and
// `rateLimitBucketFor` turns it into a counter; both are asserted through the
// production exports so a renamed prefix or a moved route breaks here.
// ===========================================================================

const ONBOARDING_BUCKET = "onboarding";
const LOOKUP_BUCKET = "lookup";

describe("sensitiveBucketFor", () => {
  it.each([
    {
      label: "POST /api/family (create)",
      method: "POST",
      path: "/api/family",
      bucket: ONBOARDING_BUCKET,
    },
    {
      label: "POST /api/family/ (trailing slash)",
      method: "POST",
      path: "/api/family/",
      bucket: ONBOARDING_BUCKET,
    },
    {
      label: "POST /api/family/:id/join",
      method: "POST",
      path: "/api/family/abcd-1234/join",
      bucket: ONBOARDING_BUCKET,
    },
    {
      label: "POST /api/family/:id/join/ (trailing slash)",
      method: "POST",
      path: "/api/family/abcd-1234/join/",
      bucket: ONBOARDING_BUCKET,
    },
    {
      label: "POST /api/auth/lookup",
      method: "POST",
      path: "/api/auth/lookup",
      bucket: LOOKUP_BUCKET,
    },
    {
      label: "POST /api/auth/lookup/ (trailing slash)",
      method: "POST",
      path: "/api/auth/lookup/",
      bucket: LOOKUP_BUCKET,
    },
    // Public but NOT sensitive — these keep the looser public tier.
    {
      label: "GET /api/user/:id/verify",
      method: "GET",
      path: "/api/user/abc123/verify",
      bucket: null,
    },
    {
      label: "GET /api/public/:shareToken",
      method: "GET",
      path: "/api/public/sometoken",
      bucket: null,
    },
    // Standard tier / wrong method.
    {
      label: "GET /api/family",
      method: "GET",
      path: "/api/family",
      bucket: null,
    },
    {
      label: "POST /api/auth/refresh",
      method: "POST",
      path: "/api/auth/refresh",
      bucket: null,
    },
    {
      label: "PUT /api/user/:id/books",
      method: "PUT",
      path: "/api/user/test/books",
      bucket: null,
    },
  ])("should classify $label as $bucket", ({ method, path, bucket }) => {
    expect(sensitiveBucketFor(method, path)).toBe(bucket);
  });

  it("should keep lookup and onboarding in different buckets", () => {
    // The whole point of the split: one bucket cannot crowd the other out.
    expect(sensitiveBucketFor("POST", "/api/auth/lookup")).not.toBe(
      sensitiveBucketFor("POST", "/api/family"),
    );
  });
});

describe("isSensitivePublicRoute", () => {
  it("should match POST /api/family (create)", () => {
    expect(isSensitivePublicRoute("POST", "/api/family")).toBe(true);
    expect(isSensitivePublicRoute("POST", "/api/family/")).toBe(true);
  });

  it("should match POST /api/family/:id/join", () => {
    expect(isSensitivePublicRoute("POST", "/api/family/abcd-1234/join")).toBe(
      true,
    );
  });

  it("should match POST /api/auth/lookup (verification-secret oracle)", () => {
    // Lookup is the cheapest oracle of the three — a pure read with no terminal
    // 409 in front of it — so it sits on the sensitive tier, in its own bucket.
    expect(isSensitivePublicRoute("POST", "/api/auth/lookup")).toBe(true);
    expect(isSensitivePublicRoute("POST", "/api/auth/lookup/")).toBe(true);
  });

  it("should NOT match public routes outside the sensitive tier", () => {
    expect(isSensitivePublicRoute("GET", "/api/user/abc123/verify")).toBe(
      false,
    );
    expect(isSensitivePublicRoute("GET", "/api/public/sometoken")).toBe(false);
  });

  it("should NOT match standard routes", () => {
    expect(isSensitivePublicRoute("GET", "/api/user/test/books")).toBe(false);
    expect(isSensitivePublicRoute("PUT", "/api/user/test/books")).toBe(false);
  });

  it("should agree with sensitiveBucketFor on every route it is asked about", () => {
    const routes: [string, string][] = [
      ["POST", "/api/family"],
      ["POST", "/api/family/abcd-1234/join"],
      ["POST", "/api/auth/lookup"],
      ["GET", "/api/user/abc123/verify"],
      ["GET", "/api/public/sometoken"],
      ["PUT", "/api/user/test/books"],
    ];
    for (const [method, path] of routes) {
      expect(isSensitivePublicRoute(method, path)).toBe(
        sensitiveBucketFor(method, path) !== null,
      );
    }
  });
});

describe("rateLimitBucketFor", () => {
  it("should give lookup and onboarding distinct counters at the SAME limit", () => {
    const lookup = rateLimitBucketFor("POST", "/api/auth/lookup");
    const onboarding = rateLimitBucketFor("POST", "/api/family");

    // Splitting the counter must not loosen the tier.
    expect(lookup.limit).toBe(onboarding.limit);
    expect(lookup.prefix).not.toBe(onboarding.prefix);
  });

  it("should give every tier its own counter prefix", () => {
    const prefixes = [
      rateLimitBucketFor("POST", "/api/family").prefix,
      rateLimitBucketFor("POST", "/api/auth/lookup").prefix,
      rateLimitBucketFor("GET", "/api/user/abc123/verify").prefix,
      rateLimitBucketFor("GET", "/api/user/test/books").prefix,
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("should order the tiers sensitive < public < standard", () => {
    const sensitive = rateLimitBucketFor("POST", "/api/family").limit;
    const publicTier = rateLimitBucketFor(
      "GET",
      "/api/user/abc123/verify",
    ).limit;
    const standard = rateLimitBucketFor("GET", "/api/user/test/books").limit;

    expect(sensitive).toBeLessThan(publicTier);
    expect(publicTier).toBeLessThan(standard);
  });

  it("should not let a crafted caller key alias the lookup counter", () => {
    // Full key is `{prefix}:{ip}:{minuteBucket}`. The only way an onboarding
    // caller could reach into the nested lookup namespace is a caller key of
    // exactly "lookup" — and even then the two keys differ in shape.
    const onboarding = rateLimitBucketFor("POST", "/api/family").prefix;
    const lookup = rateLimitBucketFor("POST", "/api/auth/lookup").prefix;

    expect(`${onboarding}:lookup:1`).not.toBe(`${lookup}:1.2.3.4:1`);
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

/**
 * Per-minute allowances, read back from the production classifier so a change to
 * any tier's ceiling reaches these loops instead of leaving them asserting a
 * stale number. The routes below are the same ones the loops exercise.
 */
const SENSITIVE_LIMIT = rateLimitBucketFor("POST", "/api/family").limit;
const LOOKUP_LIMIT = rateLimitBucketFor("POST", "/api/auth/lookup").limit;
const PUBLIC_LIMIT = rateLimitBucketFor(
  "GET",
  `/api/user/${USER3}/verify`,
).limit;
const STANDARD_LIMIT = rateLimitBucketFor("GET", "/api/user/test/books").limit;

/** A public, non-sensitive route: the login-time verification-method probe. */
const PUBLIC_ROUTE = `/api/user/${USER3}/verify`;

describe("Rate limit tiers", () => {
  it("should rate-limit sensitive route POST /api/family after 3 requests", async () => {
    // Send 3 requests — all should succeed
    for (let i = 0; i < SENSITIVE_LIMIT; i++) {
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
    // Create a family first (uses 1 of the onboarding budget)
    const createRes = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: OWNER1 }),
    });
    const family = (await createRes.json()) as Json;
    const familyId = family.data.familyId;

    // Use up the remaining onboarding budget (we already used 1 for create)
    for (let i = 0; i < SENSITIVE_LIMIT - 1; i++) {
      await request("POST", `/api/family/${familyId}/join`, {
        body: JSON.stringify({ userId: makeUserId(100 + i) }),
      });
    }

    // 4th onboarding request should be rate-limited
    const res = await request("POST", `/api/family/${familyId}/join`, {
      body: JSON.stringify({ userId: USER5 }),
    });
    expect(res.status).toBe(429);
  });

  it("should rate-limit sensitive route POST /api/auth/lookup after 3 requests", async () => {
    // Lookup lets an unauthenticated caller test a verifySecret against someone
    // else's account, so it sits on the sensitive tier, not the public one.
    for (let i = 0; i < LOOKUP_LIMIT; i++) {
      const res = await request("POST", "/api/auth/lookup", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
      expect(res.status).not.toBe(429);
    }

    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER4 }),
    });
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
  });

  it("should use separate counters for onboarding, lookup, public, and standard routes", async () => {
    // Exhaust the sensitive ONBOARDING counter (family create / join).
    for (let i = 0; i < SENSITIVE_LIMIT; i++) {
      await request("POST", "/api/family", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
    }
    const onboardingBlocked = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER4 }),
    });
    expect(onboardingBlocked.status).toBe(429);

    // The sensitive LOOKUP counter is a DIFFERENT key at the same limit, so
    // onboarding cannot crowd it out.
    const lookupRes = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER2 }),
    });
    expect(lookupRes.status).not.toBe(429);

    // Public (non-sensitive) tier — its own counter.
    const publicRes = await request("GET", PUBLIC_ROUTE);
    expect(publicRes.status).toBe(200);

    // Standard tier — its own counter.
    const res = await request("GET", "/api/user/test/books");
    expect(res.status).toBe(401); // auth required, not 429
  });

  it("should not let an exhausted lookup counter block family create", async () => {
    for (let i = 0; i < LOOKUP_LIMIT; i++) {
      await request("POST", "/api/auth/lookup", {
        body: JSON.stringify({ userId: makeUserId(i) }),
      });
    }
    const lookupBlocked = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER2 }),
    });
    expect(lookupBlocked.status).toBe(429);

    // The onboarding budget is untouched — this is the direction that matters:
    // a client that probed lookup can still complete the create it was probing for.
    const createRes = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
    });
    expect(createRes.status).toBe(201);
  });

  it("should fit one verified account's onboarding inside the split budgets", async () => {
    // The flow the split exists for: a no-secret lookup probe, the same lookup
    // carrying the secret, then the create — three sensitive requests from one
    // IP inside one minute. On a shared 3/min counter this would leave zero
    // headroom for a mistyped PIN; split, it costs 2 of 3 and 1 of 3.
    for (let i = 0; i < 2; i++) {
      const probe = await request("POST", "/api/auth/lookup", {
        body: JSON.stringify({ userId: USER1 }),
      });
      expect(probe.status).toBe(200);
    }

    const createRes = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER1 }),
    });
    expect(createRes.status).toBe(201);

    // Headroom left in BOTH counters for a retry.
    const retryLookup = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER1 }),
    });
    expect(retryLookup.status).not.toBe(429);
    const retryOnboarding = await request("POST", "/api/family", {
      body: JSON.stringify({ userId: USER2 }),
    });
    expect(retryOnboarding.status).not.toBe(429);
  });

  it("should rate-limit public (non-sensitive) routes after 10 requests", async () => {
    // GET /api/user/:id/verify is public but not sensitive.
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      const res = await request("GET", PUBLIC_ROUTE);
      expect(res.status).not.toBe(429);
    }
    // The next request should be rate-limited
    const res = await request("GET", PUBLIC_ROUTE);
    expect(res.status).toBe(429);
  });

  it("should allow up to 60 requests on standard routes", async () => {
    // Standard routes need auth token — but we can verify the counter
    // by sending requests that fail auth (401) but still pass rate-limit.
    for (let i = 0; i < STANDARD_LIMIT; i++) {
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
    const rateLimitBefore = keysBefore.keys.filter((k: { name: string }) =>
      k.name.startsWith("ratelimit"),
    );
    const countsBefore = new Map<string, string | null>();
    for (const k of rateLimitBefore) {
      countsBefore.set(k.name, await kv.get(k.name));
    }

    // Fire OPTIONS
    await optionsRequest("/api/user/test/books", ALLOWED_ORIGIN);

    // Snapshot after — must be identical
    const keysAfter = await kv.list();
    const rateLimitAfter = keysAfter.keys.filter((k: { name: string }) =>
      k.name.startsWith("ratelimit"),
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
