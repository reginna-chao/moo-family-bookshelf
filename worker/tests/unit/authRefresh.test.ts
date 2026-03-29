import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const VALID_USER_ID = "a".repeat(64); // 64-char hex
const OTHER_USER_ID = "c".repeat(64);
const VALID_FAMILY_ID = "abcd-1234";
const VALID_TOKEN = "f".repeat(64); // 64-char hex auth token

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

/** Seed KV with a member mapping, an auth token, and optionally an old auth record. */
async function seedMember(
  userId: string,
  familyId: string,
  token: string,
  oldToken?: string,
) {
  await kv.put(`member:${userId}`, familyId);
  // Set up active auth token
  await kv.put(`token:${token}`, userId);
  await kv.put(
    `auth:${userId}`,
    JSON.stringify({ token: oldToken ?? token, createdAt: "2026-01-01T00:00:00Z" }),
  );
  if (oldToken) {
    await kv.put(`token:${oldToken}`, userId);
  }
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/auth/refresh", () => {
  it("should return a new token for authenticated user", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should require Authorization header (no longer public)", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    // No Authorization header — should fail with 401
    expect(res.status).toBe(401);
  });

  it("should return 403 when callerUserId does not match body.userId", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: OTHER_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should delete old token entry after refresh", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN, oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    const newToken = json.data.token;

    // Old token should be removed from KV
    const oldTokenLookup = await kv.get(`token:${oldToken}`);
    expect(oldTokenLookup).toBeNull();

    // New token should exist in KV
    const newTokenLookup = await kv.get(`token:${newToken}`);
    expect(newTokenLookup).toBe(VALID_USER_ID);

    // auth:{userId} should point to new token
    const authRecord = await kv.get(`auth:${VALID_USER_ID}`, "json") as Json;
    expect(authRecord.token).toBe(newToken);
  });

  it("should return 400 for invalid userId format (too short)", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "abc123", familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid userId format (uppercase hex)", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "A".repeat(64), familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing userId", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing familyId", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for empty familyId", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: "" }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid JSON body", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: "not json",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return generic 401 when userId is not a member of any family", async () => {
    // Seed auth token but no member mapping
    await kv.put(`token:${VALID_TOKEN}`, VALID_USER_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should return generic 401 when userId belongs to a different family", async () => {
    await seedMember(VALID_USER_ID, "wxyz-9876", VALID_TOKEN); // different family

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should work when there is no existing auth token in auth record", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);
    // Remove the auth record but keep the token lookup
    await kv.delete(`auth:${VALID_USER_ID}`);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should return different tokens on consecutive refreshes", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, VALID_TOKEN);

    const res1 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const json1 = (await res1.json()) as Json;
    const token1 = json1.data.token;

    // Use the new token for second refresh
    const res2 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${token1}` },
    });
    const json2 = (await res2.json()) as Json;

    expect(json1.data.token).not.toBe(json2.data.token);
  });
});
