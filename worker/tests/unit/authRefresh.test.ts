import { describe, it, expect, beforeEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { TOKEN_TTL_SECONDS } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const VALID_USER_ID = "a".repeat(64); // 64-char hex
const VALID_FAMILY_ID = "abcd-1234";

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
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Seed KV with a member mapping and optionally an old auth record. */
async function seedMember(userId: string, familyId: string, oldToken?: string) {
  await kv.put(`member:${userId}`, familyId);
  if (oldToken) {
    await seedAuthToken(kv, userId, {
      token: oldToken,
      createdAt: "2026-01-01T00:00:00Z",
    });
  }
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/auth/refresh", () => {
  it("should return 401 without Authorization header (now protected)", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return a new token with valid Authorization header", async () => {
    const oldToken = "f".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.expiresAt).toBeTypeOf("number");
    expect(json.data.expiresAt).toBeGreaterThan(Date.now());
  });

  it("should reuse existing valid token on refresh", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    // Should return the same token (not generate a new one)
    expect(json.data.token).toBe(oldToken);

    // Old token should still exist in KV
    const tokenLookup = await kv.get(`token:${oldToken}`);
    expect(tokenLookup).toBe(VALID_USER_ID);

    // auth:{userId} should still point to old token
    const authRecord = (await kv.get(`auth:${VALID_USER_ID}`, "json")) as Json;
    expect(authRecord.token).toBe(oldToken);
  });

  it("should renew the 90d KV TTL on both auth entries when reusing an existing token", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);
    // Spy after seeding so only the refresh's re-puts are captured.
    const putSpy = vi.spyOn(kv, "put");

    const before = Date.now();
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    // Same token reused (no churn), but expiresAt reflects a fresh 90d window.
    expect(json.data.token).toBe(oldToken);
    expect(json.data.expiresAt).toBeGreaterThanOrEqual(
      before + TOKEN_TTL_SECONDS * 1000,
    );
    expect(json.data.expiresAt).toBeLessThanOrEqual(
      Date.now() + TOKEN_TTL_SECONDS * 1000,
    );

    // Both KV directions were re-put carrying the shared 90d TTL.
    const authPut = putSpy.mock.calls.find(
      ([k]) => k === `auth:${VALID_USER_ID}`,
    );
    const tokenPut = putSpy.mock.calls.find(([k]) => k === `token:${oldToken}`);
    expect(authPut?.[2]).toMatchObject({ expirationTtl: TOKEN_TTL_SECONDS });
    expect(tokenPut?.[2]).toMatchObject({ expirationTtl: TOKEN_TTL_SECONDS });

    putSpy.mockRestore();
  });

  it("should return 401 when token belongs to different user than body.userId", async () => {
    const otherUserId = "c".repeat(64);
    const token = "d".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);
    await seedMember(otherUserId, VALID_FAMILY_ID, token);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should return 400 for invalid userId format (too short)", async () => {
    const token = "e".repeat(64);
    await kv.put(`token:${token}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "abc123", familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid userId format (uppercase hex)", async () => {
    const token = "e".repeat(64);
    await kv.put(`token:${token}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: "A".repeat(64),
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing userId", async () => {
    const token = "e".repeat(64);
    await kv.put(`token:${token}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should succeed without familyId (v1.2.0: familyId is optional)", async () => {
    const token = "e".repeat(64);
    await seedAuthToken(kv, VALID_USER_ID, {
      token,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should return 400 for empty familyId", async () => {
    const token = "e".repeat(64);
    await kv.put(`token:${token}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: "" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid JSON body", async () => {
    const token = "e".repeat(64);
    await kv.put(`token:${token}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: "not json",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 401 when userId belongs to a different family", async () => {
    const token = "f".repeat(64);
    await seedMember(VALID_USER_ID, "wxyz-9876", token);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should generate new token when no existing auth record", async () => {
    const token = "f".repeat(64);
    // Deliberate asymmetric seed: token:{token} authenticates the request, but
    // auth:{userId} is absent, so getOrGenerateAuthToken must mint a fresh token.
    await kv.put(`token:${token}`, VALID_USER_ID);
    await kv.put(`member:${VALID_USER_ID}`, VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.token).not.toBe(token);
    expect(json.data.expiresAt).toBeTypeOf("number");

    // The mint must persist both directions, or the new token would not
    // authenticate the next request.
    const authRecord = (await kv.get(`auth:${VALID_USER_ID}`, "json")) as Json;
    expect(authRecord.token).toBe(json.data.token);
    expect(await kv.get(`token:${json.data.token}`)).toBe(VALID_USER_ID);
  });

  it("should return same token on consecutive refreshes with same auth", async () => {
    const token = "f".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, token);

    const res1 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });
    const json1 = (await res1.json()) as Json;

    // Use the returned token for the second request
    const res2 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${json1.data.token}` },
    });
    const json2 = (await res2.json()) as Json;

    expect(json1.data.token).toBe(json2.data.token);
  });
});
