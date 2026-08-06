import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { ALICE, BOB } from "../helpers/ids";
import {
  kvKeys,
  BoolFlag,
  VERIFY_MAX_FAILURES,
  type VerifyRecord,
  type VerifyFailRecord,
} from "../../src/kv/schema";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/routes/verify";
import {
  normalizeCallerIp,
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { VERIFY_SECRET_MAX_LENGTH } from "../../src/utils/validation";

// ===========================================================================
// The verification gate on the PUBLIC identity endpoints
//
// `userId` is sha256("moo:" + email) — derived from a publicly guessable value.
// Anything that mints an auth token for it, or discloses data bound to it, must
// therefore prove ownership when the account has PWA login verification
// (PIN / pattern / OTP) configured. Three entry points share one gate:
//
//   POST /api/family          — create (403 without a valid secret)
//   POST /api/family/:id/join — join   (already covered in verifyRoutes.test.ts)
//   POST /api/auth/lookup     — lookup (200 + requiresVerification, no data)
//
// Accounts with no verification record, or `method: "none"`, are unaffected.
// This suite covers create + lookup, the OTP consumption contract between them,
// the `verifySecret` format bound, and the per-userId attempt ceiling.
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/** The account whose identity the gate protects. */
const USER_ID = ALICE;
/** Owner of the family used by the join-path cases. */
const OWNER_ID = BOB;
const FAMILY_ID = "abcd-1234";

const CORRECT_PIN = "123456";
const WRONG_PIN = "000000";

const CALLER_IP = "203.0.113.10";
const OTHER_CALLER_IP = "198.51.100.20";

interface RequestOptions {
  /** Serialized with `JSON.stringify` unless it already is a string. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Sent as `cf-connecting-ip` — the only caller identity the Worker trusts
   * (see `getCallerIp`). Omit to simulate a request with no client IP.
   */
  callerIp?: string;
  /**
   * `DEV_MODE=1` short-circuits BOTH limiters (per-IP and per-userId), so it is
   * the default here exactly as in every other suite: it isolates the gate.
   * The attempt-ceiling suite passes `false` to run the limiters live.
   */
  devMode?: boolean;
}

async function apiRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.callerIp) headers["cf-connecting-ip"] = opts.callerIp;

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  const env = opts.devMode === false ? { KV: kv } : { KV: kv, DEV_MODE: "1" };
  return app.request(path, init, env);
}

/** Options accepted by every entry point of the gate. */
interface GateCallOptions {
  /**
   * Omitted (or `undefined`) means the field is absent from the JSON body, i.e.
   * "no secret supplied". Typed `unknown` so the malformed-input cases can send
   * a number / object / oversized string through the same helper.
   */
  verifySecret?: unknown;
  callerIp?: string;
  devMode?: boolean;
}

type GateCall = (userId: string, opts?: GateCallOptions) => Promise<Response>;

const lookup: GateCall = (userId, opts = {}) =>
  apiRequest("POST", "/api/auth/lookup", {
    body: { userId, verifySecret: opts.verifySecret },
    callerIp: opts.callerIp,
    devMode: opts.devMode,
  });

const createFamily: GateCall = (userId, opts = {}) =>
  apiRequest("POST", "/api/family", {
    body: { userId, verifySecret: opts.verifySecret },
    callerIp: opts.callerIp,
    devMode: opts.devMode,
  });

const joinFamily: GateCall = (userId, opts = {}) =>
  apiRequest("POST", `/api/family/${FAMILY_ID}/join`, {
    body: { userId, verifySecret: opts.verifySecret },
    callerIp: opts.callerIp,
    devMode: opts.devMode,
  });

/**
 * The three public entry points that share the gate. `prepare` seeds whatever
 * that endpoint needs in order to REACH the gate (only join needs a family to
 * exist); `successStatus` is what that endpoint answers once the gate lets the
 * request through. Everything else about a case stays endpoint-independent.
 */
const GATE_ENDPOINTS: {
  endpoint: string;
  call: GateCall;
  successStatus: number;
  prepare?: () => Promise<void>;
}[] = [
  { endpoint: "POST /api/auth/lookup", call: lookup, successStatus: 200 },
  { endpoint: "POST /api/family", call: createFamily, successStatus: 201 },
  {
    endpoint: "POST /api/family/:id/join",
    call: joinFamily,
    successStatus: 200,
    prepare: () => seedFamily([OWNER_ID]),
  },
];

// --- Seeding -------------------------------------------------------------

async function seedAuthToken(userId: string): Promise<string> {
  const token = userId.slice(0, 32).repeat(2);
  await kv.put(kvKeys.authToken(token), userId);
  await kv.put(
    kvKeys.auth(userId),
    JSON.stringify({ token, createdAt: new Date().toISOString() }),
  );
  return token;
}

/** Seed a family whose members are `userIds` (the first entry is the owner). */
async function seedFamily(userIds: string[]): Promise<void> {
  await Promise.all(
    userIds.map((uid) => kv.put(kvKeys.member(uid), FAMILY_ID)),
  );
  await kv.put(
    kvKeys.family(FAMILY_ID),
    JSON.stringify({
      familyId: FAMILY_ID,
      ownerId: userIds[0],
      members: userIds.map((userId) => ({ userId, displayName: "Test" })),
      maxMembers: 2,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * Configure verification for `userId` with NO other side effect: the stored
 * hash is a placeholder, so no submitted secret can ever match it.
 *
 * Used wherever a test asserts what the gate refuses to WRITE — `setPin` goes
 * through the authenticated route and seeds `auth:{userId}` + `token:{…}`
 * itself, which would mask a token mint by the endpoint under test.
 */
async function seedUnmatchableVerification(userId: string): Promise<void> {
  const record: VerifyRecord = {
    method: "pin",
    hash: "placeholder",
    salt: "placeholder",
    prompted: 1,
  };
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

/**
 * A `pin` record with no hash/salt — a state the authenticated
 * `PUT /:id/verify` cannot produce, but which an older or hand-edited KV entry
 * could hold. The gate and the `isVerificationConfigured` probe classify it
 * DIFFERENTLY on purpose (see the doc comment on that probe), which is what the
 * two cases using this fixture pin down.
 */
async function seedCorruptedVerification(userId: string): Promise<void> {
  const record: VerifyRecord = {
    method: "pin",
    hash: null,
    salt: null,
    prompted: 1,
  };
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

/** Set a real PIN through the production route, so hash + salt are genuine. */
async function setPin(userId: string, pin: string): Promise<void> {
  const token = await seedAuthToken(userId);
  const res = await apiRequest("PUT", `/api/user/${userId}/verify`, {
    body: { method: "pin", secret: pin },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
}

/** Switch `userId` to the OTP method and push a fresh code; returns the code. */
async function issueOtp(userId: string): Promise<string> {
  const token = await seedAuthToken(userId);
  const set = await apiRequest("PUT", `/api/user/${userId}/verify`, {
    body: { method: "code" },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(set.status).toBe(200);

  const res = await apiRequest("POST", `/api/user/${userId}/verify/otp`, {
    body: {},
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as Json;
  return json.data.code as string;
}

/**
 * Lock ONE caller out of `userId` until `lockedUntil`. Lockout is deliberately
 * caller-scoped (`verifyfail:{userId}:{callerKey}`), never stored on the account
 * record, so the fixture is keyed on the caller and normalized exactly as the
 * Worker does.
 */
async function seedCallerLockout(
  userId: string,
  callerIp: string,
  lockedUntil: number,
): Promise<void> {
  const record: VerifyFailRecord = {
    failCount: 0,
    lockedUntil,
    startedAt: Date.now(),
  };
  await kv.put(
    kvKeys.verifyFail(userId, normalizeCallerIp(callerIp)),
    JSON.stringify(record),
  );
}

// --- Keyspace assertions -------------------------------------------------

/** Every key currently stored, sorted — a snapshot to diff a request against. */
async function snapshotKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).sort();
}

/** Pin Date only (timers stay real) so lockout arithmetic is exact. */
function pinClock(at: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

const T0 = new Date("2026-01-01T00:30:00.000Z").getTime();
/** Remaining lockout seeded by the lockout cases, in ms. */
const LOCKOUT_REMAINING_MS = 30_000;

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // Several cases pin Date via fake timers; always restore the real clock.
  vi.useRealTimers();
});

// ===========================================================================
// POST /api/family — create
//
// The gate sits AFTER the ALREADY_IN_FAMILY conflict check and BEFORE any KV
// write or token mint, so a rejected create leaves nothing behind at all.
// ===========================================================================

describe("POST /api/family verification gate", () => {
  it.each([
    { label: "no verify record exists", configure: undefined },
    {
      label: "the stored method is 'none'",
      configure: async () => {
        const record: VerifyRecord = {
          method: "none",
          hash: null,
          salt: null,
          prompted: 1,
        };
        await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
      },
    },
  ])(
    "should create the family without a secret when $label",
    async ({ configure }) => {
      await configure?.();

      const res = await createFamily(USER_ID, { callerIp: CALLER_IP });

      expect(res.status).toBe(201);
      const json = (await res.json()) as Json;
      expect(json.data.ownerId).toBe(USER_ID);
      expect(json.data.authToken).toMatch(/^[a-f0-9]{64}$/);
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(json.data.familyId);
    },
  );

  it("should create the family when the correct secret is supplied", async () => {
    await setPin(USER_ID, CORRECT_PIN);

    const res = await createFamily(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(json.data.familyId);
    // A successful verification clears the caller's failure history and spends
    // nothing, so no accounting entry is left behind.
    expect(
      await kv.get(kvKeys.verifyFail(USER_ID, normalizeCallerIp(CALLER_IP))),
    ).toBeNull();
  });

  it("should refuse to create and write nothing when no secret is supplied", async () => {
    await seedUnmatchableVerification(USER_ID);
    const before = await snapshotKeys();

    const res = await createFamily(USER_ID, { callerIp: CALLER_IP });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");

    // No family record, no member reverse-lookup, no auth token — and nothing
    // deleted either. The whole keyspace is untouched: no attempt was made, so
    // not even the caller's failure budget may be charged.
    expect(await snapshotKeys()).toEqual(before);
  });

  it("should refuse to create and write nothing but the caller's failure streak on a wrong secret", async () => {
    await seedUnmatchableVerification(USER_ID);
    const before = await snapshotKeys();

    const res = await createFamily(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");

    // The ONLY new key is this caller's own failure record.
    const failKey = kvKeys.verifyFail(USER_ID, normalizeCallerIp(CALLER_IP));
    expect(await snapshotKeys()).toEqual([...before, failKey].sort());
    expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
  });

  it("should refuse to create and write nothing while the caller is locked out", async () => {
    pinClock(T0);
    await seedUnmatchableVerification(USER_ID);
    await seedCallerLockout(
      USER_ID,
      CALLER_IP,
      Date.now() + LOCKOUT_REMAINING_MS,
    );
    const before = await snapshotKeys();

    const res = await createFamily(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
    expect(json.error.retryAfter).toBe(LOCKOUT_REMAINING_MS / 1000);
    expect(res.headers.get("Retry-After")).toBe(
      String(LOCKOUT_REMAINING_MS / 1000),
    );

    expect(await snapshotKeys()).toEqual(before);
  });

  it("should leave an orphaned member key in place when the gate rejects the create", async () => {
    // `member:{userId}` pointing at a family record that no longer exists is
    // cleaned up by the create flow — but only AFTER the gate, so a caller who
    // cannot prove ownership cannot make the Worker mutate the account either.
    const staleFamilyId = "dead-beef";
    await kv.put(kvKeys.member(USER_ID), staleFamilyId);
    await seedUnmatchableVerification(USER_ID);

    const res = await createFamily(USER_ID, { callerIp: CALLER_IP });

    expect(res.status).toBe(403);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(staleFamilyId);
  });

  it("should treat a corrupted pin record as no verification at all", async () => {
    // `method: "pin"` with no hash/salt is a state `PUT /:id/verify` cannot
    // produce. The gate treats it as unconfigured rather than as an account
    // nobody can ever unlock — see `matchesSecret`.
    await seedCorruptedVerification(USER_ID);

    const res = await createFamily(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(201);
  });

  it("should answer ALREADY_IN_FAMILY before asking for a secret", async () => {
    // Documented ordering: the conflict is cheap and terminal (no secret can
    // make the request succeed), so gating first would only prompt for a PIN,
    // spend the account's attempt ceiling, and still refuse. Everything of
    // value — familyId, token, member data — stays behind the gate.
    await seedFamily([USER_ID]);
    await seedUnmatchableVerification(USER_ID);
    const before = await snapshotKeys();

    const res = await createFamily(USER_ID, { callerIp: CALLER_IP });

    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("ALREADY_IN_FAMILY");
    expect(await snapshotKeys()).toEqual(before);
  });
});

// ===========================================================================
// POST /api/auth/lookup
//
// familyId is the payload of the sync code, so handing it to anyone who can
// guess an email lets a stranger join the victim's not-yet-full family. A
// configured account with no secret therefore gets an INFORMATIONAL 200 that
// carries no membership data, not an error.
// ===========================================================================

describe("POST /api/auth/lookup verification gate", () => {
  it.each([
    {
      label: "the userId belongs to no family",
      members: [] as string[],
      expected: { existingFamilyId: null, memberCount: 0 },
    },
    {
      label: "the userId is a member of a two-person family",
      members: [OWNER_ID, USER_ID],
      expected: { existingFamilyId: FAMILY_ID, memberCount: 2 },
    },
  ])(
    "should return the membership result with requiresVerification 0 when nothing is configured and $label",
    async ({ members, expected }) => {
      if (members.length > 0) await seedFamily(members);

      const res = await lookup(USER_ID, { callerIp: CALLER_IP });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.data).toEqual({
        ...expected,
        requiresVerification: BoolFlag.FALSE,
      });
      // BoolFlag, never a JS boolean — `true === 1` is false in strict equality
      // and both the Extension and the PWA compare against BoolFlag.
      expect(typeof json.data.requiresVerification).toBe("number");
    },
  );

  it("should withhold the membership result and ask for a secret when verification is configured", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedUnmatchableVerification(USER_ID);
    const before = await snapshotKeys();

    const res = await lookup(USER_ID, { callerIp: CALLER_IP });

    // Informational, not an error: the client uses it to know it must prompt.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toEqual({
      existingFamilyId: null,
      memberCount: 0,
      requiresVerification: BoolFlag.TRUE,
    });
    // The account IS in a family — the real familyId is simply not disclosed.
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
    // Reporting the requirement costs nothing: no attempt was made.
    expect(await snapshotKeys()).toEqual(before);
  });

  it.each([
    { label: "the field is absent", verifySecret: undefined },
    { label: "the field is null", verifySecret: null },
    { label: "the field is an empty string", verifySecret: "" },
  ])(
    "should treat a configured account as requiring verification when $label",
    async ({ verifySecret }) => {
      await seedFamily([OWNER_ID, USER_ID]);
      await seedUnmatchableVerification(USER_ID);

      const res = await lookup(USER_ID, { verifySecret, callerIp: CALLER_IP });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.data).toEqual({
        existingFamilyId: null,
        memberCount: 0,
        requiresVerification: BoolFlag.TRUE,
      });
    },
  );

  it("should return the real membership result when the correct secret is supplied", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await setPin(USER_ID, CORRECT_PIN);

    const res = await lookup(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toEqual({
      existingFamilyId: FAMILY_ID,
      memberCount: 2,
      requiresVerification: BoolFlag.FALSE,
    });
  });

  it("should reject a wrong secret without disclosing anything", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await setPin(USER_ID, CORRECT_PIN);

    const res = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");
    expect(json.data).toBeUndefined();
    // Charged to the CALLER, exactly as on the join path.
    expect(
      await kv.get(kvKeys.verifyFail(USER_ID, normalizeCallerIp(CALLER_IP))),
    ).not.toBeNull();
  });

  it("should return the caller's lockout verbatim as 429 VERIFICATION_LOCKED", async () => {
    pinClock(T0);
    await seedFamily([OWNER_ID, USER_ID]);
    await seedUnmatchableVerification(USER_ID);
    await seedCallerLockout(
      USER_ID,
      CALLER_IP,
      Date.now() + LOCKOUT_REMAINING_MS,
    );

    const res = await lookup(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_LOCKED");
    expect(json.error.retryAfter).toBe(LOCKOUT_REMAINING_MS / 1000);
    expect(res.headers.get("Retry-After")).toBe(
      String(LOCKOUT_REMAINING_MS / 1000),
    );

    // A different caller is unaffected — the lockout is not on the account.
    const other = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: OTHER_CALLER_IP,
    });
    expect(other.status).toBe(403);
  });

  it("should err closed on a corrupted verify record and ask for a secret anyway", async () => {
    // Deliberate asymmetry with the create/join gate above, which lets the same
    // record through: the probe used here reports "configured", so the account
    // is asked for a secret it can never fail — one extra round-trip — instead
    // of having its membership disclosed unprompted.
    await seedFamily([OWNER_ID, USER_ID]);
    await seedCorruptedVerification(USER_ID);

    const res = await lookup(USER_ID, { callerIp: CALLER_IP });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toEqual({
      existingFamilyId: null,
      memberCount: 0,
      requiresVerification: BoolFlag.TRUE,
    });

    // Any secret then passes, so the account is never permanently locked out.
    const retry = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: CALLER_IP,
    });
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as Json;
    expect(retryJson.data.existingFamilyId).toBe(FAMILY_ID);
  });

  it("should not read the membership record when it only reports the requirement", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedUnmatchableVerification(USER_ID);
    const reads = trackReads();

    const res = await lookup(USER_ID, { callerIp: CALLER_IP });

    expect(res.status).toBe(200);
    // Gating BEFORE the membership read is what makes the disclosure decision
    // total: a rejected caller triggers no membership lookup at all.
    expect(reads).toContain(kvKeys.verify(USER_ID));
    expect(reads).not.toContain(kvKeys.member(USER_ID));
  });
});

/**
 * Replace `kv` with a wrapper that records every key passed to `get`, and return
 * the live log. The wrapper is discarded together with the per-test `kv`
 * instance (`beforeEach` builds a fresh mock), so there is nothing to restore.
 */
function trackReads(): string[] {
  const reads: string[] = [];
  const base = kv;
  const read = base.get.bind(base) as (
    key: string,
    opts?: unknown,
  ) => Promise<unknown>;
  kv = {
    ...base,
    get: async (key: string, opts?: unknown): Promise<unknown> => {
      reads.push(key);
      return read(key, opts);
    },
  } as unknown as KVNamespace;
  return reads;
}

// ===========================================================================
// OTP consumption across the lookup → create/join flow
//
// The client flow is "lookup with the secret, then create/join with the SAME
// secret". A one-time `code` secret spent by the read-only lookup would make
// that second call fail — and be charged as a failure — so every OTP login
// would break. Lookup therefore passes `consumeOtp: false`; create and join
// keep the default and spend it.
// ===========================================================================

describe("OTP consumption across the lookup → create/join flow", () => {
  it("should leave the OTP intact on lookup and spend it on the following join", async () => {
    await seedFamily([OWNER_ID]);
    const code = await issueOtp(USER_ID);
    const storedOtp = await kv.get(kvKeys.otp(USER_ID));
    expect(storedOtp).not.toBeNull();

    const lookupRes = await lookup(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });

    expect(lookupRes.status).toBe(200);
    const lookupJson = (await lookupRes.json()) as Json;
    expect(lookupJson.data.requiresVerification).toBe(BoolFlag.FALSE);
    // Byte-identical: the read-only disclosure decision did not spend the code.
    expect(await kv.get(kvKeys.otp(USER_ID))).toBe(storedOtp);

    const joinRes = await joinFamily(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });

    expect(joinRes.status).toBe(200);
    // NOW it is spent — one-time use is enforced by the call that acts on it.
    expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
    // Neither call was charged as a failure.
    expect(
      await kv.get(kvKeys.verifyFail(USER_ID, normalizeCallerIp(CALLER_IP))),
    ).toBeNull();
  });

  it("should leave the OTP intact on lookup and spend it on the following create", async () => {
    const code = await issueOtp(USER_ID);
    const storedOtp = await kv.get(kvKeys.otp(USER_ID));

    const lookupRes = await lookup(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });

    expect(lookupRes.status).toBe(200);
    expect(await kv.get(kvKeys.otp(USER_ID))).toBe(storedOtp);

    const createRes = await createFamily(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });

    expect(createRes.status).toBe(201);
    expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
  });

  it("should refuse an OTP that a previous join already spent", async () => {
    await seedFamily([OWNER_ID]);
    const code = await issueOtp(USER_ID);

    const first = await joinFamily(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });
    expect(first.status).toBe(200);

    const replay = await joinFamily(USER_ID, {
      verifySecret: code,
      callerIp: CALLER_IP,
    });

    expect(replay.status).toBe(403);
    const json = (await replay.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");
  });
});

// ===========================================================================
// verifySecret format bound
//
// A value that is not a secret at all is a REQUEST-FORMAT error, not a failed
// verification: it must answer 400 at all three entry points and must never be
// charged against the caller's failure budget or the account's ceiling.
// ===========================================================================

const MALFORMED_SECRETS = [
  { valueLabel: "a number", value: 123 },
  { valueLabel: "a boolean", value: true },
  { valueLabel: "an object", value: { pin: CORRECT_PIN } },
  {
    valueLabel: "a string one character over the length bound",
    value: "x".repeat(VERIFY_SECRET_MAX_LENGTH + 1),
  },
];

const NOT_SUPPLIED_SECRETS = [
  { valueLabel: "absent", value: undefined },
  { valueLabel: "null", value: null },
  { valueLabel: "an empty string", value: "" },
];

describe("verifySecret format validation", () => {
  it.each(
    GATE_ENDPOINTS.flatMap((endpoint) =>
      MALFORMED_SECRETS.map((secret) => ({ ...endpoint, ...secret })),
    ),
  )(
    "should reject $valueLabel with 400 INVALID_VERIFY_SECRET at $endpoint",
    async ({ call, prepare, value }) => {
      await prepare?.();

      const res = await call(USER_ID, {
        verifySecret: value,
        callerIp: CALLER_IP,
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("INVALID_VERIFY_SECRET");
      expect(json.error.message).toContain(String(VERIFY_SECRET_MAX_LENGTH));
    },
  );

  it("should charge nothing for a malformed secret", async () => {
    await seedUnmatchableVerification(USER_ID);
    const before = await snapshotKeys();

    const res = await createFamily(USER_ID, {
      verifySecret: 123,
      callerIp: CALLER_IP,
    });

    expect(res.status).toBe(400);
    // No failure streak, no counter — a format error is not an attempt.
    expect(await snapshotKeys()).toEqual(before);
  });

  it.each(GATE_ENDPOINTS)(
    "should accept a secret exactly at the length bound as a real attempt at $endpoint",
    async ({ call, prepare }) => {
      await prepare?.();
      await seedUnmatchableVerification(USER_ID);

      const res = await call(USER_ID, {
        verifySecret: "x".repeat(VERIFY_SECRET_MAX_LENGTH),
        callerIp: CALLER_IP,
      });

      // Wrong, not malformed: it reaches the comparison and fails there.
      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_FAILED");
    },
  );

  it.each(NOT_SUPPLIED_SECRETS)(
    "should treat $valueLabel as 'no secret supplied' on create",
    async ({ value }) => {
      await seedUnmatchableVerification(USER_ID);

      const res = await createFamily(USER_ID, {
        verifySecret: value,
        callerIp: CALLER_IP,
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_REQUIRED");
    },
  );

  it.each(NOT_SUPPLIED_SECRETS)(
    "should treat $valueLabel as 'no secret supplied' on join",
    async ({ value }) => {
      await seedFamily([OWNER_ID]);
      await seedUnmatchableVerification(USER_ID);

      const res = await joinFamily(USER_ID, {
        verifySecret: value,
        callerIp: CALLER_IP,
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_REQUIRED");
    },
  );
});

// ===========================================================================
// Per-userId verification attempt ceiling
//
// The caller-scoped lockout alone leaves no GLOBAL bound: the shortest allowed
// pattern has 9×8×7×6 = 3,024 combinations, so ~605 rotated /64 prefixes would
// exhaust the space at 5 tries each. The ceiling
// (`ratelimit:user:verify:{userId}`, VERIFY_ATTEMPT_MAX per window) closes that,
// and counts FAILED attempts only — a legitimate login never spends the
// account's quota.
//
// The secret is compared BEFORE the ceiling is read, so the ceiling only ever
// measures a wrong guess. That is what stops a third party from spending the
// window and locking the account OWNER out of their own onboarding: a correct
// secret is admitted no matter how spent the window is, and charges nothing.
//
// These cases run WITHOUT DEV_MODE, which every other suite sets: DEV_MODE
// short-circuits both limiters, so the ceiling would never fire. Running live
// also arms the per-IP limits — every sensitive route allows only
// `rateLimitBucketFor(...).limit` requests per address per minute — hence a
// fresh source address per request, which is precisely the attacker this
// ceiling exists to bound.
// ===========================================================================

let sourceCounter = 0;

/** A source address never used before in this test. */
function freshSourceIp(): string {
  sourceCounter += 1;
  return `203.0.113.${sourceCounter}`;
}

/**
 * The per-IP limiter's minute bucket, in ms (`BUCKET_MS` in
 * `middleware/rateLimit.ts`, which does not export it).
 *
 * Used ONLY to roll the pinned clock forward, and only by the cases that must
 * reuse ONE source address — reusing an address is the whole point of a lockout
 * case, but the sensitive tier admits just a handful of requests per address per
 * bucket and would refuse them before the gate ever saw them. If the production
 * window ever grows past this value those cases fail loudly with a per-IP
 * RATE_LIMITED where a gate verdict was expected; they cannot silently pass.
 */
const PER_IP_BUCKET_MS = 60_000;

/**
 * One live lookup from a FIXED source address, with the pinned clock rolled into
 * a fresh per-IP bucket first so the per-IP limiter never gets in the way and
 * only the gate's own verdict is observed.
 *
 * Rolling forward a few minutes is safe for everything else these cases depend
 * on: the attempt ceiling's window is an hour and the caller lockout lasts
 * VERIFY_LOCKOUT_MS (15 min).
 */
function lookupFromPinnedSource(
  callerIp: string,
  verifySecret: string,
): Promise<Response> {
  vi.setSystemTime(Date.now() + PER_IP_BUCKET_MS);
  return lookup(USER_ID, { verifySecret, callerIp, devMode: false });
}

/**
 * The counter key of the account's CURRENT attempt window, derived through the
 * production key builder (`peekPerUserRateLimit`) with the production
 * constants, so this test cannot drift from the scope/window the gate uses.
 * Pure read — peeking never charges.
 */
async function attemptCeilingKey(userId: string): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return reading.key;
}

/** Attempts charged against the account so far, or null if never charged. */
async function attemptsCharged(userId: string): Promise<number | null> {
  const raw = await kv.get(await attemptCeilingKey(userId));
  return raw === null ? null : parseInt(raw, 10);
}

describe("Per-userId verification attempt ceiling", () => {
  beforeEach(async () => {
    // Pin the clock so the 1-hour counter window cannot roll over mid-test.
    pinClock(T0);
    sourceCounter = 0;
    // Setup runs in DEV_MODE so it does not consume any of the live budgets
    // the assertions below depend on.
    await setPin(USER_ID, CORRECT_PIN);
  });

  /** One wrong guess from a never-seen source, asserted to be a plain failure. */
  async function guessWrongFromFreshSource(): Promise<void> {
    const res = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_FAILED");
  }

  /**
   * Spend the account's whole window with wrong guesses, each from a source
   * address never seen before — the rotating attacker the ceiling exists for.
   * Every one of them is still a plain 403 while budget remains; only the next
   * one is refused by the ceiling.
   */
  async function spendCeilingWithWrongGuesses(): Promise<void> {
    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      await guessWrongFromFreshSource();
    }
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_ATTEMPT_MAX);
  }

  it("should refuse further wrong guesses once the ceiling is spent, however many source addresses the attacker rotates through", async () => {
    await spendCeilingWithWrongGuesses();

    const blocked = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });

    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
    expect(Number.isInteger(json.error.retryAfter)).toBe(true);
    expect(json.error.retryAfter).toBeGreaterThan(0);
    expect(json.error.retryAfter).toBeLessThanOrEqual(
      VERIFY_ATTEMPT_WINDOW_SECONDS,
    );
    expect(blocked.headers.get("Retry-After")).toBe(
      String(json.error.retryAfter),
    );

    // A refused attempt does not extend the window.
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_ATTEMPT_MAX);
  });

  it("should answer a wrong guess with 403 under the ceiling and 429 over it", async () => {
    // The last guess the window still has room for is a PLAIN verification
    // failure; the very next one is refused by the ceiling instead. Pins the
    // boundary between the two refusals, which differ in status AND in code.
    for (let i = 0; i < VERIFY_ATTEMPT_MAX - 1; i++) {
      await guessWrongFromFreshSource();
    }

    const lastAllowed = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });
    expect(lastAllowed.status).toBe(403);
    expect(((await lastAllowed.json()) as Json).error.code).toBe(
      "VERIFICATION_FAILED",
    );

    const overCeiling = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });
    expect(overCeiling.status).toBe(429);
    expect(((await overCeiling.json()) as Json).error.code).toBe(
      "RATE_LIMITED",
    );
  });

  it("should still charge the caller's own streak for a guess the spent ceiling refuses", async () => {
    await spendCeilingWithWrongGuesses();

    const callerIp = freshSourceIp();
    const res = await lookup(USER_ID, {
      verifySecret: WRONG_PIN,
      callerIp,
      devMode: false,
    });
    expect(res.status).toBe(429);

    // The account-wide window is NOT extended by a refusal...
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_ATTEMPT_MAX);
    // ...but the guess still counts against THIS caller's lockout streak, so a
    // refused attacker cannot keep guessing for free once the window rolls.
    const fail = (await kv.get(
      kvKeys.verifyFail(USER_ID, normalizeCallerIp(callerIp)),
      "json",
    )) as VerifyFailRecord | null;
    expect(fail?.failCount).toBe(1);
  });

  it.each(GATE_ENDPOINTS)(
    "should admit the correct secret at $endpoint even when the ceiling is spent",
    async ({ call, prepare, successStatus }) => {
      // The reason the comparison happens BEFORE the ceiling is read: the
      // ceiling is keyed on the TARGET userId, so consulting it first would let
      // any third party spend the window and lock the owner out of onboarding.
      await prepare?.();
      await spendCeilingWithWrongGuesses();

      const callerIp = freshSourceIp();
      const res = await call(USER_ID, {
        verifySecret: CORRECT_PIN,
        callerIp,
        devMode: false,
      });

      expect(res.status).toBe(successStatus);
      // ...and it consumes nothing: the ceiling is never even read on the
      // success path, and this caller has no failure streak to leave behind.
      expect(await attemptsCharged(USER_ID)).toBe(VERIFY_ATTEMPT_MAX);
      expect(
        await kv.get(kvKeys.verifyFail(USER_ID, normalizeCallerIp(callerIp))),
      ).toBeNull();
    },
  );

  it("should never spend the ceiling on a successful verification", async () => {
    for (let i = 0; i < VERIFY_ATTEMPT_MAX + 2; i++) {
      const res = await lookup(USER_ID, {
        verifySecret: CORRECT_PIN,
        callerIp: freshSourceIp(),
        devMode: false,
      });
      expect(res.status).toBe(200);
    }

    // Well past the ceiling in request count, yet the counter was never even
    // created — legitimate logins cannot exhaust the account's own budget.
    expect(await attemptsCharged(USER_ID)).toBeNull();
  });

  it("should count only the wrong guesses interleaved with successful logins", async () => {
    for (const secret of [WRONG_PIN, CORRECT_PIN, WRONG_PIN, CORRECT_PIN]) {
      await lookup(USER_ID, {
        verifySecret: secret,
        callerIp: freshSourceIp(),
        devMode: false,
      });
    }

    expect(await attemptsCharged(USER_ID)).toBe(2);
  });

  it("should not spend the ceiling when no secret is supplied", async () => {
    // Probing create with no secret is the cheapest possible request; if it
    // charged, a stranger could lock the account owner out of their own login.
    for (let i = 0; i < VERIFY_ATTEMPT_MAX + 2; i++) {
      const res = await createFamily(USER_ID, {
        callerIp: freshSourceIp(),
        devMode: false,
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_REQUIRED");
    }

    expect(await attemptsCharged(USER_ID)).toBeNull();
    // And a real attempt afterwards is still a normal failure, not a 429.
    await guessWrongFromFreshSource();
  });

  it("should not spend the ceiling on a malformed verifySecret", async () => {
    for (let i = 0; i < VERIFY_ATTEMPT_MAX + 2; i++) {
      const res = await lookup(USER_ID, {
        verifySecret: 123,
        callerIp: freshSourceIp(),
        devMode: false,
      });
      expect(res.status).toBe(400);
    }

    expect(await attemptsCharged(USER_ID)).toBeNull();
    await guessWrongFromFreshSource();
  });

  it("should not spend the ceiling for a caller who is already locked out", async () => {
    // One address throughout — that is what a lockout is keyed on. The per-IP
    // minute limiter would refuse this run long before the lockout arrives, so
    // every call steps the pinned clock into a fresh per-IP bucket first; the
    // hour-long ceiling window and the 15-minute lockout both outlive that.
    const lockedOutIp = freshSourceIp();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      const res = await lookupFromPinnedSource(lockedOutIp, WRONG_PIN);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe(
        "VERIFICATION_FAILED",
      );
    }
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_MAX_FAILURES);

    // The ceiling is read AFTER the lockout check, so a locked-out caller can
    // no longer burn the victim's remaining budget.
    for (let i = 0; i < 2; i++) {
      const res = await lookupFromPinnedSource(lockedOutIp, WRONG_PIN);
      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_LOCKED");
    }

    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_MAX_FAILURES);
  });

  it("should let the locked-out caller's own correct secret wait out the lockout, not the ceiling", async () => {
    // A locked caller is refused by brake 1 regardless of correctness — the
    // lockout check runs before the comparison — and that refusal, too, charges
    // nothing to the account's window.
    const lockedOutIp = freshSourceIp();
    for (let i = 0; i < VERIFY_MAX_FAILURES; i++) {
      expect(
        (await lookupFromPinnedSource(lockedOutIp, WRONG_PIN)).status,
      ).toBe(403);
    }

    const res = await lookupFromPinnedSource(lockedOutIp, CORRECT_PIN);
    expect(res.status).toBe(429);
    expect(((await res.json()) as Json).error.code).toBe("VERIFICATION_LOCKED");
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_MAX_FAILURES);

    // A different caller with the same correct secret is unaffected: the
    // lockout is on the caller, never on the account.
    const other = await lookup(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });
    expect(other.status).toBe(200);
  });

  it("should not spend the join quota on a malformed verifySecret", async () => {
    await seedFamily([OWNER_ID]);

    // More malformed bodies than the join ceiling allows requests. If the
    // format check ran after the counter, the legitimate join below would be
    // rate-limited instead of admitted.
    for (let i = 0; i < 11; i++) {
      const res = await joinFamily(USER_ID, {
        verifySecret: 123,
        callerIp: freshSourceIp(),
        devMode: false,
      });
      expect(res.status).toBe(400);
    }

    const res = await joinFamily(USER_ID, {
      verifySecret: CORRECT_PIN,
      callerIp: freshSourceIp(),
      devMode: false,
    });
    expect(res.status).toBe(200);
  });

  it("should leave the ceiling unenforced under DEV_MODE", async () => {
    // Documented: DEV_MODE skips the ceiling exactly like every other limiter,
    // leaving the caller-scoped lockout as the only brake. Local dev and E2E
    // runs depend on it; production never sets it.
    for (let i = 0; i < VERIFY_ATTEMPT_MAX * 2; i++) {
      const res = await lookup(USER_ID, {
        verifySecret: WRONG_PIN,
        callerIp: freshSourceIp(),
      });
      expect(res.status).toBe(403);
    }

    expect(await attemptsCharged(USER_ID)).toBeNull();
  });
});
