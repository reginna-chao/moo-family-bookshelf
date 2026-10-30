import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  expectRevokeIndexOrder,
  seedAuthToken,
  tokenOwner,
} from "../helpers/auth";
import { USER1, USER2 } from "../helpers/ids";
import { readAuthRecord } from "../../src/services/authRecord";
import {
  listAuthTokenIndexHashes,
  listRevocableIndexHashes,
  MAX_REVOKE_INDEX_HASHES,
  mintAuthToken,
  revokeAllAuthTokens,
  revokeAuthTokenKeys,
  type IssuedToken,
} from "../../src/services/authTokens";
import { renewPresentedAuthToken } from "../../src/services/authRenewal";
import {
  kvKeys,
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_TTL_SECONDS,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * The per-token index `tokenidx:{userId}:{hash}` (#431) and the guards around it.
 *
 * Why it exists: `mintAuthToken` rewrites `auth:{userId}` from the caller's
 * read, and KV has no CAS, so two mints from one stale read leave an ORPHAN —
 * a live `token:{hash}` no list names. Revoke-all now also lists the account's
 * index prefix and deletes every `token:` key it names.
 *
 * Write rules pinned here (each guard had a one-shot mutation check when it was
 * written — see the run report):
 * - Index BEFORE token: every `token:{hash}` put (a new token, a refresh slide)
 *   is preceded by its index put with
 *   the same TTL, and an index put that throws stops the write before that
 *   `token:` (and `auth:`) exists — so no token ever lacks its index.
 * - Token deletes BEFORE index deletes: a revoke whose `token:` delete throws
 *   keeps every index, so the retry still finds the token.
 * - Index deletes are fail-open (`AUTH_TOKEN_INDEX_DELETE_FAILED`, `{ err }`
 *   only — no userId, no hash): a leftover index names a key already gone.
 * - A list failure is fail-open (`AUTH_TOKEN_INDEX_LIST_FAILED`): the known set
 *   (the `auth:` list, `alsoKeys`) is still deleted and no index is touched.
 *   Revoke-all runs beside `deleteAuthRecord`, so a throw there would leave
 *   every token alive with `auth:` gone.
 * - Only 64-hex tails steer a `token:` delete; anything else under the prefix
 *   is skipped, so a stray key can never delete an arbitrary `token:` key.
 * - Paging: every page is read; a malformed page, a missing / repeated cursor,
 *   or more than 10 pages throws (and, inside revoke, falls into the fail-open
 *   above).
 * - Per-call cap: one revoke processes at most `MAX_REVOKE_INDEX_HASHES` (400)
 *   indexes — KV's 1,000 operations per invocation — the lexicographically
 *   smallest, and fetches no page past the one that reaches the cap. Over the
 *   cap it logs `AUTH_TOKEN_INDEX_CAPPED` with `{ listed }` alone (no userId,
 *   no hash); the processed indexes are deleted, so the next revoke takes the
 *   rest and repeated revokes converge.
 *
 * Fault injection: `failWrites` / `failLists` make every matching op reject
 * with `Error("KV down")` and pass the rest straight through to the mock;
 * `pagedBy` forces a small `limit` onto every `list` so paging is reached
 * without seeding 1000 keys. All are `vi.spyOn`s, restored in `afterEach`.
 * `noIdsLogged` checks that the logged object holds only `err` and that no
 * userId / hash appears anywhere in the call.
 */

let kv: KVNamespace;

const OTHER_HASH = "e".repeat(64);
const INDEX_PREFIX = kvKeys.authTokenIndex(USER1, "");

/** Every key under `prefix`, read without going through any spy installed later. */
let keysUnder: (prefix: string) => Promise<string[]>;

function indexKey(hash: string): string {
  return kvKeys.authTokenIndex(USER1, hash);
}

async function hashOf(issued: IssuedToken | string): Promise<string> {
  return hashAuthToken(typeof issued === "string" ? issued : issued.token);
}

/** Make every `op` whose key matches reject with `Error("KV down")`; others go through. */
function failWrites(
  op: "put" | "delete",
  matches: (key: string) => boolean,
): void {
  const real = (kv[op] as (...args: unknown[]) => Promise<void>).bind(kv);
  vi.spyOn(kv, op).mockImplementation(((key: string, ...rest: unknown[]) =>
    matches(key)
      ? Promise.reject(new Error("KV down"))
      : real(key, ...rest)) as never);
}

/** Force `limit` onto every `list`, so a handful of keys spans several pages. */
function pagedBy(limit: number) {
  const real = kv.list.bind(kv);
  return vi
    .spyOn(kv, "list")
    .mockImplementation(((options?: KVNamespaceListOptions) =>
      real({ ...options, limit })) as never);
}

/** Answer every `list` with `page`, unchanged. */
function listAnswers(page: unknown) {
  return vi.spyOn(kv, "list").mockResolvedValue(page as never);
}

/** Two mints from one stale `auth` read: `orphan` is live but unlisted, `current` is listed. */
async function mintOrphan(): Promise<{
  orphan: IssuedToken;
  current: IssuedToken;
}> {
  const auth = await readAuthRecord(kv, USER1);
  const orphan = await mintAuthToken(kv, USER1, auth);
  const current = await mintAuthToken(kv, USER1, auth);
  const listed = (await readAuthRecord(kv, USER1))?.tokens.map((e) => e.hash);
  expect(listed).not.toContain(await hashOf(orphan));
  expect(await tokenOwner(kv, orphan.token)).toBe(USER1);
  return { orphan, current };
}

/** Mint `count` tokens for USER1, each from a fresh read, so all are listed. */
async function mintListed(count: number): Promise<IssuedToken[]> {
  const issued: IssuedToken[] = [];
  for (let i = 0; i < count; i += 1)
    issued.push(
      await mintAuthToken(kv, USER1, await readAuthRecord(kv, USER1)),
    );
  return issued;
}

/** The logged object is `{ err }` alone and no userId / hash appears anywhere in the call. */
function noIdsLogged(call: unknown[], hashes: readonly string[]): void {
  expect(Object.keys(call[1] as object)).toEqual(["err"]);
  const text = JSON.stringify(call, (_k, v: unknown) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v,
  );
  for (const id of [USER1, ...hashes]) expect(text).not.toContain(id);
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** `count` distinct 64-hex hashes whose lexicographic order is their index order. */
function fakeHashes(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
}

async function seedIndexes(count: number): Promise<string[]> {
  const hashes = fakeHashes(count);
  for (const hash of hashes) await kv.put(indexKey(hash), "1");
  return hashes;
}

/** `seedIndexes` plus a USER1 `token:{hash}` record behind every index. */
async function seedIndexedTokens(count: number): Promise<string[]> {
  const hashes = await seedIndexes(count);
  const record = JSON.stringify({ userId: USER1, createdAt: "", expiresAt: 0 });
  for (const hash of hashes) await kv.put(kvKeys.authToken(hash), record);
  return hashes;
}

beforeEach(() => {
  kv = createMockKV();
  const list = kv.list.bind(kv);
  keysUnder = async (prefix) =>
    (await list({ prefix })).keys.map((k) => k.name);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("mintAuthToken — tokenidx index", () => {
  it("puts the new token's index first, with the token's TTL, then auth: and token:", async () => {
    const ops = watchKvOps(kv);

    const issued = await mintAuthToken(kv, USER1, null);

    const hash = await hashOf(issued);
    expect(ops.writeTrail()).toEqual([
      `put ${indexKey(hash)}`,
      `put ${kvKeys.auth(USER1)}`,
      `put ${kvKeys.authToken(hash)}`,
    ]);
    expect(await kv.get(indexKey(hash))).toBe("1");
    expect(getPutTtl(kv, indexKey(hash))).toBe(TOKEN_TTL_SECONDS);
    expect(getPutTtl(kv, kvKeys.authToken(hash))).toBe(TOKEN_TTL_SECONDS);
    expect(await kv.get(kvKeys.auth(USER1))).not.toBeNull();
  });

  it("writes neither auth: nor the new token: when the index put throws", async () => {
    failWrites("put", (key) => key.startsWith(INDEX_PREFIX));
    const puts = kv.put as unknown as { mock: { calls: unknown[][] } };

    await expect(mintAuthToken(kv, USER1, null)).rejects.toThrow("KV down");

    expect(puts.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(new RegExp(`^${INDEX_PREFIX}[0-9a-f]{64}$`)),
    ]);
    expect(await kv.get(kvKeys.auth(USER1))).toBeNull();
    expect(await keysUnder(kvKeys.authToken(""))).toEqual([]);
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
  });

  it("deletes an evicted token's index after its token: key", async () => {
    const tokens = await mintListed(MAX_AUTH_TOKENS_PER_USER);
    const evicted = await hashOf(tokens[0]);
    const ops = watchKvOps(kv);

    await mintAuthToken(kv, USER1, await readAuthRecord(kv, USER1));

    const trail = ops.writeTrail();
    expect(trail.slice(0, 2)).toEqual([
      `delete ${kvKeys.authToken(evicted)}`,
      `delete ${indexKey(evicted)}`,
    ]);
    expect(await kv.get(indexKey(evicted))).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toHaveLength(
      MAX_AUTH_TOKENS_PER_USER,
    );
  });

  it("still returns the token when an evicted index delete throws, logging no identifier", async () => {
    const tokens = await mintListed(MAX_AUTH_TOKENS_PER_USER);
    const evicted = await hashOf(tokens[0]);
    const errors = silenceErrors();
    failWrites("delete", (key) => key.startsWith(INDEX_PREFIX));

    const issued = await mintAuthToken(
      kv,
      USER1,
      await readAuthRecord(kv, USER1),
    );

    expect(await tokenOwner(kv, issued.token)).toBe(USER1);
    expect(await kv.get(kvKeys.authToken(evicted))).toBeNull();
    // The leftover index is harmless: it names a key that is already gone.
    expect(await kv.get(indexKey(evicted))).toBe("1");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("AUTH_TOKEN_INDEX_DELETE_FAILED");
    noIdsLogged(errors.mock.calls[0], [evicted, await hashOf(issued)]);
  });
});

describe("revokeAuthTokenKeys — reaches the index", () => {
  it("deletes a listed token, an orphan only the index names, then the listed indexes", async () => {
    const { orphan, current } = await mintOrphan();
    const auth = await readAuthRecord(kv, USER1);
    const ops = watchKvOps(kv);

    await revokeAuthTokenKeys(kv, USER1, auth);

    expect(await tokenOwner(kv, orphan.token)).toBeNull();
    expect(await tokenOwner(kv, current.token)).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
    const trail = ops.writeTrail();
    expect([...trail].sort()).toEqual(
      [
        `list ${INDEX_PREFIX}`,
        `delete ${kvKeys.authToken(await hashOf(orphan))}`,
        `delete ${kvKeys.authToken(await hashOf(current))}`,
        `delete ${indexKey(await hashOf(orphan))}`,
        `delete ${indexKey(await hashOf(current))}`,
      ].sort(),
    );
    expectRevokeIndexOrder(trail, USER1);
    // Never touches auth: — a following mint is its only write.
    expect(await kv.get(kvKeys.auth(USER1))).not.toBeNull();
  });

  it("keeps every index when a token: delete throws, so a retry finds them all", async () => {
    const { orphan, current } = await mintOrphan();
    const auth = await readAuthRecord(kv, USER1);
    const indexes = await keysUnder(INDEX_PREFIX);
    expect(indexes).toHaveLength(2);
    const orphanKey = kvKeys.authToken(await hashOf(orphan));
    failWrites("delete", (key) => key === orphanKey);
    const deletes = kv.delete as unknown as { mock: { calls: unknown[][] } };

    await expect(revokeAuthTokenKeys(kv, USER1, auth)).rejects.toThrow(
      "KV down",
    );
    // Let the sibling deletes of the rejected Promise.all settle before reading.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await keysUnder(INDEX_PREFIX)).toEqual(indexes);
    const indexDeletes = deletes.mock.calls
      .map((c) => String(c[0]))
      .filter((k) => k.startsWith(INDEX_PREFIX));
    expect(indexDeletes).toEqual([]);
    expect(await tokenOwner(kv, orphan.token)).toBe(USER1);

    // The retry still finds the orphan, which only its kept index names.
    vi.restoreAllMocks();
    await revokeAuthTokenKeys(kv, USER1, auth);

    expect(await tokenOwner(kv, orphan.token)).toBeNull();
    expect(await tokenOwner(kv, current.token)).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
  });

  it("never turns a non-64-hex index tail into a token: delete", async () => {
    const [valid] = await mintListed(1);
    const validHash = await hashOf(valid);
    const strays = ["abc", "../x", "A".repeat(64), `${"a".repeat(64)}:x`, ""];
    for (const tail of strays) {
      await kv.put(kvKeys.authTokenIndex(USER1, tail), "1");
      await kv.put(kvKeys.authToken(tail), JSON.stringify({ userId: USER2 }));
    }
    // Another account's index under a different prefix is out of reach too.
    await kv.put(kvKeys.authTokenIndex(USER2, OTHER_HASH), "1");
    await kv.put(
      kvKeys.authToken(OTHER_HASH),
      JSON.stringify({ userId: USER2 }),
    );
    const ops = watchKvOps(kv);

    await revokeAuthTokenKeys(kv, USER1, null);

    const deleted = ops.deleteKeys();
    for (const tail of [...strays, OTHER_HASH]) {
      expect(deleted).not.toContain(kvKeys.authToken(tail));
      expect(await kv.get(kvKeys.authToken(tail))).not.toBeNull();
    }
    // Positive companion: the valid tail under the same prefix IS revoked.
    expect(deleted).toContain(kvKeys.authToken(validHash));
    expect(await tokenOwner(kv, valid.token)).toBeNull();
    expect(deleted).toContain(indexKey(validHash));
  });

  it("completes when an index delete throws, logging no identifier", async () => {
    const { orphan, current } = await mintOrphan();
    const errors = silenceErrors();
    failWrites("delete", (key) => key.startsWith(INDEX_PREFIX));

    await expect(
      revokeAuthTokenKeys(kv, USER1, await readAuthRecord(kv, USER1)),
    ).resolves.toBeUndefined();

    expect(await tokenOwner(kv, orphan.token)).toBeNull();
    expect(await tokenOwner(kv, current.token)).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("AUTH_TOKEN_INDEX_DELETE_FAILED");
    noIdsLogged(errors.mock.calls[0], [
      await hashOf(orphan),
      await hashOf(current),
    ]);
  });

  it("deletes the known set and no index when the list throws, logging no identifier", async () => {
    const { orphan, current } = await mintOrphan();
    const auth = await readAuthRecord(kv, USER1);
    const errors = silenceErrors();
    vi.spyOn(kv, "list").mockRejectedValue(new Error("KV down"));
    const ops = watchKvOps(kv);

    await expect(
      revokeAuthTokenKeys(kv, USER1, auth, [OTHER_HASH]),
    ).resolves.toBeUndefined();

    expect(await tokenOwner(kv, current.token)).toBeNull();
    expect(ops.deleteKeys()).toContain(kvKeys.authToken(OTHER_HASH));
    expect(ops.deleteKeys().filter((k) => k.startsWith(INDEX_PREFIX))).toEqual(
      [],
    );
    expect(await keysUnder(INDEX_PREFIX)).toHaveLength(2);
    // Accepted residual (R16): the orphan waits for the next revoke or its TTL.
    expect(await tokenOwner(kv, orphan.token)).toBe(USER1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("AUTH_TOKEN_INDEX_LIST_FAILED");
    noIdsLogged(errors.mock.calls[0], [
      await hashOf(orphan),
      await hashOf(current),
    ]);

    // Positive companion: with the list working again, the next revoke reaches the orphan.
    vi.restoreAllMocks();
    await revokeAuthTokenKeys(kv, USER1, auth);
    expect(await tokenOwner(kv, orphan.token)).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
  });

  it("treats a malformed list page like a list failure", async () => {
    const [listed] = await mintListed(1);
    const errors = silenceErrors();
    listAnswers({ keys: null, list_complete: true });

    await revokeAuthTokenKeys(kv, USER1, await readAuthRecord(kv, USER1));

    expect(await tokenOwner(kv, listed.token)).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toHaveLength(1);
    expect(errors.mock.calls.map((c) => c[0])).toEqual([
      "AUTH_TOKEN_INDEX_LIST_FAILED",
    ]);
  });

  it("revokes every indexed token across several list pages", async () => {
    const tokens = await mintListed(MAX_AUTH_TOKENS_PER_USER);
    // Drop the list so ONLY the index can reach them — the paging is what's under test.
    await kv.delete(kvKeys.auth(USER1));
    const list = pagedBy(2);

    await revokeAllAuthTokens(kv, USER1, null);

    expect(list).toHaveBeenCalledTimes(3);
    for (const token of tokens)
      expect(await tokenOwner(kv, token.token)).toBeNull();
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
  });
});

describe("listAuthTokenIndexHashes — paging guards", () => {
  it("returns every hash across pages, following each cursor once", async () => {
    const hashes = await seedIndexes(5);
    const list = pagedBy(2);

    expect(await listAuthTokenIndexHashes(kv, USER1)).toEqual(hashes);

    expect(list.mock.calls.map((c) => c[0])).toEqual([
      { prefix: INDEX_PREFIX, cursor: undefined },
      { prefix: INDEX_PREFIX, cursor: "2" },
      { prefix: INDEX_PREFIX, cursor: "4" },
    ]);
  });

  it("reads up to 10 pages", async () => {
    const hashes = await seedIndexes(10);
    pagedBy(1);

    expect(await listAuthTokenIndexHashes(kv, USER1)).toEqual(hashes);
  });

  it("throws past 10 pages", async () => {
    await seedIndexes(11);
    pagedBy(1);

    await expect(listAuthTokenIndexHashes(kv, USER1)).rejects.toThrow(
      "token index: too many pages",
    );
  });

  it.each([
    { label: "a missing cursor", page: { keys: [], list_complete: false } },
    {
      label: "an empty cursor",
      page: { keys: [], list_complete: false, cursor: "" },
    },
    {
      label: "a non-string cursor",
      page: { keys: [], list_complete: false, cursor: 2 },
    },
  ])("throws on an incomplete page with $label", async ({ page }) => {
    const list = listAnswers(page);

    await expect(listAuthTokenIndexHashes(kv, USER1)).rejects.toThrow(
      "token index: bad list cursor",
    );
    // On the first page — not only once the same bad cursor comes back.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("throws when a cursor repeats", async () => {
    const list = listAnswers({ keys: [], list_complete: false, cursor: "x" });

    await expect(listAuthTokenIndexHashes(kv, USER1)).rejects.toThrow(
      "token index: bad list cursor",
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "keys is not an array",
      page: { keys: null, list_complete: true },
    },
    {
      label: "list_complete is not a boolean",
      page: { keys: [], list_complete: "yes" },
    },
  ])("throws on a malformed page ($label)", async ({ page }) => {
    listAnswers(page);

    await expect(listAuthTokenIndexHashes(kv, USER1)).rejects.toThrow(
      "token index: malformed list page",
    );
  });

  it("skips entries without a string name or outside the prefix", async () => {
    const valid = "a".repeat(64);
    listAnswers({
      keys: [
        null,
        "tokenidx",
        { name: 5 },
        { name: kvKeys.authTokenIndex(USER2, OTHER_HASH) },
        { name: indexKey(valid) },
      ],
      list_complete: true,
    });

    expect(await listAuthTokenIndexHashes(kv, USER1)).toEqual([valid]);
  });
});

describe("revokeAuthTokenKeys — per-call index cap", () => {
  const TOKEN_PREFIX = kvKeys.authToken("");

  function tokenKeys(hashes: readonly string[]): string[] {
    return hashes.map((h) => kvKeys.authToken(h));
  }

  it("processes the 400 smallest indexes, logs the count only, and the next revoke takes the rest", async () => {
    const hashes = await seedIndexedTokens(MAX_REVOKE_INDEX_HASHES + 1);
    const first = hashes.slice(0, MAX_REVOKE_INDEX_HASHES);
    const rest = hashes.slice(MAX_REVOKE_INDEX_HASHES);
    const errors = silenceErrors();
    const ops = watchKvOps(kv);

    await revokeAuthTokenKeys(kv, USER1, null);

    const deleted = ops.deleteKeys();
    expect(deleted).toHaveLength(2 * MAX_REVOKE_INDEX_HASHES);
    expect(deleted.filter((k) => k.startsWith(TOKEN_PREFIX)).sort()).toEqual(
      tokenKeys(first),
    );
    expect(deleted.filter((k) => k.startsWith(INDEX_PREFIX)).sort()).toEqual(
      first.map(indexKey),
    );
    expect(await keysUnder(INDEX_PREFIX)).toEqual(rest.map(indexKey));
    expect(await keysUnder(TOKEN_PREFIX)).toEqual(tokenKeys(rest));
    expect(errors).toHaveBeenCalledTimes(1);
    const [event, payload] = errors.mock.calls[0];
    expect(event).toBe("AUTH_TOKEN_INDEX_CAPPED");
    expect(Object.keys(payload as object)).toEqual(["listed"]);
    expect(payload).toEqual({ listed: MAX_REVOKE_INDEX_HASHES });
    const text = JSON.stringify(errors.mock.calls);
    for (const id of [USER1, ...hashes]) expect(text).not.toContain(id);

    // Convergence: the leftover index is still there for the next revoke to find.
    vi.restoreAllMocks();
    const again = silenceErrors();
    await revokeAuthTokenKeys(kv, USER1, null);

    expect(again).not.toHaveBeenCalled();
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
    expect(await keysUnder(TOKEN_PREFIX)).toEqual([]);
  });

  it("revokes exactly 400 indexes in one call without logging (positive companion)", async () => {
    const hashes = await seedIndexedTokens(MAX_REVOKE_INDEX_HASHES);
    const errors = silenceErrors();
    const ops = watchKvOps(kv);

    await revokeAuthTokenKeys(kv, USER1, null);

    const deleted = ops.deleteKeys();
    expect(deleted).toHaveLength(2 * MAX_REVOKE_INDEX_HASHES);
    expect(deleted.filter((k) => k.startsWith(TOKEN_PREFIX)).sort()).toEqual(
      tokenKeys(hashes),
    );
    expect(await keysUnder(INDEX_PREFIX)).toEqual([]);
    expect(await keysUnder(TOKEN_PREFIX)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("listRevocableIndexHashes — stops at the cap", () => {
  it.each([
    { label: "mid-page", seeded: 500, limit: 150, calls: 3 },
    {
      label: "exactly at a page end with pages left",
      seeded: 450,
      limit: 100,
      calls: 4,
    },
  ])(
    "returns the first 400, capped, and fetches no further page ($label)",
    async ({ seeded, limit, calls }) => {
      const hashes = await seedIndexes(seeded);
      const list = pagedBy(limit);

      expect(await listRevocableIndexHashes(kv, USER1)).toEqual({
        hashes: hashes.slice(0, MAX_REVOKE_INDEX_HASHES),
        capped: true,
      });

      expect(list).toHaveBeenCalledTimes(calls);
      // More really remained: the last page fetched was not the final one.
      const last = (await list.mock.results[calls - 1].value) as {
        list_complete: boolean;
      };
      expect(last.list_complete).toBe(false);
    },
  );

  it.each([
    { label: "no index", count: 0, limit: 1000, calls: 1 },
    { label: "one index", count: 1, limit: 1000, calls: 1 },
    { label: "exactly 400 on one page", count: 400, limit: 1000, calls: 1 },
    { label: "exactly 400 across pages", count: 400, limit: 100, calls: 4 },
    { label: "399 across pages", count: 399, limit: 100, calls: 4 },
  ])(
    "returns every hash, not capped, once the list completes ($label)",
    async ({ count, limit, calls }) => {
      const hashes = await seedIndexes(count);
      const list = pagedBy(limit);

      expect(await listRevocableIndexHashes(kv, USER1)).toEqual({
        hashes,
        capped: false,
      });
      expect(list).toHaveBeenCalledTimes(calls);
    },
  );
});

describe("renewPresentedAuthToken — the index put comes first", () => {
  const TOKEN_A = "a".repeat(64);
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function seedSlidable(): Promise<string> {
    return seedAuthToken(kv, USER1, {
      token: TOKEN_A,
      createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    });
  }

  it("re-puts a slid token's index with the token's TTL, before its token: key", async () => {
    await seedSlidable();
    const hash = await hashOf(TOKEN_A);
    const ops = watchKvOps(kv);

    await renewPresentedAuthToken(kv, USER1, TOKEN_A);

    expect(ops.writeTrail()).toEqual([
      `put ${indexKey(hash)}`,
      `put ${kvKeys.authToken(hash)}`,
    ]);
    expect(getPutTtl(kv, indexKey(hash))).toBe(
      getPutTtl(kv, kvKeys.authToken(hash)),
    );
  });

  it("fails a slide without touching token: when its index put throws", async () => {
    await seedSlidable();
    const hash = await hashOf(TOKEN_A);
    const before = await kv.get(kvKeys.authToken(hash));
    failWrites("put", (key) => key.startsWith(INDEX_PREFIX));
    const puts = kv.put as unknown as { mock: { calls: unknown[][] } };

    await expect(renewPresentedAuthToken(kv, USER1, TOKEN_A)).rejects.toThrow(
      "KV down",
    );

    expect(puts.mock.calls.map((c) => String(c[0]))).toEqual([indexKey(hash)]);
    expect(await kv.get(kvKeys.authToken(hash))).toBe(before);
  });
});
