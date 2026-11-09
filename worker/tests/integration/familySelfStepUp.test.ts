import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, authTokenKey, tokenOwner } from "../helpers/auth";
import { watchKvOps, type KvOpLog } from "../helpers/kvOps";
import { ALICE, BOB, STRANGER } from "../helpers/ids";
import { kvKeys } from "../../src/kv/schema";
import { VERIFY_SECRET_MAX_LENGTH } from "../../src/utils/validation";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import { FAMILY_WRITE_LIMIT } from "../../src/routes/family";
import {
  VERIFICATION_REQUIRED_ERROR,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
  VERIFY_STEP_UP_ATTEMPT_MAX,
  VERIFY_STEP_UP_ATTEMPT_SCOPE,
} from "../../src/services/verification";
import { STEP_UP_UPDATE_REQUIRED_MESSAGE } from "../../src/services/currentSecretStepUp";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * Current-secret step-up on self-leave (`DELETE /api/family/:id/member/:uid`
 * with `uid` = caller) and `PUT /api/family/:id/transfer`.
 *
 * A PIN / pattern account must send its CURRENT secret as `currentSecret` (the
 * self-leave reads it from an optional JSON body, the transfer from its own
 * body). Order on both routes: 401 → `family-write` charge → body format 400s
 * → bearer currency (`401` when the token is off `auth:{userId}`'s list) →
 * `enforceCurrentSecret` → only THEN `family:{id}` is read. So every refusal
 * here leaves `family:`, `member:`, `auth:`, `token:` and `verify:` exactly as
 * they were, never reads `family:{id}`, and writes nothing but the
 * `family-write` counter (plus, on a wrong guess, the step-up's own two guess
 * counters). `FAMILY_NOT_FOUND` / `OWNER_CANNOT_LEAVE` / `NOT_OWNER` /
 * `SAME_OWNER` / `INVALID_MEMBER` answer only after the step-up passes.
 *
 * Messages: the gate's no-secret `403 VERIFICATION_REQUIRED` on these two routes
 * carries `STEP_UP_UPDATE_REQUIRED_MESSAGE` (a pre-step-up client shows it as
 * an update prompt); the stale-record `403 VERIFICATION_REQUIRED` keeps the
 * original `VERIFICATION_REQUIRED_ERROR` message for every record shape (an
 * update cannot fix it), and `PUT /api/user/:id/verify` / `DELETE /api/user/:id`
 * are unchanged. Both are asserted with exact equality on the whole error.
 *
 * Unchanged: the owner removing ANOTHER member reads no body and runs no
 * step-up (an unparseable body still succeeds, `verify:` is never read);
 * `none` / `code` / no-record accounts need no secret while their record is
 * not stale and their token is listed. The 401 and the stale-record 403 do
 * apply to them.
 *
 * Budget: the step-up's per-token `verify-stepup` budget is the one
 * `PUT /api/user/:id/verify` spends — wrong guesses on any of the three routes
 * add up, and once spent a correct secret is refused on all of them. Each guess
 * there comes from a fresh source address so the caller lockout (5 failures,
 * keyed by address) cannot answer first.
 *
 * Requests run without DEV_MODE, with the binding stubs (the hourly
 * `family-write` / `verify-stepup` counters are real KV writes); PIN / pattern
 * setup goes through the real verify route under DEV_MODE. `Date` is pinned
 * mid-hour so the counter keys computed before a request name its bucket.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;
let ipCounter = 0;

const USER_ID = ALICE;
const OTHER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const CALLER_IP = "203.0.113.40";
const PIN = "123456";
const WRONG_PIN = "000000";
const OFF_LIST_TOKEN = "7".repeat(64);
const OVER_LONG = "1".repeat(VERIFY_SECRET_MAX_LENGTH + 1);

const SECRET_METHODS = [
  { method: "pin", secret: PIN, wrong: WRONG_PIN },
  { method: "pattern", secret: "0,1,2,5,8", wrong: "0,1,2,5,7" },
] as const;

function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function call(
  method: string,
  path: string,
  token: string,
  rawBody?: string,
  ip = CALLER_IP,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "cf-connecting-ip": ip,
    },
  };
  if (rawBody !== undefined) init.body = rawBody;
  return app.request(path, init, { KV: kv, ...rateLimitBindings() });
}

const leavePath = `/api/family/${FAMILY_ID}/member/${USER_ID}`;

/** Self-leave; `secret` undefined ⇒ no body at all, anything else ⇒ `{ currentSecret: secret }`. */
function leave(token: string, secret?: unknown, ip?: string) {
  const body =
    secret === undefined
      ? undefined
      : JSON.stringify({ currentSecret: secret });
  return call("DELETE", leavePath, token, body, ip);
}

/** Transfer to `newOwnerId`; `secret` undefined ⇒ the field is omitted. */
function transfer(
  token: string,
  secret?: unknown,
  ip?: string,
  newOwnerId: string = OTHER_ID,
) {
  const body = {
    newOwnerId,
    ...(secret !== undefined && { currentSecret: secret }),
  };
  return call(
    "PUT",
    `/api/family/${FAMILY_ID}/transfer`,
    token,
    JSON.stringify(body),
    ip,
  );
}

/** Configure `method` on USER_ID through the real route (DEV_MODE); returns the rotated, current token. */
async function setSecret(method: string, secret: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await app.request(
    `/api/user/${USER_ID}/verify`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seeded}`,
      },
      body: JSON.stringify({ method, secret }),
    },
    { KV: kv, DEV_MODE: "1" },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

const setPin = () => setSecret("pin", PIN);

/** A `none` / `code` account with a listed token and no `secretAt` (never had a PIN). */
async function setUnprotected(method: "none" | "code"): Promise<string> {
  const token = await seedAuthToken(kv, USER_ID);
  await kv.put(
    kvKeys.verify(USER_ID),
    JSON.stringify({ method, hash: null, salt: null, prompted: 1 }),
  );
  return token;
}

async function seedFamily(
  ownerId: string,
  memberIds: string[],
  pointerIds: string[] = memberIds,
): Promise<void> {
  await Promise.all(
    pointerIds.map((id) => kv.put(kvKeys.member(id), FAMILY_ID)),
  );
  await kv.put(
    kvKeys.family(FAMILY_ID),
    JSON.stringify({
      familyId: FAMILY_ID,
      ownerId,
      members: memberIds.map((userId) => ({ userId, displayName: "M" })),
      maxMembers: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

/** Each route under the step-up, with a family shape in which a correct secret succeeds. */
const ROUTES = [
  {
    label: "self-leave",
    send: leave,
    seed: () => seedFamily(OTHER_ID, [OTHER_ID, USER_ID]),
  },
  {
    label: "transfer",
    send: (token: string, secret?: unknown, ip?: string) =>
      transfer(token, secret, ip),
    seed: () => seedFamily(USER_ID, [USER_ID, OTHER_ID]),
  },
] as const;

/** Every stored value the two routes could change, plus the presented token's key. */
async function accountState(token: string): Promise<(string | null)[]> {
  return Promise.all(
    [
      kvKeys.family(FAMILY_ID),
      kvKeys.member(USER_ID),
      kvKeys.member(OTHER_ID),
      kvKeys.auth(USER_ID),
      kvKeys.verify(USER_ID),
      await authTokenKey(token),
    ].map((key) => kv.get(key)),
  );
}

async function familyWriteKey(): Promise<string> {
  return (
    await peekPerUserRateLimit(kv, { userId: USER_ID, ...FAMILY_WRITE_LIMIT })
  ).key;
}

async function stepUpReading(token: string) {
  return peekPerUserRateLimit(kv, {
    userId: `${USER_ID}:${await hashAuthToken(token)}`,
    scope: VERIFY_STEP_UP_ATTEMPT_SCOPE,
    max: VERIFY_STEP_UP_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
}

/** The two keys a wrong guess with `token` from `ip` charges: its step-up budget and its caller streak. */
async function guessCounterKeys(token: string, ip = CALLER_IP) {
  const bucket = await hashAuthToken(token);
  return [
    (await stepUpReading(token)).key,
    kvKeys.verifyFail(USER_ID, `${ip}:${bucket}`),
  ];
}

/** A refused request: `family:{id}` unread, only `allowedPuts` written, every account key unchanged. */
async function expectUntouched(
  ops: KvOpLog,
  token: string,
  before: (string | null)[],
  allowedPuts: string[],
): Promise<void> {
  expect(ops.getKeys()).not.toContain(kvKeys.family(FAMILY_ID));
  expect([...ops.writeTrail()].sort()).toEqual(
    allowedPuts.map((key) => `put ${key}`).sort(),
  );
  expect(await accountState(token)).toEqual(before);
}

async function errorOf(res: Response): Promise<Json> {
  return ((await res.json()) as Json).error;
}

const UPDATE_REQUIRED = {
  code: "VERIFICATION_REQUIRED",
  message: STEP_UP_UPDATE_REQUIRED_MESSAGE,
};

/** The gate's original no-secret / stale-record error, as the envelope carries it. */
const ORIGINAL_REQUIRED = {
  code: VERIFICATION_REQUIRED_ERROR.code,
  message: VERIFICATION_REQUIRED_ERROR.message,
};

describe("VERIFICATION_REQUIRED_ERROR", () => {
  it("still carries the message every pre-existing route answered with", () => {
    expect(ORIGINAL_REQUIRED).toEqual({
      code: "VERIFICATION_REQUIRED",
      message: "此帳號需要驗證才能登入",
    });
  });
});

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(SECRET_METHODS)(
  "a $method account — self-leave and transfer",
  ({ method, secret, wrong }) => {
    describe.each(ROUTES)("$label", ({ send, seed }) => {
      it.each([
        { label: "no currentSecret", value: undefined },
        { label: "currentSecret: null", value: null },
        { label: 'currentSecret: ""', value: "" },
      ])(
        "refuses $label with 403 and the update message, before reading the family",
        async ({ value }) => {
          const token = await setSecret(method, secret);
          await seed();
          const fwKey = await familyWriteKey();
          const before = await accountState(token);
          const ops = watchKvOps(kv);

          const res = await send(token, value);

          expect(res.status).toBe(403);
          const error = await errorOf(res);
          expect(error).toEqual(UPDATE_REQUIRED);
          expect(error.message).not.toBe(VERIFICATION_REQUIRED_ERROR.message);
          await expectUntouched(ops, token, before, [fwKey]);
        },
      );

      it("refuses a wrong secret with 403 VERIFICATION_FAILED, writing only the guess counters", async () => {
        const token = await setSecret(method, secret);
        await seed();
        const fwKey = await familyWriteKey();
        const guessKeys = await guessCounterKeys(token);
        const before = await accountState(token);
        const ops = watchKvOps(kv);

        const res = await send(token, wrong);

        expect(res.status).toBe(403);
        expect((await errorOf(res)).code).toBe("VERIFICATION_FAILED");
        await expectUntouched(ops, token, before, [fwKey, ...guessKeys]);
      });
    });

    it("lets the correct secret leave: unlisted, pointer and every token gone", async () => {
      const token = await setSecret(method, secret);
      await seedFamily(OTHER_ID, [OTHER_ID, USER_ID]);
      const ops = watchKvOps(kv);

      const res = await leave(token, secret);

      expect(res.status).toBe(200);
      expect(ops.getKeys()).toContain(kvKeys.family(FAMILY_ID));
      const record = (await kv.get(kvKeys.family(FAMILY_ID), "json")) as Json;
      expect(record.members.map((m: Json) => m.userId)).toEqual([OTHER_ID]);
      expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();
      expect(await kv.get(kvKeys.member(OTHER_ID))).toBe(FAMILY_ID);
      expect(await tokenOwner(kv, token)).toBeNull();
      expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
    });

    it("lets the correct secret transfer ownership, the session intact", async () => {
      const token = await setSecret(method, secret);
      await seedFamily(USER_ID, [USER_ID, OTHER_ID]);

      const res = await transfer(token, secret);

      expect(res.status).toBe(200);
      const record = (await kv.get(kvKeys.family(FAMILY_ID), "json")) as Json;
      expect(record.ownerId).toBe(OTHER_ID);
      expect(record.members.map((m: Json) => m.userId)).toEqual([
        USER_ID,
        OTHER_ID,
      ]);
      expect(await tokenOwner(kv, token)).toBe(USER_ID);
    });
  },
);

describe("self-leave's revoking branches on a PIN account", () => {
  const BRANCHES = [
    {
      label: "a sole owner's dissolve",
      seed: () => seedFamily(USER_ID, [USER_ID]),
      status: 200,
      code: undefined,
      familyKept: false,
    },
    {
      label: "an unlisted leaver's stray-pointer cleanup",
      seed: () => seedFamily(OTHER_ID, [OTHER_ID], [OTHER_ID, USER_ID]),
      status: 404,
      code: "MEMBER_NOT_FOUND",
      familyKept: true,
    },
    {
      label: "the last listed member's dissolve",
      seed: () => seedFamily(OTHER_ID, [USER_ID], [USER_ID]),
      status: 200,
      code: undefined,
      familyKept: false,
    },
  ];

  it.each(BRANCHES)(
    "$label revokes nothing without a secret",
    async ({ seed }) => {
      const token = await setPin();
      await seed();
      const fwKey = await familyWriteKey();
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const res = await leave(token);

      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual(UPDATE_REQUIRED);
      await expectUntouched(ops, token, before, [fwKey]);
      expect(await tokenOwner(kv, token)).toBe(USER_ID);
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
    },
  );

  it.each(BRANCHES)(
    "$label runs as before with the correct secret",
    async ({ seed, status, code, familyKept }) => {
      const token = await setPin();
      await seed();
      const familyBefore = await kv.get(kvKeys.family(FAMILY_ID));

      const res = await leave(token, PIN);

      expect(res.status).toBe(status);
      if (code !== undefined) expect((await errorOf(res)).code).toBe(code);
      expect(await kv.get(kvKeys.family(FAMILY_ID))).toBe(
        familyKept ? familyBefore : null,
      );
      expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();
      expect(await tokenOwner(kv, token)).toBeNull();
      expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
    },
  );
});

describe("a token that is not one of the account's current tokens", () => {
  /** A live `token:` key the middleware accepts but `auth:{userId}`'s list does not name. */
  async function seedOffListToken(): Promise<void> {
    await kv.put(
      await authTokenKey(OFF_LIST_TOKEN),
      JSON.stringify({
        userId: USER_ID,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + 86_400_000,
      }),
    );
  }

  const ACCOUNTS = [
    { label: "a PIN account (correct PIN sent)", setUp: setPin, secret: PIN },
    {
      label: "a none account",
      setUp: () => setUnprotected("none"),
      secret: undefined,
    },
  ];

  describe.each(ROUTES)("$label", ({ send, seed }) => {
    it.each(ACCOUNTS)(
      "answers 401 UNAUTHORIZED for $label and changes nothing",
      async ({ setUp, secret }) => {
        const current = await setUp();
        await seed();
        await seedOffListToken();
        // Positive companion: the middleware does accept the off-list bearer.
        const books = await call(
          "GET",
          `/api/user/${USER_ID}/books`,
          OFF_LIST_TOKEN,
        );
        expect(books.status).toBe(200);
        const fwKey = await familyWriteKey();
        const before = await accountState(OFF_LIST_TOKEN);
        const currentBefore = await kv.get(await authTokenKey(current));
        const ops = watchKvOps(kv);

        const res = await send(OFF_LIST_TOKEN, secret);

        expect(res.status).toBe(401);
        expect((await errorOf(res)).code).toBe("UNAUTHORIZED");
        await expectUntouched(ops, OFF_LIST_TOKEN, before, [fwKey]);
        expect(await kv.get(await authTokenKey(current))).toBe(currentBefore);
      },
    );
  });
});

describe("a stale verify record", () => {
  const SHAPES = [
    {
      label: "a PIN account whose auth: is newer (correct PIN sent)",
      secret: PIN as string | undefined,
      setUp: async () => {
        const token = await setPin();
        const auth = (await kv.get(kvKeys.auth(USER_ID), "json")) as Json;
        await kv.put(
          kvKeys.auth(USER_ID),
          JSON.stringify({ ...auth, secretAt: auth.secretAt + 1000 }),
        );
        return token;
      },
    },
    {
      label: "a none record older than auth:'s secretAt",
      secret: undefined,
      setUp: async () => {
        const token = await seedAuthToken(kv, USER_ID, { secretAt: 2000 });
        await kv.put(
          kvKeys.verify(USER_ID),
          JSON.stringify({
            method: "none",
            hash: null,
            salt: null,
            prompted: 1,
            secretUpdatedAt: 1000,
          }),
        );
        return token;
      },
    },
    {
      label: "case one: no verify: record while auth: carries secretAt",
      secret: undefined,
      setUp: () => seedAuthToken(kv, USER_ID, { secretAt: 2000 }),
    },
  ];

  describe.each(ROUTES)("$label", ({ send, seed }) => {
    it.each(SHAPES)(
      "refuses $label with 403 and the ORIGINAL message, changing nothing",
      async ({ setUp, secret }) => {
        const token = await setUp();
        await seed();
        const fwKey = await familyWriteKey();
        const before = await accountState(token);
        const ops = watchKvOps(kv);

        const res = await send(token, secret);

        expect(res.status).toBe(403);
        const error = await errorOf(res);
        expect(error).toEqual(ORIGINAL_REQUIRED);
        expect(error.message).not.toBe(STEP_UP_UPDATE_REQUIRED_MESSAGE);
        await expectUntouched(ops, token, before, [fwKey]);
      },
    );
  });
});

describe("the owner removing another member", () => {
  it.each([
    { label: "no body", body: undefined },
    { label: "an unparseable body", body: "{oops" },
    { label: "a wrong currentSecret", body: '{"currentSecret":"000000"}' },
  ])(
    "needs no secret and reads neither the body nor verify: ($label)",
    async ({ body }) => {
      const token = await setPin();
      await seedFamily(USER_ID, [USER_ID, OTHER_ID]);
      const ops = watchKvOps(kv);

      const res = await call(
        "DELETE",
        `/api/family/${FAMILY_ID}/member/${OTHER_ID}`,
        token,
        body,
      );

      expect(res.status).toBe(200);
      expect(ops.getKeys()).not.toContain(kvKeys.verify(USER_ID));
      const record = (await kv.get(kvKeys.family(FAMILY_ID), "json")) as Json;
      expect(record.members.map((m: Json) => m.userId)).toEqual([USER_ID]);
      expect(await kv.get(kvKeys.member(OTHER_ID))).toBeNull();
      expect(await tokenOwner(kv, token)).toBe(USER_ID);
    },
  );
});

describe("accounts with nothing to step up on", () => {
  const ACCOUNTS = [
    { label: "a none account", setUp: () => setUnprotected("none") },
    { label: "a code account", setUp: () => setUnprotected("code") },
    {
      label: "an account with no verify record",
      setUp: () => seedAuthToken(kv, USER_ID),
    },
  ];

  describe.each(ROUTES)("$label", ({ send, seed }) => {
    it.each(
      ACCOUNTS.flatMap((account) => [
        { ...account, secretLabel: "no secret", secret: undefined },
        { ...account, secretLabel: "a wrong secret", secret: WRONG_PIN },
      ]),
    )(
      "lets $label through with $secretLabel, charging no guess counter",
      async ({ setUp, secret }) => {
        const token = await setUp();
        await seed();

        const res = await send(token, secret);

        expect(res.status).toBe(200);
        expect((await stepUpReading(token)).count).toBe(0);
        const streaks = await kv.list({
          prefix: kvKeys.verifyFail(USER_ID, ""),
        });
        expect(streaks.keys).toEqual([]);
      },
    );
  });
});

describe("the step-up runs before the family record is read", () => {
  const CASES = [
    {
      label: "self-leave of a missing family",
      seed: async () => {},
      send: (token: string, secret?: string) => leave(token, secret),
      status: 404,
      code: "FAMILY_NOT_FOUND",
    },
    {
      label: "transfer of a missing family",
      seed: async () => {},
      send: (token: string, secret?: string) => transfer(token, secret),
      status: 404,
      code: "FAMILY_NOT_FOUND",
    },
    {
      label: "the owner of a two-member family leaving",
      seed: () => seedFamily(USER_ID, [USER_ID, OTHER_ID]),
      send: (token: string, secret?: string) => leave(token, secret),
      status: 403,
      code: "OWNER_CANNOT_LEAVE",
    },
    {
      label: "a non-owner transferring",
      seed: () => seedFamily(OTHER_ID, [OTHER_ID, USER_ID]),
      send: (token: string, secret?: string) => transfer(token, secret),
      status: 403,
      code: "NOT_OWNER",
    },
    {
      label: "the owner transferring to themself",
      seed: () => seedFamily(USER_ID, [USER_ID, OTHER_ID]),
      send: (token: string, secret?: string) =>
        transfer(token, secret, undefined, USER_ID),
      status: 400,
      code: "SAME_OWNER",
    },
    {
      label: "the owner transferring to a non-member",
      seed: () => seedFamily(USER_ID, [USER_ID, OTHER_ID]),
      send: (token: string, secret?: string) =>
        transfer(token, secret, undefined, STRANGER),
      status: 400,
      code: "INVALID_MEMBER",
    },
  ];

  it.each(CASES)(
    "$label: 403 without the secret, $code only with it",
    async ({ seed, send, status, code }) => {
      const token = await setPin();
      await seed();
      const fwKey = await familyWriteKey();
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const refused = await send(token);

      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toEqual(UPDATE_REQUIRED);
      await expectUntouched(ops, token, before, [fwKey]);

      const res = await send(token, PIN);

      expect(res.status).toBe(status);
      expect((await errorOf(res)).code).toBe(code);
      expect(ops.getKeys()).toContain(kvKeys.family(FAMILY_ID));
    },
  );
});

describe("a malformed self-leave or transfer body", () => {
  const INVALID_SECRET = {
    code: "INVALID_VERIFY_SECRET",
    message: `currentSecret must be a string of ${VERIFY_SECRET_MAX_LENGTH} characters or fewer`,
  };
  const CASES = [
    ...ROUTES.flatMap(({ label, send }) => [
      {
        label: `${label} with a numeric currentSecret`,
        send: (token: string) => send(token, 123456),
        error: INVALID_SECRET,
      },
      {
        label: `${label} with an over-long currentSecret`,
        send: (token: string) => send(token, OVER_LONG),
        error: INVALID_SECRET,
      },
    ]),
    {
      label: "self-leave with unparseable JSON",
      send: (token: string) => call("DELETE", leavePath, token, "{oops"),
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON",
      },
    },
    {
      label: "self-leave with an array body",
      send: (token: string) => call("DELETE", leavePath, token, "[]"),
      error: {
        code: "INVALID_PAYLOAD",
        message: "Request body must be an object",
      },
    },
  ];

  it.each(CASES)(
    "answers $label with 400 before reading verify:, charging no guess",
    async ({ send, error }) => {
      const token = await setPin();
      await seedFamily(USER_ID, [USER_ID, OTHER_ID]);
      const fwKey = await familyWriteKey();
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const res = await send(token);

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual(error);
      expect(ops.getKeys()).not.toContain(kvKeys.verify(USER_ID));
      await expectUntouched(ops, token, before, [fwKey]);
      expect((await stepUpReading(token)).count).toBe(0);
    },
  );
});

describe("the step-up budget shared with PUT /api/user/:id/verify", () => {
  const putVerify = (token: string, currentSecret: string, ip: string) =>
    call(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      token,
      JSON.stringify({ method: "none", currentSecret }),
      ip,
    );

  it("adds wrong guesses across all three routes and then refuses the correct PIN on each", async () => {
    const token = await setPin();
    await seedFamily(USER_ID, [USER_ID, OTHER_ID]);
    const guesses = [
      () => putVerify(token, WRONG_PIN, freshIp()),
      () => putVerify(token, WRONG_PIN, freshIp()),
      () => leave(token, WRONG_PIN, freshIp()),
      () => transfer(token, WRONG_PIN, freshIp()),
      () => leave(token, WRONG_PIN, freshIp()),
    ];
    expect(guesses).toHaveLength(VERIFY_STEP_UP_ATTEMPT_MAX);

    for (const [index, guess] of guesses.entries()) {
      const res = await guess();
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("VERIFICATION_FAILED");
      expect((await stepUpReading(token)).count).toBe(index + 1);
    }
    const familyBefore = await kv.get(kvKeys.family(FAMILY_ID));

    for (const res of [
      await transfer(token, PIN, freshIp()),
      await leave(token, PIN, freshIp()),
      await putVerify(token, PIN, freshIp()),
    ]) {
      expect(res.status).toBe(429);
      expect((await errorOf(res)).code).toBe("RATE_LIMITED");
    }
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBe(familyBefore);
    expect(await tokenOwner(kv, token)).toBe(USER_ID);
  });
});

describe("PUT /api/user/:id/verify and DELETE /api/user/:id keep their message", () => {
  it("answers PUT verify without currentSecret with the original VERIFICATION_REQUIRED", async () => {
    const token = await setPin();

    const res = await call(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      token,
      JSON.stringify({ method: "none" }),
    );

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual(ORIGINAL_REQUIRED);
  });

  it("answers DELETE user without a body with the original VERIFICATION_REQUIRED", async () => {
    const token = await setPin();

    const res = await call("DELETE", `/api/user/${USER_ID}`, token);

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual(ORIGINAL_REQUIRED);
  });
});
