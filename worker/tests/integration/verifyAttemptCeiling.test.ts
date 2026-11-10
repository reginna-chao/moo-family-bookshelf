import { inspect } from "node:util";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  createRateLimitBindings,
  type RateLimitDecider,
} from "../helpers/rateLimitBindings";
import { seedAuthToken } from "../helpers/auth";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  VERIFY_HASH_VERSION_PEPPER,
  type VerifyRecord,
} from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { VERIFY_SET_LIMIT } from "../../src/routes/verify";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
  VERIFY_STEP_UP_ATTEMPT_MAX,
  VERIFY_STEP_UP_ATTEMPT_SCOPE,
} from "../../src/services/verification";
import {
  hashAuthToken,
  hashSecret,
  hashSecretWithPepper,
  pepperFingerprint,
} from "../../src/utils/crypto";

/**
 * The verification gate's two per-account limits, through the real Hono app.
 *
 * Order of the gate, first match wins: nothing configured ⇒ pass; locked caller
 * ⇒ 429 VERIFICATION_LOCKED; unverifiable hash ⇒ 503; no secret ⇒ 403; corrupted
 * record ⇒ pass; per-minute limit spent ⇒ 429 RATE_LIMITED (`retryAfter` 60);
 * hourly budget spent ⇒ 429 RATE_LIMITED (`retryAfter` = the rest of the window);
 * correct ⇒ pass; wrong ⇒ 403 and both counters charged.
 *
 * Once either limit is spent, a correct and a wrong secret get the SAME answer:
 * nothing is compared, the submitted secret is not hashed, `otp:{userId}` is not
 * read and nothing is written. A device whose session is still valid keeps its
 * way back in: a QR Code needs no secret and never touches these limits.
 *
 * Separate budgets: public login traffic uses `verify` + `verify-burst`, 10 an
 * hour on the account; the current-secret step-up (`PUT /api/user/:id/verify`,
 * `DELETE /api/user/:id`) uses `verify-stepup` + `verify-stepup-burst`, 5 an hour
 * per token (subject `{userId}:{hash}` for an unmarked token), so neither can
 * spend the other. A successful `PUT /api/user/:id/verify` deletes the current
 * window of `verify` only, right after the record write. How step-up budgets
 * divide between tokens is in `loginRecoveryScenarios.test.ts`.
 *
 * `verify-burst` / `verify-stepup-burst` live on the native binding alone: no
 * binding, or one that throws, means "not limited" with a log line and no KV
 * write. Log assertions inject an error carrying the userId, because a Worker log
 * must carry no identifier (#357).
 *
 * Harness: every request runs WITHOUT DEV_MODE unless a case says otherwise, with
 * binding stubs in the env (the per-IP tier then stays off KV) and a source
 * address never used before, which keeps the caller-scoped lockout out of the
 * way. `Date` is pinned mid-window, so `retryAfter` is exactly half the window and
 * no bucket rolls over by accident. Setup goes through DEV_MODE so it spends
 * nothing. `spend` seeds a counter directly; the first case spends one for real.
 *
 * KV FALLBACK, on purpose: the env carries the Rate Limiting stubs but no
 * `ATTEMPT_BUDGET` binding, so the hourly budgets run on their KV counter
 * (`ratelimit:user:verify*`), which these cases seed and read — the path a
 * self-hosted Worker without the Durable Object takes. Each budget-checking
 * request therefore logs `ATTEMPT_BUDGET_BINDING_MISSING` once, and the cases
 * that pin the full `console.error` list include it. The Durable Object path is
 * in `verifyAttemptBudgetDurable.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;
let sourceCounter = 0;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const NEW_PIN = "654321";
const WRONG_PIN = "000000";
const SALT = "ab".repeat(16);
const PEPPER = "server-pepper-0123456789abcdef";
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const REST_OF_WINDOW = VERIFY_ATTEMPT_WINDOW_SECONDS / 2;
const BURST_WINDOW = 60;
const LOGIN_BURST_KEY = `ratelimit:user:verify-burst:${USER_ID}`;
const REAL_BOOK_ID = "210439468000101";

type Env = Record<string, unknown>;

function freshIp(): string {
  sourceCounter += 1;
  return `203.0.${Math.floor(sourceCounter / 250)}.${sourceCounter % 250}`;
}

// No ATTEMPT_BUDGET: the hourly budgets take their KV fallback. See the header → "KV FALLBACK".
function prodEnv(decide?: RateLimitDecider) {
  const { bindings, calls } = createRateLimitBindings(decide);
  return { env: { KV: kv, ...bindings } as Env, calls };
}

const devEnv = (): Env => ({ KV: kv, DEV_MODE: "1" });

async function send(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; env?: Env; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": opts.ip ?? freshIp(),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return app.request(path, init, opts.env ?? prodEnv().env);
}

const LOOKUP_PATH = "/api/auth/lookup";
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;

const ENTRY_POINTS = [
  {
    label: "POST /api/auth/lookup",
    path: LOOKUP_PATH,
    prepare: () => seedFamily([OWNER_ID, USER_ID]),
  },
  {
    label: "POST /api/family",
    path: "/api/family",
    prepare: async () => {},
  },
  {
    label: "POST /api/family/:id/join",
    path: `/api/family/${FAMILY_ID}/join`,
    prepare: () => seedFamily([OWNER_ID]),
  },
];

function gate(path: string, verifySecret: string | undefined, env?: Env) {
  return send("POST", path, { body: { userId: USER_ID, verifySecret }, env });
}

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
      createdAt: new Date(PINNED_NOW).toISOString(),
    }),
  );
}

/** Set a real PIN through the production route (DEV_MODE); returns the token now current. */
async function setPin(pin: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await send("PUT", VERIFY_PATH, {
    body: { method: "pin", secret: pin },
    token: seeded,
    env: devEnv(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** The current window's counter key of an hourly budget, via the production builder. */
async function budgetKey(scope: string): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    scope,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return key;
}

async function budgetCount(scope: string): Promise<number | null> {
  const raw = await kv.get(await budgetKey(scope));
  return raw === null ? null : parseInt(raw, 10);
}

async function spend(scope: string, used = VERIFY_ATTEMPT_MAX): Promise<void> {
  await kv.put(await budgetKey(scope), String(used));
}

/** The step-up subject of an unmarked `token`. */
async function stepUpSubject(token: string): Promise<string> {
  return `${USER_ID}:${await hashAuthToken(token)}`;
}

/** `token`'s own step-up budget key, via the production builder. */
async function stepUpKey(token: string): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: await stepUpSubject(token),
    scope: VERIFY_STEP_UP_ATTEMPT_SCOPE,
    max: VERIFY_STEP_UP_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return key;
}

async function stepUpCount(token: string): Promise<number | null> {
  const raw = await kv.get(await stepUpKey(token));
  return raw === null ? null : parseInt(raw, 10);
}

async function spendStepUp(
  token: string,
  used = VERIFY_STEP_UP_ATTEMPT_MAX,
): Promise<void> {
  await kv.put(await stepUpKey(token), String(used));
}

function storedMethod(): Promise<string | undefined> {
  return kv
    .get<VerifyRecord>(kvKeys.verify(USER_ID), "json")
    .then((record) => record?.method);
}

/** Silence and record console output; `text()` is everything logged, errors with their stacks. */
function captureLogs() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  return {
    errors: () => spies[2].mock.calls,
    text: () =>
      inspect(
        spies.flatMap((spy) => spy.mock.calls),
        { depth: 6 },
      ),
  };
}

const RATE_LIMITED_BODY = (retryAfter: number) => ({
  error: { code: "RATE_LIMITED", message: RATE_LIMITED_MESSAGE, retryAfter },
});

beforeEach(() => {
  kv = createMockKV();
  sourceCounter = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hourly attempt budget — spent by wrong guesses", () => {
  it("answers 60 wrong guesses from many source addresses with 10 × 403 then 50 × 429, the counter stopping at 10", async () => {
    await setPin(PIN);

    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      statuses.push((await gate(LOOKUP_PATH, WRONG_PIN)).status);
    }

    expect(statuses).toEqual([
      ...Array<number>(VERIFY_ATTEMPT_MAX).fill(403),
      ...Array<number>(60 - VERIFY_ATTEMPT_MAX).fill(429),
    ]);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
  });

  it.each(ENTRY_POINTS)(
    "refuses the correct secret at $label exactly like a wrong one, writing nothing and issuing nothing",
    async ({ path, prepare }) => {
      await prepare();
      await setPin(PIN);
      await spend(VERIFY_ATTEMPT_SCOPE);
      const ops = watchKvOps(kv);

      const wrong = await gate(path, WRONG_PIN);
      const correct = await gate(path, PIN);

      expect(correct.status).toBe(429);
      expect(wrong.status).toBe(429);
      const correctBody = await correct.text();
      expect(correctBody).toBe(await wrong.text());
      expect(JSON.parse(correctBody)).toEqual(
        RATE_LIMITED_BODY(REST_OF_WINDOW),
      );
      expect(correct.headers.get("Retry-After")).toBe(String(REST_OF_WINDOW));
      expect(correctBody).not.toContain("authToken");
      expect(correctBody).not.toContain(FAMILY_ID);
      expect(ops.writeTrail()).toEqual([]);
    },
  );

  it("admits the correct secret again once the window rolls", async () => {
    await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    expect((await gate(LOOKUP_PATH, PIN)).status).toBe(429);

    vi.setSystemTime(PINNED_NOW + WINDOW_MS);

    expect((await gate(LOOKUP_PATH, PIN)).status).toBe(200);
  });
});

describe("hourly attempt budget — a refusal never reaches the comparison", () => {
  const v1Record = async (): Promise<VerifyRecord> => ({
    method: "pin",
    hash: await hashSecret(SALT, PIN),
    salt: SALT,
    prompted: 1,
  });
  const v2Record = async (): Promise<VerifyRecord> => ({
    method: "pin",
    hash: await hashSecretWithPepper(PEPPER, SALT, PIN),
    salt: SALT,
    prompted: 1,
    version: VERIFY_HASH_VERSION_PEPPER,
    pepperId: await pepperFingerprint(PEPPER),
  });

  const SCHEMES = [
    {
      scheme: "v1, no pepper configured",
      record: v1Record,
      pepper: {},
      refused: { digest: 0, sign: 0 },
      compared: { digest: 1, sign: 0 },
    },
    {
      // The one digest of a refusal is the pepper fingerprint, which never sees the submitted secret.
      scheme: "v2",
      record: v2Record,
      pepper: { VERIFY_PEPPER: PEPPER },
      refused: { digest: 1, sign: 0 },
      compared: { digest: 1, sign: 1 },
    },
  ];

  async function countCrypto(
    secret: string,
    pepper: Env,
  ): Promise<{ status: number; digest: number; sign: number }> {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const sign = vi.spyOn(crypto.subtle, "sign");
    const res = await gate(LOOKUP_PATH, secret, {
      ...prodEnv().env,
      ...pepper,
    });
    return {
      status: res.status,
      digest: digest.mock.calls.length,
      sign: sign.mock.calls.length,
    };
  }

  it.each(
    SCHEMES.flatMap((scheme) => [
      { ...scheme, answer: "correct", secret: PIN },
      { ...scheme, answer: "wrong", secret: WRONG_PIN },
    ]),
  )(
    "hashes no $answer secret on a $scheme record with the budget spent",
    async ({ record, pepper, refused, secret }) => {
      await kv.put(kvKeys.verify(USER_ID), JSON.stringify(await record()));
      await spend(VERIFY_ATTEMPT_SCOPE);

      expect(await countCrypto(secret, pepper)).toEqual({
        status: 429,
        ...refused,
      });
    },
  );

  it.each(SCHEMES)(
    "does compare on a $scheme record while budget remains",
    async ({ record, pepper, compared }) => {
      await kv.put(kvKeys.verify(USER_ID), JSON.stringify(await record()));

      expect(await countCrypto(PIN, pepper)).toEqual({
        status: 200,
        ...compared,
      });
    },
  );

  /** A `code` account with a pending OTP, through the real routes; returns the code. */
  async function issueOtp(): Promise<string> {
    const token = await seedAuthToken(kv, USER_ID);
    const set = await send("PUT", VERIFY_PATH, {
      body: { method: "code" },
      token,
      env: devEnv(),
    });
    expect(set.status).toBe(200);
    const res = await send("POST", `${VERIFY_PATH}/otp`, {
      body: {},
      token,
      env: devEnv(),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as Json).data.code as string;
  }

  it("neither reads nor spends the OTP of a code account with the budget spent", async () => {
    await seedFamily([OWNER_ID]);
    const code = await issueOtp();
    const storedOtp = await kv.get(kvKeys.otp(USER_ID));
    await spend(VERIFY_ATTEMPT_SCOPE);
    const joinPath = `/api/family/${FAMILY_ID}/join`;
    const ops = watchKvOps(kv);

    const refused = await gate(joinPath, code);

    expect(refused.status).toBe(429);
    expect(ops.getKeys()).not.toContain(kvKeys.otp(USER_ID));
    expect(ops.writeTrail()).toEqual([]);
    expect(await kv.get(kvKeys.otp(USER_ID))).toBe(storedOtp);

    // Positive companion: with the budget back, that same code is read and spent.
    await kv.delete(await budgetKey(VERIFY_ATTEMPT_SCOPE));
    const admitted = await gate(joinPath, code);
    expect(admitted.status).toBe(200);
    expect(ops.getKeys()).toContain(kvKeys.otp(USER_ID));
    expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
  });
});

describe("hourly attempt budget — recovering through a device still logged in", () => {
  it("lets a valid session mint a QR, join from a new source with it, and read the books, with the counter unmoved", async () => {
    const created = await send("POST", "/api/family", {
      body: { userId: USER_ID },
      env: devEnv(),
    });
    expect(created.status).toBe(201);
    const { familyId, authToken: firstToken } = ((await created.json()) as Json)
      .data;
    const pinned = await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: PIN },
      token: firstToken,
      env: devEnv(),
    });
    expect(pinned.status).toBe(200);
    const sessionToken = ((await pinned.json()) as Json).data.authToken;
    const saved = await send("PUT", `/api/user/${USER_ID}/books`, {
      body: {
        books: [
          {
            bookId: REAL_BOOK_ID,
            title: "Title",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: BoolFlag.FALSE,
          },
        ],
      },
      token: sessionToken,
      env: devEnv(),
    });
    expect(saved.status).toBe(200);

    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      expect((await gate(LOOKUP_PATH, WRONG_PIN)).status).toBe(403);
    }
    const joinPath = `/api/family/${familyId}/join`;
    expect((await gate(joinPath, PIN)).status).toBe(429);

    const { env, calls } = prodEnv();
    const qr = await send("POST", `/api/user/${USER_ID}/qr-token`, {
      body: {},
      token: sessionToken,
      env,
    });
    expect(qr.status).toBe(200);
    const qrToken = ((await qr.json()) as Json).data.token as string;

    const joined = await send("POST", joinPath, {
      body: { userId: USER_ID, qrToken },
      env,
    });
    expect(joined.status).toBe(200);
    const newToken = ((await joined.json()) as Json).data.authToken as string;
    expect(newToken).toMatch(/^[a-f0-9]{64}$/);
    expect(newToken).not.toBe(sessionToken);

    const books = await send("GET", `/api/user/${USER_ID}/books`, {
      token: newToken,
      env,
    });
    expect(books.status).toBe(200);
    const [book] = ((await books.json()) as Json).data.books;
    expect(book.bookId).toBe(REAL_BOOK_ID);
    expect(book.isShared).toBe(BoolFlag.FALSE);

    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
    expect(calls.map((call) => call.key)).not.toContain(LOGIN_BURST_KEY);
  });
});

describe("current-secret step-up — its own budget", () => {
  it("saves with the correct currentSecret while the login budget is spent", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(200);
    expect(await storedMethod()).toBe("none");
  });

  it("refuses a correct and a wrong currentSecret alike while the step-up budget is spent, leaving the login budget as it was", async () => {
    const token = await setPin(PIN);
    await spendStepUp(token);
    await spend(VERIFY_ATTEMPT_SCOPE, 3);
    const ops = watchKvOps(kv);

    const wrong = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: WRONG_PIN },
      token,
    });
    const correct = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(correct.status).toBe(429);
    expect(wrong.status).toBe(429);
    const correctBody = await correct.text();
    expect(correctBody).toBe(await wrong.text());
    expect(JSON.parse(correctBody)).toEqual(RATE_LIMITED_BODY(REST_OF_WINDOW));
    expect(ops.writeTrail()).toEqual([]);
    expect(await storedMethod()).toBe("pin");
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(3);
  });

  it("charges a wrong currentSecret to the step-up budget, and a wrong login to the login budget", async () => {
    const token = await setPin(PIN);

    const stepUp = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: WRONG_PIN },
      token,
    });

    expect(stepUp.status).toBe(403);
    expect(await stepUpCount(token)).toBe(1);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBeNull();

    expect((await gate(LOOKUP_PATH, WRONG_PIN)).status).toBe(403);
    expect(await stepUpCount(token)).toBe(1);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(1);
  });
});

describe("PUT /api/user/:id/verify — clearing the login budget", () => {
  it("deletes the counter after a successful save, so the new PIN opens the account at once", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: NEW_PIN, currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(200);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBeNull();
    expect((await gate(LOOKUP_PATH, NEW_PIN)).status).toBe(200);
    expect((await gate(LOOKUP_PATH, PIN)).status).toBe(403);
  });

  it.each([
    { method: "pin", secret: NEW_PIN },
    { method: "pattern", secret: "0,1,2,5,8" },
    { method: "none" },
    { method: "code" },
  ])("clears it when the save is to $method", async (body) => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);

    const res = await send("PUT", VERIFY_PATH, {
      body: { ...body, currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(200);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBeNull();
  });

  it("leaves the step-up budget alone on a successful save", async () => {
    const token = await setPin(PIN);
    await spendStepUp(token, 3);

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(200);
    expect(await stepUpCount(token)).toBe(3);
  });

  it("keeps the counter when the currentSecret is wrong", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: NEW_PIN, currentSecret: WRONG_PIN },
      token,
    });

    expect(res.status).toBe(403);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
  });

  it("keeps the counter when the verify-set ceiling refuses the save", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { key: setKey } = await peekPerUserRateLimit(kv, {
      userId: USER_ID,
      ...VERIFY_SET_LIMIT,
    });
    await kv.put(setKey, String(VERIFY_SET_LIMIT.max));

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(429);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
  });

  it("keeps the counter when the record write fails", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    failFirstWriteTo(kv, "put", kvKeys.verify(USER_ID));
    captureLogs();

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(500);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
  });

  it("still answers the save when the delete fails, logging the event name without the userId", async () => {
    const token = await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    const counterKey = await budgetKey(VERIFY_ATTEMPT_SCOPE);
    const realDelete = kv.delete.bind(kv);
    vi.spyOn(kv, "delete").mockImplementation((key) =>
      key === counterKey
        ? Promise.reject(new Error(`KV delete failed for ${key}`))
        : realDelete(key),
    );
    const logs = captureLogs();

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
    });

    expect(res.status).toBe(200);
    expect(await storedMethod()).toBe("none");
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(VERIFY_ATTEMPT_MAX);
    expect(logs.errors()).toEqual([
      ["ATTEMPT_BUDGET_BINDING_MISSING"],
      ["VERIFY_CEILING_RESET_FAILED"],
    ]);
    expect(logs.text()).not.toContain(USER_ID);
  });
});

describe("per-minute limit", () => {
  const refuse =
    (refusedKey: string): RateLimitDecider =>
    (_name, key) =>
      key !== refusedKey;

  it.each(ENTRY_POINTS)(
    "refuses the correct secret at $label like a wrong one, without touching the hourly counter",
    async ({ path, prepare }) => {
      await prepare();
      await setPin(PIN);
      const counterKey = await budgetKey(VERIFY_ATTEMPT_SCOPE);
      const { env, calls } = prodEnv(refuse(LOGIN_BURST_KEY));
      const ops = watchKvOps(kv);

      const correct = await gate(path, PIN, env);
      const wrong = await gate(path, WRONG_PIN, env);

      expect(correct.status).toBe(429);
      expect(wrong.status).toBe(429);
      const correctBody = await correct.text();
      expect(correctBody).toBe(await wrong.text());
      expect(JSON.parse(correctBody)).toEqual(RATE_LIMITED_BODY(BURST_WINDOW));
      expect(correct.headers.get("Retry-After")).toBe(String(BURST_WINDOW));
      expect(calls).toContainEqual({
        name: "RATE_LIMIT_10_PER_MIN",
        key: LOGIN_BURST_KEY,
      });
      expect(ops.getKeys()).not.toContain(counterKey);
      expect(ops.writeTrail()).toEqual([]);
    },
  );

  it("counts a correct secret too, on the login key alone", async () => {
    await setPin(PIN);
    const { env, calls } = prodEnv();

    const res = await gate(LOOKUP_PATH, PIN, env);

    expect(res.status).toBe(200);
    const burstCalls = calls.filter((call) => call.key.includes("burst"));
    expect(burstCalls).toEqual([
      { name: "RATE_LIMIT_10_PER_MIN", key: LOGIN_BURST_KEY },
    ]);
  });

  it("does not count a request with no secret", async () => {
    await setPin(PIN);
    const { env, calls } = prodEnv(refuse(LOGIN_BURST_KEY));

    const res = await gate("/api/family", undefined, env);

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
    expect(calls.map((call) => call.key)).not.toContain(LOGIN_BURST_KEY);
  });

  it("uses the step-up key on PUT /api/user/:id/verify, refusing the correct secret and saving nothing", async () => {
    const token = await setPin(PIN);
    const burstKey = `ratelimit:user:verify-stepup-burst:${await stepUpSubject(token)}`;
    const { env, calls } = prodEnv(refuse(burstKey));

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
      env,
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(RATE_LIMITED_BODY(BURST_WINDOW));
    expect(await storedMethod()).toBe("pin");
    const burstCalls = calls.filter((call) => call.key.includes("burst"));
    expect(burstCalls).toEqual([
      { name: "RATE_LIMIT_10_PER_MIN", key: burstKey },
    ]);
  });

  it("does not let a spent login limit stop the step-up", async () => {
    const token = await setPin(PIN);
    const { env } = prodEnv(refuse(LOGIN_BURST_KEY));

    const res = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
      env,
    });

    expect(res.status).toBe(200);
  });

  it("is skipped with the hourly budget under DEV_MODE", async () => {
    await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { bindings, calls } = createRateLimitBindings(() => false);
    const env = { KV: kv, DEV_MODE: "1", ...bindings };

    expect((await gate(LOOKUP_PATH, PIN, env)).status).toBe(200);
    expect((await gate(LOOKUP_PATH, WRONG_PIN, env)).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("per-minute limit — no usable binding", () => {
  it("writes no KV key and logs the missing binding, the gate working as usual, when only that binding is absent", async () => {
    const token = await setPin(PIN);
    const env = { ...prodEnv().env, RATE_LIMIT_10_PER_MIN: undefined };
    const logs = captureLogs();

    expect((await gate(LOOKUP_PATH, PIN, env)).status).toBe(200);
    expect(logs.errors()).toEqual([
      ["RATE_LIMIT_BINDING_MISSING", { binding: "RATE_LIMIT_10_PER_MIN" }],
      ["ATTEMPT_BUDGET_BINDING_MISSING"],
    ]);
    expect((await gate(LOOKUP_PATH, WRONG_PIN, env)).status).toBe(403);
    expect(await budgetCount(VERIFY_ATTEMPT_SCOPE)).toBe(1);
    const stepUp = await send("PUT", VERIFY_PATH, {
      body: { method: "none", currentSecret: PIN },
      token,
      env,
    });
    expect(stepUp.status).toBe(200);

    const { keys } = await kv.list({ prefix: "ratelimit:user:" });
    expect(keys.filter((k) => k.name.includes("burst"))).toEqual([]);
  });

  it("still refuses a spent hourly budget on a deployment with no bindings at all", async () => {
    await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    captureLogs();

    const res = await gate(LOOKUP_PATH, PIN, { KV: kv });

    expect(res.status).toBe(429);
    const { keys } = await kv.list({ prefix: "ratelimit:user:" });
    expect(keys.filter((k) => k.name.includes("burst"))).toEqual([]);
  });

  it("admits the correct secret when the binding throws, logging the event name without the userId", async () => {
    await setPin(PIN);
    const { env } = prodEnv((_name, key) => {
      if (key === LOGIN_BURST_KEY) throw new Error(`limit failed for ${key}`);
      return true;
    });
    const logs = captureLogs();

    const res = await gate(LOOKUP_PATH, PIN, env);

    expect(res.status).toBe(200);
    expect(logs.errors()).toEqual([
      ["PER_USER_BURST_CHECK_FAILED"],
      ["ATTEMPT_BUDGET_BINDING_MISSING"],
    ]);
    expect(logs.text()).not.toContain(USER_ID);
  });
});

describe("gate order — what comes before the two limits", () => {
  const everyLimitSpent = (): RateLimitDecider => (_name, key) =>
    !key.includes("burst");

  async function seedRecord(record: VerifyRecord): Promise<void> {
    await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
  }

  const corrupted: VerifyRecord = {
    method: "pin",
    hash: null,
    salt: null,
    prompted: 1,
  };

  it("passes a corrupted record whatever the secret, with both limits spent and neither consulted", async () => {
    await seedRecord(corrupted);
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { env, calls } = prodEnv(everyLimitSpent());
    const ops = watchKvOps(kv);

    const res = await gate("/api/family", WRONG_PIN, env);

    expect(res.status).toBe(201);
    expect(calls.map((call) => call.key)).not.toContain(LOGIN_BURST_KEY);
    expect(ops.getKeys()).not.toContain(await budgetKey(VERIFY_ATTEMPT_SCOPE));
  });

  it("still asks a corrupted record for a secret when none is sent", async () => {
    await seedRecord(corrupted);
    await spend(VERIFY_ATTEMPT_SCOPE);

    const res = await gate("/api/family", undefined);

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
  });

  it("answers a request with no secret with 403, not 429, with both limits spent", async () => {
    await setPin(PIN);
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { env } = prodEnv(everyLimitSpent());

    const res = await gate("/api/family", undefined, env);

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
  });

  it("answers an unverifiable hash with 503, not 429, with both limits spent", async () => {
    await seedRecord({
      method: "pin",
      hash: "placeholder",
      salt: SALT,
      prompted: 1,
      version: VERIFY_HASH_VERSION_PEPPER,
      pepperId: "0000000000000000",
    });
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { env } = prodEnv(everyLimitSpent());
    captureLogs();

    const res = await gate(LOOKUP_PATH, PIN, env);

    expect(res.status).toBe(503);
    expect(((await res.json()) as Json).error.code).toBe("VERIFY_UNAVAILABLE");
  });

  it("answers a locked caller with VERIFICATION_LOCKED, not RATE_LIMITED, with both limits spent", async () => {
    await setPin(PIN);
    const ip = "198.51.100.77";
    await kv.put(
      kvKeys.verifyFail(USER_ID, ip),
      JSON.stringify({
        failCount: 0,
        lockedUntil: PINNED_NOW + 30_000,
        startedAt: PINNED_NOW,
      }),
    );
    await spend(VERIFY_ATTEMPT_SCOPE);
    const { env } = prodEnv(everyLimitSpent());

    const res = await send("POST", LOOKUP_PATH, {
      body: { userId: USER_ID, verifySecret: PIN },
      env,
      ip,
    });

    expect(res.status).toBe(429);
    expect(((await res.json()) as Json).error.code).toBe("VERIFICATION_LOCKED");
  });
});
