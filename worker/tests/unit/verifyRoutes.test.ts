import { describe, it, expect, beforeEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import {
  kvKeys,
  VERIFY_MAX_FAILURES,
  VERIFY_FAIL_TTL_SECONDS,
  VERIFY_LOCKOUT_MS,
  type VerifyRecord,
  type VerifyFailRecord,
} from "../../src/kv/schema";
import {
  normalizeCallerIp,
  UNKNOWN_CALLER_KEY,
} from "../../src/middleware/rateLimit";

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
  await kv.put(kvKeys.authToken(token), userId);
  await kv.put(
    kvKeys.auth(userId),
    JSON.stringify({ token, createdAt: new Date().toISOString() }),
  );
  return token;
}

/**
 * Seed a family whose members are `userIds` (first entry is the owner), plus the
 * `member:{userId}` reverse-lookup keys so each listed user counts as an
 * EXISTING member of that family on the join path.
 */
async function seedFamilyWithMembers(userIds: string[], familyId: string) {
  await Promise.all(userIds.map((uid) => kv.put(kvKeys.member(uid), familyId)));
  await kv.put(
    kvKeys.family(familyId),
    JSON.stringify({
      familyId,
      ownerId: userIds[0],
      members: userIds.map((userId) => ({ userId, displayName: "Test" })),
      maxMembers: 2,
      createdAt: new Date().toISOString(),
    }),
  );
}

function seedFamily(userId: string, familyId: string) {
  return seedFamilyWithMembers([userId], familyId);
}

/** Set a PIN for `userId` through the real verify route (hash + salt included). */
async function setPin(userId: string, pin: string) {
  const token = await seedAuthToken(userId);
  const res = await request("PUT", `/api/user/${userId}/verify`, {
    body: JSON.stringify({ method: "pin", secret: pin }),
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
}

/**
 * Join the target family as `userId`. `callerIp` is sent as `cf-connecting-ip`,
 * the only header the Worker trusts as caller identity (see `getCallerIp` in
 * `worker/src/middleware/rateLimit.ts`); omit it to simulate a request with no
 * client IP available.
 */
function joinFamily(userId: string, verifySecret?: string, callerIp?: string) {
  const body: { userId: string; verifySecret?: string } = { userId };
  if (verifySecret !== undefined) body.verifySecret = verifySecret;
  const headers = callerIp ? { "cf-connecting-ip": callerIp } : undefined;
  return request("POST", `/api/family/${VALID_FAMILY_ID}/join`, {
    body: JSON.stringify(body),
    headers,
  });
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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

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
      (await kv.get(kvKeys.verify(VALID_USER_ID))) as string,
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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(existing));

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

  it("should store only account fields, never failure accounting", async () => {
    const token = await seedAuthToken(VALID_USER_ID);

    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "999999" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    // Failure counters live in `verifyfail:{userId}:{callerKey}`, never on the
    // account record — a counter on the account would be a DoS lever.
    const record = JSON.parse(
      (await kv.get(kvKeys.verify(VALID_USER_ID))) as string,
    ) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "hash",
      "method",
      "prompted",
      "salt",
    ]);
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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

    const res = await request("POST", `/api/user/${VALID_USER_ID}/verify/otp`, {
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    });

    const json = (await res.json()) as Json;
    const otpRecord = JSON.parse(
      (await kv.get(kvKeys.otp(VALID_USER_ID))) as string,
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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

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

    const res = await joinFamily(VALID_USER_ID);

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
    };
    await kv.put(kvKeys.verify(VALID_USER_ID), JSON.stringify(record));

    const res = await joinFamily(VALID_USER_ID);

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should allow join with correct PIN", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
    await setPin(VALID_USER_ID, "123456");

    const res = await joinFamily(VALID_USER_ID, "123456");

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.authToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should reject join with wrong PIN", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
    await setPin(VALID_USER_ID, "123456");

    const res = await joinFamily(VALID_USER_ID, "999999");

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

    const res = await joinFamily(VALID_USER_ID, "0,1,2,5,8");

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
    const res = await joinFamily(VALID_USER_ID, otpJson.data.code);

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
    await joinFamily(VALID_USER_ID, otpJson.data.code);

    // OTP should be deleted from KV
    const otpRecord = await kv.get(kvKeys.otp(VALID_USER_ID));
    expect(otpRecord).toBeNull();
  });
});

// ===========================================================================
// Verification failure accounting — caller-scoped (DoS regression suite)
//
// Failures are charged to `verifyfail:{userId}:{callerKey}` where callerKey is
// the Cloudflare-supplied client IP, NEVER to `verify:{userId}`. Rationale: the
// join endpoint is public, the submitted userId is derived from the user's email
// with a fixed salt, and the victim's own familyId is retrievable with no
// credentials from the public `POST /api/auth/lookup`. Any counter keyed on the
// victim's identity — including one gated on "is an existing member" — would let
// a stranger lock the victim out of PWA login on demand.
// ===========================================================================

const ATTACKER_IP = "203.0.113.10";
const VICTIM_IP = "198.51.100.20";
const CORRECT_PIN = "123456";
const WRONG_PIN = "000000";

async function readFailRecord(
  userId: string,
  callerKey: string,
): Promise<VerifyFailRecord | null> {
  const raw = await kv.get(kvKeys.verifyFail(userId, callerKey));
  return raw ? (JSON.parse(raw) as VerifyFailRecord) : null;
}

/** Victim has a PIN and is ALREADY a member of the family being targeted. */
async function seedVictimInsideTargetFamily() {
  await seedFamilyWithMembers([OTHER_USER_ID, VALID_USER_ID], VALID_FAMILY_ID);
  await setPin(VALID_USER_ID, CORRECT_PIN);
}

/** Victim has a PIN and belongs to no family; the target family is someone else's. */
async function seedVictimOutsideTargetFamily() {
  await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
  await setPin(VALID_USER_ID, CORRECT_PIN);
}

/** Submit `count` wrong secrets from `callerIp`, asserting each is rejected 403. */
async function submitWrongSecrets(count: number, callerIp?: string) {
  for (let i = 0; i < count; i++) {
    const res = await joinFamily(VALID_USER_ID, WRONG_PIN, callerIp);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");
  }
}

describe("Verification failure accounting in join flow (caller-scoped)", () => {
  // The core DoS regression. Membership is deliberately parameterised: the
  // attacker can always aim at the victim's OWN familyId (public lookup), so
  // "existing member" is not a trust signal and must not change the outcome.
  it.each([
    {
      label: "an existing member of the target family",
      seed: seedVictimInsideTargetFamily,
    },
    {
      label: "not a member of the target family",
      seed: seedVictimOutsideTargetFamily,
    },
  ])(
    "should not lock the victim out when an attacker floods wrong secrets and the victim is $label",
    async ({ seed }) => {
      await seed();
      const accountRecordBefore = await kv.get(kvKeys.verify(VALID_USER_ID));

      await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);

      // The account record was not written at all — byte-identical, not merely
      // field-equal.
      expect(await kv.get(kvKeys.verify(VALID_USER_ID))).toBe(
        accountRecordBefore,
      );

      // The decisive assertion: the victim, from their own IP, still logs in
      // with the correct PIN. A 429 here is the DoS.
      const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, VICTIM_IP);
      expect(res.status).toBe(200);

      // The attacker only locked THEMSELVES out.
      const attackerRecord = await readFailRecord(VALID_USER_ID, ATTACKER_IP);
      expect(attackerRecord?.lockedUntil).toBeGreaterThan(Date.now());
      expect(await readFailRecord(VALID_USER_ID, VICTIM_IP)).toBeNull();
    },
  );

  it("should count failures per caller under verifyfail:{userId}:{callerKey}", async () => {
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(2, ATTACKER_IP);

    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toEqual({
      failCount: 2,
      lockedUntil: null,
    });
  });

  it("should charge failures to the fallback caller bucket when no client IP is present", async () => {
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(2);

    expect(await readFailRecord(VALID_USER_ID, UNKNOWN_CALLER_KEY)).toEqual({
      failCount: 2,
      lockedUntil: null,
    });
  });

  it("should lock out the caller after the max failures from the same IP", async () => {
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);

    const failRecord = await readFailRecord(VALID_USER_ID, ATTACKER_IP);
    expect(failRecord?.lockedUntil).toBeGreaterThan(Date.now());
    expect(failRecord?.failCount).toBe(0);

    // Even the CORRECT PIN is refused while that caller is locked out.
    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
  });

  it("should not apply one caller's lockout to a different caller", async () => {
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);
    const lockedRes = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);
    expect(lockedRes.status).toBe(429);

    // A different caller with the correct PIN is unaffected.
    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, VICTIM_IP);
    expect(res.status).toBe(200);
  });

  it("should delete the caller's failure record after a successful verification", async () => {
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(3, VICTIM_IP);
    expect((await readFailRecord(VALID_USER_ID, VICTIM_IP))?.failCount).toBe(3);

    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, VICTIM_IP);
    expect(res.status).toBe(200);
    expect(await readFailRecord(VALID_USER_ID, VICTIM_IP)).toBeNull();
  });

  it("should allow a join once the caller's lockout has expired", async () => {
    await seedVictimInsideTargetFamily();
    const expired: VerifyFailRecord = {
      failCount: 0,
      lockedUntil: Date.now() - 1000,
    };
    await kv.put(
      kvKeys.verifyFail(VALID_USER_ID, VICTIM_IP),
      JSON.stringify(expired),
    );

    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, VICTIM_IP);

    expect(res.status).toBe(200);
    expect(await readFailRecord(VALID_USER_ID, VICTIM_IP)).toBeNull();
  });

  it("should not charge a failure when no secret is submitted at all", async () => {
    await seedVictimInsideTargetFamily();

    const res = await joinFamily(VALID_USER_ID, undefined, ATTACKER_IP);

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toBeNull();
  });

  it("should write the caller's failure record with a self-expiring TTL", async () => {
    await seedVictimInsideTargetFamily();
    const failKey = kvKeys.verifyFail(VALID_USER_ID, ATTACKER_IP);

    await submitWrongSecrets(1, ATTACKER_IP);
    expect(getPutTtl(kv, failKey)).toBe(VERIFY_FAIL_TTL_SECONDS);

    // The lockout write must expire on its own too — a TTL-less `verifyfail:*`
    // entry would keep both the counter and the lock alive in KV forever.
    await submitWrongSecrets(VERIFY_MAX_FAILURES - 1, ATTACKER_IP);
    expect(
      (await readFailRecord(VALID_USER_ID, ATTACKER_IP))?.lockedUntil,
    ).toBeGreaterThan(Date.now());
    expect(getPutTtl(kv, failKey)).toBe(VERIFY_FAIL_TTL_SECONDS);
  });

  it("should not extend a caller's own lockout while they keep hammering", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await seedVictimInsideTargetFamily();
      await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);

      const failKey = kvKeys.verifyFail(VALID_USER_ID, ATTACKER_IP);
      const lockedRaw = await kv.get(failKey);
      const lockedUntil = (JSON.parse(lockedRaw as string) as VerifyFailRecord)
        .lockedUntil;
      expect(lockedUntil).toBe(Date.now() + VERIFY_LOCKOUT_MS);

      // Keep hammering well into the lockout window, wrong secret and right one.
      vi.setSystemTime(Date.now() + 60_000);
      for (let i = 0; i < 3; i++) {
        const res = await joinFamily(VALID_USER_ID, WRONG_PIN, ATTACKER_IP);
        expect(res.status).toBe(429);
      }
      const withCorrectPin = await joinFamily(
        VALID_USER_ID,
        CORRECT_PIN,
        ATTACKER_IP,
      );
      expect(withCorrectPin.status).toBe(429);

      // Byte-identical: the record was never rewritten, so the lock cannot slide
      // forward on every attempt into an indefinite self-inflicted ban.
      expect(await kv.get(failKey)).toBe(lockedRaw);

      // It therefore ends exactly on schedule.
      vi.setSystemTime(lockedUntil! + 1);
      const afterExpiry = await joinFamily(
        VALID_USER_ID,
        CORRECT_PIN,
        ATTACKER_IP,
      );
      expect(afterExpiry.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// IPv6 caller bucketing (rotation regression suite)
//
// A residential IPv6 subscriber gets at least a /64 and privacy extensions let
// the client pick a new interface identifier per request. Keying failure
// accounting on the full address would therefore hand an attacker an unlimited
// number of 5-attempt budgets. `getCallerIp` buckets IPv6 callers on their /64.
// ===========================================================================

const ATTACKER_SUBNET = "2001:db8:1:2";
/** One fresh interface identifier per allowed failure, all inside one /64. */
const ROTATING_IIDS = Array.from(
  { length: VERIFY_MAX_FAILURES },
  (_, i) => `${ATTACKER_SUBNET}::${(10 + i).toString(16)}`,
);
/** A previously unseen identifier in the SAME /64. */
const NEXT_IID_SAME_SUBNET = `${ATTACKER_SUBNET}::ff`;
/** A caller in a neighbouring /64 — a genuinely different subscriber. */
const OTHER_SUBNET_IP = "2001:db8:1:3::a";

/** Every `verifyfail:` key currently stored for `userId`. */
async function listFailKeys(userId: string): Promise<string[]> {
  const { keys } = await kv.list();
  return keys
    .map((k) => k.name)
    .filter((name) => name.startsWith(kvKeys.verifyFail(userId, "")));
}

describe("Verification failure accounting across IPv6 caller rotation", () => {
  it("should accumulate rotating identifiers in one /64 into a single failure bucket", async () => {
    await seedVictimInsideTargetFamily();

    for (const ip of ROTATING_IIDS) {
      const res = await joinFamily(VALID_USER_ID, WRONG_PIN, ip);
      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_FAILED");
    }

    // One shared bucket, not one per identifier — and it is now locked.
    expect(await listFailKeys(VALID_USER_ID)).toEqual([
      kvKeys.verifyFail(VALID_USER_ID, normalizeCallerIp(ROTATING_IIDS[0])),
    ]);

    // The decisive assertion: a sixth, never-seen identifier in the same /64 is
    // already locked out. Rotation bought no extra attempts.
    const sixth = await joinFamily(
      VALID_USER_ID,
      WRONG_PIN,
      NEXT_IID_SAME_SUBNET,
    );
    expect(sixth.status).toBe(429);
    const json = (await sixth.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
  });

  it("should keep a caller in a different /64 on a fresh failure budget", async () => {
    await seedVictimInsideTargetFamily();

    for (const ip of ROTATING_IIDS) {
      await joinFamily(VALID_USER_ID, WRONG_PIN, ip);
    }
    const lockedRes = await joinFamily(
      VALID_USER_ID,
      CORRECT_PIN,
      NEXT_IID_SAME_SUBNET,
    );
    expect(lockedRes.status).toBe(429);

    // The neighbouring subscriber is untouched: still charged normally...
    const wrong = await joinFamily(VALID_USER_ID, WRONG_PIN, OTHER_SUBNET_IP);
    expect(wrong.status).toBe(403);
    const wrongJson = (await wrong.json()) as Json;
    expect(wrongJson.error.code).toBe("VERIFICATION_FAILED");

    // ...and still able to log in with the correct PIN.
    const ok = await joinFamily(VALID_USER_ID, CORRECT_PIN, OTHER_SUBNET_IP);
    expect(ok.status).toBe(200);
  });
});
