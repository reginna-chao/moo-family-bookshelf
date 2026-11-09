import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, holdNextWrite, watchKvOps } from "../helpers/kvOps";
import { passRecreateCooldown } from "../helpers/recreateCooldown";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";
import {
  ACCOUNT_RECREATE_COOLDOWN_MS,
  BoolFlag,
  kvKeys,
  type AccountDeletingMark,
  type VerifyRecord,
} from "../../src/kv/schema";
import { sweepDeletedAccounts } from "../../src/services/accountDeletionSweep";
import { hashAuthToken, hashSecret } from "../../src/utils/crypto";

/**
 * Create and join around a pending account deletion (#468). Both are public routes, so
 * `accountDeletionGuard` does not apply and they check for themselves.
 *
 * ADMITTED: WIPE, WRITE, THEN END THE DELETION. A mark past the cooldown when a create or
 * a manual join is about to be admitted means the person came back:
 * `settleDeletionForAdmission` finishes the wipe, the route deletes the mark right before
 * its mint, and the answer is the ordinary one. Everything read before the wipe is stale,
 * so nothing is upgraded or compared against it, and a `member:` pointing at the same
 * family must be put back or the user becomes a hollow member with a valid token. `seedMark`
 * defaults to an ancient `startedAt`, so these cases sit far past the cooldown; the cooldown
 * itself and the mark's fate on a late refusal are in `accountRecreateCooldown.test.ts`.
 *
 * REFUSED: THE MARK STAYS. `recovery: 1`, kicked and `FAMILY_FULL` refusals wipe nothing,
 * since a doomed silent recovery join ending the deletion would end every later protection.
 * Each such case runs the sweep afterwards to show the deletion still finishes. A listed
 * member's `recovery: 1` with a mark is refused too: a silent rejoin is never a re-creation.
 *
 * A WIPE IS NOT RE-READ. A request that deleted the mark must not read it again after
 * minting, because KV may answer with the old value and that request would wipe the
 * account it just made. The mock is instantly consistent, so a count of reads is what
 * can be pinned, plus one case whose KV keeps answering the old mark.
 *
 * A DELETION STARTING MID-REQUEST. `holdNextWrite` parks the create or join before the
 * mint, the real `DELETE /api/user/:id` then runs with a token of the same account, and
 * the release reaches `deletionStartedDuring`: `409 ACCOUNT_DELETION_IN_PROGRESS`, or
 * `409 RECOVERY_NOT_MEMBER` for `recovery: 1`. A create also dissolves its new family.
 *
 * A PIN NEWER THAN THE MARK IS NOT A LEFTOVER. A colo can hold a stale mark past its cooldown
 * and a stale `verify:` miss for an account re-created since, whose PIN the gate then cannot
 * see. `auth.secretAt` newer than the mark's `startedAt` means nothing is wiped and the
 * stale-record rule answers 403. The mock has no colos, so the case hides that one read.
 *
 * `DEV_MODE` is on: rate limits are not under test, and nothing here depends on them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const OWNER = BOB;
const THIRD = CHARLIE;
const MARK_KEY = kvKeys.accountDeleting(USER);
const SHARE_TOKEN = "a1".repeat(16);
const PIN = "123456";
const SALT = "ab".repeat(16);
const PEPPER = "server-pepper-0123456789abcdef";
const OLD_DEVICE_TOKEN = "d".repeat(64);
const IN_PROGRESS_BODY = {
  error: {
    code: "ACCOUNT_DELETION_IN_PROGRESS",
    message: "這個帳戶正在移除，請稍後再試一次",
  },
};
const RECOVERY_REFUSED_BODY = {
  error: { code: "RECOVERY_NOT_MEMBER", message: "你已經不是這個家庭的成員" },
};

let kv: KVNamespace;
let consoleError: ReturnType<typeof vi.spyOn>;

function send(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return Promise.resolve(
    app.request(path, init, {
      KV: kv,
      DEV_MODE: "1",
      VERIFY_PEPPER: PEPPER,
    }),
  );
}

function createFamily(userId = USER, extra: object = {}): Promise<Response> {
  return send("POST", "/api/family", { userId, ...extra });
}

function joinFamily(
  familyId: string,
  extra: object = {},
  userId = USER,
): Promise<Response> {
  return send("POST", `/api/family/${familyId}/join`, { userId, ...extra });
}

async function dataOf(res: Response, status: number): Promise<Json> {
  expect(res.status).toBe(status);
  return ((await res.json()) as Json).data;
}

async function ownerFamily(): Promise<string> {
  const data = await dataOf(await createFamily(OWNER), 201);
  return data.familyId as string;
}

async function seedMark(startedAt = 1): Promise<void> {
  const mark: AccountDeletingMark = {
    startedAt,
    shareTokens: [SHARE_TOKEN],
  };
  await kv.put(MARK_KEY, JSON.stringify(mark), { expirationTtl: 86400 });
}

/** What a write landing after the deletion left behind, with a device token still alive. */
async function seedLeftovers(): Promise<void> {
  await kv.put(kvKeys.user(USER), JSON.stringify({ userId: USER, books: [] }));
  await kv.put(
    kvKeys.publicShelf(SHARE_TOKEN),
    JSON.stringify({ userId: USER }),
  );
  await kv.put(kvKeys.newBookDefault(USER), '{"newBookDefaultShared":1}');
  await seedAuthToken(kv, USER, {
    token: OLD_DEVICE_TOKEN,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

async function expectLeftoversGone(): Promise<void> {
  expect(await kv.get(kvKeys.user(USER))).toBeNull();
  expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).toBeNull();
  expect(await kv.get(kvKeys.newBookDefault(USER))).toBeNull();
  expect(await tokenOwner(kv, OLD_DEVICE_TOKEN)).toBeNull();
}

async function expectMarkKeptThenSwept(): Promise<void> {
  expect(await kv.get(MARK_KEY)).not.toBeNull();
  expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
  await sweepDeletedAccounts(kv, Date.now());
  await expectLeftoversGone();
}

function marksRead(ops: ReturnType<typeof watchKvOps>): string[] {
  return ops.getKeys().filter((key) => key === MARK_KEY);
}

async function v1PinRecord(): Promise<VerifyRecord> {
  return {
    method: "pin",
    hash: await hashSecret(SALT, PIN),
    salt: SALT,
    prompted: 1,
    secretUpdatedAt: 1,
  };
}

/** `secretAt` is newer than the PIN record the gate compares, so that record is stale, and older than the mark. */
async function seedStaleRecordOlderThanMark(): Promise<void> {
  await kv.put(kvKeys.verify(USER), JSON.stringify(await v1PinRecord()));
  await seedAuthToken(kv, USER, { token: OLD_DEVICE_TOKEN, secretAt: 2 });
  await seedMark(3);
}

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ADMISSIONS: {
  label: string;
  status: number;
  seed: () => Promise<string | null>;
  send: (familyId: string | null, extra?: object) => Promise<Response>;
}[] = [
  {
    label: "POST /api/family",
    status: 201,
    seed: async () => null,
    send: (_, extra) => createFamily(USER, extra),
  },
  {
    label: "a manual join",
    status: 200,
    seed: ownerFamily,
    send: (familyId, extra) => joinFamily(familyId as string, extra),
  },
];

describe.each(ADMISSIONS)(
  "$label with a mark present",
  ({ status, seed, send: admit }) => {
    it("wipes the leftovers, ends the deletion and admits with the ordinary answer", async () => {
      const familyId = await seed();
      const control = await dataOf(await createFamily(THIRD), 201);
      await seedLeftovers();
      await seedMark();

      const data = await dataOf(await admit(familyId), status);

      const expectedKeys = Object.keys(control).sort();
      expect(Object.keys(data).sort()).toEqual(expectedKeys);
      expect(await kv.get(MARK_KEY)).toBeNull();
      await expectLeftoversGone();
      expect(await kv.get(kvKeys.member(USER))).toBe(data.familyId);
      expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    });

    it("does not read the mark again after minting", async () => {
      const familyId = await seed();
      await seedMark();
      const ops = watchKvOps(kv);

      const res = await admit(familyId);

      expect(res.status).toBe(status);
      expect(marksRead(ops)).toHaveLength(1);
    });

    it("reads it twice when there was none: once to settle, once after the mint", async () => {
      const familyId = await seed();
      const ops = watchKvOps(kv);

      const res = await admit(familyId);

      expect(res.status).toBe(status);
      expect(marksRead(ops)).toHaveLength(2);
    });

    it("keeps the new account when KV goes on answering the mark it just deleted", async () => {
      const familyId = await seed();
      await seedMark();
      const stale = await kv.get(MARK_KEY, "json");
      const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
      vi.spyOn(kv, "get").mockImplementation(((...args: unknown[]) =>
        args[0] === MARK_KEY
          ? Promise.resolve(stale)
          : real(...args)) as never);

      const data = await dataOf(await admit(familyId), status);

      expect(await tokenOwner(kv, data.authToken)).toBe(USER);
      expect(await kv.get(kvKeys.member(USER))).toBe(data.familyId);
    });

    it("does not write the old PIN back through the hash upgrade", async () => {
      const familyId = await seed();
      await kv.put(kvKeys.verify(USER), JSON.stringify(await v1PinRecord()));
      await seedMark();
      const ops = watchKvOps(kv);

      const res = await admit(familyId, { verifySecret: PIN });

      expect(res.status).toBe(status);
      expect(ops.putKeys()).not.toContain(kvKeys.verify(USER));
      expect(await kv.get(kvKeys.verify(USER))).toBeNull();
    });

    it("is not refused by the stale-record rule, whose auth: it just deleted", async () => {
      const familyId = await seed();
      await seedStaleRecordOlderThanMark();

      const data = await dataOf(
        await admit(familyId, { verifySecret: PIN }),
        status,
      );

      expect(await tokenOwner(kv, data.authToken)).toBe(USER);
      const auth = (await kv.get(kvKeys.auth(USER), "json")) as Json;
      expect(auth.secretAt).toBeUndefined();
    });

    it("is refused by that rule when there is no mark, so the case above has something to escape", async () => {
      const familyId = await seed();
      await seedStaleRecordOlderThanMark();
      await kv.delete(MARK_KEY);

      const res = await admit(familyId, { verifySecret: PIN });

      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe(
        "VERIFICATION_REQUIRED",
      );
    });

    it("wipes nothing when the verification gate refuses", async () => {
      const familyId = await seed();
      await kv.put(kvKeys.verify(USER), JSON.stringify(await v1PinRecord()));
      await seedLeftovers();
      await seedMark();

      const res = await admit(familyId, { verifySecret: "654321" });

      expect(res.status).toBe(403);
      expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();
      await expectMarkKeptThenSwept();
    });

    it("answers 500 and writes nothing when the wipe fails, and the retry admits", async () => {
      const familyId = await seed();
      await seedLeftovers();
      await seedMark();
      failFirstWriteTo(kv, "delete", kvKeys.user(USER));

      const first = await admit(familyId);

      expect(first.status).toBe(500);
      expect(await kv.get(MARK_KEY)).not.toBeNull();
      expect(await kv.get(kvKeys.member(USER))).toBeNull();

      const data = await dataOf(await admit(familyId), status);
      expect(await kv.get(MARK_KEY)).toBeNull();
      expect(await kv.get(kvKeys.user(USER))).toBeNull();
      expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    });
  },
);

describe("POST /api/family with a pointer left behind", () => {
  it("overwrites a stale member: naming a family that is gone", async () => {
    await kv.put(kvKeys.member(USER), "dead-0000");
    await seedMark();

    const data = await dataOf(await createFamily(), 201);

    expect(await kv.get(kvKeys.member(USER))).toBe(data.familyId);
    expect(await kv.get(MARK_KEY)).toBeNull();
  });

  it("answers ALREADY_IN_FAMILY without touching the mark when the membership is live", async () => {
    const familyId = await ownerFamily();
    await dataOf(await joinFamily(familyId), 200);
    await seedMark();

    const res = await createFamily();

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("ALREADY_IN_FAMILY");
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });
});

describe("a manual join by a user still listed, with a mark present", () => {
  /** Listed in the family with a `member:` naming it: what a write back of the list leaves. */
  async function seedListedMember(): Promise<string> {
    const familyId = await ownerFamily();
    await dataOf(await joinFamily(familyId), 200);
    await seedLeftovers();
    await seedMark();
    return familyId;
  }

  it("heals the pointer the wipe removed, so no hollow member results", async () => {
    const familyId = await seedListedMember();
    const ops = watchKvOps(kv);

    const data = await dataOf(await joinFamily(familyId), 200);

    expect(ops.deleteKeys()).toContain(kvKeys.member(USER));
    expect(await kv.get(kvKeys.member(USER))).toBe(familyId);
    expect(await kv.get(MARK_KEY)).toBeNull();
    await expectLeftoversGone();
    const members = await send(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      data.authToken,
    );
    expect(members.status).toBe(200);
  });

  it("does not read the mark again after minting", async () => {
    const familyId = await seedListedMember();
    const ops = watchKvOps(kv);

    expect((await joinFamily(familyId)).status).toBe(200);

    expect(marksRead(ops)).toHaveLength(1);
  });
});

describe("a refused join with a mark present keeps it, and the sweep still wipes", () => {
  it("recovery: 1 from an unlisted user", async () => {
    const familyId = await ownerFamily();
    await seedLeftovers();
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId, { recovery: BoolFlag.TRUE });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(RECOVERY_REFUSED_BODY);
    expect(ops.writeTrail()).toEqual([]);
    expect(marksRead(ops)).toEqual([]);
    await expectMarkKeptThenSwept();
  });

  it("a kicked user", async () => {
    const familyId = await ownerFamily();
    await kv.put(
      kvKeys.kicked(familyId, USER),
      JSON.stringify({ removedAt: 1, removedBy: OWNER }),
    );
    await seedLeftovers();
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId);

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("MEMBER_REMOVED");
    expect(ops.writeTrail()).toEqual([]);
    await expectMarkKeptThenSwept();
  });

  it("a full family", async () => {
    const familyId = await ownerFamily();
    await dataOf(await joinFamily(familyId, {}, THIRD), 200);
    await seedLeftovers();
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("FAMILY_FULL");
    expect(ops.writeTrail()).toEqual([]);
    expect(marksRead(ops)).toEqual([]);
    await expectMarkKeptThenSwept();
  });

  it("a listed member's recovery: 1, which is never a re-creation", async () => {
    const familyId = await ownerFamily();
    await dataOf(await joinFamily(familyId), 200);
    await seedLeftovers();
    await seedMark();
    const pointerBefore = await kv.get(kvKeys.member(USER));
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId, { recovery: BoolFlag.TRUE });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(RECOVERY_REFUSED_BODY);
    expect(ops.writeTrail()).toEqual([]);
    expect(marksRead(ops)).toHaveLength(1);
    expect(await kv.get(kvKeys.member(USER))).toBe(pointerBefore);
    await expectMarkKeptThenSwept();
    expect(await kv.get(kvKeys.member(USER))).toBeNull();
  });

  it("a listed member's recovery: 1 with no mark reconnects for two extra reads", async () => {
    const familyId = await ownerFamily();
    await dataOf(await joinFamily(familyId), 200);
    const ops = watchKvOps(kv);

    const data = await dataOf(
      await joinFamily(familyId, { recovery: BoolFlag.TRUE }),
      200,
    );

    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    expect(marksRead(ops)).toHaveLength(2);
  });
});

describe("a QR-bypass join with a mark present", () => {
  async function seedQrBound(token: string): Promise<string> {
    const qrToken = "c".repeat(64);
    await kv.put(
      kvKeys.qrToken(qrToken),
      JSON.stringify({ userId: USER, tokenHash: await hashAuthToken(token) }),
    );
    return qrToken;
  }

  it("does not end the deletion, and is refused once the mint re-check sees the mark", async () => {
    const familyId = await ownerFamily();
    const token = await seedAuthToken(kv, USER);
    const qrToken = await seedQrBound(token);
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId, { qrToken });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_PROGRESS_BODY);
    expect(marksRead(ops)).toHaveLength(1);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
  });

  it("answers VERIFICATION_REQUIRED without reading the mark when the bound token was wiped", async () => {
    const familyId = await ownerFamily();
    const token = await seedAuthToken(kv, USER);
    const qrToken = await seedQrBound(token);
    await kv.delete(kvKeys.authToken(await hashAuthToken(token)));
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await joinFamily(familyId, { qrToken });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
    expect(marksRead(ops)).toEqual([]);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });
});

describe("a deletion that starts during the request", () => {
  /** Run the real deletion while `request` is parked on `key`, then `between`, then let it finish. */
  async function deleteDuring(
    key: string | ((name: string) => boolean),
    token: string,
    request: () => Promise<Response>,
    between: () => Promise<void> = async () => {},
  ): Promise<Response> {
    const hold = holdNextWrite(kv, "put", key);
    const inFlight = request();
    await Promise.race([
      hold.reached,
      inFlight.then((res) => {
        throw new Error(`answered ${res.status} before the hold`);
      }),
    ]);
    const deletion = await send(
      "DELETE",
      `/api/user/${USER}`,
      undefined,
      token,
    );
    expect(await dataOf(deletion, 200)).toEqual({ ok: true });
    await between();
    hold.release();
    const res = await inFlight;
    expect(hold.landed()).toBe(true);
    return res;
  }

  async function familyKeys(): Promise<string[]> {
    const { keys } = await kv.list({ prefix: kvKeys.family("") });
    return keys.map((key) => key.name);
  }

  async function expectNoSession(): Promise<void> {
    expect(await kv.get(kvKeys.member(USER))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
    const { keys } = await kv.list({ prefix: kvKeys.authTokenIndex(USER, "") });
    expect(keys).toEqual([]);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  }

  it("create answers 409 IN_PROGRESS and dissolves its family; a retry is refused until the cooldown passes", async () => {
    const token = await seedAuthToken(kv, USER);

    const res = await deleteDuring(kvKeys.member(USER), token, () =>
      createFamily(),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_PROGRESS_BODY);
    expect(await familyKeys()).toEqual([]);
    await expectNoSession();

    const tooSoon = await createFamily();
    expect(tooSoon.status).toBe(409);
    expect(await tooSoon.json()).toEqual(IN_PROGRESS_BODY);
    expect(await kv.get(MARK_KEY)).not.toBeNull();

    passRecreateCooldown();
    const data = await dataOf(await createFamily(), 201);
    expect(await kv.get(MARK_KEY)).toBeNull();
    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
  });

  it("create still refuses when the wipe fails, logging the event name only", async () => {
    const token = await seedAuthToken(kv, USER);
    const hold = holdNextWrite(kv, "put", kvKeys.member(USER));
    const inFlight = createFamily();
    await hold.reached;
    expect(
      (await send("DELETE", `/api/user/${USER}`, undefined, token)).status,
    ).toBe(200);
    failFirstWriteTo(kv, "delete", kvKeys.member(USER));
    hold.release();

    const res = await inFlight;

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_PROGRESS_BODY);
    expect(await familyKeys()).toEqual([]);
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
  });

  it("create is admitted when the re-check cannot read the mark, and the sweep is left to clean", async () => {
    const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
    let reads = 0;
    vi.spyOn(kv, "get").mockImplementation(((...args: unknown[]) => {
      if (args[0] === MARK_KEY) {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error("KV down"));
      }
      return real(...args);
    }) as never);

    const data = await dataOf(await createFamily(), 201);

    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    expect(reads).toBe(2);
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
  });

  function familyRecord(familyId: string): Promise<Json> {
    return kv.get(kvKeys.family(familyId), "json");
  }

  function memberIds(record: Json): string[] {
    return (record.members as Json[]).map((m) => m.userId as string);
  }

  /** The writes from this call on, read once the request has finished. */
  function writesFromNow(): () => string[] {
    const ops = watchKvOps(kv);
    const seen = ops.writeTrail().length;
    return () => ops.writeTrail().slice(seen);
  }

  it("a new member's join answers 409 IN_PROGRESS, leaves no session and takes the joiner off the list", async () => {
    const familyId = await ownerFamily();
    const before = await familyRecord(familyId);
    const token = await seedAuthToken(kv, USER);

    const res = await deleteDuring(kvKeys.family(familyId), token, () =>
      joinFamily(familyId),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_PROGRESS_BODY);
    await expectNoSession();
    const after = await familyRecord(familyId);
    expect(memberIds(after)).toEqual([OWNER]);
    expect(after).toEqual(before);
    expect(await kv.get(kvKeys.member(OWNER))).toBe(familyId);
  });

  describe("taking the joiner back off the list", () => {
    /** The join parked on its pointer put, after its `family:` put has landed. */
    function raceNewMemberJoin(
      familyId: string,
      token: string,
      between: () => Promise<void>,
    ): Promise<Response> {
      return deleteDuring(
        kvKeys.member(USER),
        token,
        () => joinFamily(familyId),
        between,
      );
    }

    it("re-reads the record, so a write landing after the join's own put survives", async () => {
      const owner = await dataOf(await createFamily(OWNER), 201);
      const familyId = owner.familyId as string;
      const token = await seedAuthToken(kv, USER);
      let writes: () => string[] = () => [];

      const res = await raceNewMemberJoin(familyId, token, async () => {
        const renamed = await send(
          "PUT",
          `/api/family/${familyId}/member/${OWNER}/displayName`,
          { displayName: "新名字" },
          owner.authToken,
        );
        expect(renamed.status).toBe(200);
        writes = writesFromNow();
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(IN_PROGRESS_BODY);
      await expectNoSession();
      expect(writes()).toContain(`put ${kvKeys.family(familyId)}`);
      const after = await familyRecord(familyId);
      expect(memberIds(after)).toEqual([OWNER]);
      expect(after.members[0].displayName).toBe("新名字");
      expect(after.ownerId).toBe(OWNER);
    });

    it("writes nothing to the family when the joiner is already gone from the list", async () => {
      const familyId = await ownerFamily();
      const ownerOnly = await familyRecord(familyId);
      const token = await seedAuthToken(kv, USER);
      let writes: () => string[] = () => [];

      const res = await raceNewMemberJoin(familyId, token, async () => {
        await kv.put(kvKeys.family(familyId), JSON.stringify(ownerOnly));
        writes = writesFromNow();
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(IN_PROGRESS_BODY);
      expect(
        writes().filter((w) => w.endsWith(kvKeys.family(familyId))),
      ).toEqual([]);
      expect(await familyRecord(familyId)).toEqual(ownerOnly);
    });

    it("never writes an empty member list: a record listing only the joiner is left as it is", async () => {
      const familyId = await ownerFamily();
      const token = await seedAuthToken(kv, USER);
      let joinerOnly: Json = null;
      let writes: () => string[] = () => [];

      const res = await raceNewMemberJoin(familyId, token, async () => {
        const listed = await familyRecord(familyId);
        expect(memberIds(listed)).toEqual([OWNER, USER]);
        joinerOnly = {
          ...listed,
          members: listed.members.filter((m: Json) => m.userId === USER),
        };
        await kv.put(kvKeys.family(familyId), JSON.stringify(joinerOnly));
        writes = writesFromNow();
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(IN_PROGRESS_BODY);
      expect(
        writes().filter((w) => w.endsWith(kvKeys.family(familyId))),
      ).toEqual([]);
      expect(await familyRecord(familyId)).toEqual(joinerOnly);
      expect(memberIds(joinerOnly)).toEqual([USER]);
    });

    it.each(["get", "put"] as const)(
      "still answers 409 IN_PROGRESS when the family %s throws, logging the event name only",
      async (op) => {
        const familyId = await ownerFamily();
        const token = await seedAuthToken(kv, USER);
        const real = (kv[op] as (...args: unknown[]) => unknown).bind(kv);

        const res = await raceNewMemberJoin(familyId, token, async () => {
          vi.spyOn(kv, op).mockImplementation(((...args: unknown[]) =>
            args[0] === kvKeys.family(familyId)
              ? Promise.reject(new Error("KV down"))
              : real(...args)) as never);
        });

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual(IN_PROGRESS_BODY);
        await expectNoSession();
        expect(consoleError.mock.calls).toEqual([
          ["JOIN_RACE_MEMBER_CLEANUP_FAILED"],
        ]);
      },
    );
  });

  it.each([
    { label: "a manual reconnect", extra: {}, body: IN_PROGRESS_BODY },
    {
      label: "a silent recovery reconnect",
      extra: { recovery: BoolFlag.TRUE },
      body: RECOVERY_REFUSED_BODY,
    },
  ])(
    "$label answers its own 409, leaves no session and leaves the list as the deletion left it",
    async ({ extra, body }) => {
      const familyId = await ownerFamily();
      const joined = await dataOf(await joinFamily(familyId), 200);
      let writes: () => string[] = () => [];
      let leftByDeletion: Json = null;

      const res = await deleteDuring(
        (name) => name.startsWith(kvKeys.authTokenIndex(USER, "")),
        joined.authToken,
        () => joinFamily(familyId, extra),
        async () => {
          leftByDeletion = await familyRecord(familyId);
          writes = writesFromNow();
        },
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(body);
      await expectNoSession();
      expect(memberIds(leftByDeletion)).toEqual([OWNER]);
      expect(
        writes().filter((w) => w.endsWith(kvKeys.family(familyId))),
      ).toEqual([]);
      expect(await familyRecord(familyId)).toEqual(leftByDeletion);
    },
  );
});

describe("a stale mark and a stale verify: miss, with a PIN newer than the mark", () => {
  /** The account as it stands now: PIN set after the mark, a live token, books. No `member:`, or create stops at 409. */
  async function seedAccountWithNewerPin(): Promise<void> {
    const secretAt = Date.now();
    await seedMark(secretAt - ACCOUNT_RECREATE_COOLDOWN_MS - 1);
    await kv.put(
      kvKeys.verify(USER),
      JSON.stringify({ ...(await v1PinRecord()), secretUpdatedAt: secretAt }),
    );
    await kv.put(
      kvKeys.user(USER),
      JSON.stringify({ userId: USER, books: [] }),
    );
    await seedAuthToken(kv, USER, { token: OLD_DEVICE_TOKEN, secretAt });
  }

  function hideReadsOf(key: string) {
    const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
    return vi
      .spyOn(kv, "get")
      .mockImplementation(((...args: unknown[]) =>
        args[0] === key ? Promise.resolve(null) : real(...args)) as never);
  }

  it.each(ADMISSIONS)(
    "$label answers VERIFICATION_REQUIRED, mints and wipes nothing, and the owner's token still works",
    async ({ seed, send: admit }) => {
      const familyId = await seed();
      await seedAccountWithNewerPin();
      const staleColo = hideReadsOf(kvKeys.verify(USER));
      const ops = watchKvOps(kv);

      const res = await admit(familyId);

      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe(
        "VERIFICATION_REQUIRED",
      );
      expect(ops.getKeys()).toContain(kvKeys.verify(USER));
      expect(ops.writeTrail()).toEqual([]);
      staleColo.mockRestore();

      expect(await kv.get(MARK_KEY)).not.toBeNull();
      expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();
      expect(await kv.get(kvKeys.auth(USER))).not.toBeNull();
      expect(await kv.get(kvKeys.member(USER))).toBeNull();
      const books = await send(
        "GET",
        `/api/user/${USER}/books`,
        undefined,
        OLD_DEVICE_TOKEN,
      );
      expect(await dataOf(books, 200)).not.toBeNull();
      const saved = await send(
        "PUT",
        `/api/user/${USER}/new-book-default`,
        { newBookDefaultShared: BoolFlag.TRUE },
        OLD_DEVICE_TOKEN,
      );
      expect(saved.status).toBe(200);
      expect(await tokenOwner(kv, OLD_DEVICE_TOKEN)).toBe(USER);
    },
  );
});

describe("a re-created account after a real deletion", () => {
  it("starts clean, keeps the mark gone and survives its first write", async () => {
    const created = await dataOf(await createFamily(), 201);
    await kv.put(
      kvKeys.user(USER),
      JSON.stringify({ userId: USER, books: [] }),
    );
    expect(
      (await send("DELETE", `/api/user/${USER}`, undefined, created.authToken))
        .status,
    ).toBe(200);
    expect(await kv.get(MARK_KEY)).not.toBeNull();

    expect((await createFamily()).status).toBe(409);
    expect(await kv.get(MARK_KEY)).not.toBeNull();

    passRecreateCooldown();
    const fresh = await dataOf(await createFamily(), 201);
    expect(await kv.get(MARK_KEY)).toBeNull();

    const saved = await send(
      "PUT",
      `/api/user/${USER}/new-book-default`,
      { newBookDefaultShared: BoolFlag.TRUE },
      fresh.authToken,
    );

    expect(saved.status).toBe(200);
    expect(await tokenOwner(kv, fresh.authToken)).toBe(USER);
    expect(await kv.get(kvKeys.newBookDefault(USER))).not.toBeNull();
  });
});
