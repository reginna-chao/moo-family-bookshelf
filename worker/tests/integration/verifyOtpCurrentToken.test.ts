import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { createRateLimitBindings } from "../helpers/rateLimitBindings";
import {
  authTokenKey,
  listsToken,
  seedAuthToken,
  tokenFor,
} from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import { kvKeys, type OtpRecord, type VerifyRecord } from "../../src/kv/schema";
import { readAuthRecord } from "../../src/services/authRecord";
import { mintAuthToken, type IssuedToken } from "../../src/services/authTokens";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import { VERIFY_WRITE_LIMIT } from "../../src/routes/verify";

/**
 * `POST /api/user/:id/verify/otp` mints a one-time code for a CURRENT token only (#470).
 *
 * A code trades through lookup + join for a new listed token, so a token that
 * is still alive but off `auth:{userId}`'s list must not be able to mint one.
 * The handler's order is: 401 for a foreign caller → `verify-write` charge →
 * parallel `verify:` + `auth:` reads → non-current token `401 UNAUTHORIZED` →
 * non-`code` method `400 INVALID_METHOD` → `otp:{userId}` put.
 *
 * What is pinned here:
 *
 * - Two non-current shapes are refused on a `code` account with no `otp:` key:
 *   the ORPHAN (two production mints from one `auth` read — its `token:` key is
 *   live, the second mint's `auth:` put dropped it from the list) and the token
 *   REVOKED on a lagging colo (`token:` live, the list names only another token).
 *   The orphan still gets 200 from another protected route, so the middleware
 *   accepts it and the refusal is the handler's own. The refused request spends
 *   exactly the one `verify-write` slot and writes nothing else.
 * - The positive companions: a listed token, the other token of the same orphan
 *   fixture, and the TTL gap (no `auth:` record or an empty list, where the
 *   bearer counts as current) all get a code that `otp:{userId}` holds.
 * - Currency is answered before the method: a non-current token on a `pin`
 *   account gets 401, not `400 INVALID_METHOD`, so the account's method does not
 *   reach it. A listed token on the same account does get the 400.
 *
 * Every request runs WITHOUT DEV_MODE (with the Rate Limiting binding stubs), so
 * the hourly `verify-write` KV counter is live and its `put` opens every write
 * trail; the counter key is built by the production `peekPerUserRateLimit`.
 * `Date` is pinned mid-window so the bucket cannot roll over between the request
 * and the key lookup.
 *
 * This file is the red-before / green-after check for #470: on the pre-fix
 * handler the orphan and revoked-token cases receive 200 and an `otp:` key.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER_ID = ALICE;
const OTP_KEY = kvKeys.otp(USER_ID);
const WINDOW_MS = VERIFY_WRITE_LIMIT.windowSec * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;

const CODE_RECORD: VerifyRecord = {
  method: "code",
  hash: null,
  salt: null,
  prompted: 1,
};
const PIN_RECORD: VerifyRecord = {
  method: "pin",
  hash: "a".repeat(64),
  salt: "b".repeat(32),
  prompted: 1,
};

let kv: KVNamespace;

function authedRequest(
  method: string,
  path: string,
  token: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      { method, headers: { Authorization: `Bearer ${token}` } },
      { KV: kv, ...createRateLimitBindings().bindings },
    ),
  );
}

function postOtp(token: string): Promise<Response> {
  return authedRequest("POST", `/api/user/${USER_ID}/verify/otp`, token);
}

async function seedVerify(record: VerifyRecord): Promise<void> {
  await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
}

async function writeCounter(): Promise<{ key: string; count: number }> {
  const { key, count } = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    ...VERIFY_WRITE_LIMIT,
  });
  return { key, count };
}

/** Two mints from one `auth` read: `orphan` is live but unlisted, `current` is listed. */
async function mintOrphan(): Promise<{
  orphan: IssuedToken;
  current: IssuedToken;
}> {
  const auth = await readAuthRecord(kv, USER_ID);
  const orphan = await mintAuthToken(kv, USER_ID, auth);
  const current = await mintAuthToken(kv, USER_ID, auth);

  expect(await kv.get(await authTokenKey(orphan.token))).not.toBeNull();
  expect(await listsToken(kv, USER_ID, orphan.token)).toBe(false);
  expect(await listsToken(kv, USER_ID, current.token)).toBe(true);
  return { orphan, current };
}

/** `token:{hash(revoked)}` stays live while `auth:{userId}` lists only another token. */
async function seedRevokedOnLaggingColo(): Promise<string> {
  const revoked = await seedAuthToken(kv, USER_ID);
  await seedAuthToken(kv, USER_ID, { token: tokenFor(BOB) });

  expect(await kv.get(await authTokenKey(revoked))).not.toBeNull();
  expect(await listsToken(kv, USER_ID, revoked)).toBe(false);
  expect(await listsToken(kv, USER_ID, tokenFor(BOB))).toBe(true);
  return revoked;
}

async function expectUnauthorized(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
}

/** A 200 carrying a six-digit code that `otp:{userId}` holds. */
async function expectCodeIssued(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  const { code } = ((await res.json()) as Json).data;
  expect(code).toMatch(/^\d{6}$/);
  const stored = await kv.get<OtpRecord>(OTP_KEY, "json");
  expect(stored?.code).toBe(code);
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

describe("POST /api/user/:id/verify/otp — non-current token on a code account", () => {
  it("refuses an orphan the middleware accepts, spending only one counter slot", async () => {
    await seedVerify(CODE_RECORD);
    const { orphan } = await mintOrphan();
    const ops = watchKvOps(kv);

    await expectUnauthorized(await postOtp(orphan.token));

    expect(await kv.get(OTP_KEY)).toBeNull();
    const counter = await writeCounter();
    expect(ops.writeTrail()).toEqual([`put ${counter.key}`]);
    expect(counter.count).toBe(1);

    const books = await authedRequest(
      "GET",
      `/api/user/${USER_ID}/books`,
      orphan.token,
    );
    expect(books.status).toBe(200);
  });

  it("refuses a token revoked on a lagging colo", async () => {
    await seedVerify(CODE_RECORD);
    const revoked = await seedRevokedOnLaggingColo();

    await expectUnauthorized(await postOtp(revoked));

    expect(await kv.get(OTP_KEY)).toBeNull();
  });
});

describe("POST /api/user/:id/verify/otp — current token on a code account", () => {
  it("issues a code to a listed token", async () => {
    await seedVerify(CODE_RECORD);
    const listed = await seedAuthToken(kv, USER_ID);
    const ops = watchKvOps(kv);

    await expectCodeIssued(await postOtp(listed));

    const counter = await writeCounter();
    expect(ops.writeTrail()).toEqual([`put ${counter.key}`, `put ${OTP_KEY}`]);
  });

  it("issues a code to the listed token of the orphan fixture", async () => {
    await seedVerify(CODE_RECORD);
    const { current } = await mintOrphan();

    await expectCodeIssued(await postOtp(current.token));
  });

  it.each([
    {
      label: "no auth: record",
      openGap: () => kv.delete(kvKeys.auth(USER_ID)),
    },
    {
      label: "an empty token list",
      openGap: () =>
        kv.put(kvKeys.auth(USER_ID), JSON.stringify({ tokens: [] })),
    },
  ])("issues a code in the TTL gap: $label", async ({ openGap }) => {
    await seedVerify(CODE_RECORD);
    const token = await seedAuthToken(kv, USER_ID);
    await openGap();

    await expectCodeIssued(await postOtp(token));
  });
});

describe("POST /api/user/:id/verify/otp — non-code account", () => {
  it("answers a non-current token 401, not INVALID_METHOD", async () => {
    await seedVerify(PIN_RECORD);
    const revoked = await seedRevokedOnLaggingColo();

    await expectUnauthorized(await postOtp(revoked));

    expect(await kv.get(OTP_KEY)).toBeNull();
  });

  it("answers a listed token 400 INVALID_METHOD", async () => {
    await seedVerify(PIN_RECORD);
    const listed = await seedAuthToken(kv, USER_ID);

    const res = await postOtp(listed);

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_METHOD");
    expect(await kv.get(OTP_KEY)).toBeNull();
  });
});
