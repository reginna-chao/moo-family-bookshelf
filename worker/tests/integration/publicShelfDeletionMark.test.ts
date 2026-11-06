import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, holdNextWrite, watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";

/**
 * Public shelves and a pending account deletion (#468).
 *
 * THE READ. `GET /api/public/:shareToken` reads `token:deleting:{ownerId}` right after
 * liveness: with a mark the link answers a 404 byte-identical to an unknown token, so
 * a link stops working before the sweep reaches it. The handler still writes nothing;
 * the mark's cost on a live hit is pinned with the other read trails in
 * `publicShelfCurrentSharing.test.ts`.
 *
 * THE CREATE ORDER. Create now writes the snapshot before the list, so a visible list
 * always finds its snapshot. A failed list put would otherwise leave a snapshot nothing
 * names, and a retry mints a new token, so the handler deletes it on the spot and
 * rethrows.
 *
 * THE LATE TOKEN. A shelf created after the route read `publicTokens` is caught by the
 * deletion's second read of the list. The mock always shows that read the new list; on
 * real KV it is best effort (docs/architecture.md → 已接受的殘餘風險), so the case proves
 * the code path and nothing about visibility.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const UNKNOWN_TOKEN = "f0".repeat(16);
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
const LEGACY_SHELF: PublicShelf = {
  shelfId: "11111111-1111-4111-8111-111111111111",
  shareToken: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  title: "Legacy shelf",
  expiresDays: null,
  createdAt: 1,
  expiresAt: null,
  selectionMode: "all-shared",
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

/** An owner with a synced book list and no public shelf yet. */
async function seedOwner(): Promise<string> {
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
  return family.authToken;
}

async function createShelf(token: string): Promise<PublicShelf> {
  const { shelf } = await dataOf(
    await call("POST", `/api/user/${USER}/public-shelf`, token, {
      title: "Shelf",
      expiresDays: null,
    }),
    201,
  );
  return shelf;
}

const OWNERS: {
  label: string;
  seedLink: () => Promise<string>;
}[] = [
  {
    label: "a migrated owner",
    seedLink: async () => (await createShelf(await seedOwner())).shareToken,
  },
  {
    label: "an un-migrated owner",
    seedLink: async () => {
      await seedOwner();
      const stored = (await kv.get(
        kvKeys.user(USER),
        "json",
      )) as UserBooksRecord;
      await kv.put(
        kvKeys.user(USER),
        JSON.stringify({
          ...stored,
          publicSharing: { shelves: [LEGACY_SHELF] },
        }),
      );
      await writePublicSnapshot(kv, USER, LEGACY_SHELF, [BOOK]);
      return LEGACY_SHELF.shareToken;
    },
  },
];

beforeEach(() => {
  kv = createMockKV();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(OWNERS)(
  "GET /api/public/:shareToken for $label",
  ({ seedLink }) => {
    it("answers exactly like an unknown token while the mark exists, writing nothing", async () => {
      const shareToken = await seedLink();
      const live = await call("GET", `/api/public/${shareToken}`);
      expect(live.status).toBe(200);
      await kv.put(MARK_KEY, JSON.stringify({ startedAt: 1, shareTokens: [] }));
      const ops = watchKvOps(kv);

      const hidden = await call("GET", `/api/public/${shareToken}`);

      const trail = ops.writeTrail();
      const unknown = await call("GET", `/api/public/${UNKNOWN_TOKEN}`);
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).toBe(await unknown.text());
      expect(hidden.headers.get("Content-Type")).toBe(
        unknown.headers.get("Content-Type"),
      );
      expect(trail).toEqual([]);
    });

    it("serves the link again once the mark is gone", async () => {
      const shareToken = await seedLink();
      await kv.put(MARK_KEY, JSON.stringify({ startedAt: 1, shareTokens: [] }));
      expect((await call("GET", `/api/public/${shareToken}`)).status).toBe(404);

      await kv.delete(MARK_KEY);

      expect((await call("GET", `/api/public/${shareToken}`)).status).toBe(200);
    });

    it("is not hidden by a mark on another account", async () => {
      const shareToken = await seedLink();
      await kv.put(
        kvKeys.accountDeleting(BOB),
        JSON.stringify({ startedAt: 1, shareTokens: [] }),
      );

      expect((await call("GET", `/api/public/${shareToken}`)).status).toBe(200);
    });
  },
);

describe("POST /api/user/:id/public-shelf, the write order", () => {
  it("writes the snapshot before the list", async () => {
    const token = await seedOwner();
    const ops = watchKvOps(kv);

    const shelf = await createShelf(token);

    const trail = ops.writeTrail();
    const snapshot = trail.indexOf(
      `put ${kvKeys.publicShelf(shelf.shareToken)}`,
    );
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(trail.indexOf(`put ${kvKeys.publicShelves(USER)}`)).toBeGreaterThan(
      snapshot,
    );
  });

  it("deletes the snapshot and rethrows when the list put fails, and a retry starts clean", async () => {
    const token = await seedOwner();
    failFirstWriteTo(kv, "put", kvKeys.publicShelves(USER));
    const ops = watchKvOps(kv);

    const first = await call("POST", `/api/user/${USER}/public-shelf`, token, {
      title: "Shelf",
      expiresDays: null,
    });

    expect(first.status).toBe(500);
    expect(((await first.json()) as Json).error.code).toBe("INTERNAL_ERROR");
    const written = ops
      .putKeys()
      .filter((key) => key.startsWith(kvKeys.publicShelf("")));
    expect(written).toHaveLength(1);
    expect(await kv.get(written[0])).toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect(consoleError.mock.calls.map(([event]) => event)).not.toContain(
      "PUBLIC_SHELF_SNAPSHOT_CLEANUP_FAILED",
    );

    const shelf = await createShelf(token);
    expect((await call("GET", `/api/public/${shelf.shareToken}`)).status).toBe(
      200,
    );
  });

  it("rethrows the list error when the cleanup fails too, logging the event name only", async () => {
    const token = await seedOwner();
    failFirstWriteTo(kv, "put", kvKeys.publicShelves(USER));
    vi.spyOn(kv, "delete").mockRejectedValueOnce(new Error("KV down"));

    const res = await call("POST", `/api/user/${USER}/public-shelf`, token, {
      title: "Shelf",
      expiresDays: null,
    });

    expect(res.status).toBe(500);
    expect(((await res.json()) as Json).error.code).toBe("INTERNAL_ERROR");
    const events = consoleError.mock.calls.map((args: unknown[]) => args[0]);
    expect(events).toContain("PUBLIC_SHELF_SNAPSHOT_CLEANUP_FAILED");
    const cleanup = consoleError.mock.calls.find(
      (args: unknown[]) => args[0] === "PUBLIC_SHELF_SNAPSHOT_CLEANUP_FAILED",
    );
    expect(cleanup).toEqual(["PUBLIC_SHELF_SNAPSHOT_CLEANUP_FAILED"]);
  });
});

describe("a shelf created after the deletion read its tokens", () => {
  /** Park the deletion at its mark, after it read `publicTokens`; `finish` lets it run to its answer. */
  async function deletionPausedAtItsMark(token: string) {
    const hold = holdNextWrite(kv, "put", MARK_KEY);
    const deletion = call("DELETE", `/api/user/${USER}`, token);
    await hold.reached;
    return {
      finish: async () => {
        hold.release();
        return deletion;
      },
    };
  }

  it("loses its snapshot and its list to the deletion's second read", async () => {
    const token = await seedOwner();
    const paused = await deletionPausedAtItsMark(token);

    const shelf = await createShelf(token);
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();

    expect(await dataOf(await paused.finish(), 200)).toEqual({ ok: true });

    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect((await call("GET", `/api/public/${shelf.shareToken}`)).status).toBe(
      404,
    );
  });

  it("answers 500 and keeps the list that names it when that snapshot's delete fails", async () => {
    const token = await seedOwner();
    const paused = await deletionPausedAtItsMark(token);
    const shelf = await createShelf(token);
    const snapshotKey = kvKeys.publicShelf(shelf.shareToken);
    failFirstWriteTo(kv, "delete", snapshotKey);

    const res = await paused.finish();

    expect(res.status).toBe(500);
    expect(await kv.get(snapshotKey)).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).not.toBeNull();
    expect(await kv.get(MARK_KEY)).not.toBeNull();
    expect((await call("GET", `/api/public/${shelf.shareToken}`)).status).toBe(
      404,
    );

    expect(
      await dataOf(await call("DELETE", `/api/user/${USER}`, token), 200),
    ).toEqual({ ok: true });
    expect(await kv.get(snapshotKey)).toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
  });
});
