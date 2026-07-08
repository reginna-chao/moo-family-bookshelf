import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const VALID_USER_ID = "a".repeat(64);
const OTHER_USER_ID = "b".repeat(64);
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

async function seedAuthToken(userId: string): Promise<string> {
  const token = userId.slice(0, 32).repeat(2);
  await kv.put(`token:${token}`, userId);
  await kv.put(
    `auth:${userId}`,
    JSON.stringify({ token, createdAt: new Date().toISOString() }),
  );
  return token;
}

async function seedFamily(userId: string, familyId: string) {
  await kv.put(`member:${userId}`, familyId);
  await kv.put(
    `family:${familyId}`,
    JSON.stringify({
      familyId,
      ownerId: userId,
      members: [{ userId, displayName: "Test" }],
      maxMembers: 2,
      createdAt: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/user/:id/qr-token", () => {
  it("should generate a 64-char hex token with expiresIn", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.expiresIn).toBe(300);
  });

  it("should store QR token in KV with correct userId", async () => {
    const authToken = await seedAuthToken(VALID_USER_ID);

    const res = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const json = (await res.json()) as Json;
    const qrToken = json.data.token;
    const stored = JSON.parse((await kv.get(`qr:${qrToken}`)) as string);
    expect(stored.userId).toBe(VALID_USER_ID);
  });

  it("should return 401 without authentication", async () => {
    const res = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });

  it("should return 403 when auth userId does not match param :id", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("POST", `/api/user/${OTHER_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 for invalid userId format", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("POST", "/api/user/!invalid!/qr-token", {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should generate unique tokens on successive calls", async () => {
    const authToken = await seedAuthToken(VALID_USER_ID);

    const res1 = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const json1 = (await res1.json()) as Json;

    const res2 = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const json2 = (await res2.json()) as Json;

    expect(json1.data.token).not.toBe(json2.data.token);
  });
});

describe("Join with QR token bypass", () => {
  it("should bypass verification with valid qrToken", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    // Set up PIN verification for the joining user
    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Generate QR token
    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;

    // Join with qrToken — no verifySecret needed
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        qrToken: qrJson.data.token,
      }),
    });

    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.data.authToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should delete qrToken after one-time use", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Generate QR token
    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;
    const qrToken = qrJson.data.token;

    // First join succeeds
    await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, qrToken }),
    });

    // QR token should be deleted from KV
    const stored = await kv.get(`qr:${qrToken}`);
    expect(stored).toBeNull();
  });

  it("should reject reused qrToken: existing member with PIN set still must verify (SEC-1)", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Generate QR token
    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;
    const qrToken = qrJson.data.token;

    // First use succeeds (new member join via one-time QR bypass, token consumed)
    const firstRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, qrToken }),
    });
    expect(firstRes.status).toBe(200);

    // Second use — token is deleted. Since SEC-1 the verification gate runs
    // BEFORE the existing-member branch, so an existing member with a PIN set
    // and no valid qrToken/verifySecret is now rejected (was 200 pre-SEC-1).
    const secondRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, qrToken }),
    });

    expect(secondRes.status).toBe(403);
    const json = (await secondRes.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should still consume the qrToken on the first (successful) join", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;
    const qrToken = qrJson.data.token;

    await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, qrToken }),
    });

    // One-time token must be gone after the successful bypass.
    const stored = await kv.get(`qr:${qrToken}`);
    expect(stored).toBeNull();
  });

  it("should fall through to verification when qrToken has wrong userId", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    // Generate QR token for OTHER_USER_ID
    const otherAuthToken = await seedAuthToken(OTHER_USER_ID);
    const qrRes = await request("POST", `/api/user/${OTHER_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${otherAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;

    // Set up PIN for the joining user
    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Try to join with the wrong user's QR token
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        qrToken: qrJson.data.token,
      }),
    });

    expect(joinRes.status).toBe(403);
    const json = (await joinRes.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should fall through to verification when qrToken is expired (not in KV)", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Use a fabricated token that doesn't exist in KV (simulates expired)
    const fakeToken = "f".repeat(64);

    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        qrToken: fakeToken,
      }),
    });

    expect(joinRes.status).toBe(403);
    const json = (await joinRes.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should still allow normal verification flow when no qrToken is provided", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Join with correct verifySecret, no qrToken
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        verifySecret: "123456",
      }),
    });

    expect(joinRes.status).toBe(200);
  });

  it("should allow join without verification when method is 'none' and no qrToken", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    // No verification set — method defaults to "none"
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID }),
    });

    expect(joinRes.status).toBe(200);
  });

  it("should bypass verification even with pattern method set", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,5,8" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Generate QR token
    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;

    // Join with qrToken, bypassing pattern verification
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        qrToken: qrJson.data.token,
      }),
    });

    expect(joinRes.status).toBe(200);
  });

  it("should bypass verification even with OTP method set", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const userAuthToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });

    // Generate QR token
    const qrRes = await request("POST", `/api/user/${VALID_USER_ID}/qr-token`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${userAuthToken}` },
    });
    const qrJson = (await qrRes.json()) as Json;

    // Join with qrToken, bypassing OTP verification
    const joinRes = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        qrToken: qrJson.data.token,
      }),
    });

    expect(joinRes.status).toBe(200);
  });
});
