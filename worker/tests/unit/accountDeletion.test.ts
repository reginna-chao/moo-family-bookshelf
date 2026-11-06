import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  ACCOUNT_RECREATE_COOLDOWN_MS,
  kvKeys,
  type AccountDeletingMark,
  type AuthRecord,
  type PublicShelf,
} from "../../src/kv/schema";
import {
  deletionStartedDuring,
  isTokenAfterDeletion,
  MAX_SETTLE_INDEX_HASHES,
  settleDeletionForAdmission,
  wipeAccountData,
} from "../../src/services/accountDeletion";
import { readAuthRecord } from "../../src/services/authRecord";
import { mintAuthToken } from "../../src/services/authTokens";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * `wipeAccountData` and its two callers on the create / join path (#468).
 *
 * THE CONTRACT. A wipe runs after a handler wrote to the same keys milliseconds earlier,
 * where KV's one-write-per-second limit is likely to bite, so one key's failure must not
 * stop the others and the function throws only at the end. Three things depend on another:
 * `publicshelves:` waits for every snapshot delete, because it may be the last place
 * naming a failed token's snapshot; `verify:` waits for `auth:`, because a leftover
 * `secretAt` with no record answers every later join 403
 * (`passedAgainstStaleVerifyRecord`); and `auth:` waits for every token, because a pass
 * that left one alive (a failed delete, an index listing that failed or stopped at the
 * cap) must not report success. A failed `token:` keeps its index for the next pass.
 *
 * THE ADMISSION. `settleDeletionForAdmission` never deletes the mark: the route does, right
 * before its mint (`accountRecreateCooldown.test.ts`). A mark younger than
 * `ACCOUNT_RECREATE_COOLDOWN_MS` touches nothing at all; age equal to the cooldown is past it.
 * Past it, an `auth.secretAt` strictly newer than the mark's `startedAt` wipes nothing and answers
 * `none`, leaving the route's stale-record check to decide; that one `auth:` read feeds the wipe.
 *
 * WHAT THE ROWS CHECK. `FAILURES` names one key whose delete fails and exactly what that
 * leaves behind, compared with the whole store, so a key that was kept too eagerly or
 * dropped too early fails either way. `createMockKV()` does not model the rate limit
 * itself: a failure here is an injected rejection, which is all the function can see.
 *
 * FIXTURES. Tokens come from the real `mintAuthToken`, so `tokenidx:` and `auth:` match
 * production; a token only the index or only the list names is built by removing the
 * other half, the states a racing mint leaves.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const MARK_TOKEN = "a1".repeat(16);
const LIST_TOKEN = "b2".repeat(16);
const MARK_KEY = kvKeys.accountDeleting(USER);
const INCOMPLETE = "account wipe incomplete";

let kv: KVNamespace;
let consoleError: ReturnType<typeof vi.spyOn>;

function shelfOf(shareToken: string): PublicShelf {
  return {
    shelfId: "11111111-1111-4111-8111-111111111111",
    shareToken,
    title: "Shelf",
    expiresDays: null,
    createdAt: 1,
    expiresAt: null,
    selectionMode: "all-shared",
  };
}

const MARK: AccountDeletingMark = {
  startedAt: 1,
  shareTokens: [MARK_TOKEN],
};

interface Seeded {
  hashes: string[];
}

/** Everything a wipe can find: a snapshot only the mark names, one only the list names, two real tokens. */
async function seedAccount(): Promise<Seeded> {
  await kv.put(MARK_KEY, JSON.stringify(MARK), { expirationTtl: 86400 });
  await kv.put(kvKeys.user(USER), JSON.stringify({ userId: USER, books: [] }));
  await kv.put(kvKeys.newBookDefault(USER), '{"newBookDefaultShared":1}');
  await kv.put(kvKeys.otp(USER), '{"code":"111111"}');
  await kv.put(kvKeys.member(USER), "ab12-cd34");
  await kv.put(kvKeys.verify(USER), '{"method":"none"}');
  await kv.put(
    kvKeys.publicShelves(USER),
    JSON.stringify({ shelves: [shelfOf(LIST_TOKEN)] }),
  );
  await kv.put(kvKeys.publicShelf(MARK_TOKEN), "{}");
  await kv.put(kvKeys.publicShelf(LIST_TOKEN), "{}");
  const first = await mintAuthToken(kv, USER, null);
  const second = await mintAuthToken(kv, USER, await readAuthRecord(kv, USER));
  return {
    hashes: await Promise.all(
      [first.token, second.token].map((token) => hashAuthToken(token)),
    ),
  };
}

async function allKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((key) => key.name);
}

/** What stays after a clean wipe: the mark and one deleted mark per token. */
function cleanResult(hashes: string[]): string[] {
  return [MARK_KEY, ...hashes.map((hash) => kvKeys.accountDeleted(hash))];
}

function expectStore(actual: string[], expected: string[]): void {
  expect(actual).toEqual([...expected].sort());
}

/** Reject every `get` of `key`; the mock's other keys go straight through. */
function failReadsOf(key: string): void {
  const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
  vi.spyOn(kv, "get").mockImplementation(((...args: unknown[]) =>
    args[0] === key
      ? Promise.reject(new Error("KV down"))
      : real(...args)) as never);
}

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("wipeAccountData, nothing failing", () => {
  it("removes everything but the mark and a deleted mark per token", async () => {
    const { hashes } = await seedAccount();

    await wipeAccountData(kv, USER, MARK);

    expectStore(await allKeys(), cleanResult(hashes));
    for (const hash of hashes) {
      expect(await kv.get(kvKeys.accountDeleted(hash))).toBe(USER);
    }
  });

  it("writes a token's deleted mark before deleting it, and its index after every token", async () => {
    const { hashes } = await seedAccount();
    const ops = watchKvOps(kv);

    await wipeAccountData(kv, USER, MARK);

    const trail = ops.writeTrail();
    for (const hash of hashes) {
      const marked = trail.indexOf(`put ${kvKeys.accountDeleted(hash)}`);
      const deleted = trail.indexOf(`delete ${kvKeys.authToken(hash)}`);
      expect(marked).toBeGreaterThanOrEqual(0);
      expect(deleted).toBeGreaterThan(marked);
    }
    const lastToken = Math.max(
      ...hashes.map((h) => trail.indexOf(`delete ${kvKeys.authToken(h)}`)),
    );
    for (const hash of hashes) {
      expect(
        trail.indexOf(`delete ${kvKeys.authTokenIndex(USER, hash)}`),
      ).toBeGreaterThan(lastToken);
    }
  });

  it("deletes auth: before verify:", async () => {
    await seedAccount();
    const ops = watchKvOps(kv);

    await wipeAccountData(kv, USER, MARK);

    const trail = ops.writeTrail();
    expect(trail.indexOf(`delete ${kvKeys.auth(USER)}`)).toBeGreaterThanOrEqual(
      0,
    );
    expect(trail.indexOf(`delete ${kvKeys.verify(USER)}`)).toBeGreaterThan(
      trail.indexOf(`delete ${kvKeys.auth(USER)}`),
    );
  });

  it("spends no delete when nothing is left, and never deletes the mark", async () => {
    await kv.put(MARK_KEY, JSON.stringify(MARK));
    const ops = watchKvOps(kv);

    await wipeAccountData(kv, USER, MARK);

    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.putKeys()).toEqual([]);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });

  it.each<{ label: string; mark: Json }>([
    { label: "a shareTokens that is not an array", mark: { startedAt: 1 } },
    {
      label: "non-string entries",
      mark: { startedAt: 1, shareTokens: [1, null] },
    },
  ])("treats $label as no tokens", async ({ mark }) => {
    await kv.put(kvKeys.user(USER), "{}");

    await wipeAccountData(kv, USER, mark as AccountDeletingMark);

    expect(await kv.get(kvKeys.user(USER))).toBeNull();
  });
});

describe("wipeAccountData, one delete failing", () => {
  const FAILURES: {
    label: string;
    key: (hashes: string[]) => string;
    /** Also kept, besides the failed key, because of it. */
    alsoKept: (hashes: string[]) => string[];
  }[] = [
    {
      label: "a snapshot the mark names",
      key: () => kvKeys.publicShelf(MARK_TOKEN),
      alsoKept: () => [kvKeys.publicShelves(USER)],
    },
    {
      label: "a snapshot only the list names",
      key: () => kvKeys.publicShelf(LIST_TOKEN),
      alsoKept: () => [kvKeys.publicShelves(USER)],
    },
    {
      label: "user:",
      key: () => kvKeys.user(USER),
      alsoKept: () => [],
    },
    {
      label: "publicshelves:",
      key: () => kvKeys.publicShelves(USER),
      alsoKept: () => [],
    },
    {
      label: "newbookdefault:",
      key: () => kvKeys.newBookDefault(USER),
      alsoKept: () => [],
    },
    {
      label: "otp:",
      key: () => kvKeys.otp(USER),
      alsoKept: () => [],
    },
    {
      label: "member:",
      key: () => kvKeys.member(USER),
      alsoKept: () => [],
    },
    {
      label: "a token:",
      key: (hashes) => kvKeys.authToken(hashes[0]),
      alsoKept: (hashes) => [
        kvKeys.authTokenIndex(USER, hashes[0]),
        kvKeys.auth(USER),
        kvKeys.verify(USER),
      ],
    },
    {
      label: "auth:",
      key: () => kvKeys.auth(USER),
      alsoKept: () => [kvKeys.verify(USER)],
    },
    {
      label: "verify:",
      key: () => kvKeys.verify(USER),
      alsoKept: () => [],
    },
  ];

  it.each(FAILURES)(
    "still removes the rest when deleting $label fails, and throws with no identifier",
    async ({ key, alsoKept }) => {
      const { hashes } = await seedAccount();
      failFirstWriteTo(kv, "delete", key(hashes));

      const error: Error = await wipeAccountData(kv, USER, MARK).then(
        () => {
          throw new Error("expected the wipe to throw");
        },
        (err: Error) => err,
      );

      expect(error.message).toBe(INCOMPLETE);
      expect(error.message).not.toContain(USER);
      expectStore(await allKeys(), [
        ...cleanResult(hashes),
        key(hashes),
        ...alsoKept(hashes),
      ]);
    },
  );

  it("finishes on a second pass once the key can be deleted", async () => {
    const { hashes } = await seedAccount();
    failFirstWriteTo(kv, "delete", kvKeys.auth(USER));
    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);
    expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();

    await wipeAccountData(kv, USER, MARK);

    expectStore(await allKeys(), cleanResult(hashes));
  });

  it("finishes on a second pass once a failed token can be deleted, and auth: goes only then", async () => {
    const { hashes } = await seedAccount();
    failFirstWriteTo(kv, "delete", kvKeys.authToken(hashes[1]));
    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);
    expect(await kv.get(kvKeys.authToken(hashes[1]))).not.toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();

    await wipeAccountData(kv, USER, MARK);

    expectStore(await allKeys(), cleanResult(hashes));
  });

  it("does not count a failed index delete, the one fail-open delete, as incomplete", async () => {
    const { hashes } = await seedAccount();
    const indexKey = kvKeys.authTokenIndex(USER, hashes[0]);
    failFirstWriteTo(kv, "delete", indexKey);

    await wipeAccountData(kv, USER, MARK);

    expectStore(await allKeys(), [...cleanResult(hashes), indexKey]);
    expect(consoleError.mock.calls.map(([event]) => event)).toEqual([
      "AUTH_TOKEN_INDEX_DELETE_FAILED",
    ]);
  });

  it("still deletes a token whose deleted mark cannot be written, logging the event name only", async () => {
    const { hashes } = await seedAccount();
    failFirstWriteTo(kv, "put", kvKeys.accountDeleted(hashes[0]));

    await wipeAccountData(kv, USER, MARK);

    expect(await kv.get(kvKeys.authToken(hashes[0]))).toBeNull();
    expect(await kv.get(kvKeys.accountDeleted(hashes[0]))).toBeNull();
    expect(consoleError.mock.calls).toEqual([["ACCOUNT_DELETED_MARK_FAILED"]]);
  });
});

describe("wipeAccountData, one read failing", () => {
  it("still deletes the mark's snapshots and the rest when the list cannot be read, keeping the list", async () => {
    const { hashes } = await seedAccount();
    failReadsOf(kvKeys.publicShelves(USER));

    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    expectStore(await allKeys(), [
      ...cleanResult(hashes),
      kvKeys.publicShelves(USER),
      // The list could not be read, so nothing can name this one yet.
      kvKeys.publicShelf(LIST_TOKEN),
    ]);
  });

  it("keeps auth: and verify: when auth: cannot be read, and still removes the indexed tokens", async () => {
    const { hashes } = await seedAccount();
    failReadsOf(kvKeys.auth(USER));

    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    expectStore(await allKeys(), [
      ...cleanResult(hashes),
      kvKeys.auth(USER),
      kvKeys.verify(USER),
    ]);
  });

  it("removes the tokens auth: lists when the index cannot be listed, keeping their indexes, auth: and verify:", async () => {
    const { hashes } = await seedAccount();
    vi.spyOn(kv, "list").mockRejectedValueOnce(new Error("KV down"));

    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    expectStore(await allKeys(), [
      ...cleanResult(hashes),
      ...hashes.map((hash) => kvKeys.authTokenIndex(USER, hash)),
      kvKeys.auth(USER),
      kvKeys.verify(USER),
    ]);
  });

  it.each([
    { label: "user:", key: kvKeys.user(USER) },
    { label: "verify:", key: kvKeys.verify(USER) },
  ])("leaves $label and throws when it cannot be read", async ({ key }) => {
    const { hashes } = await seedAccount();
    failReadsOf(key);

    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    expectStore(await allKeys(), [...cleanResult(hashes), key]);
  });
});

describe("wipeAccountData, its options", () => {
  it("does not read auth: when the caller hands one in, and deletes it as told", async () => {
    await seedAccount();
    const auth = (await readAuthRecord(kv, USER)) as AuthRecord;
    const ops = watchKvOps(kv);

    await wipeAccountData(kv, USER, MARK, { auth });

    expect(ops.getKeys()).not.toContain(kvKeys.auth(USER));
    expect(ops.deleteKeys()).toContain(kvKeys.auth(USER));
  });

  it("reaches a token only extraTokenHashes names, and handles a duplicate once", async () => {
    const { hashes } = await seedAccount();
    const extra = "e".repeat(64);
    await kv.put(kvKeys.authToken(extra), '{"userId":"x"}');
    const ops = watchKvOps(kv);

    await wipeAccountData(kv, USER, MARK, {
      extraTokenHashes: [extra, hashes[0]],
    });

    expect(await kv.get(kvKeys.authToken(extra))).toBeNull();
    expect(await kv.get(kvKeys.accountDeleted(extra))).toBe(USER);
    const deletes = ops
      .deleteKeys()
      .filter((key) => key === kvKeys.authToken(hashes[0]));
    expect(deletes).toHaveLength(1);
  });

  it("reaches a token only the index names and a token only auth: lists", async () => {
    const { hashes } = await seedAccount();
    await kv.delete(kvKeys.authTokenIndex(USER, hashes[0]));
    const auth = (await readAuthRecord(kv, USER)) as AuthRecord;
    await kv.put(
      kvKeys.auth(USER),
      JSON.stringify({
        ...auth,
        tokens: auth.tokens.filter((entry) => entry.hash === hashes[0]),
      }),
    );

    await wipeAccountData(kv, USER, MARK);

    expect(await kv.get(kvKeys.authToken(hashes[0]))).toBeNull();
    expect(await kv.get(kvKeys.authToken(hashes[1]))).toBeNull();
  });

  /** `count` indexed tokens plus `auth:` and `verify:`, the state a wipe past the cap must not report as done. */
  async function seedIndexedTokens(count: number): Promise<string[]> {
    const hashes = Array.from({ length: count }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    await Promise.all(
      hashes.flatMap((hash) => [
        kv.put(kvKeys.authTokenIndex(USER, hash), "1"),
        kv.put(kvKeys.authToken(hash), '{"userId":"x"}'),
      ]),
    );
    await kv.put(kvKeys.auth(USER), JSON.stringify({ tokens: [] }));
    await kv.put(kvKeys.verify(USER), '{"method":"none"}');
    return hashes;
  }

  async function indexesLeft(): Promise<number> {
    const left = await kv.list({ prefix: kvKeys.authTokenIndex(USER, "") });
    return left.keys.length;
  }

  it("processes the cap of indexed tokens and then throws, keeping auth: and verify:, logging only the count", async () => {
    const hashes = await seedIndexedTokens(MAX_SETTLE_INDEX_HASHES + 2);

    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    expect(await indexesLeft()).toBe(2);
    for (const hash of hashes.slice(0, MAX_SETTLE_INDEX_HASHES)) {
      expect(await kv.get(kvKeys.authToken(hash))).toBeNull();
    }
    for (const hash of hashes.slice(MAX_SETTLE_INDEX_HASHES)) {
      expect(await kv.get(kvKeys.authToken(hash))).not.toBeNull();
    }
    expect(await kv.get(kvKeys.auth(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();
    expect(consoleError.mock.calls).toEqual([
      ["AUTH_TOKEN_INDEX_CAPPED", { listed: MAX_SETTLE_INDEX_HASHES }],
    ]);
  });

  it("finishes on the pass that lists the rest", async () => {
    const hashes = await seedIndexedTokens(MAX_SETTLE_INDEX_HASHES + 2);
    await expect(wipeAccountData(kv, USER, MARK)).rejects.toThrow(INCOMPLETE);

    await wipeAccountData(kv, USER, MARK);

    expect(await indexesLeft()).toBe(0);
    for (const hash of hashes) {
      expect(await kv.get(kvKeys.authToken(hash))).toBeNull();
    }
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
    expect(await kv.get(kvKeys.verify(USER))).toBeNull();
  });

  it("does not call exactly the cap incomplete", async () => {
    await seedIndexedTokens(MAX_SETTLE_INDEX_HASHES);

    await wipeAccountData(kv, USER, MARK);

    expect(await indexesLeft()).toBe(0);
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("isTokenAfterDeletion", () => {
  const AT = Date.parse("2026-05-01T00:00:00.000Z");
  const mark: AccountDeletingMark = { startedAt: AT, shareTokens: [] };

  it.each<{ label: string; createdAt: string | null; expected: boolean }>([
    { label: "null", createdAt: null, expected: false },
    { label: "unparseable", createdAt: "not a date", expected: false },
    { label: "an empty string", createdAt: "", expected: false },
    {
      label: "older than the mark",
      createdAt: new Date(AT - 1).toISOString(),
      expected: false,
    },
    {
      label: "as old as the mark",
      createdAt: new Date(AT).toISOString(),
      expected: false,
    },
    {
      label: "newer than the mark",
      createdAt: new Date(AT + 1).toISOString(),
      expected: true,
    },
  ])("answers $expected for $label", ({ createdAt, expected }) => {
    expect(isTokenAfterDeletion(createdAt, mark)).toBe(expected);
  });
});

describe("settleDeletionForAdmission", () => {
  const NOW = Date.parse("2026-05-01T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  async function seedMarkAged(ageMs: number): Promise<void> {
    await kv.put(MARK_KEY, JSON.stringify({ ...MARK, startedAt: NOW - ageMs }));
  }

  it("cools for two minutes, the number CHANGELOG.md and worker/DEPLOY.md state", () => {
    expect(ACCOUNT_RECREATE_COOLDOWN_MS).toBe(120_000);
  });

  it("answers none for one read when there is no mark", async () => {
    const ops = watchKvOps(kv);

    await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe("none");

    expect(ops.getKeys()).toEqual([MARK_KEY]);
    expect(ops.writeTrail()).toEqual([]);
  });

  it.each([
    { label: "just written", ageMs: 0 },
    { label: "a millisecond short", ageMs: ACCOUNT_RECREATE_COOLDOWN_MS - 1 },
  ])(
    "answers cooling for one read and touches nothing when the mark is $label",
    async ({ ageMs }) => {
      await seedAccount();
      await seedMarkAged(ageMs);
      const before = await allKeys();
      const ops = watchKvOps(kv);

      await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe(
        "cooling",
      );

      expect(ops.getKeys()).toEqual([MARK_KEY]);
      expect(ops.writeTrail()).toEqual([]);
      expect(await allKeys()).toEqual(before);
    },
  );

  it.each([
    { label: "exactly the cooldown old", ageMs: ACCOUNT_RECREATE_COOLDOWN_MS },
    { label: "a millisecond past it", ageMs: ACCOUNT_RECREATE_COOLDOWN_MS + 1 },
  ])(
    "wipes, keeps the mark and answers wiped when it is $label",
    async ({ ageMs }) => {
      const { hashes } = await seedAccount();
      await seedMarkAged(ageMs);

      await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe("wiped");

      expectStore(await allKeys(), cleanResult(hashes));
    },
  );

  it.each<{ label: string; mark: Json }>([
    { label: "a word", mark: { startedAt: "soon", shareTokens: [] } },
    { label: "absent", mark: { shareTokens: [] } },
    { label: "null", mark: { startedAt: null, shareTokens: [] } },
    { label: "an object", mark: { startedAt: {}, shareTokens: [] } },
  ])(
    "does not read a startedAt that is $label as cooling",
    async ({ mark }) => {
      await kv.put(kvKeys.user(USER), "{}");
      await kv.put(MARK_KEY, JSON.stringify(mark));

      await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe("wiped");

      expect(await kv.get(kvKeys.user(USER))).toBeNull();
      expect(await kv.get(MARK_KEY)).not.toBeNull();
    },
  );

  it("throws and keeps the mark when the wipe fails", async () => {
    await seedAccount();
    failFirstWriteTo(kv, "delete", kvKeys.user(USER));

    await expect(settleDeletionForAdmission(kv, USER)).rejects.toThrow(
      INCOMPLETE,
    );

    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });

  describe("past the cooldown, by auth.secretAt", () => {
    const AUTH_KEY = kvKeys.auth(USER);
    const STARTED_AT = NOW - ACCOUNT_RECREATE_COOLDOWN_MS;

    /** A whole account with its mark just past the cooldown, and `secretAt` written straight into `auth:`. */
    async function seedSecretAt(secretAt: Json): Promise<string[]> {
      const { hashes } = await seedAccount();
      await seedMarkAged(ACCOUNT_RECREATE_COOLDOWN_MS);
      const auth = (await kv.get(AUTH_KEY, "json")) as Json;
      await kv.put(AUTH_KEY, JSON.stringify({ ...auth, secretAt }));
      return hashes;
    }

    it.each([
      { label: "one millisecond newer", secretAt: STARTED_AT + 1 },
      { label: "newer than the clock", secretAt: NOW + 60_000 },
    ])(
      "answers none and touches nothing when it is $label than the mark",
      async ({ secretAt }) => {
        await seedSecretAt(secretAt);
        const before = await allKeys();
        const ops = watchKvOps(kv);

        await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe(
          "none",
        );

        expect(ops.getKeys()).toEqual([MARK_KEY, AUTH_KEY]);
        expect(ops.writeTrail()).toEqual([]);
        expect(await allKeys()).toEqual(before);
      },
    );

    const WIPED: {
      label: string;
      seed: () => Promise<string[]>;
      authDeleted: boolean;
    }[] = [
      {
        label: "equal to startedAt",
        seed: () => seedSecretAt(STARTED_AT),
        authDeleted: true,
      },
      {
        label: "one millisecond older",
        seed: () => seedSecretAt(STARTED_AT - 1),
        authDeleted: true,
      },
      {
        label: "not a number",
        seed: () => seedSecretAt(String(NOW + 60_000)),
        authDeleted: true,
      },
      {
        label: "absent",
        seed: async () => {
          const { hashes } = await seedAccount();
          await seedMarkAged(ACCOUNT_RECREATE_COOLDOWN_MS);
          return hashes;
        },
        authDeleted: true,
      },
      {
        label: "absent with no auth: record",
        seed: async () => {
          const { hashes } = await seedAccount();
          await seedMarkAged(ACCOUNT_RECREATE_COOLDOWN_MS);
          await kv.delete(AUTH_KEY);
          return hashes;
        },
        authDeleted: false,
      },
    ];

    it.each(WIPED)(
      "wipes and answers wiped when it is $label",
      async ({ seed }) => {
        const hashes = await seed();

        await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe(
          "wiped",
        );

        expectStore(await allKeys(), cleanResult(hashes));
      },
    );

    it.each(WIPED)(
      "reads auth: once on the wipe path when it is $label",
      async ({ seed, authDeleted }) => {
        await seed();
        const ops = watchKvOps(kv);

        await settleDeletionForAdmission(kv, USER);

        expect(ops.getKeys().filter((key) => key === AUTH_KEY)).toHaveLength(1);
        expect(ops.deleteKeys().includes(AUTH_KEY)).toBe(authDeleted);
      },
    );

    it.each<{ label: string; startedAt: Json }>([
      { label: "a word", startedAt: "soon" },
      { label: "absent", startedAt: undefined },
      { label: "an object", startedAt: {} },
    ])(
      "does not read a startedAt that is $label as older than it",
      async ({ startedAt }) => {
        const hashes = await seedSecretAt(NOW);
        await kv.put(MARK_KEY, JSON.stringify({ ...MARK, startedAt }));

        await expect(settleDeletionForAdmission(kv, USER)).resolves.toBe(
          "wiped",
        );

        expectStore(await allKeys(), cleanResult(hashes));
      },
    );

    it("throws and wipes nothing when auth: cannot be read", async () => {
      await seedSecretAt(STARTED_AT);
      const before = await allKeys();
      failReadsOf(AUTH_KEY);
      const ops = watchKvOps(kv);

      await expect(settleDeletionForAdmission(kv, USER)).rejects.toThrow(
        "KV down",
      );

      expect(ops.writeTrail()).toEqual([]);
      expect(await allKeys()).toEqual(before);
    });
  });

  it("throws when the mark cannot be read", async () => {
    failReadsOf(MARK_KEY);

    await expect(settleDeletionForAdmission(kv, USER)).rejects.toThrow(
      "KV down",
    );
  });
});

describe("deletionStartedDuring", () => {
  it("answers false for one read when there is no mark", async () => {
    const ops = watchKvOps(kv);

    await expect(deletionStartedDuring(kv, USER)).resolves.toBe(false);

    expect(ops.getKeys()).toEqual([MARK_KEY]);
    expect(ops.writeTrail()).toEqual([]);
  });

  it("wipes, keeps the mark and answers true", async () => {
    const { hashes } = await seedAccount();

    await expect(deletionStartedDuring(kv, USER)).resolves.toBe(true);

    expectStore(await allKeys(), cleanResult(hashes));
  });

  it("answers true and logs the event name only when the wipe fails", async () => {
    await seedAccount();
    failFirstWriteTo(kv, "delete", kvKeys.user(USER));

    await expect(deletionStartedDuring(kv, USER)).resolves.toBe(true);

    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });

  it("answers false and logs the event name only when the mark cannot be read", async () => {
    await seedAccount();
    failReadsOf(MARK_KEY);

    await expect(deletionStartedDuring(kv, USER)).resolves.toBe(false);

    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
  });
});
