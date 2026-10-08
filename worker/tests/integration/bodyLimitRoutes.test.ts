import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { USER1 } from "../helpers/ids";
import { BoolFlag, kvKeys, type UserBooksRecord } from "../../src/kv/schema";
import {
  DEFAULT_MAX_BODY_SIZE,
  PUT_BOOKS_MAX_BODY_SIZE,
} from "../../src/utils/bodyLimit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Issue #233: the request-body guard in `index.ts` used to be one global 256KB
 * limit, so a full personal-shelf upload (`PUT /api/user/:id/books`, which
 * carries the WHOLE book list) of a ~500+ book library was rejected with 413.
 * The guard is now per route (`utils/bodyLimit.ts`): 2MB for that PUT only,
 * 256KB for everything else.
 *
 * Both guard branches are driven: by default `app.request` with a string body
 * sends NO Content-Length header (undici's Request does not add one), so the
 * guard buffers the body; `withContentLength` sets the header explicitly to the
 * real byte length, which takes the header branch.
 *
 * Realistic book: `realisticBook` is shaped like what the Extension scrapes —
 * CJK title / author / category (3 bytes per char in UTF-8) and full-length
 * cover / book URLs on Readmoo domains, so the write-path whitelist KEEPS them
 * and the stored record is comparable to the input.
 *
 * PATCH companion: positive companion to the #233 regression — the size that
 * PUT now saves is still over the default limit, so a route that did NOT get
 * the 2MB limit (PATCH on the very same path) refuses it.
 */

let kv: KVNamespace;
let token: string;

const BOOKS_PATH = `/api/user/${USER1}/books`;
const PREFS_PATH = `/api/user/${USER1}/family-prefs`;

interface SendOptions {
  /** Set Content-Length to the body's real byte length (header branch). */
  withContentLength?: boolean;
  /** Override Content-Length with an arbitrary value. */
  contentLength?: number;
}

function send(method: string, path: string, body: string, opts?: SendOptions) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (opts?.contentLength !== undefined) {
    headers["Content-Length"] = String(opts.contentLength);
  } else if (opts?.withContentLength) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  // DEV_MODE: "1" bypasses the per-IP and per-user rate limits; the body guard
  // runs regardless of DEV_MODE.
  return app.request(
    path,
    { method, headers, body },
    { KV: kv, DEV_MODE: "1" },
  );
}

/** A scraped-shaped book (CJK text, whitelisted Readmoo URLs) the write path keeps.
 *  See the header → "Realistic book". */
function realisticBook(i: number) {
  const id = String(210000000000000 + i);
  return {
    bookId: id,
    title: `測試用的書名：一本相當長的長篇小說 第${i}集`,
    author: `作者姓名 著／譯者姓名 譯`,
    isbn: `978${String(9000000000 + i)}`,
    coverUrl: `https://cdn.readmoo.com/cover/ab/${id}_210x315.jpg?v=1700000000`,
    readmooUrl: `https://readmoo.com/book/${id}`,
    category: "文學小說",
    isShared: i % 3 === 0 ? BoolFlag.TRUE : BoolFlag.FALSE,
  };
}

function booksBody(count: number): string {
  return JSON.stringify({
    books: Array.from({ length: count }, (_v, i) => realisticBook(i)),
  });
}

/** Number of realistic books that serializes to clearly more than 256KB. */
const LARGE_SHELF_COUNT = 900;

async function storedRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
}

async function expect413(res: Response, message: string): Promise<void> {
  expect(res.status).toBe(413);
  const json = (await res.json()) as Json;
  expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  expect(json.error.message).toBe(message);
}

beforeEach(async () => {
  kv = createMockKV();
  token = await seedAuthToken(kv, USER1);
});

describe("PUT /api/user/:id/books — large shelf (#233)", () => {
  it.each([
    ["without Content-Length (buffered branch)", false],
    ["with Content-Length (header branch)", true],
  ])(
    "saves a shelf whose body exceeds 256KB %s",
    async (_label, withContentLength) => {
      const body = booksBody(LARGE_SHELF_COUNT);
      // Fixture guard: the body must stay above the OLD global limit, or this
      // test stops reproducing #233; and below the new limit, or it tests 413.
      expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_MAX_BODY_SIZE);
      expect(Buffer.byteLength(body)).toBeLessThan(PUT_BOOKS_MAX_BODY_SIZE);

      const res = await send("PUT", BOOKS_PATH, body, { withContentLength });

      expect(res.status).toBe(200);
      const record = await storedRecord();
      expect(record?.books).toHaveLength(LARGE_SHELF_COUNT);
      // The whitelist kept the realistic URLs (the fixture is not degenerate).
      expect(record?.books[0]).toMatchObject({
        bookId: realisticBook(0).bookId,
        coverUrl: realisticBook(0).coverUrl,
        readmooUrl: realisticBook(0).readmooUrl,
      });
      expect(record?.books[LARGE_SHELF_COUNT - 1].bookId).toBe(
        realisticBook(LARGE_SHELF_COUNT - 1).bookId,
      );
    },
  );

  it("rejects a books body over 2MB with 413 (buffered branch)", async () => {
    const body = booksBody(6000);
    expect(Buffer.byteLength(body)).toBeGreaterThan(PUT_BOOKS_MAX_BODY_SIZE);

    const res = await send("PUT", BOOKS_PATH, body);

    await expect413(res, "Request body exceeds 2MB limit");
    expect(await storedRecord()).toBeNull();
  });

  it("rejects a Content-Length over 2MB with 413 (header branch)", async () => {
    const res = await send("PUT", BOOKS_PATH, booksBody(1), {
      contentLength: PUT_BOOKS_MAX_BODY_SIZE + 1,
    });

    await expect413(res, "Request body exceeds 2MB limit");
    expect(await storedRecord()).toBeNull();
  });

  it("lets a Content-Length of exactly 2MB through the guard", async () => {
    const res = await send("PUT", BOOKS_PATH, booksBody(1), {
      contentLength: PUT_BOOKS_MAX_BODY_SIZE,
    });

    expect(res.status).toBe(200);
  });
});

describe("other /api routes keep the 256KB default", () => {
  /** A JSON body just over 256KB; content is irrelevant — the guard fires first. */
  function overDefaultBody(key: string): string {
    const filler = "x".repeat(DEFAULT_MAX_BODY_SIZE);
    const body = JSON.stringify({ [key]: [filler] });
    expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_MAX_BODY_SIZE);
    expect(Buffer.byteLength(body)).toBeLessThan(PUT_BOOKS_MAX_BODY_SIZE);
    return body;
  }

  it.each([
    ["PATCH books, buffered branch", "PATCH", BOOKS_PATH, "changes", false],
    ["PATCH books, header branch", "PATCH", BOOKS_PATH, "changes", true],
    ["PUT family-prefs, buffered branch", "PUT", PREFS_PATH, "hidden", false],
    ["PUT family-prefs, header branch", "PUT", PREFS_PATH, "hidden", true],
  ])(
    "rejects a >256KB body with the 256KB 413 (%s)",
    async (_label, method, path, key, withContentLength) => {
      const res = await send(method, path, overDefaultBody(key), {
        withContentLength,
      });

      await expect413(res, "Request body exceeds 256KB limit");
    },
  );

  it("rejects the same >256KB realistic shelf on PATCH that PUT accepts", async () => {
    // #233 positive companion: PATCH on the same path keeps the 256KB default.
    // See the header → "PATCH companion".
    const body = booksBody(LARGE_SHELF_COUNT);

    const res = await send("PATCH", BOOKS_PATH, body);

    await expect413(res, "Request body exceeds 256KB limit");
  });
});
