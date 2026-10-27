import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import { hashSecret } from "../../src/utils/crypto";
import {
  kvKeys,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type OtpRecord,
  type QrTokenRecord,
  type VerifyRecord,
} from "../../src/kv/schema";

/**
 * Auth-token rotation on `PUT /api/user/:id/verify` (#378), and the paths
 * that must not hand a pre-change session back its access: the QR bypass on
 * join, `POST /api/auth/refresh`, and the verify PUT itself.
 *
 * Setting a NEW secret — `pin` or `pattern` — revokes the account's auth
 * token and issues a fresh pair: `token:{old}` is deleted, `auth:{userId}` and
 * `token:{new}` are written, and the response carries `authToken` +
 * `expiresAt` next to `method` / `prompted`. A session opened under the old
 * secret (a stolen PWA token, a shared device) stops working the moment the
 * owner changes it. `none` and `code` rotate nothing: `none` sets no secret,
 * and `code` is the method whose OTP the Extension DISPLAYS but cannot type, so
 * revoking its token would lock the Extension out. Their response keeps the
 * pre-#378 shape `{ method, prompted }` exactly, while the record still stamps
 * `secretUpdatedAt` like every method change.
 *
 * Pending one-time code: a `pin` / `pattern` save also deletes `otp:{userId}`,
 * so a code displayed before the change cannot open the account afterwards;
 * `none` / `code` saves leave it alone.
 *
 * Rejected PUTs: a request refused before the record write (bad secret, bad
 * method, someone else's token, a revoked bearer) must leave every session as
 * it was — a 400 is not a reason to log the owner out.
 *
 * Record first, then rotation: the verify record is written BEFORE the token
 * swap. When the swap then fails the request answers 500 with the new secret
 * already in force — never the reverse, a session revoked while the old secret
 * still opens the account. `failPutFor` makes ONE key's put throw (the wrapper
 * from `kickedTombstone.test.ts`) and returns the plain mock, which the test
 * reads afterwards; `beforeEach` builds a fresh mock, so nothing is restored.
 *
 * Stale colo: KV is eventually consistent, so a colo that has not seen the
 * rotation's delete can still accept the revoked token. Modelled by re-seeding
 * `token:{old}` alone while `auth:{userId}` names the rotated token
 * (`revokedButAccepted`). Bearer currency — the one rule shared by refresh and
 * the verify PUT — says such a bearer is NOT current: refresh answers
 * `401 REFRESH_FAILED` and the verify PUT `401 UNAUTHORIZED`, both writing
 * nothing, rather than renew it or let it change the secret. With no
 * `auth:{userId}` record at all (TTL gap) the bearer counts as current.
 *
 * QR binding: `POST /qr-token` stores `{ userId, tokenHash }`, where
 * `tokenHash` is the hex SHA-256 of `"qr:" + <minting bearer>` — pinned here
 * with `hashSecret("qr:", …)` directly, not through the production helper, so
 * a salt change fails this file. A join presenting a QR token issued to its
 * userId always SPENDS it (deleted). The gate skips verification only while
 * `auth:{userId}` still names the minting token (a pure hash compare); the
 * join then only RENEWS that token, which needs `token:{that token}` to still
 * map to the user — otherwise `403 VERIFICATION_REQUIRED` before any write. A
 * record without `tokenHash` (the older shape), or whose hash names another
 * token, never bypasses; such a QR falls through to the ordinary secret check,
 * so it neither opens the account nor blocks the correct secret. `none` /
 * `code` keep the token, so a QR survives a switch to them.
 *
 * A QR bypass never mints, on either join branch: the new-member join and the
 * reconnect both hand back the bound token with its pair re-put (sliding TTL).
 * When the colo missed the WHOLE rotation (both halves of the old pair
 * re-seeded) the bound QR still bypasses and the join hands back that OLD token
 * — never the rotated one; the colo still accepts the old token anyway (accepted
 * residual, docs/architecture.md → PWA 登入驗證機制). `staleFirstRead` sharpens
 * this: the gate's `auth:` read sees the old record while any later read would
 * see the new one, so the join must reuse the gate's record. Half-stale —
 * `auth:` names the old token but `token:{old}` is gone — is refused with only
 * the QR delete written. `onDeleteOf` models the reverse key vanishing between
 * the gate and the renewal (a rotation landing mid-request).
 *
 * TTL-gap PUT: with no `auth:{userId}` record the presented bearer is still the
 * token a PIN / pattern save revokes — `token:{presented}` is deleted.
 *
 * `AuthRecord.secretAt`: a PIN / pattern save writes it as the new verify
 * record's `secretUpdatedAt`; later mints and renewals carry it forward; a
 * token minted for an account that never saved a PIN has none. The join's
 * refusal of a secret checked against an older verify record lives in
 * `joinStaleVerifyRecord.test.ts`.
 *
 * Current secret (#396): once the account holds a PIN / pattern, every later
 * verify PUT — whatever the target method — carries that PIN as `currentSecret`
 * (`withCurrentPin`). The step-up itself is covered by `verifyStepUp.test.ts`.
 *
 * Every request runs with DEV_MODE: the verify-set ceiling is not under test
 * here (`verifySetRateLimit.test.ts` covers it). `Date` is pinned (timers stay
 * real) so `expiresAt` can be asserted exactly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const OTHER_USER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const WRONG_PIN = "000000";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
const HEX_64 = /^[a-f0-9]{64}$/;
const TOKEN_KEY_PREFIX = kvKeys.authToken("");

/** The two methods that set a typed secret, and so rotate the token. */
const SECRET_METHODS = [
  { method: "pin", body: { method: "pin", secret: PIN } },
  { method: "pattern", body: { method: "pattern", secret: "0,1,2,5,8" } },
];

/** The methods that keep the session (no typed secret). */
const SESSION_KEEPING_METHODS = [{ method: "none" }, { method: "code" }];

/** Every method, as a verify PUT body. */
const ALL_METHOD_BODIES = [
  ...SECRET_METHODS,
  ...SESSION_KEEPING_METHODS.map(({ method }) => ({
    method,
    body: { method },
  })),
];

async function request(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function putVerify(token: string, body: unknown): Promise<Response> {
  return request("PUT", `/api/user/${USER_ID}/verify`, token, body);
}

/** A verify PUT body from a PIN account, carrying its current PIN. See the header → "Current secret". */
function withCurrentPin(body: object): object {
  return { ...body, currentSecret: PIN };
}

/** PUT a PIN and return the token the rotation issued. */
async function setPin(token: string): Promise<string> {
  const res = await putVerify(token, SECRET_METHODS[0].body);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** An authenticated owner-only read — the probe for "does this token still work". */
function readBooks(token: string): Promise<Response> {
  return request("GET", `/api/user/${USER_ID}/books`, token);
}

function refresh(token: string): Promise<Response> {
  return request("POST", "/api/auth/refresh", token, { userId: USER_ID });
}

async function mintQr(token: string): Promise<string> {
  const res = await request("POST", `/api/user/${USER_ID}/qr-token`, token, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.token as string;
}

function join(extra: Record<string, unknown>): Promise<Response> {
  return request("POST", `/api/family/${FAMILY_ID}/join`, undefined, {
    userId: USER_ID,
    ...extra,
  });
}

/** The `tokenHash` a QR minted by `authToken` carries. See the header → "QR binding". */
function qrBindingOf(authToken: string): Promise<string> {
  return hashSecret("qr:", authToken);
}

function seedFamilyRecord(members: string[]): Promise<void> {
  return kv.put(
    kvKeys.family(FAMILY_ID),
    JSON.stringify({
      familyId: FAMILY_ID,
      ownerId: OTHER_USER_ID,
      members: members.map((userId) => ({ userId, displayName: "Member" })),
      maxMembers: 2,
      createdAt: new Date(PINNED_NOW).toISOString(),
    }),
  );
}

/** A family owned by OTHER_USER_ID with one free slot for USER_ID (new-member branch). */
async function seedFamily(): Promise<void> {
  await kv.put(kvKeys.member(OTHER_USER_ID), FAMILY_ID);
  await seedFamilyRecord([OTHER_USER_ID]);
}

/** The same family with USER_ID already listed and pointed (reconnect branch). */
async function seedFamilyWithUser(): Promise<void> {
  await kv.put(kvKeys.member(OTHER_USER_ID), FAMILY_ID);
  await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
  await seedFamilyRecord([OTHER_USER_ID, USER_ID]);
}

async function seedQrRecord(token: string, record: QrTokenRecord) {
  await kv.put(kvKeys.qrToken(token), JSON.stringify(record), {
    expirationTtl: QR_TOKEN_TTL_SECONDS,
  });
}

function authRecordFor(token: string): AuthRecord {
  return { token, createdAt: new Date(PINNED_NOW).toISOString() };
}

/** Put back an `auth:{userId}` record naming `token` — a colo that missed the rotation's record write. */
async function seedStaleAuthRecord(token: string): Promise<void> {
  await kv.put(kvKeys.auth(USER_ID), JSON.stringify(authRecordFor(token)));
}

/** PIN change, then a stale colo still mapping the revoked token to the user.
 *  See the header → "Stale colo". */
async function revokedButAccepted(): Promise<{ old: string; next: string }> {
  const old = await seedAuthToken(kv, USER_ID);
  const next = await setPin(old);
  await kv.put(kvKeys.authToken(old), USER_ID);
  return { old, next };
}

/** A QR minted by a fresh session, then a PIN change rotating that session. */
async function qrThenPinChange(): Promise<{
  old: string;
  next: string;
  qr: string;
}> {
  const old = await seedAuthToken(kv, USER_ID);
  const qr = await mintQr(old);
  const next = await setPin(old);
  return { old, next, qr };
}

async function expectUnauthorized(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
}

async function expectErrorCode(res: Response, code: string): Promise<void> {
  expect(res.status).toBe(403);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

async function readAuthRecord(
  store: KVNamespace,
  userId: string,
): Promise<AuthRecord | null> {
  return store.get<AuthRecord>(kvKeys.auth(userId), "json");
}

async function readVerifyRecord(
  store: KVNamespace,
  userId: string,
): Promise<VerifyRecord | null> {
  return store.get<VerifyRecord>(kvKeys.verify(userId), "json");
}

/** Make `put` throw for ONE key only; returns the plain mock underneath.
 *  See the header → "Record first, then rotation". */
function failPutFor(failingKey: string): KVNamespace {
  const base = kv;
  const put = base.put.bind(base) as (
    key: string,
    value: string,
    opts?: unknown,
  ) => Promise<void>;
  kv = {
    ...base,
    put: async (key: string, value: string, opts?: unknown): Promise<void> => {
      if (key === failingKey) throw new Error("simulated KV put failure");
      return put(key, value, opts);
    },
  } as unknown as KVNamespace;
  return base;
}

/** Answer the FIRST `get` of `key` with `staleValue`, every later one from the store.
 *  See the header → "QR on a stale colo". */
function staleFirstRead(key: string, staleValue: string): void {
  const base = kv;
  const get = base.get.bind(base) as (
    key: string,
    type?: unknown,
  ) => Promise<unknown>;
  let served = false;
  kv = {
    ...base,
    get: async (k: string, type?: unknown): Promise<unknown> => {
      if (k !== key || served) return get(k, type);
      served = true;
      return type === "json" ? JSON.parse(staleValue) : staleValue;
    },
  } as unknown as KVNamespace;
}

/** After the request's `delete` of `key`, also delete `alsoDelete` from the plain store (unwatched).
 *  See the header → "A QR bypass never mints". */
function onDeleteOf(key: string, alsoDelete: string): void {
  const base = kv;
  const del = base.delete.bind(base);
  kv = {
    ...base,
    delete: async (k: string): Promise<void> => {
      await del(k);
      if (k === key) await del(alsoDelete);
    },
  } as unknown as KVNamespace;
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/verify — token rotation on a new secret", () => {
  it.each(SECRET_METHODS)(
    "returns a fresh authToken and its expiresAt when setting $method",
    async ({ method, body }) => {
      const oldToken = await seedAuthToken(kv, USER_ID);

      const res = await putVerify(oldToken, body);

      expect(res.status).toBe(200);
      const { data } = (await res.json()) as Json;
      expect(Object.keys(data).sort()).toEqual([
        "authToken",
        "expiresAt",
        "method",
        "prompted",
      ]);
      expect(data.method).toBe(method);
      expect(data.authToken).toMatch(HEX_64);
      expect(data.authToken).not.toBe(oldToken);
      expect(data.expiresAt).toBe(PINNED_NOW + TOKEN_TTL_SECONDS * 1000);
    },
  );

  it.each(SECRET_METHODS)(
    "revokes the old token and admits the new one after setting $method",
    async ({ body }) => {
      const oldToken = await seedAuthToken(kv, USER_ID);

      const res = await putVerify(oldToken, body);
      const newToken = ((await res.json()) as Json).data.authToken as string;

      await expectUnauthorized(await readBooks(oldToken));
      expect((await readBooks(newToken)).status).toBe(200);
    },
  );

  it.each(SECRET_METHODS)(
    "swaps the stored token pair when setting $method",
    async ({ body }) => {
      const oldToken = await seedAuthToken(kv, USER_ID);

      const res = await putVerify(oldToken, body);
      const newToken = ((await res.json()) as Json).data.authToken as string;

      expect(await kv.get(kvKeys.authToken(oldToken))).toBeNull();
      expect(await kv.get(kvKeys.authToken(newToken))).toBe(USER_ID);
      expect((await readAuthRecord(kv, USER_ID))?.token).toBe(newToken);
      // Both halves expire with the token, like every other issued pair.
      expect(getPutTtl(kv, kvKeys.authToken(newToken))).toBe(TOKEN_TTL_SECONDS);
      expect(getPutTtl(kv, kvKeys.auth(USER_ID))).toBe(TOKEN_TTL_SECONDS);
    },
  );

  it.each(SECRET_METHODS)(
    "stamps the new auth record's secretAt with the verify record's secretUpdatedAt when setting $method",
    async ({ body }) => {
      const oldToken = await seedAuthToken(kv, USER_ID);

      const res = await putVerify(oldToken, body);
      const newToken = ((await res.json()) as Json).data.authToken as string;

      const verify = await readVerifyRecord(kv, USER_ID);
      expect(verify?.secretUpdatedAt).toBe(PINNED_NOW);
      expect(await readAuthRecord(kv, USER_ID)).toEqual({
        token: newToken,
        createdAt: new Date(PINNED_NOW).toISOString(),
        secretAt: verify?.secretUpdatedAt,
      });
    },
  );

  it("moves secretAt forward on a later secret change", async () => {
    const first = await setPin(await seedAuthToken(kv, USER_ID));
    vi.setSystemTime(PINNED_NOW + 5_000);

    const res = await putVerify(first, withCurrentPin(SECRET_METHODS[1].body));

    expect(res.status).toBe(200);
    expect((await readVerifyRecord(kv, USER_ID))?.secretUpdatedAt).toBe(
      PINNED_NOW + 5_000,
    );
    expect((await readAuthRecord(kv, USER_ID))?.secretAt).toBe(
      PINNED_NOW + 5_000,
    );
  });

  it("refuses POST /api/auth/refresh with the old token after a PIN change", async () => {
    const oldToken = await seedAuthToken(kv, USER_ID);
    const newToken = await setPin(oldToken);

    await expectUnauthorized(await refresh(oldToken));

    // The rotated token is a full session: it refreshes like any other.
    expect((await refresh(newToken)).status).toBe(200);
  });

  it("rotates again on every later secret change", async () => {
    const firstToken = await seedAuthToken(kv, USER_ID);
    const secondToken = await setPin(firstToken);

    const second = await putVerify(
      secondToken,
      withCurrentPin(SECRET_METHODS[1].body),
    );
    expect(second.status).toBe(200);
    const thirdToken = ((await second.json()) as Json).data.authToken as string;

    expect(thirdToken).toMatch(HEX_64);
    expect(new Set([firstToken, secondToken, thirdToken]).size).toBe(3);
    await expectUnauthorized(await readBooks(secondToken));
    expect((await readBooks(thirdToken)).status).toBe(200);
  });

  it("does not touch another user's session", async () => {
    const oldToken = await seedAuthToken(kv, USER_ID);
    const otherToken = await seedAuthToken(kv, OTHER_USER_ID);

    await setPin(oldToken);

    expect(await kv.get(kvKeys.authToken(otherToken))).toBe(OTHER_USER_ID);
    expect((await readAuthRecord(kv, OTHER_USER_ID))?.token).toBe(otherToken);
  });

  it("writes the verify record before swapping the token pair", async () => {
    const oldToken = await seedAuthToken(kv, USER_ID);
    const ops = watchKvOps(kv);

    const newToken = await setPin(oldToken);

    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`put ${kvKeys.verify(USER_ID)}`);
    expect([...trail].sort()).toEqual(
      [
        `put ${kvKeys.verify(USER_ID)}`,
        `delete ${kvKeys.authToken(oldToken)}`,
        `delete ${kvKeys.otp(USER_ID)}`,
        `put ${kvKeys.auth(USER_ID)}`,
        `put ${kvKeys.authToken(newToken)}`,
      ].sort(),
    );
    // The swap itself stays serialized: the old reverse key goes before the new pair.
    const revoke = trail.indexOf(`delete ${kvKeys.authToken(oldToken)}`);
    expect(revoke).toBeLessThan(trail.indexOf(`put ${kvKeys.auth(USER_ID)}`));
    expect(revoke).toBeLessThan(
      trail.indexOf(`put ${kvKeys.authToken(newToken)}`),
    );
    // The auth: put carries the secretAt of this rotation.
    const authPut = (kv.put as unknown as MockInstance).mock.calls.find(
      ([key]) => key === kvKeys.auth(USER_ID),
    );
    expect(JSON.parse(String(authPut?.[1]))).toEqual({
      token: newToken,
      createdAt: new Date(PINNED_NOW).toISOString(),
      secretAt: PINNED_NOW,
    });
  });
});

describe("PUT /api/user/:id/verify — methods none and code keep the session", () => {
  it.each(SESSION_KEEPING_METHODS)(
    "answers exactly { method, prompted } for $method and writes only the verify record",
    async ({ method }) => {
      const token = await seedAuthToken(kv, USER_ID);
      const ops = watchKvOps(kv);

      const res = await putVerify(token, { method });

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data).toEqual({
        method,
        prompted: 0,
      });
      expect(ops.writeTrail()).toEqual([`put ${kvKeys.verify(USER_ID)}`]);
    },
  );

  it.each(SESSION_KEEPING_METHODS)(
    "leaves the current token pair working after setting $method",
    async ({ method }) => {
      const token = await seedAuthToken(kv, USER_ID);

      await putVerify(token, { method });

      expect(await kv.get(kvKeys.authToken(token))).toBe(USER_ID);
      expect((await readAuthRecord(kv, USER_ID))?.token).toBe(token);
      expect((await readBooks(token)).status).toBe(200);
    },
  );

  it.each(SESSION_KEEPING_METHODS)(
    "still stamps secretUpdatedAt when setting $method",
    async ({ method }) => {
      const token = await seedAuthToken(kv, USER_ID);

      await putVerify(token, { method });

      const record = await readVerifyRecord(kv, USER_ID);
      expect(record?.method).toBe(method);
      expect(record?.hash).toBeNull();
      expect(record?.secretUpdatedAt).toBe(PINNED_NOW);
    },
  );

  it.each(SESSION_KEEPING_METHODS)(
    "keeps the current token when switching a PIN to $method",
    async ({ method }) => {
      const seeded = await seedAuthToken(kv, USER_ID);
      const token = await setPin(seeded);

      const res = await putVerify(token, withCurrentPin({ method }));

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data).not.toHaveProperty("authToken");
      expect((await readVerifyRecord(kv, USER_ID))?.method).toBe(method);
      expect((await readBooks(token)).status).toBe(200);
    },
  );
});

describe("PUT /api/user/:id/verify — a pending one-time code", () => {
  const OTP: OtpRecord = {
    code: "654321",
    createdAt: new Date(PINNED_NOW).toISOString(),
  };

  async function seedOtp(): Promise<void> {
    await kv.put(kvKeys.otp(USER_ID), JSON.stringify(OTP), {
      expirationTtl: OTP_TTL_SECONDS,
    });
  }

  it.each(SECRET_METHODS)(
    "is deleted when setting $method",
    async ({ body }) => {
      const token = await seedAuthToken(kv, USER_ID);
      await seedOtp();
      expect(await kv.get(kvKeys.otp(USER_ID), "json")).toEqual(OTP);

      const res = await putVerify(token, body);

      expect(res.status).toBe(200);
      expect(await kv.get(kvKeys.otp(USER_ID))).toBeNull();
    },
  );

  it.each(SESSION_KEEPING_METHODS)(
    "is kept when setting $method",
    async ({ method }) => {
      const token = await seedAuthToken(kv, USER_ID);
      await seedOtp();

      const res = await putVerify(token, { method });

      expect(res.status).toBe(200);
      expect(await kv.get(kvKeys.otp(USER_ID), "json")).toEqual(OTP);
    },
  );
});

describe("PUT /api/user/:id/verify — a rejected request rotates nothing", () => {
  it.each([
    { label: "a PIN that is too short", body: { method: "pin", secret: "1" } },
    {
      label: "a pattern with too few nodes",
      body: { method: "pattern", secret: "0,1" },
    },
    { label: "an unknown method", body: { method: "fingerprint" } },
  ])("keeps the token after $label (400)", async ({ body }) => {
    const token = await seedAuthToken(kv, USER_ID);

    const res = await putVerify(token, body);

    expect(res.status).toBe(400);
    expect(await kv.get(kvKeys.authToken(token))).toBe(USER_ID);
    expect((await readAuthRecord(kv, USER_ID))?.token).toBe(token);
    expect(await readVerifyRecord(kv, USER_ID)).toBeNull();
  });

  it("keeps both sessions when a token is aimed at another user's verify (401)", async () => {
    const victimToken = await seedAuthToken(kv, USER_ID);
    const callerToken = await seedAuthToken(kv, OTHER_USER_ID);

    const res = await putVerify(callerToken, SECRET_METHODS[0].body);

    await expectUnauthorized(res);
    expect((await readAuthRecord(kv, USER_ID))?.token).toBe(victimToken);
    expect((await readAuthRecord(kv, OTHER_USER_ID))?.token).toBe(callerToken);
    expect(await readVerifyRecord(kv, USER_ID)).toBeNull();
  });
});

describe("PUT /api/user/:id/verify — only the account's current token may change it", () => {
  it.each(ALL_METHOD_BODIES)(
    "refuses a revoked bearer that still authenticates when setting $method (401), writing nothing",
    async ({ body }) => {
      const { old, next } = await revokedButAccepted();
      const verifyBefore = await kv.get(kvKeys.verify(USER_ID));
      expect(verifyBefore).not.toBeNull();
      const ops = watchKvOps(kv);

      const res = await putVerify(old, body);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
      expect(ops.writeTrail()).toEqual([]);
      expect(await kv.get(kvKeys.verify(USER_ID))).toBe(verifyBefore);
      expect((await readAuthRecord(kv, USER_ID))?.token).toBe(next);
      expect(await kv.get(kvKeys.authToken(next))).toBe(USER_ID);
    },
  );

  it("admits the token auth:{userId} names in the same state", async () => {
    const { next } = await revokedButAccepted();

    const res = await putVerify(next, withCurrentPin(SECRET_METHODS[1].body));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data.method).toBe("pattern");
    expect(data.authToken).toMatch(HEX_64);
    expect(data.authToken).not.toBe(next);
    expect((await readVerifyRecord(kv, USER_ID))?.method).toBe("pattern");
  });

  it.each(SECRET_METHODS)(
    "allows a bearer when no auth record exists (TTL gap), revoking it and minting a token on a $method save",
    async ({ method, body }) => {
      const token = "f".repeat(64);
      await kv.put(kvKeys.authToken(token), USER_ID);
      const ops = watchKvOps(kv);

      const res = await putVerify(token, body);

      expect(res.status).toBe(200);
      const minted = ((await res.json()) as Json).data.authToken as string;
      expect(minted).toMatch(HEX_64);
      expect(minted).not.toBe(token);
      // The presented bearer is the token revoked, even without an auth: record.
      expect(ops.deleteKeys()).toContain(kvKeys.authToken(token));
      expect(await kv.get(kvKeys.authToken(token))).toBeNull();
      await expectUnauthorized(await readBooks(token));
      expect((await readBooks(minted)).status).toBe(200);
      expect(await readAuthRecord(kv, USER_ID)).toEqual({
        token: minted,
        createdAt: new Date(PINNED_NOW).toISOString(),
        secretAt: PINNED_NOW,
      });
      expect(await kv.get(kvKeys.authToken(minted))).toBe(USER_ID);
      expect((await readVerifyRecord(kv, USER_ID))?.method).toBe(method);
    },
  );
});

describe("PUT /api/user/:id/verify — a failed token swap", () => {
  it("answers 500 with the new secret already stored", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    const store = failPutFor(kvKeys.auth(USER_ID));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await putVerify(token, SECRET_METHODS[0].body);

    expect(res.status).toBe(500);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.data).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    // Record first: the swap failed, yet the new PIN is in force.
    const record = await readVerifyRecord(store, USER_ID);
    expect(record?.method).toBe("pin");
    expect(record?.hash).toMatch(HEX_64);
    expect(record?.secretUpdatedAt).toBe(PINNED_NOW);
  });
});

describe("POST /api/user/:id/qr-token — bound to the minting token", () => {
  it("stores the userId and the hash of the minting token, never the token itself", async () => {
    // tokenFor(USER_ID) equals USER_ID itself, which the record legitimately holds.
    const token = await seedAuthToken(kv, USER_ID, {
      token: "0123456789abcdef".repeat(4),
    });

    const qr = await mintQr(token);

    const raw = (await kv.get(kvKeys.qrToken(qr))) as string;
    expect(JSON.parse(raw)).toEqual({
      userId: USER_ID,
      tokenHash: await qrBindingOf(token),
    });
    expect(JSON.parse(raw).tokenHash).toMatch(HEX_64);
    expect(raw).not.toContain(token);
    expect(getPutTtl(kv, kvKeys.qrToken(qr))).toBe(QR_TOKEN_TTL_SECONDS);
  });
});

describe("POST /api/family/:id/join — a QR minted before a PIN change", () => {
  beforeEach(seedFamily);

  it("refuses it without a secret, spends it, and admits no one", async () => {
    const { qr } = await qrThenPinChange();
    expect(await kv.get(kvKeys.qrToken(qr))).not.toBeNull();
    const ops = watchKvOps(kv);

    const res = await join({ qrToken: qr });

    await expectErrorCode(res, "VERIFICATION_REQUIRED");
    expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
    expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();
  });

  it.each([
    { label: "the new PIN", secret: PIN, status: 200, code: undefined },
    {
      label: "a wrong PIN",
      secret: WRONG_PIN,
      status: 403,
      code: "VERIFICATION_FAILED",
    },
  ])(
    "falls through to the secret check with $label, spending the stale QR",
    async ({ secret, status, code }) => {
      const { qr } = await qrThenPinChange();

      const res = await join({ qrToken: qr, verifySecret: secret });

      expect(res.status).toBe(status);
      const json = (await res.json()) as Json;
      if (code) expect(json.error.code).toBe(code);
      else expect(json.data.authToken).toMatch(HEX_64);
      expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
    },
  );

  it("refuses a QR minted by a revoked bearer that a stale colo still accepts", async () => {
    const { old } = await revokedButAccepted();
    const qr = await mintQr(old);

    const res = await join({ qrToken: qr });

    await expectErrorCode(res, "VERIFICATION_REQUIRED");
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
    expect(await kv.get(kvKeys.member(USER_ID))).toBeNull();
  });

  it("admits a stale QR once verification is turned off (nothing left to verify)", async () => {
    const { next, qr } = await qrThenPinChange();
    expect(
      (await putVerify(next, withCurrentPin({ method: "none" }))).status,
    ).toBe(200);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
  });
});

describe("POST /api/family/:id/join — a QR whose binding is not live", () => {
  beforeEach(seedFamily);

  it.each([
    {
      label: "auth:{userId} names the old token but token:{old} is gone",
      breakBinding: (old: string) => seedStaleAuthRecord(old),
    },
    {
      label: "token:{old} still maps but auth:{userId} names the new token",
      breakBinding: (old: string) => kv.put(kvKeys.authToken(old), USER_ID),
    },
    {
      label: "there is no auth:{userId} record at all",
      breakBinding: async (old: string) => {
        await kv.delete(kvKeys.auth(USER_ID));
        await kv.put(kvKeys.authToken(old), USER_ID);
      },
    },
  ])(
    "refuses the bypass when $label, spending the QR and minting nothing",
    async ({ breakBinding }) => {
      const { old, qr } = await qrThenPinChange();
      await breakBinding(old);
      const ops = watchKvOps(kv);

      const res = await join({ qrToken: qr });

      await expectErrorCode(res, "VERIFICATION_REQUIRED");
      expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
    },
  );

  it.each([
    {
      label: "an older-shape record without tokenHash",
      record: async (): Promise<QrTokenRecord> => ({ userId: USER_ID }),
      admitted: false,
    },
    {
      label: "an empty tokenHash",
      record: async (): Promise<QrTokenRecord> => ({
        userId: USER_ID,
        tokenHash: "",
      }),
      admitted: false,
    },
    {
      label: "a non-string tokenHash",
      record: async (): Promise<QrTokenRecord> => ({
        userId: USER_ID,
        tokenHash: 1 as unknown as string,
      }),
      admitted: false,
    },
    {
      label: "the live token itself in place of its hash",
      record: async (live: string): Promise<QrTokenRecord> => ({
        userId: USER_ID,
        tokenHash: live,
      }),
      admitted: false,
    },
    {
      label: "the hash of another user's token",
      record: async (): Promise<QrTokenRecord> => ({
        userId: USER_ID,
        tokenHash: await qrBindingOf(tokenFor(OTHER_USER_ID)),
      }),
      admitted: false,
    },
    {
      label: "the hash of the live token",
      record: async (live: string): Promise<QrTokenRecord> => ({
        userId: USER_ID,
        tokenHash: await qrBindingOf(live),
      }),
      admitted: true,
    },
  ])(
    "with $label: admitted without a secret = $admitted, spent either way",
    async ({ record, admitted }) => {
      const live = await setPin(await seedAuthToken(kv, USER_ID));
      const qr = "e".repeat(64);
      await seedQrRecord(qr, await record(live));

      const res = await join({ qrToken: qr });

      if (admitted) expect(res.status).toBe(200);
      else await expectErrorCode(res, "VERIFICATION_REQUIRED");
      expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
    },
  );
});

describe("POST /api/family/:id/join — a QR bound to the live token", () => {
  beforeEach(seedFamily);

  it("admits a QR minted after the PIN change with the rotated token", async () => {
    const next = await setPin(await seedAuthToken(kv, USER_ID));
    const qr = await mintQr(next);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
  });

  it("hands a new member the bound token renewed, minting nothing", async () => {
    const next = await setPin(await seedAuthToken(kv, USER_ID));
    const qr = await mintQr(next);
    const ops = watchKvOps(kv);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.authToken).toBe(next);
    expect([...ops.putKeys()].sort()).toEqual(
      [
        kvKeys.family(FAMILY_ID),
        kvKeys.member(USER_ID),
        kvKeys.auth(USER_ID),
        kvKeys.authToken(next),
      ].sort(),
    );
    expect(ops.deleteKeys()).toEqual([kvKeys.qrToken(qr)]);
    // The renewal keeps the record, secretAt included, and slides both TTLs.
    expect(await readAuthRecord(kv, USER_ID)).toEqual({
      token: next,
      createdAt: new Date(PINNED_NOW).toISOString(),
      secretAt: PINNED_NOW,
    });
    expect(getPutTtl(kv, kvKeys.authToken(next))).toBe(TOKEN_TTL_SECONDS);
    expect(getPutTtl(kv, kvKeys.auth(USER_ID))).toBe(TOKEN_TTL_SECONDS);
  });

  it("stays usable after a refresh of the token it is bound to", async () => {
    const token = await setPin(await seedAuthToken(kv, USER_ID));
    const qr = await mintQr(token);
    const renewed = await refresh(token);
    expect(((await renewed.json()) as Json).data.token).toBe(token);

    expect((await join({ qrToken: qr })).status).toBe(200);
  });

  it("stays usable across a switch to code (the token survives; the OTP is skipped)", async () => {
    const token = await setPin(await seedAuthToken(kv, USER_ID));
    const qr = await mintQr(token);
    expect(
      (await putVerify(token, withCurrentPin({ method: "code" }))).status,
    ).toBe(200);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
  });
});

describe("POST /api/family/:id/join — the reconnect after a QR bypass", () => {
  beforeEach(seedFamilyWithUser);

  it("hands back the token the QR is bound to, reading auth:{userId} once", async () => {
    const next = await setPin(await seedAuthToken(kv, USER_ID));
    const qr = await mintQr(next);
    const ops = watchKvOps(kv);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.authToken).toBe(next);
    expect(
      ops.getKeys().filter((k) => k === kvKeys.auth(USER_ID)),
    ).toHaveLength(1);
    expect(ops.deleteKeys()).toEqual([kvKeys.qrToken(qr)]);
  });

  it("hands a colo that missed the whole rotation the OLD token, minting nothing", async () => {
    const { old, next, qr } = await qrThenPinChange();
    await kv.put(kvKeys.authToken(old), USER_ID);
    await seedStaleAuthRecord(old);
    const ops = watchKvOps(kv);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    const authToken = ((await res.json()) as Json).data.authToken as string;
    expect(authToken).toBe(old);
    expect(authToken).not.toBe(next);
    // Only the sliding renew of the bound pair; no new token:* key, no revoke.
    expect(ops.putKeys().sort()).toEqual(
      [kvKeys.auth(USER_ID), kvKeys.authToken(old)].sort(),
    );
    expect(ops.putKeys().filter((k) => k.startsWith(TOKEN_KEY_PREFIX))).toEqual(
      [kvKeys.authToken(old)],
    );
    expect(ops.deleteKeys()).toEqual([kvKeys.qrToken(qr)]);
  });

  it("reuses the gate's auth record, never a newer one read later", async () => {
    const { old, next, qr } = await qrThenPinChange();
    await kv.put(kvKeys.authToken(old), USER_ID);
    staleFirstRead(kvKeys.auth(USER_ID), JSON.stringify(authRecordFor(old)));

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    const authToken = ((await res.json()) as Json).data.authToken as string;
    expect(authToken).toBe(old);
    expect(authToken).not.toBe(next);
  });

  it("refuses a QR minted before the PIN change without a secret", async () => {
    const { qr } = await qrThenPinChange();

    const res = await join({ qrToken: qr });

    await expectErrorCode(res, "VERIFICATION_REQUIRED");
    expect(await kv.get(kvKeys.qrToken(qr))).toBeNull();
  });

  it.each([
    { label: "pointed", pointed: true },
    { label: "pointerless (the heal would run)", pointed: false },
  ])(
    "refuses a half-stale colo ($label) with only the QR delete written",
    async ({ pointed }) => {
      const { old, qr } = await qrThenPinChange();
      await seedStaleAuthRecord(old);
      if (!pointed) await kv.delete(kvKeys.member(USER_ID));
      const ops = watchKvOps(kv);

      const res = await join({ qrToken: qr, displayName: "Renamed" });

      await expectErrorCode(res, "VERIFICATION_REQUIRED");
      expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
    },
  );
});

describe("POST /api/family/:id/join — the bound token's reverse key vanishes after the gate", () => {
  it.each([
    { branch: "reconnect", seed: seedFamilyWithUser },
    { branch: "new member", seed: seedFamily },
  ])(
    "refuses the $branch join without writing a token, a pointer or the family",
    async ({ seed }) => {
      await seed();
      const live = await setPin(await seedAuthToken(kv, USER_ID));
      const qr = await mintQr(live);
      const familyBefore = await kv.get(kvKeys.family(FAMILY_ID));
      const memberBefore = await kv.get(kvKeys.member(USER_ID));
      onDeleteOf(kvKeys.qrToken(qr), kvKeys.authToken(live));
      const ops = watchKvOps(kv);

      const res = await join({ qrToken: qr, displayName: "Renamed" });

      await expectErrorCode(res, "VERIFICATION_REQUIRED");
      expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
      // Positive companion: the renewal did look up the bound reverse key.
      expect(ops.getKeys()).toContain(kvKeys.authToken(live));
      expect(await kv.get(kvKeys.family(FAMILY_ID))).toBe(familyBefore);
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(memberBefore);
      expect(await kv.get(kvKeys.authToken(live))).toBeNull();
    },
  );
});

describe("AuthRecord.secretAt across later token writes", () => {
  it("is carried into the token a later new-member join mints", async () => {
    await seedFamily();
    const rotated = await setPin(await seedAuthToken(kv, USER_ID));
    vi.setSystemTime(PINNED_NOW + 60_000);

    const res = await join({ verifySecret: PIN });

    expect(res.status).toBe(200);
    const minted = ((await res.json()) as Json).data.authToken as string;
    expect(minted).not.toBe(rotated);
    expect(await readAuthRecord(kv, USER_ID)).toEqual({
      token: minted,
      createdAt: new Date(PINNED_NOW + 60_000).toISOString(),
      secretAt: PINNED_NOW,
    });
  });

  it("is kept by a refresh renewal", async () => {
    const rotated = await setPin(await seedAuthToken(kv, USER_ID));

    expect((await refresh(rotated)).status).toBe(200);

    expect((await readAuthRecord(kv, USER_ID))?.secretAt).toBe(PINNED_NOW);
  });

  it("is absent from a token minted for an account that never saved a PIN", async () => {
    await seedFamily();

    const res = await join({});

    expect(res.status).toBe(200);
    const minted = ((await res.json()) as Json).data.authToken as string;
    const record = await readAuthRecord(kv, USER_ID);
    expect(record?.token).toBe(minted);
    expect(record).not.toHaveProperty("secretAt");
  });

  it.each(SESSION_KEEPING_METHODS)(
    "is not added by a $method save",
    async ({ method }) => {
      const token = await seedAuthToken(kv, USER_ID);

      await putVerify(token, { method });

      expect(await readAuthRecord(kv, USER_ID)).not.toHaveProperty("secretAt");
    },
  );
});

describe("POST /api/auth/refresh — renews only the token it was presented", () => {
  it("refuses a revoked bearer that still authenticates, writing nothing", async () => {
    const { old, next } = await revokedButAccepted();
    const ops = watchKvOps(kv);

    const res = await refresh(old);

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json).toEqual({
      error: { code: "REFRESH_FAILED", message: "Token refresh failed" },
    });
    expect(ops.writeTrail()).toEqual([]);
    expect((await readAuthRecord(kv, USER_ID))?.token).toBe(next);
    expect(await kv.get(kvKeys.authToken(next))).toBe(USER_ID);
  });

  it("renews the account's current token when that token is presented", async () => {
    const { next } = await revokedButAccepted();
    const ops = watchKvOps(kv);

    const res = await refresh(next);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Json;
    expect(data).toEqual({
      token: next,
      expiresAt: PINNED_NOW + TOKEN_TTL_SECONDS * 1000,
    });
    // Positive companion of the empty trail above: a renewal does write.
    expect(ops.putKeys().sort()).toEqual(
      [kvKeys.auth(USER_ID), kvKeys.authToken(next)].sort(),
    );
    // The guard reuses the one auth-record read for the renewal.
    expect(
      ops.getKeys().filter((k) => k === kvKeys.auth(USER_ID)),
    ).toHaveLength(1);
  });

  it("still mints a token when no auth record exists (TTL gap)", async () => {
    const token = "f".repeat(64);
    await kv.put(kvKeys.authToken(token), USER_ID);
    const ops = watchKvOps(kv);

    const res = await refresh(token);

    expect(res.status).toBe(200);
    const minted = ((await res.json()) as Json).data.token as string;
    expect(minted).toMatch(HEX_64);
    expect(minted).not.toBe(token);
    // Counted before this test's own reads below.
    expect(
      ops.getKeys().filter((k) => k === kvKeys.auth(USER_ID)),
    ).toHaveLength(1);
    expect((await readAuthRecord(kv, USER_ID))?.token).toBe(minted);
    expect(await kv.get(kvKeys.authToken(minted))).toBe(USER_ID);
  });
});
