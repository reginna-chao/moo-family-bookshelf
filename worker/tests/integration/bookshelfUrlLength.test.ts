import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { generateAuthToken } from "../../src/middleware/auth";
import { USER1, USER2 } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { BOOK_URL_MAX_LENGTH } from "../../src/utils/validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * GET /api/family/:id/bookshelf — the read-side URL length ceiling (#321).
 *
 * `sanitizeCoverUrl` blanks a value longer than `BOOK_URL_MAX_LENGTH` before
 * the whitelist parse, and the aggregation runs every shared book through it,
 * so a dormant member's record holding an over-long cover (written before the
 * ceiling existed) reaches other members as `""`. The value is a whitelisted
 * Readmoo prefix padded to length, with an at-ceiling control on the same
 * member returned verbatim, so the blank can only come from the length check.
 * The family and both books records are seeded DIRECTLY to KV, mirroring
 * `bookshelfPrivacy.test.ts`; USER1 is the owner and the caller.
 */

const FAMILY_ID = "abcd-1234";
const COVER_PREFIX = "https://cdn.readmoo.com/cover/";

let kv: KVNamespace;

function urlOfLength(length: number): string {
  return COVER_PREFIX + "a".repeat(length - COVER_PREFIX.length);
}

function sharedBook(bookId: string, coverUrl: string): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl,
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

async function seedMember(userId: string, books: BookEntry[]): Promise<void> {
  await kv.put(kvKeys.member(userId), FAMILY_ID);
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: userId === USER1 ? "Owner" : "Member",
    books,
    lastUpdated: new Date().toISOString(),
  };
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

beforeEach(() => {
  kv = createMockKV();
});

describe("GET /api/family/:id/bookshelf — coverUrl length ceiling", () => {
  it("returns a member's stored over-long cover as an empty string and an at-ceiling cover verbatim", async () => {
    const atLimit = urlOfLength(BOOK_URL_MAX_LENGTH);
    await kv.put(
      kvKeys.family(FAMILY_ID),
      JSON.stringify({
        familyId: FAMILY_ID,
        ownerId: USER1,
        members: [
          { userId: USER1, displayName: "Owner", canLend: BoolFlag.TRUE },
          { userId: USER2, displayName: "Member", canLend: BoolFlag.TRUE },
        ],
        maxMembers: 2,
        createdAt: new Date().toISOString(),
      }),
    );
    await seedMember(USER1, []);
    await seedMember(USER2, [
      sharedBook("over", urlOfLength(BOOK_URL_MAX_LENGTH + 1)),
      sharedBook("at", atLimit),
    ]);
    const token = await generateAuthToken(kv, USER1);

    const res = await app.request(
      `/api/family/${FAMILY_ID}/bookshelf`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      { KV: kv, DEV_MODE: "1" },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    const member = json.data.members.find((m: Json) => m.userId === USER2);
    expect(member.books).toEqual([
      sharedBook("over", ""),
      sharedBook("at", atLimit),
    ]);
  });
});
