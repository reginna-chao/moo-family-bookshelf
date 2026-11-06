import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { failFirstWriteTo, holdNextWrite, watchKvOps } from "../helpers/kvOps";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { ALICE, BOB } from "../helpers/ids";
import {
  ACCOUNT_DELETING_MARK_TTL_SECONDS,
  BoolFlag,
  kvKeys,
  VERIFY_HASH_VERSION_PEPPER,
  type AccountDeletingMark,
  type BookEntry,
  type PublicShelf,
  type VerifyRecord,
} from "../../src/kv/schema";
import { sweepDeletedAccounts } from "../../src/services/accountDeletionSweep";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import { hashAuthToken, hashSecret } from "../../src/utils/crypto";

/**
 * Once written, the deleting mark stays and the deletion finishes (#468): whoever saw a
 * 500 and changes their mind still loses the account, by their own retry or by the sweep.
 *
 * THE MARK'S PLACE. `deleteAccountKeys` writes it first, which is AFTER the route's family
 * steps: `OWNER_CANNOT_DELETE` is decided in those steps and must leave no mark, or the
 * sweep would wipe an account whose deletion was refused. A failed mark put therefore
 * leaves the family changed but the account's own keys untouched, which a retry converges.
 *
 * A RETRY KEEPS THE TOKENS. A retry after stage 3 reads an empty `publicshelves:`, so its
 * `publicTokens` is empty; the mark takes the union with the previous mark's tokens. If it
 * did not, a late `PUT /books` writing back `public:{old}` would leave a snapshot with no
 * TTL and nothing naming it. Both the guard and the sweep are shown catching it.
 *
 * THE HASH UPGRADE. `upgradeVerifyRecordHash` runs on lookup with no token, so no guard
 * covers it: it re-reads the mark after its put and deletes what it wrote. The read is
 * paid only by a request that really upgraded.
 *
 * The matrix of which keys each injected failure leaves is in
 * `userDeletePartialFailure.test.ts`; this file is about the mark across a failure.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const MARK_KEY = kvKeys.accountDeleting(USER);
const PIN = "123456";
const SALT = "ab".repeat(16);
const PEPPER = "server-pepper-0123456789abcdef";
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

let kv: KVNamespace;
let consoleError: ReturnType<typeof vi.spyOn>;

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

async function dataOf(res: Response, status: number): Promise<Json> {
  expect(res.status).toBe(status);
  return ((await res.json()) as Json).data;
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as Json).error.code as string;
}

function deleteAccount(token: string, secret?: string): Promise<Response> {
  const body = secret === undefined ? undefined : { currentSecret: secret };
  return call("DELETE", `/api/user/${USER}`, token, body);
}

function readMark(): Promise<AccountDeletingMark | null> {
  return kv.get<AccountDeletingMark>(MARK_KEY, "json");
}

interface Account {
  token: string;
  familyId: string;
  shelf: PublicShelf;
}

/** The sole owner of a family, with books and a public shelf. */
async function seedAccount(): Promise<Account> {
  const family = await dataOf(
    await call("POST", "/api/family", undefined, { userId: USER }),
    201,
  );
  await dataOf(
    await call("PUT", `/api/user/${USER}/books`, family.authToken, {
      books: [BOOK],
    }),
    200,
  );
  const { shelf } = await dataOf(
    await call("POST", `/api/user/${USER}/public-shelf`, family.authToken, {
      title: "Shelf",
      expiresDays: null,
    }),
    201,
  );
  return { token: family.authToken, familyId: family.familyId, shelf };
}

async function expectNoAccountData(shareToken: string): Promise<void> {
  for (const key of [
    kvKeys.user(USER),
    kvKeys.publicShelves(USER),
    kvKeys.publicShelf(shareToken),
    kvKeys.member(USER),
    kvKeys.auth(USER),
    kvKeys.verify(USER),
    kvKeys.newBookDefault(USER),
    kvKeys.otp(USER),
  ]) {
    expect(await kv.get(key), key).toBeNull();
  }
}

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DELETE /api/user/:id, the mark on a clean run", () => {
  it("names the deletion's start and the share tokens, with a one-day TTL", async () => {
    const { token, shelf } = await seedAccount();
    const before = Date.now();

    expect((await deleteAccount(token)).status).toBe(200);

    const mark = await readMark();
    expect(mark?.shareTokens).toEqual([shelf.shareToken]);
    expect(mark?.startedAt).toBeGreaterThanOrEqual(before);
    expect(mark?.startedAt).toBeLessThanOrEqual(Date.now());
    expect(getPutTtl(kv, MARK_KEY)).toBe(ACCOUNT_DELETING_MARK_TTL_SECONDS);
    expect(ACCOUNT_DELETING_MARK_TTL_SECONDS).toBe(86400);
  });

  it("is written after the family steps and before the account's first delete", async () => {
    const { token, familyId, shelf } = await seedAccount();
    const ops = watchKvOps(kv);

    expect((await deleteAccount(token)).status).toBe(200);

    const trail = ops.writeTrail();
    const markAt = trail.indexOf(`put ${MARK_KEY}`);
    expect(trail.indexOf(`delete ${kvKeys.family(familyId)}`)).toBeLessThan(
      markAt,
    );
    expect(markAt).toBeLessThan(
      trail.indexOf(`delete ${kvKeys.publicShelf(shelf.shareToken)}`),
    );
  });
});

describe("DELETE /api/user/:id refused: no mark, so the sweep cannot wipe the account", () => {
  it("leaves no mark on OWNER_CANNOT_DELETE", async () => {
    const { token, familyId } = await seedAccount();
    await dataOf(
      await call("POST", `/api/family/${familyId}/join`, undefined, {
        userId: BOB,
      }),
      200,
    );

    const res = await deleteAccount(token);

    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("OWNER_CANNOT_DELETE");
    expect(await kv.get(MARK_KEY)).toBeNull();
    await sweepDeletedAccounts(kv, Date.now());
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
  });

  it("leaves no mark on a wrong current secret", async () => {
    const { token } = await seedAccount();
    const saved = await dataOf(
      await call("PUT", `/api/user/${USER}/verify`, token, {
        method: "pin",
        secret: PIN,
      }),
      200,
    );

    const res = await deleteAccount(saved.authToken, "654321");

    expect(res.status).toBe(403);
    expect(await kv.get(MARK_KEY)).toBeNull();
  });

  it("leaves no mark on another account's deletion", async () => {
    const { token } = await seedAccount();

    const res = await call("DELETE", `/api/user/${BOB}`, token);

    expect(res.status).toBe(403);
    expect(await kv.get(MARK_KEY)).toBeNull();
    expect(await kv.get(kvKeys.accountDeleting(BOB))).toBeNull();
  });
});

describe("DELETE /api/user/:id when the mark cannot be written", () => {
  it("answers 500 with the account's keys untouched, and the retry finishes", async () => {
    const { token, shelf } = await seedAccount();
    failFirstWriteTo(kv, "put", MARK_KEY);

    const first = await deleteAccount(token);

    expect(first.status).toBe(500);
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).not.toBeNull();
    expect(await kv.get(MARK_KEY)).toBeNull();

    expect((await deleteAccount(token)).status).toBe(200);
    await expectNoAccountData(shelf.shareToken);
    expect(await readMark()).toMatchObject({
      shareTokens: [shelf.shareToken],
    });
  });

  it("answers 500 the same way when the earlier mark cannot be read", async () => {
    const { token, shelf } = await seedAccount();
    const real = kv.get.bind(kv) as (...args: unknown[]) => unknown;
    const get = vi
      .spyOn(kv, "get")
      .mockImplementation(((...args: unknown[]) =>
        args[0] === MARK_KEY
          ? Promise.reject(new Error("KV down"))
          : real(...args)) as never);

    const first = await deleteAccount(token);

    expect(first.status).toBe(500);
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();

    get.mockRestore();
    expect((await deleteAccount(token)).status).toBe(200);
  });
});

describe("DELETE /api/user/:id failing partway", () => {
  const STAGES: {
    label: string;
    key: (account: Account, hash: string) => string;
  }[] = [
    {
      label: "public:{token}",
      key: ({ shelf }) => kvKeys.publicShelf(shelf.shareToken),
    },
    { label: "user:", key: () => kvKeys.user(USER) },
    { label: "publicshelves:", key: () => kvKeys.publicShelves(USER) },
    { label: "member:", key: () => kvKeys.member(USER) },
    { label: "auth:", key: () => kvKeys.auth(USER) },
    { label: "the presented token:", key: (_, hash) => kvKeys.authToken(hash) },
  ];

  it.each(STAGES)(
    "answers 500 at $label, keeps the mark, and the sweep finishes so the retry answers ACCOUNT_DELETED",
    async ({ key }) => {
      const account = await seedAccount();
      const hash = await hashAuthToken(account.token);
      failFirstWriteTo(kv, "delete", key(account, hash));

      const first = await deleteAccount(account.token);

      expect(first.status).toBe(500);
      expect(await readMark()).not.toBeNull();

      await sweepDeletedAccounts(kv, Date.now());

      await expectNoAccountData(account.shelf.shareToken);
      expect(await kv.get(kvKeys.authToken(hash))).toBeNull();
      const retry = await deleteAccount(account.token);
      expect(retry.status).toBe(401);
      expect(await codeOf(retry)).toBe("ACCOUNT_DELETED");
    },
  );

  it.each(STAGES)(
    "answers 500 at $label, and the owner's own retry finishes without any sweep",
    async ({ key }) => {
      const account = await seedAccount();
      const hash = await hashAuthToken(account.token);
      failFirstWriteTo(kv, "delete", key(account, hash));
      expect((await deleteAccount(account.token)).status).toBe(500);

      expect(await dataOf(await deleteAccount(account.token), 200)).toEqual({
        ok: true,
      });

      await expectNoAccountData(account.shelf.shareToken);
      expect(await readMark()).not.toBeNull();
    },
  );

  it("moves startedAt on a retry, so the sweep's hour counts from the last attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-05-01T00:00:00.000Z"));
    const account = await seedAccount();
    failFirstWriteTo(kv, "delete", kvKeys.user(USER));
    expect((await deleteAccount(account.token)).status).toBe(500);
    const first = await readMark();

    vi.advanceTimersByTime(5000);
    expect((await deleteAccount(account.token)).status).toBe(200);

    const second = await readMark();
    expect(second?.startedAt).toBe((first?.startedAt as number) + 5000);
  });
});

describe("a retry after stage 3: the mark keeps the old share token", () => {
  /** A first attempt that deleted `publicshelves:` and failed after it, then a retry that read no list. */
  async function failAfterTheListThenRetry(account: Account): Promise<void> {
    failFirstWriteTo(kv, "delete", kvKeys.member(USER));
    expect((await deleteAccount(account.token)).status).toBe(500);
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect((await deleteAccount(account.token)).status).toBe(200);
  }

  it("still names it after the retry that saw an empty list", async () => {
    const account = await seedAccount();

    await failAfterTheListThenRetry(account);

    expect((await readMark())?.shareTokens).toEqual([account.shelf.shareToken]);
  });

  it("lets the guard remove a snapshot a PUT /books wrote back after the retry", async () => {
    const account = await seedAccount();
    const snapshotKey = kvKeys.publicShelf(account.shelf.shareToken);
    const hold = holdNextWrite(kv, "put", snapshotKey);
    const save = call("PUT", `/api/user/${USER}/books`, account.token, {
      books: [BOOK],
    });
    await hold.reached;

    await failAfterTheListThenRetry(account);
    expect(await kv.get(snapshotKey)).toBeNull();

    hold.release();
    const res = await save;

    expect(hold.landed()).toBe(true);
    expect(res.status).toBe(401);
    expect(await kv.get(snapshotKey)).toBeNull();
  });

  it("lets the sweep remove a snapshot written back with nothing else naming it", async () => {
    const account = await seedAccount();
    await failAfterTheListThenRetry(account);
    await writePublicSnapshot(kv, USER, account.shelf, [BOOK]);
    const snapshotKey = kvKeys.publicShelf(account.shelf.shareToken);
    expect(await kv.get(snapshotKey)).not.toBeNull();

    await sweepDeletedAccounts(kv, Date.now());

    expect(await kv.get(snapshotKey)).toBeNull();
  });

  it("drops a malformed earlier mark instead of failing the deletion", async () => {
    const account = await seedAccount();
    await kv.put(MARK_KEY, JSON.stringify({ startedAt: 1, shareTokens: "x" }));

    expect((await deleteAccount(account.token)).status).toBe(200);

    expect((await readMark())?.shareTokens).toEqual([account.shelf.shareToken]);
  });
});

describe("upgradeVerifyRecordHash after a mark", () => {
  function prodLookup(): Promise<Response> {
    return Promise.resolve(
      app.request(
        "/api/auth/lookup",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.70",
          },
          body: JSON.stringify({ userId: USER, verifySecret: PIN }),
        },
        { KV: kv, VERIFY_PEPPER: PEPPER, ...rateLimitBindings() },
      ),
    );
  }

  async function seedV1Pin(): Promise<void> {
    const record: VerifyRecord = {
      method: "pin",
      hash: await hashSecret(SALT, PIN),
      salt: SALT,
      prompted: 1,
      secretUpdatedAt: 1,
    };
    await kv.put(kvKeys.verify(USER), JSON.stringify(record));
  }

  it("upgrades and keeps the record with no mark, paying one extra read", async () => {
    await seedV1Pin();
    const ops = watchKvOps(kv);

    expect((await prodLookup()).status).toBe(200);

    const stored = (await kv.get(kvKeys.verify(USER), "json")) as VerifyRecord;
    expect(stored.version).toBe(VERIFY_HASH_VERSION_PEPPER);
    expect(ops.getKeys().filter((key) => key === MARK_KEY)).toHaveLength(1);
  });

  it("deletes what it wrote when a mark exists, so the old PIN does not come back", async () => {
    await seedV1Pin();
    await kv.put(MARK_KEY, JSON.stringify({ startedAt: 1, shareTokens: [] }));
    const ops = watchKvOps(kv);

    expect((await prodLookup()).status).toBe(200);

    expect(ops.putKeys()).toContain(kvKeys.verify(USER));
    expect(await kv.get(kvKeys.verify(USER))).toBeNull();
  });

  it("does not read the mark when nothing was upgraded", async () => {
    await seedV1Pin();
    expect((await prodLookup()).status).toBe(200);
    const ops = watchKvOps(kv);

    expect((await prodLookup()).status).toBe(200);

    expect(ops.getKeys()).not.toContain(MARK_KEY);
  });

  it("stays fail-open when the delete fails, logging the event name only", async () => {
    await seedV1Pin();
    await kv.put(MARK_KEY, JSON.stringify({ startedAt: 1, shareTokens: [] }));
    failFirstWriteTo(kv, "delete", kvKeys.verify(USER));

    expect((await prodLookup()).status).toBe(200);

    expect(consoleError.mock.calls).toEqual([["VERIFY_HASH_UPGRADE_FAILED"]]);
  });
});
