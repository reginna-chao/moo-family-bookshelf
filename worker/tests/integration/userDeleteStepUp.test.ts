import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import { kvKeys } from "../../src/kv/schema";
import { VERIFY_SECRET_MAX_LENGTH } from "../../src/utils/validation";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/services/verification";

/**
 * Current-secret step-up on `DELETE /api/user/:id` (#396).
 *
 * A PIN / pattern account must send its CURRENT secret in an optional JSON
 * body `{ currentSecret }`; otherwise deleting the account and re-joining as
 * the same email would drop the PIN without ever knowing it. The body is read
 * as text: empty ⇒ no secret; unparseable ⇒ `400 INVALID_JSON`; not a plain
 * object ⇒ `400 INVALID_PAYLOAD`; a malformed `currentSecret` ⇒
 * `400 INVALID_VERIFY_SECRET`. Then the same bearer-currency rule as the verify
 * PUT (`auth:{userId}` names another token ⇒ `401 UNAUTHORIZED`; no `auth:`
 * record ⇒ proceed) and the step-up (`enforceCurrentSecret`).
 *
 * No side effects on refusal: every check runs BEFORE the first KV write, so a
 * refused DELETE leaves the family record, the pointer, the token and the
 * books untouched. Each case seeds a family (`FAMILY_SHAPES`: a non-owner in a
 * two-member family — the settle-and-put branch — and a sole owner — the
 * dissolve branch) so the write paths are reachable, and asserts an empty
 * write trail. The only writes a wrong guess may cause are the gate's own
 * guess counters, never an account write.
 *
 * Requests run without DEV_MODE (binding stubs keep the per-IP tier off KV);
 * PIN setup goes through the real verify route under DEV_MODE.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const OTHER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const WRONG_PIN = "000000";
const CALLER_IP = "203.0.113.20";

async function deleteAccount(
  token: string,
  rawBody?: string,
): Promise<Response> {
  const init: RequestInit = {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "cf-connecting-ip": CALLER_IP,
    },
  };
  if (rawBody !== undefined) init.body = rawBody;
  return app.request(`/api/user/${USER_ID}`, init, {
    KV: kv,
    ...rateLimitBindings(),
  });
}

/** Set `pin` on USER_ID through the real route (DEV_MODE); returns the rotated, current token. */
async function setPin(pin: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await app.request(
    `/api/user/${USER_ID}/verify`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${seeded}`,
      },
      body: JSON.stringify({ method: "pin", secret: pin }),
    },
    { KV: kv, DEV_MODE: "1" },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

async function seedFamily(ownerId: string, memberIds: string[]): Promise<void> {
  await Promise.all(
    memberIds.map((id) => kv.put(kvKeys.member(id), FAMILY_ID)),
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
  const books = { schemaVersion: 1, userId: USER_ID, books: [] };
  await kv.put(kvKeys.user(USER_ID), JSON.stringify(books));
}

const FAMILY_SHAPES = [
  {
    label: "a non-owner in a two-member family",
    seed: () => seedFamily(OTHER_ID, [OTHER_ID, USER_ID]),
  },
  { label: "a sole owner", seed: () => seedFamily(USER_ID, [USER_ID]) },
];

/** Every stored value the deletion would change. */
async function accountState(token: string): Promise<(string | null)[]> {
  return Promise.all(
    [
      kvKeys.family(FAMILY_ID),
      kvKeys.member(USER_ID),
      kvKeys.user(USER_ID),
      kvKeys.verify(USER_ID),
      kvKeys.auth(USER_ID),
      kvKeys.authToken(token),
    ].map((key) => kv.get(key)),
  );
}

const FAIL_KEY = kvKeys.verifyFail(USER_ID, CALLER_IP);
const OVER_LONG = "1".repeat(VERIFY_SECRET_MAX_LENGTH + 1);

function secretBody(currentSecret: unknown): string {
  return JSON.stringify({ currentSecret });
}

/** The account's `verify` guess-ceiling key, via the production builder. */
async function attemptCounterKey(): Promise<string> {
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
  // Mid-hour pin: the guess-counter key computed before a request names the bucket it charges.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(FAMILY_SHAPES)(
  "DELETE /api/user/:id on a PIN account — $label",
  ({ seed }) => {
    it.each<[string, string | undefined, number, string]>([
      ["no body", undefined, 403, "VERIFICATION_REQUIRED"],
      ["an empty object", "{}", 403, "VERIFICATION_REQUIRED"],
      ["a wrong PIN", secretBody(WRONG_PIN), 403, "VERIFICATION_FAILED"],
      ["an array body", "[]", 400, "INVALID_PAYLOAD"],
      ["a string body", '"x"', 400, "INVALID_PAYLOAD"],
      ["unparseable JSON", "{oops", 400, "INVALID_JSON"],
      ["a non-string secret", secretBody(123456), 400, "INVALID_VERIFY_SECRET"],
      [
        "a too-long secret",
        secretBody(OVER_LONG),
        400,
        "INVALID_VERIFY_SECRET",
      ],
    ])(
      "refuses %s with %i %s and touches no account key",
      async (_label, body, status, code) => {
        const token = await setPin(PIN);
        await seed();
        const guessCounters = new Set([
          `put ${await attemptCounterKey()}`,
          `put ${FAIL_KEY}`,
        ]);
        const before = await accountState(token);
        const ops = watchKvOps(kv);

        const res = await deleteAccount(token, body);

        expect(res.status).toBe(status);
        expect(await errorCode(res)).toBe(code);
        // Only the gate's guess counters may be written (wrong PIN); never an account key, never a delete.
        const accountWrites = ops
          .writeTrail()
          .filter((entry) => !guessCounters.has(entry));
        expect(accountWrites).toEqual([]);
        if (code === "VERIFICATION_FAILED") {
          expect([...ops.writeTrail()].sort()).toEqual(
            [...guessCounters].sort(),
          );
        }
        expect(await accountState(token)).toEqual(before);
      },
    );

    it("refuses a revoked bearer the middleware still accepts with 401, writing nothing", async () => {
      const token = await setPin(PIN);
      await seed();
      const old = tokenFor(USER_ID);
      await kv.put(kvKeys.authToken(old), USER_ID);
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const res = await deleteAccount(old, secretBody(PIN));

      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("UNAUTHORIZED");
      expect(ops.writeTrail()).toEqual([]);
      expect(await accountState(token)).toEqual(before);
    });

    it("deletes the account with the correct PIN", async () => {
      const token = await setPin(PIN);
      await seed();

      const res = await deleteAccount(token, secretBody(PIN));

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data.ok).toBe(true);
      for (const key of [
        kvKeys.user(USER_ID),
        kvKeys.member(USER_ID),
        kvKeys.verify(USER_ID),
        kvKeys.auth(USER_ID),
        kvKeys.authToken(token),
      ]) {
        expect(await kv.get(key)).toBeNull();
      }
    });
  },
);

describe("DELETE /api/user/:id — the rest of the step-up contract", () => {
  it("proceeds when no auth:{userId} record exists (TTL gap)", async () => {
    const token = await setPin(PIN);
    await kv.delete(kvKeys.auth(USER_ID));

    const res = await deleteAccount(token, secretBody(PIN));

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.verify(USER_ID))).toBeNull();
  });

  it("refuses the correct PIN against a stale verify record with 403 VERIFICATION_REQUIRED", async () => {
    const token = await setPin(PIN);
    const auth = (await kv.get(kvKeys.auth(USER_ID), "json")) as Json;
    await kv.put(
      kvKeys.auth(USER_ID),
      JSON.stringify({ ...auth, secretAt: auth.secretAt + 1000 }),
    );
    const ops = watchKvOps(kv);

    const res = await deleteAccount(token, secretBody(PIN));

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
    expect(ops.writeTrail()).toEqual([]);
  });

  it.each(["none", "code"])(
    "deletes a %s account, ignoring a wrong currentSecret",
    async (method) => {
      const token = await seedAuthToken(kv, USER_ID);
      await kv.put(
        kvKeys.verify(USER_ID),
        JSON.stringify({ method, hash: null, salt: null, prompted: 1 }),
      );

      const res = await deleteAccount(token, secretBody(WRONG_PIN));

      expect(res.status).toBe(200);
      expect(await kv.get(kvKeys.verifyFail(USER_ID, CALLER_IP))).toBeNull();
    },
  );

  it("deletes an account with no verify record and no body", async () => {
    const token = await seedAuthToken(kv, USER_ID);

    const res = await deleteAccount(token);

    expect(res.status).toBe(200);
  });
});
