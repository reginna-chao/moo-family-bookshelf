import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import {
  hashSecret,
  hashSecretWithPepper,
  pepperFingerprint,
} from "../../src/utils/crypto";
import {
  kvKeys,
  QR_TOKEN_TTL_SECONDS,
  VERIFY_HASH_VERSION_PEPPER,
  type AuthRecord,
  type VerifyRecord,
} from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/services/verification";

/**
 * Server-side pepper on PIN / pattern hashes (`VERIFY_PEPPER`, verify record
 * v2) through the real routes.
 *
 * Upgrade: with a pepper configured, a v1 record whose secret was just proven
 * correct by create / join / lookup is rewritten as v2 — same salt,
 * `secretUpdatedAt` and `prompted`, a new HMAC hash, `version: 2` and the
 * pepper's fingerprint. It never happens on a wrong secret, without a pepper,
 * on a record already v2, after a QR bypass, on a secret-less lookup probe,
 * when the gate passed against a stale record (`auth.secretAt` newer), or on
 * the step-ups (`PUT /verify`, `DELETE /user`). A failing upgrade put is
 * swallowed (`VERIFY_HASH_UPGRADE_FAILED`) and the request still succeeds.
 * "Not rewritten" is pinned twice: the raw stored string is unchanged AND the
 * request made no `put verify:` (a same-value rewrite would pass the first).
 *
 * Fail closed: a pin/pattern record this Worker cannot check — v2 with no
 * pepper, v2 under another pepper, or an unknown `version` — answers
 * `503 VERIFY_UNAVAILABLE` with or without a secret (never the no-secret 403)
 * and logs only the event name. Those cases run WITHOUT DEV_MODE (binding
 * stubs keep the per-IP tier off KV), so the hourly guess ceiling is live and
 * "nothing charged" is a real check: an empty write trail, no
 * `verifyfail:{userId}:{ip}` and no ceiling counter. A positive companion
 * shows a wrong guess under the right pepper does write both keys.
 *
 * Exception: a secret-less lookup never reaches the gate (it is the
 * requires-verification probe), so the no-secret 503 rows cover create and
 * join only.
 *
 * `Date` is pinned mid-window so no counter bucket rolls over.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;
let errors: ReturnType<typeof vi.spyOn>;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const NEW_PIN = "654321";
const WRONG_PIN = "000000";
const PATTERN = "0,1,2,5,8";
const SALT = "ab".repeat(16);
const PEPPER = "server-pepper-0123456789abcdef";
const OTHER_PEPPER = "another-pepper-fedcba9876543210";
const CALLER_IP = "203.0.113.44";
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const SECRET_UPDATED_AT = PINNED_NOW - 3_600_000;
const VERIFY_KEY = kvKeys.verify(USER_ID);
const FAIL_KEY = kvKeys.verifyFail(USER_ID, CALLER_IP);
const UNAVAILABLE_BODY = {
  error: {
    code: "VERIFY_UNAVAILABLE",
    message: "伺服器的驗證設定不完整，請聯絡管理者",
  },
};

interface EnvOpts {
  pepper?: string;
  prod?: boolean;
}

function envFor({ pepper, prod }: EnvOpts) {
  const base = prod
    ? { KV: kv, ...rateLimitBindings() }
    : { KV: kv, DEV_MODE: "1" };
  return pepper === undefined ? base : { ...base, VERIFY_PEPPER: pepper };
}

async function send(
  method: string,
  path: string,
  body: unknown,
  opts: EnvOpts & { token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": CALLER_IP,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await app.request(path, init, envFor(opts));
}

async function seedFamily(members: string[]): Promise<void> {
  await kv.put(kvKeys.member(OWNER_ID), FAMILY_ID);
  await kv.put(
    kvKeys.family(FAMILY_ID),
    JSON.stringify({
      familyId: FAMILY_ID,
      ownerId: OWNER_ID,
      members: members.map((userId) => ({ userId, displayName: "Member" })),
      maxMembers: 2,
      createdAt: new Date(PINNED_NOW).toISOString(),
    }),
  );
}

/** The three gate entry points that upgrade; each seeds what its success branch needs. */
const ROUTES = [
  {
    route: "create",
    okStatus: 201,
    seed: async () => {},
    call: (secret: string | undefined, opts: EnvOpts) =>
      send(
        "POST",
        "/api/family",
        { userId: USER_ID, verifySecret: secret },
        opts,
      ),
  },
  {
    route: "join (new member)",
    okStatus: 200,
    seed: () => seedFamily([OWNER_ID]),
    call: (secret: string | undefined, opts: EnvOpts) =>
      send(
        "POST",
        `/api/family/${FAMILY_ID}/join`,
        { userId: USER_ID, verifySecret: secret },
        opts,
      ),
  },
  {
    route: "join (reconnect)",
    okStatus: 200,
    seed: async () => {
      await seedFamily([OWNER_ID, USER_ID]);
      await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
    },
    call: (secret: string | undefined, opts: EnvOpts) =>
      send(
        "POST",
        `/api/family/${FAMILY_ID}/join`,
        { userId: USER_ID, verifySecret: secret },
        opts,
      ),
  },
  {
    route: "lookup",
    okStatus: 200,
    seed: async () => {},
    call: (secret: string | undefined, opts: EnvOpts) =>
      send(
        "POST",
        "/api/auth/lookup",
        { userId: USER_ID, verifySecret: secret },
        opts,
      ),
  },
];

/** Routes whose no-secret request reaches the gate (lookup answers its probe instead). */
const NO_SECRET_ROUTES = ROUTES.filter(({ route }) => route !== "lookup");

const METHODS = [
  { method: "pin" as const, secret: PIN },
  { method: "pattern" as const, secret: PATTERN },
];

function cross<A extends object, B extends object>(as: A[], bs: B[]) {
  return as.flatMap((a) => bs.map((b) => ({ ...a, ...b })));
}

async function v1Record(
  method: "pin" | "pattern" = "pin",
  secret = PIN,
): Promise<VerifyRecord> {
  return {
    method,
    hash: await hashSecret(SALT, secret),
    salt: SALT,
    prompted: 1,
    secretUpdatedAt: SECRET_UPDATED_AT,
  };
}

async function v2Record(pepper = PEPPER): Promise<VerifyRecord> {
  return {
    method: "pin",
    hash: await hashSecretWithPepper(pepper, SALT, PIN),
    salt: SALT,
    prompted: 1,
    secretUpdatedAt: SECRET_UPDATED_AT,
    version: VERIFY_HASH_VERSION_PEPPER,
    pepperId: await pepperFingerprint(pepper),
  };
}

/** Seed `verify:{userId}` and return the exact stored string. */
async function seedVerify(record: VerifyRecord): Promise<string> {
  const raw = JSON.stringify(record);
  await kv.put(VERIFY_KEY, raw);
  return raw;
}

async function storedVerify(): Promise<VerifyRecord | null> {
  return kv.get<VerifyRecord>(VERIFY_KEY, "json");
}

function verifyPuts(ops: ReturnType<typeof watchKvOps>): string[] {
  return ops.putKeys().filter((key) => key === VERIFY_KEY);
}

async function ceilingKey(): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return reading.key;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as Json).error.code as string;
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("create / join / lookup — v1 → v2 upgrade on a correct secret", () => {
  it.each(cross(ROUTES, METHODS))(
    "$route: a correct $method rewrites the record as v2, keeping salt / secretUpdatedAt / prompted",
    async ({ seed, call, okStatus, method, secret }) => {
      await seed();
      await seedVerify(await v1Record(method, secret));
      const ops = watchKvOps(kv);

      const res = await call(secret, { pepper: PEPPER });

      expect(res.status).toBe(okStatus);
      expect(verifyPuts(ops)).toEqual([VERIFY_KEY]);
      expect(await storedVerify()).toEqual({
        method,
        hash: await hashSecretWithPepper(PEPPER, SALT, secret),
        salt: SALT,
        prompted: 1,
        secretUpdatedAt: SECRET_UPDATED_AT,
        version: VERIFY_HASH_VERSION_PEPPER,
        pepperId: await pepperFingerprint(PEPPER),
      });
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$route: the upgraded record still admits the same secret",
    async ({ seed, call }) => {
      await seed();
      await seedVerify(await v1Record());
      await call(PIN, { pepper: PEPPER });

      const res = await send(
        "POST",
        "/api/auth/lookup",
        { userId: USER_ID, verifySecret: PIN },
        { pepper: PEPPER },
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data.requiresVerification).toBe(0);
      expect((await storedVerify())?.version).toBe(VERIFY_HASH_VERSION_PEPPER);
    },
  );

  it.each(ROUTES)(
    "$route: a wrong secret is refused and the v1 record is not rewritten",
    async ({ seed, call }) => {
      await seed();
      const raw = await seedVerify(await v1Record());
      const ops = watchKvOps(kv);

      const res = await call(WRONG_PIN, { pepper: PEPPER });

      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("VERIFICATION_FAILED");
      expect(verifyPuts(ops)).toEqual([]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
    },
  );

  it.each(
    cross(ROUTES, [
      { label: "unset", pepper: undefined },
      { label: "blank", pepper: " \t\n " },
    ]),
  )(
    "$route: with the pepper $label a correct v1 secret passes, unchanged and unlogged",
    async ({ seed, call, okStatus, pepper }) => {
      await seed();
      const raw = await seedVerify(await v1Record());
      const ops = watchKvOps(kv);

      const res = await call(PIN, { pepper });

      expect(res.status).toBe(okStatus);
      expect(verifyPuts(ops)).toEqual([]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$route: a correct secret on a v2 record passes without a rewrite",
    async ({ seed, call, okStatus }) => {
      await seed();
      const raw = await seedVerify(await v2Record());
      const ops = watchKvOps(kv);

      const res = await call(PIN, { pepper: PEPPER });

      expect(res.status).toBe(okStatus);
      expect(verifyPuts(ops)).toEqual([]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$route: a failing upgrade put still lets the request succeed",
    async ({ seed, call, okStatus }) => {
      await seed();
      const raw = await seedVerify(await v1Record());
      const realPut = kv.put.bind(kv);
      vi.spyOn(kv, "put").mockImplementation(async (key, value, opts) => {
        if (key === VERIFY_KEY) throw new Error(`KV put failed: ${key}`);
        return realPut(key, value, opts);
      });

      const res = await call(PIN, { pepper: PEPPER });

      expect(res.status).toBe(okStatus);
      expect(errors.mock.calls).toEqual([["VERIFY_HASH_UPGRADE_FAILED"]]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
    },
  );
});

describe("create / join / lookup — no upgrade after a stale-record pass", () => {
  async function seedAuth(secretAt: number): Promise<void> {
    const token = "9".repeat(64);
    const record: AuthRecord = {
      token,
      createdAt: new Date(PINNED_NOW).toISOString(),
      secretAt,
    };
    await kv.put(kvKeys.authToken(token), USER_ID);
    await kv.put(kvKeys.auth(USER_ID), JSON.stringify(record));
  }

  it.each(ROUTES)(
    "$route: refuses a correct secret checked against an older record and writes no upgrade",
    async ({ route, seed, call }) => {
      await seed();
      await seedAuth(SECRET_UPDATED_AT + 1);
      const raw = await seedVerify(await v1Record());
      const ops = watchKvOps(kv);

      const res = await call(PIN, { pepper: PEPPER });

      if (route === "lookup") {
        expect(res.status).toBe(200);
        expect(((await res.json()) as Json).data).toEqual({
          existingFamilyId: null,
          memberCount: 0,
          requiresVerification: 1,
        });
      } else {
        expect(res.status).toBe(403);
        expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
      }
      expect(verifyPuts(ops)).toEqual([]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
    },
  );

  it.each(ROUTES)(
    "$route: upgrades when secretAt equals the record's secretUpdatedAt",
    async ({ seed, call, okStatus }) => {
      await seed();
      await seedAuth(SECRET_UPDATED_AT);
      await seedVerify(await v1Record());

      const res = await call(PIN, { pepper: PEPPER });

      expect(res.status).toBe(okStatus);
      expect((await storedVerify())?.version).toBe(VERIFY_HASH_VERSION_PEPPER);
    },
  );
});

describe("paths that compare no secret never upgrade", () => {
  it("a secret-less lookup probe leaves the v1 record alone", async () => {
    const raw = await seedVerify(await v1Record());
    const ops = watchKvOps(kv);

    const res = await send(
      "POST",
      "/api/auth/lookup",
      { userId: USER_ID },
      { pepper: PEPPER },
    );

    expect(((await res.json()) as Json).data.requiresVerification).toBe(1);
    expect(verifyPuts(ops)).toEqual([]);
    expect(await kv.get(VERIFY_KEY)).toBe(raw);
  });

  it("a QR-bypassed join leaves the v1 record alone", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
    const token = await seedAuthToken(kv, USER_ID);
    const qr = "e".repeat(64);
    await kv.put(
      kvKeys.qrToken(qr),
      JSON.stringify({
        userId: USER_ID,
        tokenHash: await hashSecret("qr:", token),
      }),
      { expirationTtl: QR_TOKEN_TTL_SECONDS },
    );
    const raw = await seedVerify(await v1Record());
    const ops = watchKvOps(kv);

    const res = await send(
      "POST",
      `/api/family/${FAMILY_ID}/join`,
      { userId: USER_ID, qrToken: qr },
      { pepper: PEPPER },
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.authToken).toBe(token);
    expect(verifyPuts(ops)).toEqual([]);
    expect(await kv.get(VERIFY_KEY)).toBe(raw);
  });
});

/** Records this Worker cannot check, with the env that makes them so and the logged event. */
const UNVERIFIABLE = [
  {
    label: "a v2 record with no pepper",
    pepper: undefined,
    record: () => v2Record(),
    event: "VERIFY_PEPPER_MISSING",
  },
  {
    label: "a v2 record with a blank pepper",
    pepper: "   ",
    record: () => v2Record(),
    event: "VERIFY_PEPPER_MISSING",
  },
  {
    label: "a v2 record under another pepper",
    pepper: OTHER_PEPPER,
    record: () => v2Record(),
    event: "VERIFY_PEPPER_MISMATCH",
  },
  {
    label: "a version 3 record with a pepper",
    pepper: PEPPER,
    record: async () => ({ ...(await v1Record()), version: 3 }),
    event: "VERIFY_HASH_VERSION_UNSUPPORTED",
  },
  {
    label: "a version 3 record without a pepper",
    pepper: undefined,
    record: async () => ({ ...(await v1Record()), version: 3 }),
    event: "VERIFY_HASH_VERSION_UNSUPPORTED",
  },
];

async function expectNothingCharged(
  ops: ReturnType<typeof watchKvOps>,
  raw: string,
): Promise<void> {
  expect(ops.writeTrail()).toEqual([]);
  expect(await kv.get(FAIL_KEY)).toBeNull();
  expect(await kv.get(await ceilingKey())).toBeNull();
  expect(await kv.get(VERIFY_KEY)).toBe(raw);
}

describe("create / join / lookup — 503 VERIFY_UNAVAILABLE on an unverifiable record", () => {
  it.each(
    cross(cross(ROUTES, UNVERIFIABLE), [
      { secretLabel: "the correct secret", secret: PIN },
      { secretLabel: "a wrong secret", secret: WRONG_PIN },
    ]),
  )(
    "$route: $label + $secretLabel ⇒ 503, logged, nothing charged",
    async ({ seed, call, pepper, record, event, secret }) => {
      await seed();
      const raw = await seedVerify(await record());
      const ops = watchKvOps(kv);

      const res = await call(secret, { pepper, prod: true });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE_BODY);
      expect(errors.mock.calls).toEqual([[event]]);
      await expectNothingCharged(ops, raw);
    },
  );

  it.each(cross(NO_SECRET_ROUTES, UNVERIFIABLE))(
    "$route: $label without a secret ⇒ 503, not VERIFICATION_REQUIRED",
    async ({ seed, call, pepper, record, event }) => {
      await seed();
      const raw = await seedVerify(await record());
      const ops = watchKvOps(kv);

      const res = await call(undefined, { pepper, prod: true });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE_BODY);
      expect(errors.mock.calls).toEqual([[event]]);
      await expectNothingCharged(ops, raw);
    },
  );

  it.each(ROUTES)(
    "$route: positive companion — a wrong guess under the right pepper charges both counters",
    async ({ seed, call }) => {
      await seed();
      await seedVerify(await v2Record());

      const res = await call(WRONG_PIN, { pepper: PEPPER, prod: true });

      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("VERIFICATION_FAILED");
      expect(await kv.get(FAIL_KEY)).not.toBeNull();
      expect(await kv.get(await ceilingKey())).not.toBeNull();
    },
  );
});

describe("step-ups never upgrade, and inherit the 503", () => {
  function putVerify(body: unknown, token: string, pepper?: string) {
    return send("PUT", `/api/user/${USER_ID}/verify`, body, { pepper, token });
  }

  function deleteUser(body: unknown, token: string, pepper?: string) {
    return send("DELETE", `/api/user/${USER_ID}`, body, { pepper, token });
  }

  it("PUT /verify with the current secret writes only its own new v2 record", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    await seedVerify(await v1Record());
    const ops = watchKvOps(kv);

    const res = await putVerify(
      { method: "pin", secret: NEW_PIN, currentSecret: PIN },
      token,
      PEPPER,
    );

    expect(res.status).toBe(200);
    expect(verifyPuts(ops)).toEqual([VERIFY_KEY]);
    const stored = await storedVerify();
    expect(stored?.salt).not.toBe(SALT);
    expect(stored?.hash).toBe(
      await hashSecretWithPepper(PEPPER, stored?.salt as string, NEW_PIN),
    );
    expect(stored?.secretUpdatedAt).toBe(PINNED_NOW);
  });

  it("PUT /verify switching to none writes the none record once and nothing else", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    await seedVerify(await v1Record());
    const ops = watchKvOps(kv);

    const res = await putVerify(
      { method: "none", currentSecret: PIN },
      token,
      PEPPER,
    );

    expect(res.status).toBe(200);
    expect(verifyPuts(ops)).toEqual([VERIFY_KEY]);
    const stored = await storedVerify();
    expect(stored).toEqual({
      method: "none",
      hash: null,
      salt: null,
      prompted: 1,
      secretUpdatedAt: PINNED_NOW,
    });
  });

  it("DELETE /user with the current secret deletes the v1 record without rewriting it", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    await seedVerify(await v1Record());
    const ops = watchKvOps(kv);

    const res = await deleteUser({ currentSecret: PIN }, token, PEPPER);

    expect(res.status).toBe(200);
    expect(verifyPuts(ops)).toEqual([]);
    expect(ops.deleteKeys()).toContain(VERIFY_KEY);
    expect(await kv.get(VERIFY_KEY)).toBeNull();
  });

  it.each([
    { label: "the current secret", currentSecret: PIN },
    { label: "no current secret", currentSecret: undefined },
  ])(
    "PUT /verify on a v2 record with no pepper and $label ⇒ 503, nothing written",
    async ({ currentSecret }) => {
      const token = await seedAuthToken(kv, USER_ID);
      const raw = await seedVerify(await v2Record());
      const ops = watchKvOps(kv);

      const res = await putVerify(
        { method: "pin", secret: NEW_PIN, currentSecret },
        token,
      );

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE_BODY);
      expect(errors.mock.calls).toEqual([["VERIFY_PEPPER_MISSING"]]);
      expect(ops.writeTrail()).toEqual([]);
      expect(await kv.get(VERIFY_KEY)).toBe(raw);
    },
  );

  it("DELETE /user on a v2 record under another pepper ⇒ 503, account intact", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    const raw = await seedVerify(await v2Record());
    const ops = watchKvOps(kv);

    const res = await deleteUser({ currentSecret: PIN }, token, OTHER_PEPPER);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE_BODY);
    expect(errors.mock.calls).toEqual([["VERIFY_PEPPER_MISMATCH"]]);
    expect(ops.writeTrail()).toEqual([]);
    expect(await kv.get(VERIFY_KEY)).toBe(raw);
    expect(await kv.get(kvKeys.authToken(token))).toBe(USER_ID);
  });
});

describe("PUT /api/user/:id/verify — new record shape", () => {
  async function setVerify(
    body: Record<string, unknown>,
    pepper?: string,
  ): Promise<VerifyRecord | null> {
    const token = await seedAuthToken(kv, USER_ID);
    const res = await send("PUT", `/api/user/${USER_ID}/verify`, body, {
      pepper,
      token,
    });
    expect(res.status).toBe(200);
    return storedVerify();
  }

  it.each(METHODS)(
    "with a pepper, a new $method is stored as v2 with pepperId and an HMAC hash",
    async ({ method, secret }) => {
      const stored = await setVerify({ method, secret }, PEPPER);

      expect(stored?.version).toBe(VERIFY_HASH_VERSION_PEPPER);
      expect(stored?.pepperId).toBe(await pepperFingerprint(PEPPER));
      const salt = stored?.salt as string;
      expect(salt).toMatch(/^[0-9a-f]{32}$/);
      expect(stored?.hash).toBe(
        await hashSecretWithPepper(PEPPER, salt, secret),
      );
      expect(stored?.hash).not.toBe(await hashSecret(salt, secret));
    },
  );

  it.each(METHODS)(
    "without a pepper, a new $method keeps the v1 shape (no version / pepperId)",
    async ({ method, secret }) => {
      const stored = await setVerify({ method, secret });

      expect(stored && "version" in stored).toBe(false);
      expect(stored && "pepperId" in stored).toBe(false);
      expect(stored?.hash).toBe(
        await hashSecret(stored?.salt as string, secret),
      );
    },
  );

  it.each(["none", "code"])(
    "with a pepper, method %s stores no version / pepperId",
    async (method) => {
      const stored = await setVerify({ method }, PEPPER);

      expect(stored).toEqual({
        method,
        hash: null,
        salt: null,
        prompted: 0,
        secretUpdatedAt: PINNED_NOW,
      });
    },
  );

  it("a PIN saved with a pepper is admitted by lookup and not rewritten", async () => {
    await setVerify({ method: "pin", secret: PIN }, PEPPER);
    const raw = await kv.get(VERIFY_KEY);
    const ops = watchKvOps(kv);

    const res = await send(
      "POST",
      "/api/auth/lookup",
      { userId: USER_ID, verifySecret: PIN },
      { pepper: PEPPER },
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.requiresVerification).toBe(0);
    expect(verifyPuts(ops)).toEqual([]);
    expect(await kv.get(VERIFY_KEY)).toBe(raw);
  });
});
