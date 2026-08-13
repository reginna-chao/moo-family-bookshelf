import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
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
  const token = await seedAuthToken(kv, userId);
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

/**
 * Seed a PIN verify record for `userId`. The stored hash is a placeholder, so no
 * submitted secret can ever match it — use this when the test only needs
 * verification to be ACTIVE (the lockout branch runs before any hash compare).
 *
 * `secretUpdatedAt` is OMITTED unless passed, reproducing a record written
 * before that field existed (absence must never void a failure streak).
 */
async function seedPinAccount(userId: string, secretUpdatedAt?: number) {
  const record: VerifyRecord = {
    method: "pin",
    hash: "placeholder",
    salt: "placeholder",
    prompted: 1,
  };
  if (secretUpdatedAt !== undefined) record.secretUpdatedAt = secretUpdatedAt;
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

/**
 * Lock out ONE CALLER until `lockedUntil`, by seeding the caller-scoped
 * `verifyfail:{userId}:{callerKey}` record. Lockout state deliberately does not
 * live on `verify:{userId}` — see the DoS regression suite below — so a lockout
 * fixture must be keyed on the caller, normalized exactly as the Worker does.
 *
 * `startedAt` is OMITTED unless passed, reproducing an entry written before that
 * field existed (a legacy entry must stay locked, never be voided).
 */
async function seedCallerLockout(
  userId: string,
  callerIp: string,
  lockedUntil: number,
  startedAt?: number,
) {
  const record: VerifyFailRecord = { failCount: 0, lockedUntil };
  if (startedAt !== undefined) record.startedAt = startedAt;
  await kv.put(
    kvKeys.verifyFail(userId, normalizeCallerIp(callerIp)),
    JSON.stringify(record),
  );
}

/** Lockout window in whole seconds — upper bound for any retryAfter hint. */
const LOCKOUT_SECONDS = VERIFY_LOCKOUT_MS / 1000;

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // Some cases pin Date via fake timers; always restore the real clock.
  vi.useRealTimers();
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
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,5,8" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("pattern");
  });

  it("should set code verification (no secret needed)", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("code");
  });

  it("should set to none (disable verification)", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "none" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.method).toBe("none");
  });

  it("should reject invalid PIN (too short)", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "12345" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_SECRET");
  });

  it("should reject invalid PIN (non-numeric)", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "abcdef" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with fewer than 4 nodes", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with duplicate nodes", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,1,2" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject pattern with invalid node index", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,9" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  it("should reject invalid method", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${OTHER_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "123456" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
  });

  it("should preserve prompted flag when not explicitly set", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "none", prompted: 1 }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.prompted).toBe(1);
  });

  it("should store only account fields, never failure accounting", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);
    const before = Date.now();

    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: "999999" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    // Failure counters live in `verifyfail:{userId}:{callerKey}`, never on the
    // account record — a counter on the account would be a DoS lever. The only
    // failure-adjacent field allowed here is `secretUpdatedAt`, which records
    // WHEN the secret changed (not how often anyone failed) and is what voids
    // streaks charged against the replaced secret.
    const record = JSON.parse(
      (await kv.get(kvKeys.verify(VALID_USER_ID))) as string,
    ) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "hash",
      "method",
      "prompted",
      "salt",
      "secretUpdatedAt",
    ]);
    expect(record.secretUpdatedAt).toBeTypeOf("number");
    expect(record.secretUpdatedAt as number).toBeGreaterThanOrEqual(before);
    expect(record.secretUpdatedAt as number).toBeLessThanOrEqual(Date.now());
  });
});

describe("POST /api/user/:id/verify/otp", () => {
  it("should generate a 6-digit OTP code", async () => {
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

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
    const token = await seedAuthToken(kv, VALID_USER_ID);

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

    const ownerToken = await seedAuthToken(kv, VALID_USER_ID);
    await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pattern", secret: "0,1,2,5,8" }),
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const res = await joinFamily(VALID_USER_ID, "0,1,2,5,8");

    expect(res.status).toBe(200);
  });

  it("should allow join with correct OTP", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(kv, VALID_USER_ID);

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

    const ownerToken = await seedAuthToken(kv, VALID_USER_ID);

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

async function readVerifyRecord(userId: string): Promise<VerifyRecord | null> {
  const raw = await kv.get(kvKeys.verify(userId));
  return raw ? (JSON.parse(raw) as VerifyRecord) : null;
}

/**
 * Range-check the streak start stamp against the wall clock window the test ran
 * in. Paired with a `toEqual` on the rest of the record, this pins the exact
 * field set while still tolerating a real (unpinned) `Date.now()`.
 */
function expectStreakStartedBetween(
  record: VerifyFailRecord | null,
  notBefore: number,
) {
  expect(record?.startedAt).toBeGreaterThanOrEqual(notBefore);
  expect(record?.startedAt).toBeLessThanOrEqual(Date.now());
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
    const before = Date.now();

    await submitWrongSecrets(2, ATTACKER_IP);

    const record = await readFailRecord(VALID_USER_ID, ATTACKER_IP);
    expect(record).toEqual({
      failCount: 2,
      lockedUntil: null,
      startedAt: expect.any(Number),
    });
    expectStreakStartedBetween(record, before);
  });

  it("should charge failures to the fallback caller bucket when no client IP is present", async () => {
    await seedVictimInsideTargetFamily();
    const before = Date.now();

    await submitWrongSecrets(2);

    const record = await readFailRecord(VALID_USER_ID, UNKNOWN_CALLER_KEY);
    expect(record).toEqual({
      failCount: 2,
      lockedUntil: null,
      startedAt: expect.any(Number),
    });
    expectStreakStartedBetween(record, before);
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

    // Back-off hint: whole seconds, inside the lockout window, and mirrored
    // into the Retry-After header so clients can render a countdown.
    expect(Number.isInteger(json.error.retryAfter)).toBe(true);
    expect(json.error.retryAfter).toBeGreaterThan(0);
    expect(json.error.retryAfter).toBeLessThanOrEqual(LOCKOUT_SECONDS);
    expect(res.headers.get("Retry-After")).toBe(String(json.error.retryAfter));
  });

  it.each([
    { remainingMs: 1, expected: 1 },
    { remainingMs: 400, expected: 1 },
    { remainingMs: 1000, expected: 1 },
    { remainingMs: 1001, expected: 2 },
    { remainingMs: 1500, expected: 2 },
    { remainingMs: 59_000, expected: 59 },
    { remainingMs: VERIFY_LOCKOUT_MS, expected: LOCKOUT_SECONDS },
  ])(
    "should round $remainingMs ms of remaining lockout up to retryAfter=$expected",
    async ({ remainingMs, expected }) => {
      // Pin Date only (timers stay real) so the remaining lockout is exact.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
      await seedPinAccount(VALID_USER_ID);
      await seedCallerLockout(
        VALID_USER_ID,
        ATTACKER_IP,
        Date.now() + remainingMs,
      );

      const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);

      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_LOCKED");
      expect(json.error.retryAfter).toBe(expected);
      expect(res.headers.get("Retry-After")).toBe(String(expected));
    },
  );

  it("should derive retryAfter from the caller's lockout, not from the account record", async () => {
    // Pin Date only (timers stay real) so the remaining lockout is exact.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
    // A legacy account record still carrying the removed `lockedUntil` field —
    // exactly what a KV entry written by a pre-migration Worker looks like. It
    // must be inert: neither the lockout decision nor the back-off hint may be
    // read off `verify:{userId}`.
    await kv.put(
      kvKeys.verify(VALID_USER_ID),
      JSON.stringify({
        method: "pin",
        hash: "placeholder",
        salt: "placeholder",
        prompted: 1,
        failCount: VERIFY_MAX_FAILURES,
        lockedUntil: Date.now() + VERIFY_LOCKOUT_MS,
      }),
    );
    await seedCallerLockout(VALID_USER_ID, ATTACKER_IP, Date.now() + 30_000);

    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
    // 30s from the CALLER record, not the 900s sitting on the account record.
    expect(json.error.retryAfter).toBe(30);
    expect(res.headers.get("Retry-After")).toBe("30");

    // And the stale account field grants no lockout of its own: a caller with a
    // clean record still gets a normal 403 attempt.
    const other = await joinFamily(VALID_USER_ID, CORRECT_PIN, VICTIM_IP);
    expect(other.status).toBe(403);
    const otherJson = (await other.json()) as Json;
    expect(otherJson.error.code).toBe("VERIFICATION_FAILED");
  });

  it("should not expose retryAfter when verification is merely required", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
    await seedPinAccount(VALID_USER_ID);
    // Expired caller lockout — the lockout branch must fall through to the
    // "secret missing" branch, which carries no back-off hint.
    await seedCallerLockout(VALID_USER_ID, ATTACKER_IP, Date.now() - 1000);

    const res = await joinFamily(VALID_USER_ID, undefined, ATTACKER_IP);

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
    expect("retryAfter" in json.error).toBe(false);
    expect(Object.keys(json.error).sort()).toEqual(["code", "message"]);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("should not expose retryAfter when verification fails", async () => {
    await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);

    const ownerToken = await seedAuthToken(kv, VALID_USER_ID);
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
    expect("retryAfter" in json.error).toBe(false);
    expect(Object.keys(json.error).sort()).toEqual(["code", "message"]);
    expect(res.headers.get("Retry-After")).toBeNull();
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
      const expectedLockExpiry = Date.now() + VERIFY_LOCKOUT_MS;
      const { lockedUntil } = JSON.parse(
        lockedRaw as string,
      ) as VerifyFailRecord;
      expect(lockedUntil).toBe(expectedLockExpiry);

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
      vi.setSystemTime(expectedLockExpiry + 1);
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
// Failure-streak voiding after a secret change (owner recovery path)
//
// An owner who forgot their PIN/pattern resets it through the AUTHENTICATED
// `PUT /api/user/:id/verify` (callerId === userId). That stamps
// `secretUpdatedAt`, which voids any failure streak that began earlier: the
// streak accumulated against a secret that no longer exists, so honouring it
// would lock the owner out of their own account right after a legitimate reset.
//
// Voiding is deliberately narrow — it needs BOTH timestamps, compares them
// strictly, and only ever deletes the CALLER's own key. A missing timestamp
// (legacy KV entry) keeps the lockout in force: absence never unlocks.
// ===========================================================================

const SECOND_CALLER_IP = "203.0.113.77";
const NEW_PIN = "654321";
/** Baseline instant: both the original secret and the first streak start here. */
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
/** 1s later — still deep inside the 15-minute lockout window. */
const T1 = T0 + 1000;

/** Pin Date only (timers stay real) so streak/secret ordering is exact. */
function pinClock(at: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

describe("Verification failure streak voiding after a secret change", () => {
  it("should let a locked-out caller in with the new secret after the owner resets it", async () => {
    pinClock(T0);
    await seedVictimInsideTargetFamily();

    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);
    const beforeReset = await joinFamily(
      VALID_USER_ID,
      CORRECT_PIN,
      ATTACKER_IP,
    );
    expect(beforeReset.status).toBe(429);

    // The owner resets the forgotten PIN on their own account.
    vi.setSystemTime(T1);
    await setPin(VALID_USER_ID, NEW_PIN);

    // Same caller IP, new secret: the pre-reset streak no longer applies.
    const res = await joinFamily(VALID_USER_ID, NEW_PIN, ATTACKER_IP);
    expect(res.status).toBe(200);

    // The void removed exactly that caller's entry.
    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toBeNull();
  });

  it("should start a fresh streak instead of carrying the pre-reset failure count forward", async () => {
    pinClock(T0);
    await seedVictimInsideTargetFamily();

    // One short of the lockout threshold — a carried-forward count would lock.
    await submitWrongSecrets(VERIFY_MAX_FAILURES - 1, ATTACKER_IP);
    expect((await readFailRecord(VALID_USER_ID, ATTACKER_IP))?.failCount).toBe(
      VERIFY_MAX_FAILURES - 1,
    );

    vi.setSystemTime(T1);
    await setPin(VALID_USER_ID, NEW_PIN);

    const res = await joinFamily(VALID_USER_ID, WRONG_PIN, ATTACKER_IP);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");

    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toEqual({
      failCount: 1,
      lockedUntil: null,
      startedAt: T1,
    });
  });

  // Voiding must fire ONLY on a strict "streak started before the secret
  // changed". Everything else — including either timestamp being absent on a
  // legacy KV entry — leaves the lockout untouched.
  it.each([
    {
      label: "the failure entry predates the startedAt field",
      secretUpdatedAt: T1,
      startedAt: undefined,
    },
    {
      label: "the account record predates the secretUpdatedAt field",
      secretUpdatedAt: undefined,
      startedAt: T0,
    },
    {
      label: "the streak began after the last secret change",
      secretUpdatedAt: T0,
      startedAt: T1,
    },
    {
      label: "the streak began in the same millisecond as the secret change",
      secretUpdatedAt: T0,
      startedAt: T0,
    },
  ])(
    "should keep the lockout in force when $label",
    async ({ secretUpdatedAt, startedAt }) => {
      pinClock(T1);
      await seedFamily(OTHER_USER_ID, VALID_FAMILY_ID);
      await seedPinAccount(VALID_USER_ID, secretUpdatedAt);
      await seedCallerLockout(
        VALID_USER_ID,
        ATTACKER_IP,
        Date.now() + 30_000,
        startedAt,
      );

      const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);

      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_LOCKED");
      // Only a genuine void deletes the entry.
      expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).not.toBeNull();
    },
  );

  it("should void only the streak that predates the reset, leaving another caller's later lockout intact", async () => {
    pinClock(T0);
    await seedVictimInsideTargetFamily();

    // Caller A burns their budget against the OLD secret.
    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);

    vi.setSystemTime(T1);
    await setPin(VALID_USER_ID, NEW_PIN);

    // Caller B burns theirs AFTER the reset.
    vi.setSystemTime(T1 + 1000);
    await submitWrongSecrets(VERIFY_MAX_FAILURES, SECOND_CALLER_IP);

    // A is released...
    const a = await joinFamily(VALID_USER_ID, NEW_PIN, ATTACKER_IP);
    expect(a.status).toBe(200);
    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toBeNull();

    // ...B is not, and B's entry was not swept up by A's void.
    const b = await joinFamily(VALID_USER_ID, NEW_PIN, SECOND_CALLER_IP);
    expect(b.status).toBe(429);
    const json = (await b.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
    expect(
      await readFailRecord(VALID_USER_ID, SECOND_CALLER_IP),
    ).not.toBeNull();
  });

  it("should not advance secretUpdatedAt when only the prompted flag is written", async () => {
    pinClock(T0);
    await seedVictimInsideTargetFamily();
    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);

    // `POST /verify/prompted` rewrites the account record but changes no secret,
    // so it must not hand out a lockout reset.
    vi.setSystemTime(T1);
    const token = await seedAuthToken(kv, VALID_USER_ID);
    const prompted = await request(
      "POST",
      `/api/user/${VALID_USER_ID}/verify/prompted`,
      {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(prompted.status).toBe(200);
    expect((await readVerifyRecord(VALID_USER_ID))?.secretUpdatedAt).toBe(T0);

    const res = await joinFamily(VALID_USER_ID, CORRECT_PIN, ATTACKER_IP);
    expect(res.status).toBe(429);
  });

  it("should not let a third party stamp the victim's account to clear their own lockout", async () => {
    pinClock(T0);
    await seedVictimInsideTargetFamily();
    await submitWrongSecrets(VERIFY_MAX_FAILURES, ATTACKER_IP);
    const accountRecordBefore = await kv.get(kvKeys.verify(VALID_USER_ID));

    // The attacker holds a valid token — for their OWN account only.
    vi.setSystemTime(T1);
    const attackerToken = await seedAuthToken(kv, OTHER_USER_ID);
    const res = await request("PUT", `/api/user/${VALID_USER_ID}/verify`, {
      body: JSON.stringify({ method: "pin", secret: NEW_PIN }),
      headers: {
        Authorization: `Bearer ${attackerToken}`,
        "cf-connecting-ip": ATTACKER_IP,
      },
    });
    expect(res.status).toBe(401);

    // secretUpdatedAt is unreachable from outside — byte-identical record.
    expect(await kv.get(kvKeys.verify(VALID_USER_ID))).toBe(
      accountRecordBefore,
    );

    // So the self-inflicted lockout still stands.
    const stillLocked = await joinFamily(
      VALID_USER_ID,
      CORRECT_PIN,
      ATTACKER_IP,
    );
    expect(stillLocked.status).toBe(429);
  });
});

// ===========================================================================
// KV write budget per exit path (void-streak leftovers)
//
// Cloudflare KV accepts at most one write per second per key, so deleting
// `verifyfail:{userId}:{callerKey}` and writing it again within the same request
// can silently drop the second write — i.e. the failure just charged. Voiding is
// therefore an in-memory verdict only (re-derived on every read, so an undeleted
// void entry is already inert), and each exit path touches the key AT MOST ONCE:
// nothing while locked, nothing when no secret was submitted, one put on a wrong
// secret, one delete on success.
//
// The in-memory mock has no one-write-per-second limit, so a delete followed by
// a put leaves exactly the same stored value as a lone put — only the recorded
// op sequence can tell those two apart.
// ===========================================================================

/** 5s after the reset — a freshly charged streak must stamp THIS instant. */
const T2 = T1 + 5000;

type KvWriteOp = "put" | "delete";

/**
 * Replace `kv` with a wrapper that logs every write aimed at `key`, and return
 * the live log. The wrapper is discarded together with the per-test `kv`
 * instance (`beforeEach` builds a fresh mock), so there is nothing to restore.
 *
 * Note: `getPutTtl` is keyed on the original mock instance and therefore reports
 * nothing for the wrapper — assert TTLs outside a tracked request.
 */
function trackWritesTo(key: string): KvWriteOp[] {
  const ops: KvWriteOp[] = [];
  const base = kv;
  kv = {
    ...base,
    put: async (
      k: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> => {
      if (k === key) ops.push("put");
      await base.put(k, value, opts);
    },
    delete: async (k: string): Promise<void> => {
      if (k === key) ops.push("delete");
      await base.delete(k);
    },
  } as unknown as KVNamespace;
  return ops;
}

describe("Verification KV write budget on the void-streak paths", () => {
  const failKey = kvKeys.verifyFail(
    VALID_USER_ID,
    normalizeCallerIp(ATTACKER_IP),
  );

  /**
   * Leave a genuine VOID leftover under `failKey`: a real streak of `failCount`
   * wrong secrets charged at T0 against the old PIN, then an owner reset at T1
   * that stamps `secretUpdatedAt` after it. The clock ends at T2, so a freshly
   * charged streak differs from the leftover in `startedAt` as well as in
   * `failCount`. Returns the raw stored leftover for byte-identity checks.
   */
  async function seedVoidedStreak(failCount: number): Promise<string> {
    pinClock(T0);
    await seedVictimInsideTargetFamily();
    await submitWrongSecrets(failCount, ATTACKER_IP);

    vi.setSystemTime(T1);
    await setPin(VALID_USER_ID, NEW_PIN);

    vi.setSystemTime(T2);
    const raw = await kv.get(failKey);
    expect(raw).not.toBeNull();
    return raw as string;
  }

  it("should leave a void leftover in place when no secret is submitted", async () => {
    // A leftover that still LOOKS locked, to show the void verdict alone makes
    // it inert — no delete is required to neutralise it.
    const leftover = await seedVoidedStreak(VERIFY_MAX_FAILURES);
    expect(
      (JSON.parse(leftover) as VerifyFailRecord).lockedUntil,
    ).toBeGreaterThan(Date.now());
    const writes = trackWritesTo(failKey);

    const res = await joinFamily(VALID_USER_ID, undefined, ATTACKER_IP);

    // Inert, not locking: 403 REQUIRED rather than 429 LOCKED.
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");

    // No attempt was made, so nothing is charged — and nothing is cleaned up
    // either. Spending the key's one write here would leave the next request in
    // the same second unable to record a real failure.
    expect(await kv.get(failKey)).toBe(leftover);
    expect(writes).toEqual([]);
  });

  it("should replace a void leftover with a freshly started streak on a wrong secret", async () => {
    await seedVoidedStreak(2);
    const writes = trackWritesTo(failKey);

    const res = await joinFamily(VALID_USER_ID, WRONG_PIN, ATTACKER_IP);

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");

    // A fresh streak stamped now — the leftover's count is neither carried
    // forward (would read 3) nor merged, and its T0 start is not preserved.
    expect(await readFailRecord(VALID_USER_ID, ATTACKER_IP)).toEqual({
      failCount: 1,
      lockedUntil: null,
      startedAt: T2,
    });
    // Exactly one write, and it is a PUT: `chargeFailure` rewrites the whole
    // entry, so deleting the leftover first would only put this write at risk.
    expect(writes).toEqual(["put"]);
  });

  it("should delete a void leftover on a successful verification", async () => {
    // The leftover is a live, non-null entry with no lockout on it, so nothing
    // but the void verdict can zero out `failRecord` — this reaches the cleanup
    // through the `|| voided` half of the condition, which the plain
    // `failRecord` half could not cover.
    await seedVoidedStreak(2);
    const writes = trackWritesTo(failKey);

    const res = await joinFamily(VALID_USER_ID, NEW_PIN, ATTACKER_IP);

    expect(res.status).toBe(200);
    expect(await kv.get(failKey)).toBeNull();
    expect(writes).toEqual(["delete"]);
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
