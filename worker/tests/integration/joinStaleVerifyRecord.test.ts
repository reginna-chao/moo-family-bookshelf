import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";
import { hashSecret } from "../../src/utils/crypto";
import {
  kvKeys,
  QR_TOKEN_TTL_SECONDS,
  type AuthRecord,
  type VerifyRecord,
} from "../../src/kv/schema";

/**
 * Join refuses a secret checked against a STALE verify record (#378 S3).
 *
 * A PIN / pattern save rotates the auth token and stamps the new
 * `auth:{userId}` with `secretAt` = the verify record's `secretUpdatedAt`. A
 * colo that has the new `auth:` record but still serves the previous
 * `verify:{userId}` would let the OLD secret (or no secret at all, when it has
 * no verify record yet) through the gate and then hand out the rotated token.
 * So a join that passed the gate on a verify record older than `secretAt` —
 * absent, without `secretUpdatedAt`, or with an earlier one, `method: "none"`
 * included — answers `403 VERIFICATION_REQUIRED` with ZERO writes: the check
 * runs before the reconnect's pointer heal / displayName put and before the
 * new member's family put. Equal or newer timestamps pass. An `auth:` record
 * without `secretAt` never trips the check, and a QR bypass skips it (the
 * binding already proves the token is current).
 *
 * Both join branches are covered. The new-member branch is seeded with an
 * `auth:` record directly (leave and kick delete it, so no route produces that
 * state for an unlisted user today); its capacity check (`409 FAMILY_FULL`)
 * runs BEFORE this one, which the ordering case pins.
 *
 * The same check guards the other two gate entry points. Create
 * (`POST /api/family`) answers the same 403 with zero writes — no orphan
 * pointer delete, no `member:` / `family:` put, no mint, so the account's
 * current token keeps working — and reuses that one `auth:` read for the mint.
 * Lookup (`POST /api/auth/lookup`) answers its existing "verification
 * required" probe on both disclosing branches (no secret with nothing
 * configured; a secret that passed) and reads no `member:` / `family:` key;
 * its configured-no-secret probe still reads only `verify:`.
 *
 * Every request runs with DEV_MODE (per-IP limits are not under test); `Date`
 * is pinned so the verify-record timestamps are exact.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const THIRD_ID = CHARLIE;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const OLD_PIN = "654321";
const SALT = "ab".repeat(16);
const TOKEN = "9".repeat(64);
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
const SECRET_AT = PINNED_NOW - 60_000;

async function request(
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  return app.request(
    path,
    { method, headers, body: JSON.stringify(body) },
    { KV: kv, DEV_MODE: "1" },
  );
}

function join(extra: Record<string, unknown>): Promise<Response> {
  return request("POST", `/api/family/${FAMILY_ID}/join`, {
    userId: USER_ID,
    ...extra,
  });
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

/** The join branches; `reconnect-heal` drops the pointer so the heal would run. */
const BRANCHES = [
  {
    branch: "reconnect",
    seed: async () => {
      await seedFamily([OWNER_ID, USER_ID]);
      await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
    },
  },
  {
    branch: "reconnect-heal",
    seed: () => seedFamily([OWNER_ID, USER_ID]),
  },
  { branch: "new member", seed: () => seedFamily([OWNER_ID]) },
];

function authRecord(secretAt?: number): AuthRecord {
  return {
    token: TOKEN,
    createdAt: new Date(PINNED_NOW).toISOString(),
    ...(secretAt !== undefined && { secretAt }),
  };
}

async function seedAuth(secretAt?: number): Promise<void> {
  await kv.put(kvKeys.authToken(TOKEN), USER_ID);
  await kv.put(kvKeys.auth(USER_ID), JSON.stringify(authRecord(secretAt)));
}

async function pinRecord(
  pin: string,
  secretUpdatedAt?: number,
): Promise<VerifyRecord> {
  return {
    method: "pin",
    hash: await hashSecret(SALT, pin),
    salt: SALT,
    prompted: 1,
    ...(secretUpdatedAt !== undefined && { secretUpdatedAt }),
  };
}

function noneRecord(secretUpdatedAt?: number): VerifyRecord {
  return {
    method: "none",
    hash: null,
    salt: null,
    prompted: 1,
    ...(secretUpdatedAt !== undefined && { secretUpdatedAt }),
  };
}

async function seedVerify(record: VerifyRecord | null): Promise<void> {
  if (record) await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
}

async function expectVerificationRequired(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: {
      code: "VERIFICATION_REQUIRED",
      message: "此帳號需要驗證才能登入",
    },
  });
}

/** Verify records the gate passes on, against `auth.secretAt = SECRET_AT`. */
const STALE_RECORDS = [
  {
    label: "a PIN record older than secretAt",
    record: () => pinRecord(PIN, SECRET_AT - 1),
    secret: PIN,
  },
  {
    label: "a PIN record without secretUpdatedAt",
    record: () => pinRecord(PIN),
    secret: PIN,
  },
  {
    label: "no verify record at all",
    record: async () => null,
    secret: undefined,
  },
  {
    label: "a none record older than secretAt",
    record: async () => noneRecord(SECRET_AT - 1),
    secret: undefined,
  },
  {
    label: "a none record without secretUpdatedAt",
    record: async () => noneRecord(),
    secret: undefined,
  },
];

const CURRENT_RECORDS = [
  {
    label: "a PIN record stamped exactly secretAt",
    record: () => pinRecord(PIN, SECRET_AT),
    secret: PIN,
  },
  {
    label: "a PIN record newer than secretAt",
    record: () => pinRecord(PIN, SECRET_AT + 1),
    secret: PIN,
  },
  {
    label: "a none record newer than secretAt",
    record: async () => noneRecord(SECRET_AT + 1),
    secret: undefined,
  },
];

function cross<A extends object, B extends object>(as: A[], bs: B[]) {
  return as.flatMap((a) => bs.map((b) => ({ ...a, ...b })));
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

describe("POST /api/family/:id/join — a secret checked against a stale verify record", () => {
  it.each(cross(BRANCHES, STALE_RECORDS))(
    "$branch: refuses $label with zero writes",
    async ({ seed, record, secret }) => {
      await seed();
      await seedAuth(SECRET_AT);
      await seedVerify(await record());
      const ops = watchKvOps(kv);

      const res = await join({ verifySecret: secret, displayName: "Renamed" });

      await expectVerificationRequired(res);
      expect(ops.writeTrail()).toEqual([]);
      // Positive companion: the check read the account's auth record.
      expect(ops.getKeys()).toContain(kvKeys.auth(USER_ID));
    },
  );

  it.each(cross(BRANCHES, CURRENT_RECORDS))(
    "$branch: admits $label",
    async ({ branch, seed, record, secret }) => {
      await seed();
      await seedAuth(SECRET_AT);
      await seedVerify(await record());

      const res = await join({ verifySecret: secret });

      expect(res.status).toBe(200);
      const authToken = ((await res.json()) as Json).data.authToken as string;
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(FAMILY_ID);
      const stored = await kv.get<AuthRecord>(kvKeys.auth(USER_ID), "json");
      expect(stored?.token).toBe(authToken);
      expect(stored?.secretAt).toBe(SECRET_AT);
      // A reconnect renews the live token; a new member gets a fresh one.
      if (branch === "new member") expect(authToken).not.toBe(TOKEN);
      else expect(authToken).toBe(TOKEN);
    },
  );

  it.each(cross(BRANCHES, STALE_RECORDS))(
    "$branch: never trips without secretAt on the auth record ($label)",
    async ({ seed, record, secret }) => {
      await seed();
      await seedAuth();
      await seedVerify(await record());

      const res = await join({ verifySecret: secret });

      expect(res.status).toBe(200);
    },
  );

  it.each(BRANCHES)(
    "$branch: never trips without an auth record",
    async ({ seed }) => {
      await seed();
      await seedVerify(await pinRecord(PIN));

      const res = await join({ verifySecret: PIN });

      expect(res.status).toBe(200);
    },
  );

  it("refuses the superseded PIN a stale colo still holds, and admits the current one", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
    await seedAuth(SECRET_AT);
    const stale = await pinRecord(OLD_PIN, SECRET_AT - 30_000);
    await seedVerify(stale);

    await expectVerificationRequired(await join({ verifySecret: OLD_PIN }));

    // Once the colo sees the record the rotation was written for, the new PIN works.
    await seedVerify(await pinRecord(PIN, SECRET_AT));
    const res = await join({ verifySecret: PIN });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.authToken).toBe(TOKEN);
  });

  it("answers 409 FAMILY_FULL before the stale check on the new-member branch", async () => {
    await seedFamily([OWNER_ID, THIRD_ID]);
    await seedAuth(SECRET_AT);
    await seedVerify(await pinRecord(PIN, SECRET_AT - 1));
    const ops = watchKvOps(kv);

    const res = await join({ verifySecret: PIN });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("FAMILY_FULL");
    expect(ops.writeTrail()).toEqual([]);
  });

  it("skips the check after a QR bypass bound to the live token", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
    await seedAuth(SECRET_AT);
    const qr = "e".repeat(64);
    await kv.put(
      kvKeys.qrToken(qr),
      JSON.stringify({
        userId: USER_ID,
        tokenHash: await hashSecret("qr:", TOKEN),
      }),
      { expirationTtl: QR_TOKEN_TTL_SECONDS },
    );

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.authToken).toBe(TOKEN);
  });
});

function create(verifySecret: string | undefined): Promise<Response> {
  return request("POST", "/api/family", {
    userId: USER_ID,
    displayName: "Alice",
    verifySecret,
  });
}

/** Create's membership states that reach the gate; `orphaned` points at a missing family. */
const CREATE_STATES = [
  { state: "no pointer", seed: async () => {} },
  {
    state: "orphaned pointer",
    seed: () => kv.put(kvKeys.member(USER_ID), FAMILY_ID),
  },
];

describe("POST /api/family — a secret checked against a stale verify record", () => {
  it.each(cross(CREATE_STATES, STALE_RECORDS))(
    "$state: refuses $label with zero writes and keeps the current token",
    async ({ seed, record, secret }) => {
      await seed();
      const pointerBefore = await kv.get(kvKeys.member(USER_ID));
      await seedAuth(SECRET_AT);
      await seedVerify(await record());
      const ops = watchKvOps(kv);

      await expectVerificationRequired(await create(secret));

      expect(ops.writeTrail()).toEqual([]);
      expect(ops.getKeys()).toContain(kvKeys.auth(USER_ID));
      expect(await kv.get(kvKeys.authToken(TOKEN))).toBe(USER_ID);
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(pointerBefore);
    },
  );

  it.each(CURRENT_RECORDS)(
    "admits $label, reading auth: once and carrying secretAt",
    async ({ record, secret }) => {
      await seedAuth(SECRET_AT);
      await seedVerify(await record());
      const ops = watchKvOps(kv);

      const res = await create(secret);
      // Counted before the assertions below read auth: themselves.
      const authReads = ops
        .getKeys()
        .filter((key) => key === kvKeys.auth(USER_ID));

      expect(res.status).toBe(201);
      expect(authReads).toHaveLength(1);
      const data = ((await res.json()) as Json).data;
      expect(data.authToken).not.toBe(TOKEN);
      expect(await kv.get(kvKeys.member(USER_ID))).toBe(data.familyId);
      const stored = await kv.get<AuthRecord>(kvKeys.auth(USER_ID), "json");
      expect(stored?.token).toBe(data.authToken);
      expect(stored?.secretAt).toBe(SECRET_AT);
      expect(await kv.get(kvKeys.authToken(TOKEN))).toBeNull();
    },
  );

  it.each(STALE_RECORDS)(
    "never trips without secretAt on the auth record ($label)",
    async ({ record, secret }) => {
      await seedAuth();
      await seedVerify(await record());

      const res = await create(secret);

      expect(res.status).toBe(201);
    },
  );

  it("never trips without an auth record", async () => {
    await seedVerify(await pinRecord(PIN));

    const res = await create(PIN);

    expect(res.status).toBe(201);
    const stored = await kv.get<AuthRecord>(kvKeys.auth(USER_ID), "json");
    expect(stored?.secretAt).toBeUndefined();
  });
});

function lookup(verifySecret: string | undefined): Promise<Response> {
  return request("POST", "/api/auth/lookup", { userId: USER_ID, verifySecret });
}

async function seedLiveMembership(): Promise<void> {
  await seedFamily([OWNER_ID, USER_ID]);
  await kv.put(kvKeys.member(USER_ID), FAMILY_ID);
}

async function expectProbe(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    data: { existingFamilyId: null, memberCount: 0, requiresVerification: 1 },
  });
}

describe("POST /api/auth/lookup — a secret checked against a stale verify record", () => {
  it.each(STALE_RECORDS)(
    "answers the probe for $label and reads no membership",
    async ({ record, secret }) => {
      await seedLiveMembership();
      await seedAuth(SECRET_AT);
      await seedVerify(await record());
      const ops = watchKvOps(kv);

      await expectProbe(await lookup(secret));

      expect(ops.getKeys()).toContain(kvKeys.auth(USER_ID));
      expect(ops.getKeys()).not.toContain(kvKeys.member(USER_ID));
      expect(ops.getKeys()).not.toContain(kvKeys.family(FAMILY_ID));
    },
  );

  it.each(CURRENT_RECORDS)(
    "discloses the membership for $label",
    async ({ record, secret }) => {
      await seedLiveMembership();
      await seedAuth(SECRET_AT);
      await seedVerify(await record());

      const res = await lookup(secret);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          existingFamilyId: FAMILY_ID,
          memberCount: 2,
          requiresVerification: 0,
        },
      });
    },
  );

  it.each(STALE_RECORDS)(
    "discloses without secretAt on the auth record ($label)",
    async ({ record, secret }) => {
      await seedLiveMembership();
      await seedAuth();
      await seedVerify(await record());

      const res = await lookup(secret);

      expect(((await res.json()) as Json).data.existingFamilyId).toBe(
        FAMILY_ID,
      );
    },
  );

  it("keeps the configured-no-secret probe to one verify: read", async () => {
    await seedLiveMembership();
    await seedAuth(SECRET_AT);
    await seedVerify(await pinRecord(PIN, SECRET_AT));
    const ops = watchKvOps(kv);

    await expectProbe(await lookup(undefined));

    expect(ops.getKeys()).toEqual([kvKeys.verify(USER_ID)]);
  });
});
