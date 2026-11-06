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
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { passRecreateCooldown } from "../helpers/recreateCooldown";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { ALICE, BOB, NOBODY } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { readAuthRecord } from "../../src/services/authRecord";
import { mintAuthToken } from "../../src/services/authTokens";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * Staged account deletion (#462): `DELETE /api/user/:id` answers `500` when a KV
 * operation fails partway, and the state it leaves must let the same token finish
 * the job on a retry.
 *
 * THE STAGES (`deleteAccountKeys`, `src/services/accountDeletion.ts`), each awaited
 * before the next: (0) the deleting mark `token:deleting:{id}` (#468), never cleared
 * here, (1) `public:{token}`s, (2) `user:` / `newbookdefault:` / `otp:`,
 * (3) `publicshelves:`, (4) the other tokens, strict listing, (5) `member:`,
 * (6) mark `token:deleted:{hash}`, fail-open, (7) `auth:`, (8) `verify:`,
 * (9) presented `token:`, then its index, fail-open.
 *
 * WHY THE ORDER MATTERS. `auth:` before `verify:`: with `auth.secretAt` still there
 * and `verify:` gone, `passedAgainstStaleVerifyRecord` refuses every retry with
 * `403`. Presented token last: a `code` account can only get a new code with a
 * token. `user:` before `publicshelves:`: an empty pointer is what keeps a leftover
 * legacy `publicSharing` from reviving a revoked link on the next `PUT /books`.
 * Mark before `auth:`: with `auth:` gone this token's refresh is in the TTL gap,
 * and only the mark stops it minting a new token, which would leave this one off
 * the list and refuse the owner's retry with `401`. A failed mark put is fail-open,
 * so that older path stays reachable and has its own case.
 *
 * THE MATRIX. Every operation that throws gets one injected failure, on each of the
 * four verification methods, driven by `FAILURES` (key → stage). The state check is
 * by stage: earlier stages gone, later stages untouched, the failed key still there.
 * The retry uses the original token; `code` and `none` send no secret.
 *
 * `failFirstWriteTo` only covers put / delete, so `failFirstIndexList` injects the
 * `list` failure of stage 4 the same way: a spy over `createMockKV()`.
 *
 * FIXTURES. Accounts go through the real routes, so `tokenidx:` and `publicshelves:`
 * exist as in production; only `otp:` is written directly, because a PIN save would
 * delete it. Each account is the sole owner of a family, so the first attempt also
 * dissolves it; the non-owner branch has its own case. Requests run with `DEV_MODE`
 * (rate limits are not under test), so `ratelimit:` keys are ignored when counting
 * what is left.
 *
 * THE DELETING MARK (#468). Once written it stays, so a finished deletion leaves it
 * next to `token:deleted:` until the sweep retires it, and any write the old token
 * sends between a failed attempt and its retry is wiped and answered 401: the deletion
 * always finishes. That is why the refresh and `PUT /books` cases come in two forms.
 * "the deleting mark stands" is what a client meets after a failed attempt. "the mark
 * expired" deletes the key by hand, since the mock never expires one, and pins the
 * state a Worker with no cron reaches 24 hours later: the #462 refusals still hold.
 *
 * A write in flight landing after the deletion is pinned in
 * `userDeleteConcurrentWrites.test.ts`, the mark's retry behaviour in
 * `userDeleteMarkRetry.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

type Method = "pin" | "pattern" | "code" | "none";

const USER = ALICE;
const FAMILY_MEMBER = BOB;
const SECRETS: Record<Method, string | undefined> = {
  pin: "123456",
  pattern: "0,1,2,3",
  code: undefined,
  none: undefined,
};
const METHODS: Method[] = ["pin", "pattern", "code", "none"];
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
const REVOKED_TOKEN = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const MARK_TTL_SECONDS = 86400;
const MARK_STAGE = 6;
const DELETING_MARK = kvKeys.accountDeleting(USER);
const REVOKE_BATCH = 400;
const INVALID_TOKEN_BODY = {
  error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
};
const ACCOUNT_DELETED_BODY = {
  error: { code: "ACCOUNT_DELETED", message: "這個帳戶已經移除" },
};

interface AccountKeys {
  snapshot: string;
  user: string;
  newBookDefault: string;
  otp: string;
  pointer: string;
  otherToken: string;
  otherToken2: string;
  otherIndex: string;
  otherIndex2: string;
  member: string;
  auth: string;
  verify: string;
  mark: string;
  presented: string;
  presentedIndex: string;
}

interface Account {
  token: string;
  others: string[];
  secret: string | undefined;
  familyId: string;
  shelf: PublicShelf;
  keys: AccountKeys;
}

let kv: KVNamespace;
let consoleError: MockInstance<typeof console.error>;

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

function deleteAccount(token: string, secret?: string): Promise<Response> {
  const body = secret === undefined ? undefined : { currentSecret: secret };
  return call("DELETE", `/api/user/${USER}`, token, body);
}

function saveBooks(token: string): Promise<Response> {
  return call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] });
}

async function dataOf(res: Response, status: number): Promise<Json> {
  expect(res.status).toBe(status);
  return ((await res.json()) as Json).data;
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as Json).error.code as string;
}

/** A second device's token: listed in `auth:` and indexed, like a real mint. */
async function mintOtherDevice(): Promise<string> {
  const auth = await readAuthRecord(kv, USER);
  return (await mintAuthToken(kv, USER, auth)).token;
}

async function keysOf(
  token: string,
  others: string[],
  shareToken: string,
): Promise<AccountKeys> {
  const hash = await hashAuthToken(token);
  const [otherHash, otherHash2] = await Promise.all(others.map(hashAuthToken));
  return {
    snapshot: kvKeys.publicShelf(shareToken),
    user: kvKeys.user(USER),
    newBookDefault: kvKeys.newBookDefault(USER),
    otp: kvKeys.otp(USER),
    pointer: kvKeys.publicShelves(USER),
    otherToken: kvKeys.authToken(otherHash),
    otherToken2: kvKeys.authToken(otherHash2),
    otherIndex: kvKeys.authTokenIndex(USER, otherHash),
    otherIndex2: kvKeys.authTokenIndex(USER, otherHash2),
    member: kvKeys.member(USER),
    auth: kvKeys.auth(USER),
    verify: kvKeys.verify(USER),
    mark: kvKeys.accountDeleted(hash),
    presented: kvKeys.authToken(hash),
    presentedIndex: kvKeys.authTokenIndex(USER, hash),
  };
}

/** A complete account: family, verification, books, setting, public shelf, code, two more devices. */
async function seedAccount(method: Method): Promise<Account> {
  const family = await dataOf(
    await call("POST", "/api/family", undefined, { userId: USER }),
    201,
  );
  const secret = SECRETS[method];
  const saved = await dataOf(
    await call("PUT", `/api/user/${USER}/verify`, family.authToken, {
      method,
      secret,
    }),
    200,
  );
  const token: string = saved.authToken ?? family.authToken;
  await dataOf(await saveBooks(token), 200);
  await dataOf(
    await call("PUT", `/api/user/${USER}/new-book-default`, token, {
      newBookDefaultShared: BoolFlag.TRUE,
    }),
    200,
  );
  const { shelf } = await dataOf(
    await call("POST", `/api/user/${USER}/public-shelf`, token, {
      title: "Shelf",
      expiresDays: null,
    }),
    201,
  );
  await kv.put(
    kvKeys.otp(USER),
    JSON.stringify({ code: "111111", createdAt: "2026-01-01T00:00:00.000Z" }),
    { expirationTtl: 300 },
  );
  const others = [await mintOtherDevice(), await mintOtherDevice()];
  return {
    token,
    others,
    secret,
    familyId: family.familyId,
    shelf,
    keys: await keysOf(token, others, shelf.shareToken),
  };
}

/** The mock never expires a key, so "the mark expired" is this delete. See the header → "THE DELETING MARK". */
function expireDeletingMark(): Promise<void> {
  return kv.delete(DELETING_MARK);
}

/** Every token key still alive for the account, ignoring both marks that share the `token:` prefix. */
async function liveTokenKeys(): Promise<string[]> {
  const { keys } = await kv.list({ prefix: "token:" });
  return keys
    .map((key) => key.name)
    .filter(
      (name) =>
        !name.startsWith(kvKeys.accountDeleted("")) &&
        !name.startsWith(kvKeys.accountDeleting("")),
    );
}

/** Every key still stored for the account, sorted; rate-limit counters are not under test. */
async function keysLeft(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys
    .map((key) => key.name)
    .filter((name) => !name.startsWith("ratelimit:"));
}

function stagesOf(keys: AccountKeys): [number, string[]][] {
  return [
    [1, [keys.snapshot]],
    [2, [keys.user, keys.newBookDefault, keys.otp]],
    [3, [keys.pointer]],
    [4, [keys.otherToken]],
    [5, [keys.member]],
    [7, [keys.auth]],
    [8, [keys.verify]],
    [9, [keys.presented]],
  ];
}

async function expectStateAfterFailure(
  keys: AccountKeys,
  failedStage: number,
  failedKey: string,
): Promise<void> {
  for (const [stage, stageKeys] of stagesOf(keys)) {
    for (const key of stageKeys) {
      const value = await kv.get(key);
      if (stage < failedStage) expect(value, key).toBeNull();
      if (stage > failedStage) expect(value, key).not.toBeNull();
    }
  }
  expect(await kv.get(failedKey), failedKey).not.toBeNull();
  expect(await kv.get(keys.presentedIndex)).not.toBeNull();
  expect(await kv.get(keys.mark)).toBe(failedStage > MARK_STAGE ? USER : null);
  expect(await kv.get(DELETING_MARK)).not.toBeNull();
}

/** Make the first `tokenidx:` list of `USER` reject, or answer a malformed page. */
function failFirstIndexList(mode: "reject" | "malformed"): void {
  const prefix = kvKeys.authTokenIndex(USER, "");
  const real = kv.list.bind(kv);
  let failed = false;
  vi.spyOn(kv, "list").mockImplementation(((options?: { prefix?: string }) => {
    if (options?.prefix === prefix && !failed) {
      failed = true;
      return mode === "reject"
        ? Promise.reject(new Error("KV down"))
        : Promise.resolve({ keys: "not-an-array", list_complete: true });
    }
    return real(options as KVNamespaceListOptions);
  }) as never);
}

/** Index + `token:` pairs with no device behind them, to push a listing past its batch. */
async function seedExtraIndexes(count: number, prefix = "0000"): Promise<void> {
  const record = JSON.stringify({ userId: USER, createdAt: "", expiresAt: 0 });
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const hash = prefix + i.toString(16).padStart(60, "0");
      return Promise.all([
        kv.put(kvKeys.authTokenIndex(USER, hash), "1"),
        kv.put(kvKeys.authToken(hash), record),
      ]);
    }),
  );
}

async function indexCount(): Promise<number> {
  const { keys } = await kv.list({ prefix: kvKeys.authTokenIndex(USER, "") });
  return keys.length;
}

/** The chunks of `trail`, each sorted, sized like `groups`: order between, not within, a stage. */
function chunksLike(trail: string[], groups: string[][]): string[][] {
  let at = 0;
  return groups.map((group) => {
    const chunk = trail.slice(at, at + group.length);
    at += group.length;
    return [...chunk].sort();
  });
}

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const FAILURES: {
  label: string;
  stage: number;
  key: (keys: AccountKeys) => string;
}[] = [
  { label: "public:{token}", stage: 1, key: (k) => k.snapshot },
  { label: "user:", stage: 2, key: (k) => k.user },
  { label: "newbookdefault:", stage: 2, key: (k) => k.newBookDefault },
  { label: "otp:", stage: 2, key: (k) => k.otp },
  { label: "publicshelves:", stage: 3, key: (k) => k.pointer },
  { label: "another device's token:", stage: 4, key: (k) => k.otherToken },
  { label: "member:", stage: 5, key: (k) => k.member },
  { label: "auth:", stage: 7, key: (k) => k.auth },
  { label: "verify:", stage: 8, key: (k) => k.verify },
  { label: "the presented token:", stage: 9, key: (k) => k.presented },
];

/** The failures that leave `auth:` gone with the presented token alive: refresh's TTL gap. */
const TTL_GAP_FAILURES = FAILURES.filter(({ stage }) => stage > 7);

function acrossGapFailures<M extends Method>(
  methods: readonly M[],
): ((typeof FAILURES)[number] & { method: M })[] {
  return methods.flatMap((method) =>
    TTL_GAP_FAILURES.map((failure) => ({ ...failure, method })),
  );
}

describe.each(METHODS)("DELETE /api/user/:id on a %s account", (method) => {
  it.each(FAILURES)(
    "answers 500 when deleting $label fails, keeps what the retry needs, and the retry finishes",
    async ({ stage, key }) => {
      const account = await seedAccount(method);
      const failedKey = key(account.keys);
      failFirstWriteTo(kv, "delete", failedKey);

      const first = await deleteAccount(account.token, account.secret);

      expect(first.status).toBe(500);
      expect(await codeOf(first)).toBe("INTERNAL_ERROR");
      await expectStateAfterFailure(account.keys, stage, failedKey);

      const retry = await deleteAccount(account.token, account.secret);

      expect(await dataOf(retry, 200)).toEqual({ ok: true });
      expect(await keysLeft()).toEqual([account.keys.mark, DELETING_MARK]);
    },
  );
});

describe("DELETE /api/user/:id, write order of a clean run", () => {
  it("runs the stages in order and answers exactly as before", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    const ops = watchKvOps(kv);

    const res = await deleteAccount(token, secret);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const trail = ops.writeTrail();
    const teardown = trail.slice(trail.indexOf(`put ${DELETING_MARK}`));
    const groups = [
      [`put ${DELETING_MARK}`],
      [`delete ${keys.snapshot}`],
      [
        `delete ${keys.user}`,
        `delete ${keys.newBookDefault}`,
        `delete ${keys.otp}`,
      ],
      [`delete ${keys.pointer}`],
      [`list ${kvKeys.authTokenIndex(USER, "")}`],
      [`delete ${keys.otherToken}`, `delete ${keys.otherToken2}`],
      [`delete ${keys.otherIndex}`, `delete ${keys.otherIndex2}`],
      [`delete ${keys.member}`],
      [`put ${keys.mark}`],
      [`delete ${keys.auth}`],
      [`delete ${keys.verify}`],
      [`delete ${keys.presented}`],
      [`delete ${keys.presentedIndex}`],
    ];
    expect(teardown).toHaveLength(groups.flat().length);
    expect(chunksLike(teardown, groups)).toEqual(
      groups.map((group) => [...group].sort()),
    );
  });

  it("writes the mark with a one-day TTL, naming the deleted account", async () => {
    const { token, keys, secret } = await seedAccount("none");

    expect((await deleteAccount(token, secret)).status).toBe(200);

    expect(await kv.get(keys.mark)).toBe(USER);
    expect(getPutTtl(kv, keys.mark)).toBe(MARK_TTL_SECONDS);
  });
});

describe("DELETE /api/user/:id, a retry on a PIN account", () => {
  it.each(FAILURES.filter(({ stage }) => stage <= 8))(
    "still demands the PIN after deleting $label failed",
    async ({ key }) => {
      const { token, keys, secret } = await seedAccount("pin");
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token, secret)).status).toBe(500);

      const noSecret = await deleteAccount(token);

      expect(noSecret.status).toBe(403);
      expect(await codeOf(noSecret)).toBe("VERIFICATION_REQUIRED");
      expect((await deleteAccount(token, secret)).status).toBe(200);
    },
  );

  it("refuses a wrong PIN too while verify: and the token survive a failed verify: delete", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    failFirstWriteTo(kv, "delete", keys.verify);
    expect((await deleteAccount(token, secret)).status).toBe(500);
    expect(await kv.get(keys.auth)).toBeNull();
    expect(await kv.get(keys.verify)).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER);

    const wrong = await deleteAccount(token, "654321");

    expect(wrong.status).toBe(403);
    expect(await codeOf(wrong)).toBe("VERIFICATION_FAILED");
    expect(await kv.get(keys.verify)).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER);

    expect((await deleteAccount(token, secret)).status).toBe(200);
    expect(await kv.get(keys.verify)).toBeNull();
  });

  it("needs no PIN once verify: is gone", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    failFirstWriteTo(kv, "delete", keys.presented);
    expect((await deleteAccount(token, secret)).status).toBe(500);

    expect((await deleteAccount(token)).status).toBe(200);
    expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
  });
});

describe("DELETE /api/user/:id, a non-owner's retry", () => {
  it("finishes without writing the family record again", async () => {
    const created = await dataOf(
      await call("POST", "/api/family", undefined, { userId: FAMILY_MEMBER }),
      201,
    );
    const joined = await dataOf(
      await call("POST", `/api/family/${created.familyId}/join`, undefined, {
        userId: USER,
      }),
      200,
    );
    const familyKey = kvKeys.family(created.familyId);
    failFirstWriteTo(kv, "delete", kvKeys.auth(USER));
    expect((await deleteAccount(joined.authToken)).status).toBe(500);
    const ops = watchKvOps(kv);

    expect((await deleteAccount(joined.authToken)).status).toBe(200);

    expect(ops.putKeys()).not.toContain(familyKey);
    const family = (await kv.get(familyKey, "json")) as Json;
    expect(family.members.map((m: Json) => m.userId)).toEqual([FAMILY_MEMBER]);
    expect(await kv.get(kvKeys.member(FAMILY_MEMBER))).toBe(created.familyId);
  });
});

describe("DELETE /api/user/:id, stage 4: the other tokens", () => {
  it("leaves the presented token and its index alone until stage 9", async () => {
    const { token, others, keys, secret } = await seedAccount("none");
    failFirstWriteTo(kv, "delete", keys.member);
    const ops = watchKvOps(kv);

    expect((await deleteAccount(token, secret)).status).toBe(500);

    expect(ops.deleteKeys()).not.toContain(keys.presented);
    expect(ops.deleteKeys()).not.toContain(keys.presentedIndex);
    expect(ops.deleteKeys()).toContain(keys.otherToken);
    expect(ops.deleteKeys()).toContain(keys.otherIndex);
    expect(await tokenOwner(kv, token)).toBe(USER);
    expect(await kv.get(keys.presentedIndex)).toBe("1");
    expect(await tokenOwner(kv, others[0])).toBeNull();
    expect(await tokenOwner(kv, others[1])).toBeNull();
  });

  it("reaches a token only the index names and a token only auth: lists", async () => {
    const { token, keys, secret } = await seedAccount("none");
    const listBefore = await kv.get(keys.auth);
    const indexedOnly = await mintOtherDevice();
    await kv.put(keys.auth, listBefore as string);
    const listedOnly = await seedAuthToken(kv, USER, {
      token: "f".repeat(64),
      appendTo: true,
    });
    expect(await tokenOwner(kv, indexedOnly)).toBe(USER);
    expect(await tokenOwner(kv, listedOnly)).toBe(USER);
    failFirstWriteTo(kv, "delete", keys.member);

    expect((await deleteAccount(token, secret)).status).toBe(500);

    expect(await tokenOwner(kv, indexedOnly)).toBeNull();
    expect(await tokenOwner(kv, listedOnly)).toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER);
  });

  it.each(["reject", "malformed"] as const)(
    "answers 500 and keeps verify: and the token when the index list fails (%s)",
    async (mode) => {
      const { token, others, keys, secret } = await seedAccount("pin");
      failFirstIndexList(mode);

      const first = await deleteAccount(token, secret);

      expect(first.status).toBe(500);
      for (const key of [
        keys.verify,
        keys.auth,
        keys.member,
        keys.presented,
        keys.otherToken,
      ]) {
        expect(await kv.get(key), key).not.toBeNull();
      }
      expect(await tokenOwner(kv, others[0])).toBe(USER);
      expect(await kv.get(keys.mark)).toBeNull();

      expect((await deleteAccount(token, secret)).status).toBe(200);
      expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
    },
  );

  it.each([
    { total: REVOKE_BATCH, statuses: [200] },
    { total: REVOKE_BATCH + 1, statuses: [500, 200] },
  ])(
    "with $total indexes in all, answers $statuses",
    async ({ total, statuses }) => {
      const { token, keys } = await seedAccount("none");
      await seedExtraIndexes(total - (await indexCount()));

      const seen: number[] = [];
      for (let i = 0; i < statuses.length; i += 1) {
        seen.push((await deleteAccount(token)).status);
      }

      expect(seen).toEqual(statuses);
      expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
    },
  );

  it.each([
    { label: "before", prefix: "0000" },
    { label: "after", prefix: "ffff" },
  ])(
    "answers 500 past the batch and converges when the presented index sorts $label the rest",
    async ({ prefix }) => {
      const { token, keys } = await seedAccount("none");
      await seedExtraIndexes(850, prefix);
      const ops = watchKvOps(kv);

      const first = await deleteAccount(token);

      expect(first.status).toBe(500);
      expect(ops.writeTrail().length + ops.getKeys().length).toBeLessThan(1000);
      expect(consoleError).toHaveBeenCalledWith("AUTH_TOKEN_INDEX_CAPPED", {
        listed: REVOKE_BATCH,
      });

      let remaining = await indexCount();
      let status = first.status;
      for (let attempt = 0; attempt < 5 && status === 500; attempt += 1) {
        expect(await kv.get(keys.verify)).not.toBeNull();
        expect(await tokenOwner(kv, token)).toBe(USER);
        expect(await kv.get(keys.mark)).toBeNull();
        status = (await deleteAccount(token)).status;
        const now = await indexCount();
        expect(now).toBeLessThan(remaining);
        remaining = now;
      }

      expect(status).toBe(200);
      expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
    },
  );
});

describe("POST /api/auth/refresh around a failed deletion, the deleting mark standing", () => {
  it.each(FAILURES)(
    "wipes and answers 401 after deleting $label failed, and the retry answers ACCOUNT_DELETED",
    async ({ key }) => {
      const { token, familyId, keys, secret } = await seedAccount("none");
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token, secret)).status).toBe(500);

      const res = await call("POST", "/api/auth/refresh", token, {
        userId: USER,
        familyId,
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
      expect(await liveTokenKeys()).toEqual([]);
      const data = (await keysLeft()).filter(
        (name) => !name.startsWith(kvKeys.accountDeleted("")),
      );
      expect(data).toEqual([DELETING_MARK]);

      const retry = await deleteAccount(token, secret);
      expect(retry.status).toBe(401);
      expect(await retry.json()).toEqual(ACCOUNT_DELETED_BODY);
    },
  );

  it("wipes the token a TTL-gap refresh minted when the deleted mark put failed too", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    failFirstWriteTo(kv, "put", keys.mark);
    failFirstWriteTo(kv, "delete", keys.verify);
    expect((await deleteAccount(token, secret)).status).toBe(500);
    expect(await kv.get(keys.mark)).toBeNull();
    expect(await kv.get(keys.auth)).toBeNull();
    const ops = watchKvOps(kv);

    const res = await call("POST", "/api/auth/refresh", token, {
      userId: USER,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
    // Positive companion for the empty list below: the handler really did mint.
    expect(ops.putKeys()).toContain(keys.auth);
    expect(await liveTokenKeys()).toEqual([]);
    expect(await kv.get(keys.auth)).toBeNull();
    expect(await kv.get(keys.verify)).toBeNull();
  });
});

describe("POST /api/auth/refresh around a failed deletion, the mark expired", () => {
  it.each(acrossGapFailures(["pin", "code", "none"] as const))(
    "without familyId refuses a $method account after deleting $label failed, minting nothing, and the original token finishes",
    async ({ method, key }) => {
      const { token, keys, secret } = await seedAccount(method);
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token, secret)).status).toBe(500);
      expect(await kv.get(keys.auth)).toBeNull();
      expect(await kv.get(keys.mark)).toBe(USER);
      await expireDeletingMark();
      const before = await keysLeft();
      const ops = watchKvOps(kv);
      const writesBefore = ops.writeTrail().length;

      const res = await call("POST", "/api/auth/refresh", token, {
        userId: USER,
      });

      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe("REFRESH_FAILED");
      expect(ops.getKeys()).toContain(keys.mark);
      expect(ops.writeTrail().slice(writesBefore)).toEqual([]);
      expect(await keysLeft()).toEqual(before);

      const retry = await deleteAccount(token, secret);

      expect(await dataOf(retry, 200)).toEqual({ ok: true });
      expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
    },
  );

  it.each(acrossGapFailures(["pin", "none"] as const))(
    "mints on a $method account when the mark put failed too and deleting $label failed; the new token finishes through the index",
    async ({ method, key }) => {
      const { token, keys, secret } = await seedAccount(method);
      failFirstWriteTo(kv, "put", keys.mark);
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token, secret)).status).toBe(500);
      expect(await kv.get(keys.mark)).toBeNull();
      await expireDeletingMark();

      const issued = await dataOf(
        await call("POST", "/api/auth/refresh", token, { userId: USER }),
        200,
      );
      const newToken: string = issued.token;
      expect(newToken).not.toBe(token);

      const stale = await deleteAccount(token, secret);
      expect(stale.status).toBe(401);
      expect(await codeOf(stale)).toBe("UNAUTHORIZED");

      await dataOf(await saveBooks(newToken), 200);
      expect(await kv.get(keys.user)).not.toBeNull();

      expect((await deleteAccount(newToken, secret)).status).toBe(200);

      expect(await tokenOwner(kv, token)).toBeNull();
      expect(await kv.get(keys.user)).toBeNull();
      const newMark = kvKeys.accountDeleted(await hashAuthToken(newToken));
      expect(await keysLeft()).toEqual([newMark, DELETING_MARK]);
    },
  );

  it("without familyId still renews after deleting auth: failed: a listed token reads no mark", async () => {
    const { token, keys, secret } = await seedAccount("none");
    failFirstWriteTo(kv, "delete", keys.auth);
    expect((await deleteAccount(token, secret)).status).toBe(500);
    expect(await kv.get(keys.mark)).toBe(USER);
    await expireDeletingMark();
    const ops = watchKvOps(kv);

    const issued = await dataOf(
      await call("POST", "/api/auth/refresh", token, { userId: USER }),
      200,
    );

    expect(issued.token).toBe(token);
    expect(ops.getKeys()).toContain(keys.auth);
    expect(ops.getKeys()).not.toContain(keys.mark);

    expect((await deleteAccount(token, secret)).status).toBe(200);
    expect(await keysLeft()).toEqual([keys.mark, DELETING_MARK]);
  });

  it.each(FAILURES.filter(({ stage }) => stage <= 5))(
    "with familyId still renews after deleting $label failed (member: is there)",
    async ({ key }) => {
      const { token, familyId, keys } = await seedAccount("none");
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token)).status).toBe(500);
      await expireDeletingMark();

      const issued = await dataOf(
        await call("POST", "/api/auth/refresh", token, {
          userId: USER,
          familyId,
        }),
        200,
      );

      expect(issued.token).toBe(token);
    },
  );

  it.each(FAILURES.filter(({ stage }) => stage > 5))(
    "with familyId refuses after deleting $label failed (member: is gone), minting nothing",
    async ({ key }) => {
      const { token, familyId, keys } = await seedAccount("none");
      failFirstWriteTo(kv, "delete", key(keys));
      expect((await deleteAccount(token)).status).toBe(500);
      await expireDeletingMark();
      const ops = watchKvOps(kv);

      const res = await call("POST", "/api/auth/refresh", token, {
        userId: USER,
        familyId,
      });

      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe("REFRESH_FAILED");
      expect(ops.putKeys()).toEqual([]);
    },
  );
});

describe("PUT /books between a failed deletion and its retry", () => {
  it("is wiped and answers 401 while the deleting mark stands, and the retry answers ACCOUNT_DELETED", async () => {
    const { token, keys, shelf, secret } = await seedAccount("none");
    failFirstWriteTo(kv, "delete", keys.user);
    expect((await deleteAccount(token, secret)).status).toBe(500);

    const saved = await saveBooks(token);

    expect(saved.status).toBe(401);
    expect(await saved.json()).toEqual(INVALID_TOKEN_BODY);
    expect(await kv.get(keys.snapshot)).toBeNull();
    expect(await kv.get(keys.user)).toBeNull();
    const reader = await call("GET", `/api/public/${shelf.shareToken}`);
    expect(reader.status).toBe(404);
    const retry = await deleteAccount(token, secret);
    expect(retry.status).toBe(401);
    expect(await retry.json()).toEqual(ACCOUNT_DELETED_BODY);
  });

  it("rebuilds the snapshot once the mark expired, and the retry clears it again", async () => {
    const { token, keys, shelf, secret } = await seedAccount("none");
    failFirstWriteTo(kv, "delete", keys.user);
    expect((await deleteAccount(token, secret)).status).toBe(500);
    expect(await kv.get(keys.snapshot)).toBeNull();
    await expireDeletingMark();

    await dataOf(await saveBooks(token), 200);

    expect(await kv.get(keys.snapshot)).not.toBeNull();
    const reader = await call("GET", `/api/public/${shelf.shareToken}`);
    expect(reader.status).toBe(200);

    expect((await deleteAccount(token, secret)).status).toBe(200);

    expect(await kv.get(keys.snapshot)).toBeNull();
    expect(await kv.get(keys.user)).toBeNull();
    const gone = await call("GET", `/api/public/${shelf.shareToken}`);
    expect(gone.status).toBe(404);
  });

  /** An account whose `publicshelves:` says "no shelves" while `user:` still holds a revoked legacy shelf. */
  async function seedRevokedLegacyShelf(): Promise<string> {
    const family = await dataOf(
      await call("POST", "/api/family", undefined, { userId: USER }),
      201,
    );
    const shelf: PublicShelf = {
      shelfId: "11111111-1111-4111-8111-111111111111",
      shareToken: REVOKED_TOKEN,
      title: "Shelf",
      expiresDays: null,
      createdAt: 1,
      expiresAt: null,
      selectionMode: "all-shared",
    };
    const record: UserBooksRecord = {
      schemaVersion: 1,
      userId: USER,
      displayName: "Name",
      books: [BOOK],
      lastUpdated: "2026-01-01T00:00:00.000Z",
      publicSharing: { shelves: [shelf] },
    };
    await kv.put(kvKeys.user(USER), JSON.stringify(record));
    await kv.put(kvKeys.publicShelves(USER), JSON.stringify({ shelves: [] }));
    return family.authToken;
  }

  it("rebuilds the legacy shelf's snapshot when no pointer exists (the state the order rules out)", async () => {
    const token = await seedRevokedLegacyShelf();
    await kv.delete(kvKeys.publicShelves(USER));

    await dataOf(await saveBooks(token), 200);

    expect(await kv.get(kvKeys.publicShelf(REVOKED_TOKEN))).not.toBeNull();
  });

  it.each([
    { label: "user:", key: () => kvKeys.user(USER) },
    { label: "publicshelves:", key: () => kvKeys.publicShelves(USER) },
  ])(
    "does not bring a revoked legacy link back after deleting $label failed, the deleting mark standing",
    async ({ key }) => {
      const token = await seedRevokedLegacyShelf();
      failFirstWriteTo(kv, "delete", key());
      expect((await deleteAccount(token)).status).toBe(500);

      expect((await saveBooks(token)).status).toBe(401);

      expect(await kv.get(kvKeys.publicShelf(REVOKED_TOKEN))).toBeNull();
      expect(await kv.get(kvKeys.user(USER))).toBeNull();
      expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    },
  );

  it.each([
    { label: "user:", key: () => kvKeys.user(USER) },
    { label: "publicshelves:", key: () => kvKeys.publicShelves(USER) },
  ])(
    "does not bring a revoked legacy link back after deleting $label failed, the mark expired",
    async ({ key }) => {
      const token = await seedRevokedLegacyShelf();
      failFirstWriteTo(kv, "delete", key());
      expect((await deleteAccount(token)).status).toBe(500);
      await expireDeletingMark();

      await dataOf(await saveBooks(token), 200);

      expect(await kv.get(kvKeys.publicShelf(REVOKED_TOKEN))).toBeNull();

      expect((await deleteAccount(token)).status).toBe(200);
      expect(await kv.get(kvKeys.publicShelf(REVOKED_TOKEN))).toBeNull();
      expect(await kv.get(kvKeys.user(USER))).toBeNull();
      expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    },
  );
});

describe("401 ACCOUNT_DELETED", () => {
  it("answers the token that deleted the account, reading four keys and writing none", async () => {
    const { token, keys, secret } = await seedAccount("none");
    expect((await deleteAccount(token, secret)).status).toBe(200);
    const ops = watchKvOps(kv);

    const res = await deleteAccount(token);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(ACCOUNT_DELETED_BODY);
    expect([...ops.getKeys()].sort()).toEqual(
      [keys.presented, keys.mark, keys.auth, keys.user].sort(),
    );
    expect(ops.writeTrail()).toEqual([]);
  });

  it("answers a token whose stage 9 failed once the retry finished", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    failFirstWriteTo(kv, "delete", keys.presented);
    expect((await deleteAccount(token, secret)).status).toBe(500);
    expect((await deleteAccount(token)).status).toBe(200);

    const res = await deleteAccount(token, secret);

    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("ACCOUNT_DELETED");
  });

  it("does not answer another device's token, which carries no mark", async () => {
    const { token, others, keys, secret } = await seedAccount("none");
    expect((await deleteAccount(token, secret)).status).toBe(200);
    const ops = watchKvOps(kv);

    const res = await deleteAccount(others[0]);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
    expect([...ops.getKeys()].sort()).toEqual(
      [keys.otherToken, kvKeys.accountDeleted(keys.otherToken.slice(6))].sort(),
    );
  });

  it("does not answer a dead token on an account that was never deleted", async () => {
    await seedAccount("none");

    const res = await deleteAccount("e".repeat(64));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it.each([
    { label: "another account's id", id: NOBODY },
    { label: "its own id in upper case", id: USER.toUpperCase() },
    { label: "a malformed id", id: "abc" },
  ])("does not answer a DELETE of $label", async ({ id }) => {
    const { token, secret } = await seedAccount("none");
    expect((await deleteAccount(token, secret)).status).toBe(200);

    const res = await call("DELETE", `/api/user/${id}`, token);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it.each([
    { method: "GET", path: `/api/user/${USER}/books` },
    { method: "PUT", path: `/api/user/${USER}/books` },
    { method: "PATCH", path: `/api/user/${USER}/books` },
    { method: "GET", path: `/api/user/${USER}/public-shelf` },
    { method: "DELETE", path: `/api/user/${USER}/public-shelf/x` },
    { method: "POST", path: "/api/auth/refresh" },
    { method: "PUT", path: `/api/user/${USER}` },
    { method: "DELETE", path: `/api/family/ab12-cd34/member/${USER}` },
  ])(
    "does not answer $method $path, and that route reads only token:",
    async ({ method, path }) => {
      const { token, keys, secret } = await seedAccount("none");
      expect((await deleteAccount(token, secret)).status).toBe(200);
      const ops = watchKvOps(kv);

      const res = await call(method, path, token);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
      expect(ops.getKeys()).toEqual([keys.presented]);
    },
  );

  it("does not answer once the same user has a family again (auth: is back)", async () => {
    const { token, keys, secret } = await seedAccount("none");
    expect((await deleteAccount(token, secret)).status).toBe(200);
    passRecreateCooldown();
    await dataOf(
      await call("POST", "/api/family", undefined, { userId: USER }),
      201,
    );
    expect(await kv.get(keys.auth)).not.toBeNull();
    expect(await kv.get(keys.user)).toBeNull();

    const res = await deleteAccount(token);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it("does not answer after the same user rebuilt, synced and left again (user: is back, auth: is not)", async () => {
    const { token, keys, secret } = await seedAccount("none");
    expect((await deleteAccount(token, secret)).status).toBe(200);
    passRecreateCooldown();
    const family = await dataOf(
      await call("POST", "/api/family", undefined, { userId: USER }),
      201,
    );
    await dataOf(await saveBooks(family.authToken), 200);
    const left = await call(
      "DELETE",
      `/api/family/${family.familyId}/member/${USER}`,
      family.authToken,
    );
    expect(left.status).toBe(200);
    expect(await kv.get(keys.auth)).toBeNull();
    expect(await kv.get(keys.user)).not.toBeNull();

    const res = await deleteAccount(token);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
  });
});

describe("DELETE /api/user/:id, the fail-open writes", () => {
  it("answers 200 and finishes when the mark cannot be written, logging only the event name", async () => {
    const { token, keys, secret } = await seedAccount("pin");
    failFirstWriteTo(kv, "put", keys.mark);

    const res = await deleteAccount(token, secret);

    expect(res.status).toBe(200);
    expect(await keysLeft()).toEqual([DELETING_MARK]);
    expect(consoleError.mock.calls).toEqual([["ACCOUNT_DELETED_MARK_FAILED"]]);

    const later = await deleteAccount(token, secret);
    expect(later.status).toBe(401);
    expect(await later.json()).toEqual(INVALID_TOKEN_BODY);
  });

  it.each([
    { label: "another device's", key: (k: AccountKeys) => k.otherIndex },
    {
      label: "the presented token's",
      key: (k: AccountKeys) => k.presentedIndex,
    },
  ])(
    "answers 200 and finishes when deleting $label index fails",
    async ({ key }) => {
      const { token, keys, secret } = await seedAccount("none");
      failFirstWriteTo(kv, "delete", key(keys));

      const res = await deleteAccount(token, secret);

      expect(res.status).toBe(200);
      expect(await keysLeft()).toEqual(
        [key(keys), keys.mark, DELETING_MARK].sort(),
      );
      expect(consoleError.mock.calls.map(([event]) => event)).toEqual([
        "AUTH_TOKEN_INDEX_DELETE_FAILED",
      ]);
    },
  );
});
