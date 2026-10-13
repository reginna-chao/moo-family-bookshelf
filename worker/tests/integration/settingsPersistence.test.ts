import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, BoolFlag, type UserBooksRecord } from "../../src/kv/schema";
import { OWNER1, OWNER2, USER1 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Invariant #5 — Settings Persistence (.claude/rules/security-ux-invariants.md)
 *
 * "Personal sharing preferences (user:{userId}) are tied to the user, NOT the
 *  family. Unbinding from a family MUST NOT delete or reset the user's sharing
 *  settings. Re-joining a different family MUST automatically reflect the user's
 *  existing sharing preferences."
 *
 * The leave handler (worker/src/routes/family.ts → removeMember) deliberately
 * deletes ONLY `member:{id}` + the auth token, never `user:{id}`. No prior test
 * asserted this, so a regression that added `KV.delete(kvKeys.user(id))` on leave
 * would pass every existing test. These tests fail loudly if that happens.
 *
 * Book ids: B1..B3 are real-shaped Readmoo bookIds (12+ digits), because PUT
 * /books drops any NEW bookId of another shape (`dropNewMalformedBookIds` in
 * `src/routes/user.ts`).
 *
 * Standard fixture (`seedUserInFamilyAWithBooks`): OWNER1 owns family A, USER1
 * joins it (non-owner, so leaving does not tear down the family), then USER1
 * saves the mixed book list. It returns the join token so the caller can leave
 * / read as USER1.
 *
 * newBookDefaultShared (#238): the per-user "newly synced books default to
 * shared" setting is a personal setting, so Inv-5 covers it. It lives in its
 * own key `newbookdefault:{id}`, written only by `PUT /new-book-default`; no
 * writer of `user:{id}` (PUT and PATCH /books, PUT /family-prefs, the
 * displayName PUT in `routes/family.ts`) may reset it or copy it into the
 * books record, and leave → join another family must not reset it. Each
 * writer case also asserts the write it made, so a request that never reached
 * the record cannot pass as "the setting survived".
 */

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Real-shaped (12+ digit) bookIds — PUT /books drops new short ones.
 *  See the header → "Book ids". */
const B1 = "210439468000101";
const B2 = "210439468000102";
const B3 = "210439468000103";

/** A mix of shared + not-shared books, so the assertions prove per-book flags survive. */
const USER1_BOOKS = {
  schemaVersion: 1,
  userId: USER1,
  displayName: "User1",
  books: [
    {
      bookId: B1,
      title: "Shared One",
      author: "",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.TRUE,
    },
    {
      bookId: B2,
      title: "Private Two",
      author: "",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.FALSE,
    },
    {
      bookId: B3,
      title: "Shared Three",
      author: "",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.TRUE,
    },
  ],
};

async function createFamily(ownerId: string) {
  const res = await request("POST", "/api/family", { userId: ownerId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    ownerToken: json.data.authToken as string,
  };
}

/** OWNER1's family A + USER1 (non-owner) with the mixed books; returns USER1's token.
 *  See the header → "Standard fixture". */
async function seedUserInFamilyAWithBooks() {
  const { familyId: familyA } = await createFamily(OWNER1);
  const joinRes = await request("POST", `/api/family/${familyA}/join`, {
    userId: USER1,
    displayName: "User1",
  });
  const tokenUser1A = ((await joinRes.json()) as Json).data.authToken as string;

  const putRes = await request(
    "PUT",
    `/api/user/${USER1}/books`,
    USER1_BOOKS,
    tokenUser1A,
  );
  expect(putRes.status).toBe(200);

  return { familyA, tokenUser1A };
}

/** Extract a single member's aggregated bookshelf entry by userId. */
function memberEntry(bookshelfJson: Json, userId: string) {
  return (bookshelfJson.data.members as Json[]).find(
    (m) => m.userId === userId,
  );
}

beforeEach(() => {
  kv = createMockKV();
});

describe("Invariant #5 — personal settings persist across unbind/rebind", () => {
  it("surfaces only the user's shared books in the family bookshelf while a member", async () => {
    const { familyA, tokenUser1A } = await seedUserInFamilyAWithBooks();

    const res = await request(
      "GET",
      `/api/family/${familyA}/bookshelf`,
      undefined,
      tokenUser1A,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    const user1 = memberEntry(json, USER1);
    expect(user1).toBeDefined();
    // Only b1 + b3 (isShared TRUE) are aggregated; the private b2 is withheld.
    expect((user1.books as Json[]).map((b) => b.bookId)).toEqual([B1, B3]);
    expect(
      (user1.books as Json[]).every((b) => b.isShared === BoolFlag.TRUE),
    ).toBe(true);
  });

  it("preserves user:{id} book list and per-book isShared flags after leaving a family", async () => {
    const { familyA, tokenUser1A } = await seedUserInFamilyAWithBooks();

    const before = (await kv.get(
      kvKeys.user(USER1),
      "json",
    )) as UserBooksRecord;

    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyA}/member/${USER1}`,
      undefined,
      tokenUser1A,
    );
    expect(leaveRes.status).toBe(200);

    // Unbind isolation (Inv-4): the reverse-lookup member key IS removed.
    expect(await kv.get(kvKeys.member(USER1))).toBeNull();

    // Settings persistence (Inv-5): the personal record is UNTOUCHED. If a
    // regression made leave delete user:{id}, this read returns null and fails.
    const after = (await kv.get(
      kvKeys.user(USER1),
      "json",
    )) as UserBooksRecord | null;
    expect(after).not.toBeNull();
    expect(after!.books).toHaveLength(3);
    expect(after!.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [B1, BoolFlag.TRUE],
      [B2, BoolFlag.FALSE],
      [B3, BoolFlag.TRUE],
    ]);
    // Nothing about the sharing prefs changed relative to before the leave.
    expect(after!.books).toEqual(before.books);
  });

  it("re-surfaces the user's previously-shared books in a DIFFERENT family after rejoin, with no re-save", async () => {
    const { familyA, tokenUser1A } = await seedUserInFamilyAWithBooks();

    // Leave family A.
    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyA}/member/${USER1}`,
      undefined,
      tokenUser1A,
    );
    expect(leaveRes.status).toBe(200);

    // Join a brand-new, unrelated family B (owned by someone else).
    const { familyId: familyB } = await createFamily(OWNER2);
    const joinRes = await request("POST", `/api/family/${familyB}/join`, {
      userId: USER1,
      displayName: "User1",
    });
    expect(joinRes.status).toBe(200);
    const tokenUser1B = ((await joinRes.json()) as Json).data
      .authToken as string;

    // The reverse lookup now points to family B.
    expect(await kv.get(kvKeys.member(USER1))).toBe(familyB);

    // Family B's bookshelf reflects USER1's EXISTING sharing prefs automatically —
    // b1 + b3 reappear even though the user never re-saved after rejoining.
    const res = await request(
      "GET",
      `/api/family/${familyB}/bookshelf`,
      undefined,
      tokenUser1B,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    const user1 = memberEntry(json, USER1);
    expect(user1).toBeDefined();
    expect((user1.books as Json[]).map((b) => b.bookId)).toEqual([B1, B3]);

    // The family-B owner shares nothing, so their entry is empty — confirms the
    // aggregation is per-user and USER1's prefs did not leak onto anyone else.
    const owner = memberEntry(json, OWNER2);
    expect(owner).toBeDefined();
    expect(owner.books).toEqual([]);
  });
});

// See the header → "newBookDefaultShared".
describe("Invariant #5 — newBookDefaultShared survives every other writer", () => {
  /** Standard fixture + the setting turned on through its only writer. */
  async function seedWithNewBookDefaultOn() {
    const seeded = await seedUserInFamilyAWithBooks();
    const res = await request(
      "PUT",
      `/api/user/${USER1}/new-book-default`,
      { newBookDefaultShared: BoolFlag.TRUE },
      seeded.tokenUser1A,
    );
    expect(res.status).toBe(200);
    return seeded;
  }

  async function storedRecord(): Promise<UserBooksRecord | null> {
    return (await kv.get(kvKeys.user(USER1), "json")) as UserBooksRecord | null;
  }

  async function storedSetting(): Promise<unknown> {
    return kv.get(kvKeys.newBookDefault(USER1), "json");
  }

  /** What the client reads back: GET /books merges the setting in. */
  async function readBack(token: string): Promise<Json> {
    const res = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as Json).data;
  }

  const ON = { newBookDefaultShared: BoolFlag.TRUE };

  it.each<{
    label: string;
    write: (familyA: string, token: string) => Response | Promise<Response>;
    /** Positive companion: proves the writer really rewrote `user:{id}`. */
    landed: (rec: UserBooksRecord) => void;
  }>([
    {
      label: "PUT /books (body carrying a stale 0)",
      write: (_familyA, token) =>
        request(
          "PUT",
          `/api/user/${USER1}/books`,
          {
            ...USER1_BOOKS,
            books: USER1_BOOKS.books.slice(0, 1),
            newBookDefaultShared: BoolFlag.FALSE,
          },
          token,
        ),
      landed: (rec) => expect(rec.books.map((b) => b.bookId)).toEqual([B1]),
    },
    {
      label: "PATCH /books",
      write: (_familyA, token) =>
        request(
          "PATCH",
          `/api/user/${USER1}/books`,
          { changes: [{ bookId: B2, isShared: BoolFlag.TRUE }] },
          token,
        ),
      landed: (rec) => expect(rec.books[1].isShared).toBe(BoolFlag.TRUE),
    },
    {
      label: "PUT /family-prefs",
      write: (_familyA, token) =>
        request(
          "PUT",
          `/api/user/${USER1}/family-prefs`,
          { hidden: [`${OWNER1}:${B1}`] },
          token,
        ),
      landed: (rec) =>
        expect(rec.familyShelfPrefs?.hidden).toEqual([`${OWNER1}:${B1}`]),
    },
    {
      label: "the displayName PUT",
      write: (familyA, token) =>
        request(
          "PUT",
          `/api/family/${familyA}/member/${USER1}/displayName`,
          { displayName: "Renamed" },
          token,
        ),
      landed: (rec) => expect(rec.displayName).toBe("Renamed"),
    },
  ])("keeps the setting at 1 through $label", async ({ write, landed }) => {
    const { familyA, tokenUser1A } = await seedWithNewBookDefaultOn();
    expect(await storedSetting()).toEqual(ON);

    const res = await write(familyA, tokenUser1A);
    expect(res.status).toBe(200);

    const after = await storedRecord();
    expect(after).not.toBeNull();
    landed(after!);
    expect(await storedSetting()).toEqual(ON);
    // The books record never carries a copy a later stale write could replay.
    expect("newBookDefaultShared" in after!).toBe(false);
    expect((await readBack(tokenUser1A)).newBookDefaultShared).toBe(
      BoolFlag.TRUE,
    );
  });

  it("keeps the setting through leave → join a DIFFERENT family, and GET /books still returns it", async () => {
    const { familyA, tokenUser1A } = await seedWithNewBookDefaultOn();

    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyA}/member/${USER1}`,
      undefined,
      tokenUser1A,
    );
    expect(leaveRes.status).toBe(200);
    expect(await storedSetting()).toEqual(ON);

    const { familyId: familyB } = await createFamily(OWNER2);
    const joinRes = await request("POST", `/api/family/${familyB}/join`, {
      userId: USER1,
      displayName: "User1",
    });
    expect(joinRes.status).toBe(200);
    const tokenUser1B = ((await joinRes.json()) as Json).data
      .authToken as string;

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      tokenUser1B,
    );
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as Json;
    expect(json.data.newBookDefaultShared).toBe(BoolFlag.TRUE);
    expect(json.data.books).toHaveLength(3);
  });
});
