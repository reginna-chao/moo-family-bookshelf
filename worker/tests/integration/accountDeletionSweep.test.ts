import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB, makeUserId } from "../helpers/ids";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type AccountDeletingMark,
  type BookEntry,
  type PublicShelf,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import { mintAuthToken } from "../../src/services/authTokens";
import { MAX_SETTLE_INDEX_HASHES } from "../../src/services/accountDeletion";
import {
  MAX_SWEEP_ACCOUNTS_PER_RUN,
  SWEEP_INTERVAL_MS,
  SWEEP_RETIRE_AFTER_MS,
  sweepDeletedAccounts,
} from "../../src/services/accountDeletionSweep";
import { hashAuthToken } from "../../src/utils/crypto";
import type { Env } from "../../src/utils/env";

/**
 * The cron sweep (#468): the main guarantee that data written back after an account
 * deletion goes away, needing no writer's cooperation.
 *
 * WHAT IT MAY DECIDE. It wipes every marked account it reaches, and it retires a mark
 * only after a pass with no error once the mark is `SWEEP_RETIRE_AFTER_MS` old. It never
 * concludes "this account was re-created": a token newer than the mark can come from a
 * racing write, so the token is removed like any other. Only an admitted create / join
 * ends a deletion. A pass that left a token alive counts as an error, so no mark retires
 * while one survives; the index cap makes a many-token account take several passes.
 *
 * ROTATION. There is one list page and no stored cursor: `scheduledTime` picks the slice.
 * The 25-account cases advance `scheduledTime` by the cron interval and check that a run
 * never exceeds its cap, that every account is reached, and that all of them retire even
 * though the indexes shift as marks disappear.
 *
 * TWO ENTRY POINTS. `RUNNERS` drives every case through `sweepDeletedAccounts` and
 * through the default export's `scheduled`, the one Cloudflare actually calls. Whether
 * the cron is deployed is pinned by `tests/unit/wranglerCronTriggers.test.ts`.
 *
 * TIME. `Date` is faked (`toFake: ["Date"]`) so a mark's age is exact; retirement reads
 * `Date.now()`, rotation reads `scheduledTime`, and the two are independent.
 *
 * NOT PROVEN. The CPU time of a run (Free plan: 10 ms) and real KV's list consistency
 * cannot be observed on `createMockKV()`.
 */

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const OLD = NOW - SWEEP_RETIRE_AFTER_MS;
const YOUNG = NOW - 1000;
const SHARE_TOKEN = "a1".repeat(16);
const STANDARD_RUN = NOW;
const BOOK: BookEntry = {
  bookId: "210439468000101",
  title: "Book",
  author: "Author",
  isbn: "isbn",
  coverUrl: "https://cdn.readmoo.com/1.jpg",
  readmooUrl: "https://readmoo.com/book/210439468000101",
  category: "fiction",
  isShared: BoolFlag.TRUE,
};
const SHELF: PublicShelf = {
  shelfId: "11111111-1111-4111-8111-111111111111",
  shareToken: SHARE_TOKEN,
  title: "Shelf",
  expiresDays: null,
  createdAt: 1,
  expiresAt: null,
  selectionMode: "all-shared",
};

const RUNNERS: {
  via: string;
  run: (kv: KVNamespace, scheduledTime: number) => Promise<void>;
}[] = [
  { via: "sweepDeletedAccounts", run: sweepDeletedAccounts },
  {
    via: "the default export's scheduled",
    run: (kv, scheduledTime) =>
      app.scheduled(
        { scheduledTime, cron: "*/30 * * * *", noRetry: () => {} },
        { KV: kv } as Env,
      ),
  },
];

let kv: KVNamespace;
let consoleError: ReturnType<typeof vi.spyOn>;

async function seedMark(
  userId: string,
  startedAt: number,
  shareTokens: string[] = [SHARE_TOKEN],
): Promise<void> {
  const mark: AccountDeletingMark = { startedAt, shareTokens };
  await kv.put(kvKeys.accountDeleting(userId), JSON.stringify(mark), {
    expirationTtl: 86400,
  });
}

/** Everything a write landing after the deletion can put back. */
async function seedWrittenBack(userId: string, shareToken = SHARE_TOKEN) {
  await kv.put(kvKeys.user(userId), JSON.stringify({ userId, books: [BOOK] }));
  await kv.put(
    kvKeys.publicShelves(userId),
    JSON.stringify({ shelves: [{ ...SHELF, shareToken }] }),
  );
  await kv.put(kvKeys.publicShelf(shareToken), JSON.stringify({ userId }));
  await kv.put(kvKeys.newBookDefault(userId), '{"newBookDefaultShared":1}');
  await kv.put(kvKeys.accountSettings(userId), '{"syncArchived":1}');
  await kv.put(kvKeys.otp(userId), '{"code":"111111"}');
  await kv.put(kvKeys.member(userId), "ab12-cd34");
  await kv.put(kvKeys.verify(userId), '{"method":"none"}');
}

async function expectNoData(userId: string, shareToken = SHARE_TOKEN) {
  for (const key of [
    kvKeys.user(userId),
    kvKeys.publicShelves(userId),
    kvKeys.publicShelf(shareToken),
    kvKeys.newBookDefault(userId),
    kvKeys.accountSettings(userId),
    kvKeys.otp(userId),
    kvKeys.member(userId),
    kvKeys.verify(userId),
    kvKeys.auth(userId),
  ]) {
    expect(await kv.get(key), key).toBeNull();
  }
}

function markHas(userId: string): Promise<string | null> {
  return kv.get(kvKeys.accountDeleting(userId));
}

function marksRead(ops: ReturnType<typeof watchKvOps>): string[] {
  return ops
    .getKeys()
    .filter((key) => key.startsWith(kvKeys.accountDeleting("")));
}

async function markCount(): Promise<number> {
  const { keys } = await kv.list({ prefix: kvKeys.accountDeleting("") });
  return keys.length;
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(RUNNERS)("the sweep via $via", ({ run }) => {
  it("removes what a write put back, and leaves a young mark for the next pass", async () => {
    await seedMark(ALICE, YOUNG);
    await seedWrittenBack(ALICE);
    const token = await seedAuthToken(kv, ALICE);

    await run(kv, STANDARD_RUN);

    await expectNoData(ALICE);
    expect(await tokenOwner(kv, token)).toBeNull();
    expect(await markHas(ALICE)).not.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("removes a token newer than the mark, and does not read it as a re-creation", async () => {
    await seedMark(ALICE, YOUNG);
    await seedWrittenBack(ALICE);
    const { token } = await mintAuthToken(kv, ALICE, null);
    const stored = await tokenOwner(kv, token);
    expect(stored).toBe(ALICE);
    const hash = await hashAuthToken(token);

    await run(kv, STANDARD_RUN);

    expect(await tokenOwner(kv, token)).toBeNull();
    expect(await kv.get(kvKeys.authTokenIndex(ALICE, hash))).toBeNull();
    expect(await kv.get(kvKeys.accountDeleted(hash))).toBe(ALICE);
    await expectNoData(ALICE);
    expect(await markHas(ALICE)).not.toBeNull();
  });

  it("leaves an account with no mark alone", async () => {
    await seedMark(ALICE, YOUNG);
    await seedWrittenBack(ALICE);
    await seedWrittenBack(BOB, "b2".repeat(16));
    const bobToken = await seedAuthToken(kv, BOB);

    await run(kv, STANDARD_RUN);

    await expectNoData(ALICE);
    expect(await kv.get(kvKeys.user(BOB))).not.toBeNull();
    expect(await tokenOwner(kv, bobToken)).toBe(BOB);
  });

  it("keeps a failed account's mark, however old, and still reaches the next account", async () => {
    await seedMark(ALICE, OLD);
    await seedWrittenBack(ALICE);
    await seedMark(BOB, OLD, ["b2".repeat(16)]);
    await seedWrittenBack(BOB, "b2".repeat(16));
    failFirstWriteTo(kv, "delete", kvKeys.user(ALICE));

    await run(kv, STANDARD_RUN);

    expect(await kv.get(kvKeys.user(ALICE))).not.toBeNull();
    expect(await markHas(ALICE)).not.toBeNull();
    await expectNoData(BOB, "b2".repeat(16));
    expect(await markHas(BOB)).toBeNull();
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_SWEEP_FAILED"],
    ]);
  });

  it("finishes the failed account on the next run", async () => {
    await seedMark(ALICE, OLD);
    await seedWrittenBack(ALICE);
    failFirstWriteTo(kv, "delete", kvKeys.user(ALICE));
    await run(kv, STANDARD_RUN);
    expect(await markHas(ALICE)).not.toBeNull();

    await run(kv, STANDARD_RUN + SWEEP_INTERVAL_MS);

    await expectNoData(ALICE);
    expect(await markHas(ALICE)).toBeNull();
  });

  it.each([
    { label: "one ms short of the limit", age: -1, retired: false },
    { label: "exactly at the limit", age: 0, retired: true },
    { label: "past the limit", age: 1, retired: true },
  ])(
    "retires a mark only by its age: $label ⇒ $retired",
    async ({ age, retired }) => {
      await seedMark(ALICE, NOW - SWEEP_RETIRE_AFTER_MS - age);

      await run(kv, STANDARD_RUN);

      expect((await markHas(ALICE)) === null).toBe(retired);
    },
  );

  it("does not throw when the list fails, logging the event name only and writing nothing", async () => {
    await seedMark(ALICE, OLD);
    await seedWrittenBack(ALICE);
    vi.spyOn(kv, "list").mockRejectedValueOnce(new Error("KV down"));

    await expect(run(kv, STANDARD_RUN)).resolves.toBeUndefined();

    expect(await kv.get(kvKeys.user(ALICE))).not.toBeNull();
    expect(await markHas(ALICE)).not.toBeNull();
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_SWEEP_FAILED"],
    ]);
  });

  it("does not throw when a mark cannot be read, and goes on to the next account", async () => {
    await seedMark(ALICE, OLD);
    await seedMark(BOB, OLD);
    const aliceKey = kvKeys.accountDeleting(ALICE);
    const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
    vi.spyOn(kv, "get").mockImplementation(((...args: unknown[]) =>
      args[0] === aliceKey
        ? Promise.reject(new Error("KV down"))
        : real(...args)) as never);

    await expect(run(kv, STANDARD_RUN)).resolves.toBeUndefined();

    expect(await markHas(BOB)).toBeNull();
  });

  it("ignores a key under the prefix that is not a userId, so it cannot steer a wipe", async () => {
    await kv.put(`${kvKeys.accountDeleting("")}not-a-user-id`, "{}");
    await kv.put(kvKeys.accountDeleting(ALICE.toUpperCase()), "{}");
    await kv.put(kvKeys.user(ALICE.toUpperCase()), "{}");
    const ops = watchKvOps(kv);

    await run(kv, STANDARD_RUN);

    expect(ops.getKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.listPrefixes()).toEqual([kvKeys.accountDeleting("")]);
  });

  it("skips a mark that vanished between the list and its read", async () => {
    vi.spyOn(kv, "list").mockResolvedValueOnce({
      keys: [{ name: kvKeys.accountDeleting(ALICE) }],
      list_complete: true,
      cacheStatus: null,
    } as never);
    await kv.put(kvKeys.user(ALICE), "{}");

    await expect(run(kv, STANDARD_RUN)).resolves.toBeUndefined();

    expect(await kv.get(kvKeys.user(ALICE))).not.toBeNull();
  });

  it("reads a malformed mark's shareTokens as none and still wipes", async () => {
    await kv.put(
      kvKeys.accountDeleting(ALICE),
      JSON.stringify({ startedAt: YOUNG }),
    );
    await kv.put(kvKeys.user(ALICE), "{}");

    await run(kv, STANDARD_RUN);

    expect(await kv.get(kvKeys.user(ALICE))).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe.each(RUNNERS)("the sweep's cost via $via", ({ run }) => {
  it("lists once and does nothing else when there is no mark", async () => {
    const ops = watchKvOps(kv);

    await run(kv, STANDARD_RUN);

    expect(ops.listPrefixes()).toEqual([kvKeys.accountDeleting("")]);
    expect(ops.getKeys()).toEqual([]);
    expect(ops.writeTrail()).toEqual([`list ${kvKeys.accountDeleting("")}`]);
  });

  it("spends no delete when nothing is left, for the documented reads", async () => {
    await seedMark(ALICE, YOUNG);
    const ops = watchKvOps(kv);

    await run(kv, STANDARD_RUN);

    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.putKeys()).toEqual([]);
    expect([...ops.getKeys()].sort()).toEqual(
      [
        kvKeys.accountDeleting(ALICE),
        kvKeys.auth(ALICE),
        kvKeys.publicShelves(ALICE),
        kvKeys.user(ALICE),
        kvKeys.publicShelf(SHARE_TOKEN),
        kvKeys.newBookDefault(ALICE),
        kvKeys.accountSettings(ALICE),
        kvKeys.otp(ALICE),
        kvKeys.member(ALICE),
        kvKeys.verify(ALICE),
      ].sort(),
    );
  });

  it("spends one delete, the mark, on the pass that retires it", async () => {
    await seedMark(ALICE, OLD);
    const ops = watchKvOps(kv);

    await run(kv, STANDARD_RUN);

    expect(ops.deleteKeys()).toEqual([kvKeys.accountDeleting(ALICE)]);
  });

  it("stays under 1,000 KV operations in a worst-case run", async () => {
    const accounts = Array.from(
      { length: MAX_SWEEP_ACCOUNTS_PER_RUN + 2 },
      (_, i) => makeUserId(i + 1),
    );
    await Promise.all(
      accounts.map(async (userId, a) => {
        const shareToken = a.toString(16).padStart(32, "0");
        await seedMark(userId, OLD, [shareToken]);
        await seedWrittenBack(userId, shareToken);
        // Past the index cap, plus the most `auth:` can list outside the index.
        await Promise.all(
          Array.from({ length: 12 }, (_, i) => {
            const hash = `${a.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}`;
            return Promise.all([
              kv.put(kvKeys.authTokenIndex(userId, hash), "1"),
              kv.put(kvKeys.authToken(hash), "{}"),
            ]);
          }),
        );
        await kv.put(
          kvKeys.auth(userId),
          JSON.stringify({
            tokens: Array.from({ length: 5 }, (_, i) => ({
              hash: `f${a.toString(16).padStart(3, "0")}${i.toString(16).padStart(60, "0")}`,
              createdAt: new Date(OLD).toISOString(),
            })),
          }),
        );
      }),
    );
    const ops = watchKvOps(kv);

    await run(kv, STANDARD_RUN);

    const total =
      ops.getKeys().length +
      ops.putKeys().length +
      ops.deleteKeys().length +
      ops.listPrefixes().length;
    expect(marksRead(ops)).toHaveLength(MAX_SWEEP_ACCOUNTS_PER_RUN);
    // Positive companion: the run really did the work the number is about.
    expect(ops.deleteKeys().length).toBeGreaterThan(
      MAX_SWEEP_ACCOUNTS_PER_RUN * 20,
    );
    expect(total).toBeLessThan(1000);
  });
});

describe.each(RUNNERS)(
  "the sweep and an unfinished token pass via $via",
  ({ run }) => {
    const TOKEN_TOTAL = MAX_SETTLE_INDEX_HASHES + 2;

    /** An old mark with `count` indexed tokens, `auth:` and `verify:`. Returns the token hashes. */
    async function seedTokens(count: number): Promise<string[]> {
      const hashes = Array.from({ length: count }, (_, i) =>
        i.toString(16).padStart(64, "0"),
      );
      await seedMark(ALICE, OLD, []);
      await Promise.all(
        hashes.flatMap((hash) => [
          kv.put(kvKeys.authTokenIndex(ALICE, hash), "1"),
          kv.put(kvKeys.authToken(hash), "{}"),
        ]),
      );
      await kv.put(kvKeys.auth(ALICE), JSON.stringify({ tokens: [] }));
      await kv.put(kvKeys.verify(ALICE), '{"method":"none"}');
      return hashes;
    }

    async function liveTokens(hashes: string[]): Promise<string[]> {
      const reads = await Promise.all(
        hashes.map(async (hash) =>
          (await kv.get(kvKeys.authToken(hash))) === null ? null : hash,
        ),
      );
      return reads.filter((hash) => hash !== null);
    }

    async function expectPassUnfinished(): Promise<void> {
      expect(await markHas(ALICE)).not.toBeNull();
      expect(await kv.get(kvKeys.auth(ALICE))).not.toBeNull();
      expect(await kv.get(kvKeys.verify(ALICE))).not.toBeNull();
    }

    async function expectRetiredWithNoToken(hashes: string[]): Promise<void> {
      expect(await markHas(ALICE)).toBeNull();
      expect(await kv.get(kvKeys.auth(ALICE))).toBeNull();
      expect(await kv.get(kvKeys.verify(ALICE))).toBeNull();
      expect(await liveTokens(hashes)).toEqual([]);
    }

    it("keeps the mark, auth: and verify: past the index cap, then retires on the pass that finishes", async () => {
      const hashes = await seedTokens(TOKEN_TOTAL);

      await run(kv, STANDARD_RUN);

      await expectPassUnfinished();
      expect(await liveTokens(hashes)).toEqual(
        hashes.slice(MAX_SETTLE_INDEX_HASHES),
      );
      expect(consoleError.mock.calls).toEqual([
        ["AUTH_TOKEN_INDEX_CAPPED", { listed: MAX_SETTLE_INDEX_HASHES }],
        ["ACCOUNT_DELETION_SWEEP_FAILED"],
      ]);

      await run(kv, STANDARD_RUN + SWEEP_INTERVAL_MS);

      await expectRetiredWithNoToken(hashes);
    });

    it("takes as many passes as the index needs, retiring only after the last", async () => {
      const hashes = await seedTokens(2 * MAX_SETTLE_INDEX_HASHES + 1);

      await run(kv, STANDARD_RUN);
      await expectPassUnfinished();
      await run(kv, STANDARD_RUN + SWEEP_INTERVAL_MS);
      await expectPassUnfinished();
      expect(await liveTokens(hashes)).toHaveLength(1);

      await run(kv, STANDARD_RUN + 2 * SWEEP_INTERVAL_MS);

      await expectRetiredWithNoToken(hashes);
    });

    it("keeps the mark, auth: and verify: when a token delete fails, then retires with no token alive", async () => {
      const hashes = await seedTokens(2);
      failFirstWriteTo(kv, "delete", kvKeys.authToken(hashes[0]));

      await run(kv, STANDARD_RUN);

      await expectPassUnfinished();
      expect(await liveTokens(hashes)).toEqual([hashes[0]]);
      expect(consoleError.mock.calls).toEqual([
        ["ACCOUNT_DELETION_SWEEP_FAILED"],
      ]);

      await run(kv, STANDARD_RUN + SWEEP_INTERVAL_MS);

      await expectRetiredWithNoToken(hashes);
    });
  },
);

describe.each(RUNNERS)("the sweep's rotation via $via", ({ run }) => {
  const COUNT = 25;
  const USERS = Array.from({ length: COUNT }, (_, i) => makeUserId(i + 1));

  it.each([0, 1, 7, 12345])(
    "reaches and retires all %i-offset accounts over repeated runs, each within the cap",
    async (offset) => {
      await Promise.all(USERS.map((userId) => seedMark(userId, OLD, [])));
      const firstRun = Math.floor(NOW / SWEEP_INTERVAL_MS) + offset;

      let runs = 0;
      while ((await markCount()) > 0 && runs < 10) {
        vi.restoreAllMocks();
        const ops = watchKvOps(kv);
        const before = await markCount();
        await run(kv, (firstRun + runs) * SWEEP_INTERVAL_MS);
        expect(marksRead(ops)).toHaveLength(
          Math.min(before, MAX_SWEEP_ACCOUNTS_PER_RUN),
        );
        runs += 1;
      }

      expect(await markCount()).toBe(0);
      expect(runs).toBe(3);
    },
  );

  it("reaches every account across runs while none of the marks can retire yet", async () => {
    await Promise.all(USERS.map((userId) => seedMark(userId, YOUNG, [])));
    const firstRun = Math.floor(NOW / SWEEP_INTERVAL_MS);
    const reached = new Set<string>();

    for (let i = 0; i < 3; i += 1) {
      vi.restoreAllMocks();
      const ops = watchKvOps(kv);
      await run(kv, (firstRun + i) * SWEEP_INTERVAL_MS);
      const read = marksRead(ops);
      expect(read).toHaveLength(MAX_SWEEP_ACCOUNTS_PER_RUN);
      for (const key of read) reached.add(key);
    }

    expect(reached.size).toBe(COUNT);
    expect(await markCount()).toBe(COUNT);
  });

  it("does not skip anyone at fewer accounts than the cap", async () => {
    const few = USERS.slice(0, 3);
    await Promise.all(few.map((userId) => seedMark(userId, OLD, [])));

    await run(kv, STANDARD_RUN);

    expect(await markCount()).toBe(0);
  });
});

describe("the sweep after a real deletion", () => {
  function call(
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
    return Promise.resolve(app.request(path, init, { KV: kv, DEV_MODE: "1" }));
  }

  it("clears a write the post-write check missed, keeps the link dead throughout, and retires", async () => {
    const created = await call("POST", "/api/family", undefined, {
      userId: ALICE,
    });
    const { data } = (await created.json()) as {
      data: { authToken: string };
    };
    const token = data.authToken;
    await call("PUT", `/api/user/${ALICE}/books`, token, { books: [BOOK] });
    expect((await call("DELETE", `/api/user/${ALICE}`, token)).status).toBe(
      200,
    );

    // A write the guard never saw: it landed with no check at all.
    await kv.put(
      kvKeys.user(ALICE),
      JSON.stringify({ userId: ALICE, books: [BOOK] }),
    );
    await kv.put(
      kvKeys.publicShelves(ALICE),
      JSON.stringify({ shelves: [SHELF] }),
    );
    await writePublicSnapshot(kv, ALICE, SHELF, [BOOK]);
    expect((await call("GET", `/api/public/${SHARE_TOKEN}`)).status).toBe(404);

    await sweepDeletedAccounts(kv, STANDARD_RUN);

    await expectNoData(ALICE);
    expect(await markHas(ALICE)).not.toBeNull();
    expect((await call("GET", `/api/public/${SHARE_TOKEN}`)).status).toBe(404);

    vi.setSystemTime(NOW + SWEEP_RETIRE_AFTER_MS);
    await sweepDeletedAccounts(kv, STANDARD_RUN + SWEEP_RETIRE_AFTER_MS);

    expect(await markHas(ALICE)).toBeNull();
    const retry = await call("DELETE", `/api/user/${ALICE}`, token);
    expect(retry.status).toBe(401);
    expect(
      ((await retry.json()) as { error: { code: string } }).error.code,
    ).toBe("ACCOUNT_DELETED");
  });
});
