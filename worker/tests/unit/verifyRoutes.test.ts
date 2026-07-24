import { describe, it, expect, beforeEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import type { VerifyRecord } from "../../src/kv/schema";

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

describe("GET /api/user/:id/verify", () => {
  it("should return 'none' when no verify record exists", async () => {
    const res = await request("GET", `/api/user/${VALID_USER_ID}/verify`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("none");
    expect(json.data.prompted).toBe(0);
  });

  it("should return stored method", async () => {
    const record: VerifyRecord = {
      method: "pin",
      hash: "somehash",
      salt: "somesalt",
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("GET", `/api/user/${VALID_USER_ID}/verify`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("pin");
    expect(json.data.prompted).toBe(1);
  });

  it("should not expose hash or salt", async () => {
    const record: VerifyRecord = {
      method: "pin",
      hash: "secret-hash",
      salt: "secret-salt",
      prompted: 0,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("GET", `/api/user/${VALID_USER_ID}/verify`);
    const json = (await res.json()) as Json;
    expect(json.data.hash).toBeUndefined();
    expect(json.data.salt).toBeUndefined();
  });

  it("should return 400 for invalid userId", async () => {
    const res = await request("GET", "/api/user/!invalid!/verify");
    expect(res.status).toBe(400);
  });

  it("should be accessible without auth (public route)", async () => {
    // No Authorization header — should still work
    const res = await request("GET", `/api/user/${VALID_USER_ID}/verify`);
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/user/:id/verify", () => {
  it("should set PIN verification", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("pin");

    // Verify KV record has hash and salt
    const record = JSON.parse(
      (await kv.get(`verify:${VALID_USER_ID}`)) as string,
    ) as VerifyRecord;
    expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.salt).toMatch(/^[a-f0-9]{32}$/);
  });

  it("should set pattern verification", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,5,8" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("pattern");
  });

  it("should set code verification (no secret needed)", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("code");
  });

  it("should set to none (disable verification)", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "none" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("none");
  });

  it("should reject invalid PIN (too short)", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "12345" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_SECRET");
  });

  it("should reject invalid PIN (non-numeric)", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "abcdef" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with fewer than 4 nodes", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with duplicate nodes", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,1,2" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with invalid node index", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,9" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject invalid method", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "fingerprint" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_METHOD");
  });

  it("should return 401 without auth", async () => {
    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "none" }),
    });
    expect(res.status).toBe(401);
  });

  it("should return 401 when trying to set another user's verification", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${OTHER_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
  });

  it("should preserve prompted flag when not explicitly set", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    // First set prompted
    const existing: VerifyRecord = {
      method: "none",
      hash: null,
      salt: null,
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(existing));

    // Update method without setting prompted
    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "567890" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.prompted).toBe(1);
  });

  it("should set prompted flag when explicitly provided", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "none", prompted: 1 }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.prompted).toBe(1);
  });

  it("should reset failCount and lockedUntil when changing method", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const existing: VerifyRecord = {
      method: "pin",
      hash: "old",
      salt: "old",
      prompted: 1,
      failCount: 4,
      lockedUntil: Date.now() + 60000,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(existing));

    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "999999" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    const record = JSON.parse(
      (await kv.get(`verify:${VALID_USER_ID}`)) as string,
    ) as VerifyRecord;
    expect(record.failCount).toBe(0);
    expect(record.lockedUntil).toBeNull();
  });
});

describe("POST /api/user/:id/verify/otp", () => {
  it("should generate a 6-digit OTP code", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    // Set method to 'code'
    const record: VerifyRecord = {
      method: "code",
      hash: null,
      salt: null,
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("POST", `/api/user/${VALID_USER_ID}/verify/otp`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.code).toMatch(/^\d{6}$/);
    expect(json.data.expiresAt).toBeTypeOf("number");
    expect(json.data.expiresAt).toBeGreaterThan(Date.now());
  });

  it("should return 400 if method is not 'code'", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const record: VerifyRecord = {
      method: "pin",
      hash: "h",
      salt: "s",
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("POST", `/api/user/${VALID_USER_ID}/verify/otp`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should return 401 without auth", async () => {
    const res = await request("POST", `/api/user/${VALID_USER_ID}/verify/otp`, {
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("should store OTP in KV", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const record: VerifyRecord = {
      method: "code",
      hash: null,
      salt: null,
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("POST", `/api/user/${VALID_USER_ID}/verify/otp`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    const json = (await res.json()) as Json;
    const otpRecord = JSON.parse(
      (await kv.get(`otp:${VALID_USER_ID}`)) as string,
    );
    expect(otpRecord.code).toBe(json.data.code);
  });
});

describe("POST /api/user/:id/verify/prompted", () => {
  it("should mark user as prompted with valid auth", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const res = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/prompted`,
      {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.prompted).toBe(1);
    expect(json.data.method).toBe("none");
  });

  it("should preserve existing method when marking prompted", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    const record: VerifyRecord = {
      method: "pin",
      hash: "h",
      salt: "s",
      prompted: 0,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/prompted`,
      {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("pin");
    expect(json.data.prompted).toBe(1);
  });

  it("should return 401 without auth (now protected)", async () => {
    const res = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/prompted`,
      {
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("Verification in join flow", () => {
  it("should allow join without verification when method is 'none'", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID }),
    });

    expect(res.status).toBe(200);
  });

  it("should block join when PIN is set but no verifySecret provided", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    // Set PIN verification
    const record: VerifyRecord = {
      method: "pin",
      hash: "placeholder",
      salt: "placeholder",
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should allow join with correct PIN", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    // First set up PIN via the API
    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "123456" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.authToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should reject join with wrong PIN", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "999999" }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");
  });

  it("should allow join with correct pattern", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,5,8" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        verifySecret: "0,1,2,5,8",
      }),
    });

    expect(res.status).toBe(200);
  });

  it("should allow join with correct OTP", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);

    // Set method to code
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // Generate OTP
    const otpRes = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/otp`,
      {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    const otpJson = (await otpRes.json()) as Json;

    // Join with OTP
    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        verifySecret: otpJson.data.code,
      }),
    });

    expect(res.status).toBe(200);
  });

  it("should delete OTP after successful use", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);

    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const otpRes = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/otp`,
      {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    const otpJson = (await otpRes.json()) as Json;

    // First join succeeds
    await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        verifySecret: otpJson.data.code,
      }),
    });

    // OTP should be deleted from KV
    const otpRecord = await kv.get(`otp:${VALID_USER_ID}`);
    expect(otpRecord).toBeNull();
  });

  it("should lock out after 5 failed attempts", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
        body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "000000" }),
      });
    }

    // 6th attempt should be locked
    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "123456" }),
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
  });

  it("should reset fail count on successful verification", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // 3 failed attempts
    for (let i = 0; i < 3; i++) {
      await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
        body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "000000" }),
      });
    }

    // Successful attempt
    await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "123456" }),
    });

    // Verify fail count was reset
    const record = JSON.parse(
      (await kv.get(`verify:${VALID_USER_ID}`)) as string,
    ) as VerifyRecord;
    expect(record.failCount).toBe(0);
  });

  it("should unlock after lockout period expires", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // Set lockout in the past
    const record = JSON.parse(
      (await kv.get(`verify:${VALID_USER_ID}`)) as string,
    ) as VerifyRecord;
    record.lockedUntil = Date.now() - 1000; // expired
    await kv.put(`verify:${VALID_USER_ID}`, JSON.stringify(record));

    const res = await request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
      body: JSON.stringify({ userId: VALID_USER_ID, verifySecret: "123456" }),
    });

    expect(res.status).toBe(200);
  });
});
