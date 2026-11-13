import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import app from "../../src/index";
import { accountDeletionGuard } from "../../src/middleware/accountDeletionGuard";
import { authMiddleware } from "../../src/middleware/auth";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { authTokenKey, seedAuthToken, tokenOwner } from "../helpers/auth";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { ALICE, BOB } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type AccountDeletingMark,
  type BookEntry,
  type PublicShelf,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";
import type { Env } from "../../src/utils/env";

/**
 * `accountDeletionGuard` (#468): the post-handler check on authenticated writes.
 *
 * THE RULE. After the handler, an authenticated request other than GET / HEAD / OPTIONS
 * and `DELETE /api/user/:id` reads `token:deleting:{id}`. No mark: the response passes
 * untouched and the read is the whole cost. A mark and a token no newer than it: the
 * account is wiped and the answer becomes the 401 of an invalid token. A token NEWER
 * than the mark passes untouched, because that is a re-created account on a colo still
 * caching the mark; the mock has no such cache, so those cases seed the mark by hand.
 *
 * THE HONO PREMISE (acceptance 2). A handler that throws goes through `onError` before
 * control returns to the middleware above it, so `next()` returns normally and the
 * check still runs. Nothing else proves that, hence the two "writes then throws" rows,
 * each with a control showing the same failure answers 500 when no mark exists.
 *
 * BYTE-IDENTICAL, TWO WAYS. A no-mark response through the real routes cannot be
 * compared with a Worker without the guard, so `passThroughApp` mounts the two real
 * middlewares over a handler whose exact response is known. The 401 swap is compared
 * with the real answer to a dead token. A fresh request per case keeps the two apart.
 *
 * Marks are seeded directly in this file; a real deletion's mark is exercised in
 * `userDeleteConcurrentWrites.test.ts`. `DEV_MODE` is on (rate limits are not under
 * test) except in the one case that shows the same read under production bindings.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const OTHER = BOB;
const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const MARK_KEY = kvKeys.accountDeleting(USER);
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
const INVALID_TOKEN_BODY = {
  error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
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
    Origin: ORIGIN,
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

interface Owner {
  token: string;
  familyId: string;
  shelf: PublicShelf;
}

/** A real account: family, books, public shelf. */
async function seedOwner(): Promise<Owner> {
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

async function seedMark(
  overrides: Partial<AccountDeletingMark> = {},
): Promise<void> {
  const mark: AccountDeletingMark = {
    startedAt: Date.now(),
    shareTokens: [],
    ...overrides,
  };
  await kv.put(MARK_KEY, JSON.stringify(mark), { expirationTtl: 86400 });
}

async function expectWiped(owner: Owner): Promise<void> {
  for (const key of [
    kvKeys.user(USER),
    kvKeys.publicShelves(USER),
    kvKeys.publicShelf(owner.shelf.shareToken),
    kvKeys.member(USER),
    kvKeys.accountSettings(USER),
    kvKeys.auth(USER),
  ]) {
    expect(await kv.get(key), key).toBeNull();
  }
  expect(await tokenOwner(kv, owner.token)).toBeNull();
}

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A request every row can send: route, the status it answers with no mark, and the body. */
const WRITES: {
  label: string;
  status: number;
  send: (owner: Owner) => Promise<Response>;
}[] = [
  {
    label: "PUT /books",
    status: 200,
    send: ({ token }) =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
  },
  {
    label: "PATCH /books",
    status: 200,
    send: ({ token }) =>
      call("PATCH", `/api/user/${USER}/books`, token, {
        changes: [{ bookId: BOOK.bookId, isShared: BoolFlag.FALSE }],
      }),
  },
  {
    label: "PUT /family-prefs",
    status: 200,
    send: ({ token }) =>
      call("PUT", `/api/user/${USER}/family-prefs`, token, { hidden: [] }),
  },
  {
    label: "PUT /new-book-default",
    status: 200,
    send: ({ token }) =>
      call("PUT", `/api/user/${USER}/new-book-default`, token, {
        newBookDefaultShared: BoolFlag.TRUE,
      }),
  },
  {
    label: "PATCH /settings",
    status: 200,
    send: ({ token }) =>
      call("PATCH", `/api/user/${USER}/settings`, token, {
        settings: { syncArchived: BoolFlag.TRUE },
      }),
  },
  {
    label: "PUT a public shelf",
    status: 200,
    send: ({ token, shelf }) =>
      call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
        title: "Renamed",
      }),
  },
  {
    label: "POST /verify/prompted",
    status: 200,
    send: ({ token }) =>
      call("POST", `/api/user/${USER}/verify/prompted`, token),
  },
  {
    label: "POST /qr-token",
    status: 200,
    send: ({ token }) => call("POST", `/api/user/${USER}/qr-token`, token),
  },
  {
    label: "POST /auth/refresh",
    status: 200,
    send: ({ token }) =>
      call("POST", "/api/auth/refresh", token, { userId: USER }),
  },
  {
    label: "PUT displayName",
    status: 200,
    send: ({ token, familyId }) =>
      call("PUT", `/api/family/${familyId}/member/${USER}/displayName`, token, {
        displayName: "Renamed",
      }),
  },
  {
    label: "a handler's own 400",
    status: 400,
    send: ({ token }) =>
      call("PUT", `/api/user/${USER}/books`, token, { books: "not-an-array" }),
  },
  {
    label: "a handler's own 404",
    status: 404,
    send: ({ token }) =>
      call(
        "PUT",
        `/api/user/${USER}/public-shelf/22222222-2222-4222-8222-222222222222`,
        token,
        { title: "Nope" },
      ),
  },
];

describe("accountDeletionGuard with no mark", () => {
  it.each(WRITES)(
    "lets $label through for exactly one extra read and no delete",
    async ({ status, send }) => {
      const owner = await seedOwner();
      const ops = watchKvOps(kv);

      const res = await send(owner);

      expect(res.status).toBe(status);
      const reads = ops.getKeys();
      expect(reads.filter((key) => key === MARK_KEY)).toHaveLength(1);
      expect(reads[reads.length - 1]).toBe(MARK_KEY);
      expect(ops.deleteKeys()).toEqual([]);
      expect(await tokenOwner(kv, owner.token)).toBe(USER);
      expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    },
  );

  it("costs the same one read under production bindings, counted in the kv_ops line", async () => {
    const token = await seedAuthToken(kv, USER);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ops = watchKvOps(kv);

    const res = await app.request(
      `/api/user/${USER}/new-book-default`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.68",
        },
        body: JSON.stringify({ newBookDefaultShared: BoolFlag.TRUE }),
      },
      { KV: kv, ...rateLimitBindings() },
    );

    expect(res.status).toBe(200);
    expect(ops.getKeys()).toContain(MARK_KEY);
    const line = log.mock.calls
      .map(([entry]) => entry as Json)
      .find((entry) => entry?.event === "kv_ops");
    expect(line.reads).toBe(ops.getKeys().length);
  });

  it("leaves a known response byte-identical, headers included", async () => {
    const token = await seedAuthToken(kv, USER);
    const res = await passThroughApp().request(
      `/api/user/${USER}/anything`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
      { KV: kv },
    );

    expect(res.status).toBe(202);
    expect(res.headers.get("X-Handler")).toBe("yes");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("handler body");
  });
});

/** The two real middlewares over a handler with a known answer. See the header → "BYTE-IDENTICAL". */
function passThroughApp() {
  const mini = new Hono<{ Bindings: Env }>();
  mini.use("/api/*", authMiddleware);
  mini.use("/api/*", accountDeletionGuard);
  mini.put(
    "/api/user/:id/anything",
    () =>
      new Response("handler body", {
        status: 202,
        headers: { "Content-Type": "text/plain", "X-Handler": "yes" },
      }),
  );
  return mini;
}

describe("accountDeletionGuard with a mark", () => {
  it.each(WRITES)(
    "wipes after $label and answers the 401 of an invalid token",
    async ({ send }) => {
      const owner = await seedOwner();
      await seedMark({ shareTokens: [owner.shelf.shareToken] });

      const res = await send(owner);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
      await expectWiped(owner);
      expect(
        await kv.get(MARK_KEY),
        "only the caller may end it",
      ).not.toBeNull();
    },
  );

  it("answers byte-identically to a request with a dead token", async () => {
    const owner = await seedOwner();
    await seedMark();

    const swapped = await call("PUT", `/api/user/${USER}/books`, owner.token, {
      books: [BOOK],
    });
    const dead = await call("PUT", `/api/user/${USER}/books`, "e".repeat(64), {
      books: [BOOK],
    });

    expect(swapped.status).toBe(dead.status);
    expect(await swapped.text()).toBe(await dead.text());
    expect(swapped.headers.get("Content-Type")).toBe(
      dead.headers.get("Content-Type"),
    );
  });

  it("wipes the shelf a mark never named, through the current list", async () => {
    const owner = await seedOwner();
    await seedMark({ shareTokens: [] });

    const res = await call("PUT", `/api/user/${USER}/books`, owner.token, {
      books: [BOOK],
    });

    expect(res.status).toBe(401);
    expect(await kv.get(kvKeys.publicShelf(owner.shelf.shareToken))).toBeNull();
  });

  it("reaches a token only the request itself names, and leaves its deleted mark", async () => {
    const token = await seedAuthToken(kv, USER);
    await kv.delete(kvKeys.auth(USER));
    await seedMark();

    const res = await call("PUT", `/api/user/${USER}/new-book-default`, token, {
      newBookDefaultShared: BoolFlag.TRUE,
    });

    expect(res.status).toBe(401);
    expect(await tokenOwner(kv, token)).toBeNull();
    expect(
      await kv.get(kvKeys.accountDeleted(await hashAuthToken(token))),
    ).toBe(USER);
    expect(await kv.get(kvKeys.newBookDefault(USER))).toBeNull();
  });

  it("wipes only the caller's account when the write targets someone else", async () => {
    const owner = await seedOwner();
    const otherKey = kvKeys.user(OTHER);
    await kv.put(otherKey, JSON.stringify({ userId: OTHER, books: [BOOK] }));
    await seedMark();

    const res = await call("PUT", `/api/user/${OTHER}/books`, owner.token, {
      books: [],
    });

    expect(res.status).toBe(401);
    await expectWiped(owner);
    expect(await kv.get(otherKey)).not.toBeNull();
  });

  it("runs on a request refused by route validation too", async () => {
    const owner = await seedOwner();
    await seedMark();

    const res = await call(
      "DELETE",
      `/api/user/${USER.toUpperCase()}`,
      owner.token,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
    await expectWiped(owner);
  });
});

describe("accountDeletionGuard when the handler writes and then throws", () => {
  const THROWERS: {
    label: string;
    failedKey: (owner: Owner) => string;
    send: (owner: Owner) => Promise<Response>;
  }[] = [
    {
      label: "a public-shelf update whose snapshot put fails",
      failedKey: ({ shelf }) => kvKeys.publicShelf(shelf.shareToken),
      send: ({ token, shelf }) =>
        call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
          title: "Renamed",
        }),
    },
    {
      label: "PUT /books whose snapshot put fails",
      failedKey: ({ shelf }) => kvKeys.publicShelf(shelf.shareToken),
      send: ({ token }) =>
        call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
    },
  ];

  it.each(THROWERS)(
    "answers 500 with no mark ($label)",
    async ({ failedKey, send }) => {
      const owner = await seedOwner();
      failFirstWriteTo(kv, "put", failedKey(owner));

      const res = await send(owner);

      expect(res.status).toBe(500);
      expect(((await res.json()) as Json).error.code).toBe("INTERNAL_ERROR");
      expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    },
  );

  it.each(THROWERS)(
    "still wipes and answers 401 with a mark ($label)",
    async ({ failedKey, send }) => {
      const owner = await seedOwner();
      await seedMark({ shareTokens: [owner.shelf.shareToken] });
      failFirstWriteTo(kv, "put", failedKey(owner));

      const res = await send(owner);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
      await expectWiped(owner);
    },
  );
});

describe("accountDeletionGuard, what it skips", () => {
  it.each(["GET", "HEAD"])(
    "does not read the mark or wipe on %s",
    async (method) => {
      const owner = await seedOwner();
      await seedMark();
      const ops = watchKvOps(kv);

      const res = await call(method, `/api/user/${USER}/books`, owner.token);

      expect(res.status).toBe(200);
      expect(ops.getKeys()).not.toContain(MARK_KEY);
      expect(ops.deleteKeys()).toEqual([]);
      expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    },
  );

  it("leaves DELETE /api/user/:id to itself: its own mark read only, and its own answer", async () => {
    const owner = await seedOwner();
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await call("DELETE", `/api/user/${USER}`, owner.token);

    expect(await dataOf(res, 200)).toEqual({ ok: true });
    expect(ops.getKeys().filter((key) => key === MARK_KEY)).toHaveLength(1);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });

  it("does not run on a public route, even one carrying a bearer", async () => {
    const owner = await seedOwner();
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await call("POST", "/api/auth/lookup", owner.token, {
      userId: USER,
    });

    expect(res.status).toBe(200);
    expect(ops.getKeys()).not.toContain(MARK_KEY);
    expect(await tokenOwner(kv, owner.token)).toBe(USER);
  });

  it("does not run when the auth middleware refused the bearer", async () => {
    await seedMark();
    const ops = watchKvOps(kv);

    const res = await call("PUT", `/api/user/${USER}/books`, "e".repeat(64), {
      books: [BOOK],
    });

    expect(res.status).toBe(401);
    expect(ops.getKeys()).not.toContain(MARK_KEY);
    expect(ops.deleteKeys()).toEqual([]);
  });
});

describe("accountDeletionGuard, the response it swaps", () => {
  it("keeps the CORS and security headers of a normal response", async () => {
    const owner = await seedOwner();
    await seedMark();

    const res = await call("PUT", `/api/user/${USER}/books`, owner.token, {
      books: [BOOK],
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("still answers 401 with CORS when the wipe fails, logging the event name only", async () => {
    const owner = await seedOwner();
    await seedMark();
    failFirstWriteTo(kv, "delete", kvKeys.user(USER));

    const res = await call("PUT", `/api/user/${USER}/books`, owner.token, {
      books: [BOOK],
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID_TOKEN_BODY);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.member(USER))).toBeNull();
    expect(await kv.get(MARK_KEY)).not.toBeNull();
  });

  it("hands back the original response when the mark cannot be read, leaving the rest to the sweep", async () => {
    const owner = await seedOwner();
    await seedMark();
    const realGet = kv.get.bind(kv);
    vi.spyOn(kv, "get").mockImplementation(((key: string, ...rest: never[]) =>
      key === MARK_KEY
        ? Promise.reject(new Error("KV down"))
        : (realGet as (...args: unknown[]) => unknown)(key, ...rest)) as never);

    const res = await call(
      "PUT",
      `/api/user/${USER}/new-book-default`,
      owner.token,
      { newBookDefaultShared: BoolFlag.TRUE },
    );

    expect(res.status).toBe(200);
    expect(consoleError.mock.calls).toEqual([
      ["ACCOUNT_DELETION_GUARD_FAILED"],
    ]);
    expect(await tokenOwner(kv, owner.token)).toBe(USER);
  });
});

describe("accountDeletionGuard, a token newer than the mark", () => {
  const MARK_AT = Date.parse("2026-05-01T00:00:00.000Z");

  async function seedStaleMarkAccount(createdAt: string): Promise<string> {
    const token = await seedAuthToken(kv, USER, { createdAt });
    await kv.put(
      kvKeys.user(USER),
      JSON.stringify({ userId: USER, books: [] }),
    );
    await seedMark({ startedAt: MARK_AT });
    return token;
  }

  it("passes untouched: same response, nothing deleted, the mark kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MARK_AT + 5000);
    const token = await seedStaleMarkAccount(
      new Date(MARK_AT + 1000).toISOString(),
    );
    const ops = watchKvOps(kv);

    const res = await call("PUT", `/api/user/${USER}/new-book-default`, token, {
      newBookDefaultShared: BoolFlag.TRUE,
    });

    expect(await dataOf(res, 200)).toEqual({
      ok: true,
      newBookDefaultShared: BoolFlag.TRUE,
    });
    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.getKeys()).toEqual([await authTokenKey(token), MARK_KEY]);
    expect(await kv.get(MARK_KEY)).not.toBeNull();
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER);
  });

  it("judges by the token the request presented, even when a PIN save revoked it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MARK_AT + 5000);
    const token = await seedStaleMarkAccount(
      new Date(MARK_AT + 1000).toISOString(),
    );

    const res = await call("PUT", `/api/user/${USER}/verify`, token, {
      method: "pin",
      secret: "123456",
    });

    const data = await dataOf(res, 200);
    expect(typeof data.authToken).toBe("string");
    expect(await tokenOwner(kv, token)).toBeNull();
    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();
  });

  it.each([
    { label: "older than the mark", offset: -1000 },
    { label: "as old as the mark", offset: 0 },
  ])("wipes on a token $label", async ({ offset }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MARK_AT + 5000);
    const token = await seedStaleMarkAccount(
      new Date(MARK_AT + offset).toISOString(),
    );

    const res = await call("PUT", `/api/user/${USER}/new-book-default`, token, {
      newBookDefaultShared: BoolFlag.TRUE,
    });

    expect(res.status).toBe(401);
    expect(await tokenOwner(kv, token)).toBeNull();
    expect(await kv.get(kvKeys.user(USER))).toBeNull();
  });

  it("reads a token record with no createdAt as an old token", async () => {
    const token = await seedStaleMarkAccount(new Date(MARK_AT).toISOString());
    const key = await authTokenKey(token);
    await kv.put(key, JSON.stringify({ userId: USER, expiresAt: 0 }));

    const res = await call("PUT", `/api/user/${USER}/new-book-default`, token, {
      newBookDefaultShared: BoolFlag.TRUE,
    });

    expect(res.status).toBe(401);
    expect(await kv.get(key)).toBeNull();
  });
});
