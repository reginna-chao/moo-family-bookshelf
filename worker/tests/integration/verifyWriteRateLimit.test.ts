import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { ALICE, BOB } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type VerifyMethod,
  type VerifyRecord,
} from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { VERIFY_WRITE_LIMIT } from "../../src/routes/verify";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/services/verification";

// ===========================================================================
// Per-userId write ceiling on the verify-domain write handlers
//
// The four AUTHENTICATED write handlers — PUT /api/user/:id/verify,
// POST /api/user/:id/verify/otp, POST /api/user/:id/verify/prompted and
// POST /api/user/:id/qr-token — share ONE per-userId counter, so a single
// account cannot drain the Worker's daily KV write quota by rotating source
// addresses. The public GET /api/user/:id/verify is deliberately NOT limited.
//
// Everything here runs WITHOUT DEV_MODE, which every verify suite sets:
// DEV_MODE short-circuits `enforcePerUserRateLimit`, so the ceiling would never
// fire. Setup that must not spend the live budget goes through the DEV_MODE
// helper (`devRequest`) on purpose.
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/** The account whose write budget is under test. */
const USER_ID = ALICE;
/** A second, unrelated account — used for the foreign-token cases. */
const OTHER_USER_ID = BOB;

const CORRECT_PIN = "123456";
const WRONG_PIN = "000000";

/**
 * The very options object the four `enforcePerUserRateLimit` call sites in
 * `src/routes/verify.ts` spread, imported rather than copied — so the boundary
 * cases below (last write admitted, next one refused) track any change to the
 * ceiling instead of silently drifting from it. The counter KEY is likewise
 * always derived through the production key builder (`peekPerUserRateLimit`).
 */
const {
  scope: WRITE_SCOPE,
  max: WRITE_MAX,
  windowSec: WRITE_WINDOW_SECONDS,
} = VERIFY_WRITE_LIMIT;

const WRITE_WINDOW_MS = WRITE_WINDOW_SECONDS * 1000;

/**
 * Exactly mid-window, so the counter cannot roll over mid-test AND the back-off
 * hint is deterministic. Derived from the production window length rather than
 * hard-coded, so a changed window keeps the pin exact.
 */
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WRITE_WINDOW_MS) *
    WRITE_WINDOW_MS +
  WRITE_WINDOW_MS / 2;

/** Back-off the mid-window pin must produce: half the window, rounded up. */
const EXPECTED_RETRY_AFTER = Math.ceil(WRITE_WINDOW_SECONDS / 2);

// --- Requests ------------------------------------------------------------

interface RequestOptions {
  body?: string;
  /** Sent as `Authorization: Bearer …`; omit to send no credentials at all. */
  token?: string;
  /** Sent as `cf-connecting-ip` — the only caller identity the Worker trusts. */
  callerIp?: string;
}

async function buildRequest(
  method: string,
  path: string,
  opts: RequestOptions,
  env: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.callerIp) headers["cf-connecting-ip"] = opts.callerIp;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = opts.body;
  return app.request(path, init, env);
}

/** Live request: no DEV_MODE, so both limiters run. */
function prodRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv });
}

/** DEV_MODE request: every limiter short-circuits — for setup only. */
function devRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv, DEV_MODE: "1" });
}

// --- Seeding -------------------------------------------------------------

/** Deterministic 64-hex auth token for a userId, same shape as a real one. */
function tokenFor(userId: string): string {
  return userId.slice(0, 32).repeat(2);
}

const AUTH_TOKEN = tokenFor(USER_ID);
const OTHER_AUTH_TOKEN = tokenFor(OTHER_USER_ID);

async function seedAuthToken(userId: string): Promise<void> {
  const token = tokenFor(userId);
  await kv.put(kvKeys.authToken(token), userId);
  await kv.put(
    kvKeys.auth(userId),
    JSON.stringify({ token, createdAt: new Date().toISOString() }),
  );
}

/** Verify record with no usable secret — enough to reach a handler's happy path. */
async function seedVerifyMethod(
  userId: string,
  method: VerifyMethod,
): Promise<void> {
  const record: VerifyRecord = { method, hash: null, salt: null, prompted: 1 };
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

/** Set a real PIN through the production route, so hash + salt are genuine. */
async function setPin(userId: string, pin: string): Promise<void> {
  await seedAuthToken(userId);
  const res = await devRequest("PUT", `/api/user/${userId}/verify`, {
    body: JSON.stringify({ method: "pin", secret: pin }),
    token: tokenFor(userId),
  });
  expect(res.status).toBe(200);
}

// --- Counter inspection --------------------------------------------------

/** Counter key of the user's CURRENT write window, via the production builder. */
async function writeCounterKey(userId: string): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId,
    scope: WRITE_SCOPE,
    max: WRITE_MAX,
    windowSec: WRITE_WINDOW_SECONDS,
  });
  return reading.key;
}

/** Counter key of the verification gate's attempt window, same builder. */
async function attemptCounterKey(userId: string): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return reading.key;
}

/**
 * The scope-carrying prefix of a counter key, cut at the userId it embeds —
 * derived from a production-built key rather than spelled out here, so the key
 * shape stays owned by `peekPerUserRateLimit` alone.
 */
function counterPrefix(key: string, userId: string): string {
  return key.slice(0, key.indexOf(userId));
}

async function countAt(key: string): Promise<number | null> {
  const raw = await kv.get(key);
  return raw === null ? null : parseInt(raw, 10);
}

/** Writes charged to the account so far, or null if never charged. */
async function writesCharged(userId: string): Promise<number | null> {
  return countAt(await writeCounterKey(userId));
}

/** Failed verification attempts charged to the account, or null if never. */
async function attemptsCharged(userId: string): Promise<number | null> {
  return countAt(await attemptCounterKey(userId));
}

/** Every key currently in KV that starts with `prefix`. */
async function keysWithPrefix(prefix: string): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).filter((name) => name.startsWith(prefix));
}

/** Every verify-write counter key currently in KV, whatever the userId. */
async function writeCounterKeys(): Promise<string[]> {
  const prefix = counterPrefix(await writeCounterKey(USER_ID), USER_ID);
  return keysWithPrefix(prefix);
}

/** Pre-spend `used` slots — far cheaper than driving 30 real writes. */
async function spendWriteBudget(userId: string, used: number): Promise<void> {
  await kv.put(await writeCounterKey(userId), String(used), {
    expirationTtl: WRITE_WINDOW_SECONDS * 2,
  });
}

let sourceCounter = 0;

/** A source address never used before in this test. */
function freshSourceIp(): string {
  sourceCounter += 1;
  return `203.0.113.${sourceCounter}`;
}

// --- Endpoint table ------------------------------------------------------

interface WriteEndpoint {
  label: string;
  /** Seed whatever the handler needs to reach 200 (only OTP needs anything). */
  prepare?: () => Promise<void>;
  /** `token` is always explicit — omitting it means "send no credentials". */
  call: (token?: string) => Promise<Response>;
  /** Status for a VALID token belonging to a DIFFERENT user. */
  foreignTokenStatus: number;
}

/**
 * The four authenticated write endpoints that share the ceiling. Driving all of
 * them from one table is what proves the limit is a property of the SCOPE, not
 * of a single handler.
 */
const WRITE_ENDPOINTS: WriteEndpoint[] = [
  {
    label: "PUT verify",
    call: (token) =>
      prodRequest("PUT", `/api/user/${USER_ID}/verify`, {
        body: JSON.stringify({ method: "none" }),
        token,
      }),
    foreignTokenStatus: 401,
  },
  {
    label: "POST verify/otp",
    // The handler refuses with 400 unless the account is on the `code` method;
    // the ceiling runs before that check, but the admitted case needs it.
    prepare: () => seedVerifyMethod(USER_ID, "code"),
    call: (token) =>
      prodRequest("POST", `/api/user/${USER_ID}/verify/otp`, {
        body: "{}",
        token,
      }),
    foreignTokenStatus: 401,
  },
  {
    label: "POST verify/prompted",
    call: (token) =>
      prodRequest("POST", `/api/user/${USER_ID}/verify/prompted`, {
        body: "{}",
        token,
      }),
    foreignTokenStatus: 401,
  },
  {
    label: "POST qr-token",
    call: (token) =>
      prodRequest("POST", `/api/user/${USER_ID}/qr-token`, {
        body: "{}",
        token,
      }),
    // Documented asymmetry: this handler answers a token for someone else's id
    // with 403 FORBIDDEN rather than 401.
    foreignTokenStatus: 403,
  },
];

/** One cheap, precondition-free write — used wherever the endpoint is arbitrary. */
function promptedWrite(token?: string): Promise<Response> {
  return prodRequest("POST", `/api/user/${USER_ID}/verify/prompted`, {
    body: "{}",
    token,
  });
}

beforeEach(() => {
  kv = createMockKV();
  sourceCounter = 0;
  // Pin Date (timers stay real) so the 1-hour window cannot roll over between
  // seeding the counter and the request under test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Verify-domain per-userId write ceiling", () => {
  it.each(WRITE_ENDPOINTS)(
    "charges exactly one slot for $label and keeps the counter self-expiring",
    async ({ prepare, call }) => {
      await seedAuthToken(USER_ID);
      await prepare?.();

      const res = await call(AUTH_TOKEN);

      expect(res.status).toBe(200);
      expect(await writesCharged(USER_ID)).toBe(1);
      // Without a TTL the counter would live in KV forever.
      expect(getPutTtl(kv, await writeCounterKey(USER_ID))).toBe(
        WRITE_WINDOW_SECONDS * 2,
      );
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "refuses $label with 429 once the shared window is spent",
    async ({ prepare, call }) => {
      await seedAuthToken(USER_ID);
      await prepare?.();
      await spendWriteBudget(USER_ID, WRITE_MAX);

      const res = await call(AUTH_TOKEN);

      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
      // The pinned clock sits exactly mid-window, so the back-off hint is half
      // the window — which also pins the window length end to end.
      expect(Number.isInteger(json.error.retryAfter)).toBe(true);
      expect(json.error.retryAfter).toBe(EXPECTED_RETRY_AFTER);
      expect(json.error.retryAfter).toBeGreaterThan(0);
      expect(res.headers.get("Retry-After")).toBe(
        String(json.error.retryAfter),
      );
      // A refused write must not extend the window.
      expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
    },
  );

  it("charges the shared window even when the handler then rejects the request", async () => {
    await seedAuthToken(USER_ID);
    // `pin`, not `code` — so the OTP handler's own precondition refuses this.
    await seedVerifyMethod(USER_ID, "pin");

    const res = await prodRequest("POST", `/api/user/${USER_ID}/verify/otp`, {
      body: "{}",
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_METHOD");
    // The request did no work at all — no OTP was pushed...
    expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
    // ...and it still cost a slot. Charging BEFORE the handler's body parse and
    // precondition checks is what stops a malformed-request loop from retrying
    // for free; moving the ceiling below those checks must fail here.
    expect(await writesCharged(USER_ID)).toBe(1);
  });

  it("counts PUT verify, OTP, prompted and qr-token against ONE shared window", async () => {
    await seedAuthToken(USER_ID);
    await spendWriteBudget(USER_ID, WRITE_MAX - WRITE_ENDPOINTS.length);

    // PUT verify goes first on purpose: switching the account to the `code`
    // method is also the precondition the OTP handler needs.
    const set = await prodRequest("PUT", `/api/user/${USER_ID}/verify`, {
      body: JSON.stringify({ method: "code" }),
      token: AUTH_TOKEN,
    });
    expect(set.status).toBe(200);

    const otp = await prodRequest("POST", `/api/user/${USER_ID}/verify/otp`, {
      body: "{}",
      token: AUTH_TOKEN,
    });
    expect(otp.status).toBe(200);

    const prompted = await promptedWrite(AUTH_TOKEN);
    expect(prompted.status).toBe(200);

    const qr = await prodRequest("POST", `/api/user/${USER_ID}/qr-token`, {
      body: "{}",
      token: AUTH_TOKEN,
    });
    expect(qr.status).toBe(200);

    // Four different handlers, one counter.
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
    expect(await writeCounterKeys()).toHaveLength(1);

    // The next write is legal on every count except the shared window — which
    // is exactly what the scope enforces.
    const refused = await promptedWrite(AUTH_TOKEN);
    expect(refused.status).toBe(429);
  });

  it("admits the last write the window has room for and refuses the next handler", async () => {
    await seedAuthToken(USER_ID);
    await spendWriteBudget(USER_ID, WRITE_MAX - 1);

    const lastAllowed = await promptedWrite(AUTH_TOKEN);
    expect(lastAllowed.status).toBe(200);
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);

    // A DIFFERENT handler, the same exhausted window.
    const overCeiling = await prodRequest(
      "POST",
      `/api/user/${USER_ID}/qr-token`,
      { body: "{}", token: AUTH_TOKEN },
    );
    expect(overCeiling.status).toBe(429);
  });

  it("does not extend the window when a refused caller keeps retrying", async () => {
    await seedAuthToken(USER_ID);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    for (let i = 0; i < 3; i++) {
      const res = await promptedWrite(AUTH_TOKEN);
      expect(res.status).toBe(429);
    }

    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });

  it("performs no verify-domain KV write at all while the window is spent", async () => {
    await seedAuthToken(USER_ID);
    await seedVerifyMethod(USER_ID, "code");
    const recordBefore = await kv.get(kvKeys.verify(USER_ID));
    await spendWriteBudget(USER_ID, WRITE_MAX);

    for (const { call } of WRITE_ENDPOINTS) {
      const res = await call(AUTH_TOKEN);
      expect(res.status).toBe(429);
    }

    // Byte-identical account record, no OTP pushed, no QR token minted.
    expect(await kv.get(kvKeys.verify(USER_ID))).toBe(recordBefore);
    expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
    expect(await keysWithPrefix(kvKeys.qrToken(""))).toHaveLength(0);
  });

  it("counts each userId independently", async () => {
    await seedAuthToken(USER_ID);
    await seedAuthToken(OTHER_USER_ID);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const blocked = await promptedWrite(AUTH_TOKEN);
    expect(blocked.status).toBe(429);

    const allowed = await prodRequest(
      "POST",
      `/api/user/${OTHER_USER_ID}/verify/prompted`,
      { body: "{}", token: OTHER_AUTH_TOKEN },
    );
    expect(allowed.status).toBe(200);
    expect(await writesCharged(OTHER_USER_ID)).toBe(1);
  });

  it("does not apply the write ceiling in dev mode", async () => {
    await seedAuthToken(USER_ID);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    // Same request through the DEV_MODE helper — local wrangler dev and E2E
    // runs must not be throttled.
    const res = await devRequest(
      "POST",
      `/api/user/${USER_ID}/verify/prompted`,
      { body: "{}", token: AUTH_TOKEN },
    );

    expect(res.status).toBe(200);
    // Dev mode neither reads nor charges the counter.
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });
});

// ===========================================================================
// Auth ordering
//
// The ceiling sits AFTER each handler's auth guard on purpose: an unauthenticated
// stranger must be able neither to SPEND the account owner's write budget nor to
// OBSERVE it (a 429 where a 401 belongs would confirm the account exists and is
// active).
// ===========================================================================

describe("Verify-domain write ceiling — auth ordering", () => {
  it.each(WRITE_ENDPOINTS)(
    "answers $label with 401 without charging the account",
    async ({ prepare, call }) => {
      await seedAuthToken(USER_ID);
      await prepare?.();

      const res = await call();

      expect(res.status).toBe(401);
      expect(await writesCharged(USER_ID)).toBeNull();
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "answers $label with $foreignTokenStatus for another user's token without charging either account",
    async ({ prepare, call, foreignTokenStatus }) => {
      await seedAuthToken(USER_ID);
      await seedAuthToken(OTHER_USER_ID);
      await prepare?.();

      const res = await call(OTHER_AUTH_TOKEN);

      expect(res.status).toBe(foreignTokenStatus);
      expect(await writesCharged(USER_ID)).toBeNull();
      expect(await writesCharged(OTHER_USER_ID)).toBeNull();
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "still answers $label with an auth error rather than 429 once the window is spent",
    async ({ prepare, call, foreignTokenStatus }) => {
      await seedAuthToken(USER_ID);
      await seedAuthToken(OTHER_USER_ID);
      await prepare?.();
      await spendWriteBudget(USER_ID, WRITE_MAX);

      // A stranger learns nothing about the victim's budget...
      const anonymous = await call();
      expect(anonymous.status).toBe(401);

      const foreign = await call(OTHER_AUTH_TOKEN);
      expect(foreign.status).toBe(foreignTokenStatus);

      // ...and spends neither the victim's window nor one of their own.
      expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
      expect(await writesCharged(OTHER_USER_ID)).toBeNull();
    },
  );
});

// ===========================================================================
// The public read stays outside the ceiling
//
// GET /api/user/:id/verify is what the PWA calls BEFORE login to learn which
// verification method to prompt for. Limiting it on the owner's write budget
// would let a spent window (or a third party who somehow spent it) hide the
// login prompt.
// ===========================================================================

describe("Verify-domain write ceiling — public read", () => {
  it("serves the public GET with no token even when the write window is spent", async () => {
    await seedVerifyMethod(USER_ID, "pin");

    const beforeSpend = await prodRequest("GET", `/api/user/${USER_ID}/verify`);
    expect(beforeSpend.status).toBe(200);
    // A read must not create a write counter at all.
    expect(await writeCounterKeys()).toHaveLength(0);

    await spendWriteBudget(USER_ID, WRITE_MAX);

    const afterSpend = await prodRequest("GET", `/api/user/${USER_ID}/verify`);
    expect(afterSpend.status).toBe(200);
    const json = (await afterSpend.json()) as Json;
    expect(json.data.method).toBe("pin");
    expect(json.data.prompted).toBe(1);
    // Reading charged nothing to the spent window either.
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });
});

// ===========================================================================
// Cross-scope isolation — the core invariant of this change
//
// The write ceiling's scope is deliberately DISTINCT from the verification
// gate's wrong-guess attempt ceiling (`VERIFY_ATTEMPT_SCOPE`, 10/hr, in
// `services/verification.ts`). Sharing one counter would let an attacker's wrong
// guesses crowd out the owner's own settings writes, and the owner's settings
// writes weaken the brute-force bound — both directions are covered below.
// ===========================================================================

describe("Verify-domain write ceiling — isolation from the verification gate", () => {
  it("keys the two ceilings under prefixes that cannot alias each other", async () => {
    expect(WRITE_SCOPE).not.toBe(VERIFY_ATTEMPT_SCOPE);

    const writeKey = await writeCounterKey(USER_ID);
    const attemptKey = await attemptCounterKey(USER_ID);
    expect(writeKey).not.toBe(attemptKey);

    // Same userId and same window length, so the scope segment is the ONLY
    // thing keeping the two counters apart — and neither prefix may be a prefix
    // of the other, or a `startsWith` scan would sweep up both.
    const writePrefix = counterPrefix(writeKey, USER_ID);
    const attemptPrefix = counterPrefix(attemptKey, USER_ID);
    expect(writePrefix.startsWith(attemptPrefix)).toBe(false);
    expect(attemptPrefix.startsWith(writePrefix)).toBe(false);
  });

  it("still answers a wrong guess at the gate with 403, not 429, when the write window is spent", async () => {
    await setPin(USER_ID, CORRECT_PIN);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const res = await prodRequest("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER_ID, verifySecret: WRONG_PIN }),
      callerIp: freshSourceIp(),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("VERIFICATION_FAILED");
    // The guess was charged to the GATE's own scope, and the write window is
    // untouched by it.
    expect(await attemptsCharged(USER_ID)).toBe(1);
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });

  it("still admits the correct secret at the gate when the write window is spent", async () => {
    await setPin(USER_ID, CORRECT_PIN);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const res = await prodRequest("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER_ID, verifySecret: CORRECT_PIN }),
      callerIp: freshSourceIp(),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.requiresVerification).toBe(BoolFlag.FALSE);
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });

  it("leaves the write budget intact when the gate's attempt window is spent by wrong guesses", async () => {
    await setPin(USER_ID, CORRECT_PIN);

    // A rotating attacker: one never-seen source address per guess, because the
    // per-IP limiter on the sensitive tier would otherwise refuse them first.
    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      const res = await prodRequest("POST", "/api/auth/lookup", {
        body: JSON.stringify({ userId: USER_ID, verifySecret: WRONG_PIN }),
        callerIp: freshSourceIp(),
      });
      expect(res.status).toBe(403);
    }
    expect(await attemptsCharged(USER_ID)).toBe(VERIFY_ATTEMPT_MAX);

    // The next guess is refused by the GATE's ceiling...
    const blocked = await prodRequest("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER_ID, verifySecret: WRONG_PIN }),
      callerIp: freshSourceIp(),
    });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as Json).error.code).toBe("RATE_LIMITED");

    // ...while the owner's write budget was never touched, so their own
    // settings write still goes through and starts the window from zero.
    expect(await writesCharged(USER_ID)).toBeNull();
    const write = await promptedWrite(AUTH_TOKEN);
    expect(write.status).toBe(200);
    expect(await writesCharged(USER_ID)).toBe(1);
  });

  it("does not spend the gate's attempt window when the owner writes their settings", async () => {
    await setPin(USER_ID, CORRECT_PIN);
    await spendWriteBudget(USER_ID, WRITE_MAX - 1);

    const write = await promptedWrite(AUTH_TOKEN);
    expect(write.status).toBe(200);
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);

    // Settings writes are not guesses: the gate's counter was never created, so
    // the owner keeps their full guessing budget for the PWA login that follows.
    expect(await attemptsCharged(USER_ID)).toBeNull();
    const login = await prodRequest("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: USER_ID, verifySecret: CORRECT_PIN }),
      callerIp: freshSourceIp(),
    });
    expect(login.status).toBe(200);
  });
});
