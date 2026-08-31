import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  BoolFlag,
  kvKeys,
  MAX_FAMILY_PREF_ENTRIES,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";
import { parseBooks, MAX_PUT_BOOKS } from "../../src/routes/user";
import { USER1 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * A coverUrl the Readmoo whitelist accepts (`isAllowedCoverUrl` in
 * `shared/src/config/readmoo.ts`). Fixtures that are NOT about cover
 * sanitization must use a whitelisted value, otherwise the write path blanks it
 * and the assertion silently ends up about the wrong thing.
 */
const ALLOWED_COVER = "https://cdn.readmoo.com/cover/abc.jpg";

/**
 * An attacker-controlled cover host. Rendered by every family member and every
 * public-shelf visitor, so storing it would turn a book cover into a tracking
 * beacon — the P0 this suite guards.
 */
const BEACON_COVER = "https://evil.example.com/beacon.gif";
const BEACON_HOST = "evil.example.com";

/**
 * A readmooUrl the Readmoo whitelist accepts (`isAllowedBookUrl` in
 * `shared/src/config/readmoo.ts`) — the apex `/book/{id}` shape the scraper
 * emits. Same rule as ALLOWED_COVER above: a fixture that is NOT about
 * book-link sanitization must carry a whitelisted value, otherwise the write
 * path blanks it and the assertion silently ends up about the wrong thing.
 */
const ALLOWED_BOOK_URL = "https://readmoo.com/book/210123456";

/**
 * An attacker-controlled book link, on a host distinct from BEACON_HOST so the
 * two URL fields can never pass each other's "leaks nowhere" assertion. The
 * Extension and the PWA render `readmooUrl` as a clickable `<a href>`, so
 * storing it would serve a phishing / arbitrary-redirect lure under a
 * legitimate book title — the twin P0 of the beacon cover above.
 */
const PHISHING_HOST = "phish.example.com";
const PHISHING_BOOK_URL = `https://${PHISHING_HOST}/login`;

/**
 * A base-sensitive book link: an https scheme with no `//`.
 *
 * Standalone it parses to host `readmoo.com` — which is why a whitelist that
 * only inspects the string in isolation used to accept it — but a browser
 * resolves an `href` against the base of the RENDERING document, and against a
 * same-scheme base WHATWG switches to "relative" state, so the host becomes the
 * VIEWER's own origin. Rendered by the PWA that is a click through to its own
 * `/public/x#invite=…`, a route that unconditionally clears the stored session
 * (`apiHost` included) and pre-fills the attacker's sync code.
 *
 * The `#invite=` marker is what makes the "never reached KV" assertion below
 * specific: it appears nowhere else in a stored record.
 */
const BASE_SENSITIVE_BOOK_URL = "https:readmoo.com/../../public/x#invite=moo-x";

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
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Build a valid `{ownerId}:{bookId}` family-pref ref for USER1. */
function ref(bookId: string): string {
  return `${USER1}:${bookId}`;
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// BE-1 (unit): parseBooks pure-function validation + normalization
// ===========================================================================

describe("parseBooks", () => {
  it("rebuilds each entry from a fixed allowlist, dropping unknown fields", () => {
    const result = parseBooks(
      [
        {
          bookId: "b1",
          title: "T",
          author: "A",
          isbn: "I",
          // Whitelisted on purpose — an off-whitelist cover is blanked (see the
          // sanitize table below), which would make this a test about blanking
          // rather than about the field allowlist.
          coverUrl: ALLOWED_COVER,
          // Whitelisted for the same reason as the cover beside it — an
          // off-whitelist book link is blanked too (see the readmooUrl
          // sanitize table below).
          readmooUrl: ALLOWED_BOOK_URL,
          category: "cat",
          isShared: BoolFlag.TRUE,
          // unknown fields that must NOT be carried through:
          evil: "payload",
          isAdmin: true,
          __proto__: { polluted: true },
        },
      ],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [book] = result.books;
    expect(book).toEqual({
      bookId: "b1",
      title: "T",
      author: "A",
      isbn: "I",
      coverUrl: ALLOWED_COVER,
      readmooUrl: ALLOWED_BOOK_URL,
      category: "cat",
      isShared: BoolFlag.TRUE,
    });
    expect("evil" in book).toBe(false);
    expect("isAdmin" in book).toBe(false);
  });

  it.each([
    ["missing bookId", { title: "x" }],
    ["empty-string bookId", { bookId: "" }],
    ["non-string bookId", { bookId: 123 }],
    ["null entry", null],
    ["array entry", ["b1"]],
    ["primitive entry", "b1"],
  ])("rejects the whole payload when an entry is %s", (_desc, entry) => {
    const result = parseBooks([entry], MAX_PUT_BOOKS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PAYLOAD");
  });

  it.each([
    [true, BoolFlag.FALSE],
    [false, BoolFlag.FALSE],
    ["1", BoolFlag.FALSE],
    ["yes", BoolFlag.FALSE],
    [2, BoolFlag.FALSE],
    [BoolFlag.TRUE, BoolFlag.TRUE],
    [BoolFlag.FALSE, BoolFlag.FALSE],
  ])("coerces garbage isShared %s to a BoolFlag", (raw, expected) => {
    const result = parseBooks([{ bookId: "b1", isShared: raw }], MAX_PUT_BOOKS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books[0].isShared).toBe(expected);
  });

  it("only emits isArchived when the field is present", () => {
    const withArchive = parseBooks(
      [{ bookId: "b1", isArchived: BoolFlag.TRUE }],
      MAX_PUT_BOOKS,
    );
    const withoutArchive = parseBooks([{ bookId: "b2" }], MAX_PUT_BOOKS);
    expect(withArchive.ok && withArchive.books[0].isArchived).toBe(
      BoolFlag.TRUE,
    );
    expect(withoutArchive.ok && "isArchived" in withoutArchive.books[0]).toBe(
      false,
    );
  });

  it("rejects a books array longer than the cap", () => {
    const many = Array.from({ length: 3 }, (_v, i) => ({ bookId: `b${i}` }));
    const result = parseBooks(many, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PAYLOAD");
    expect(result.message).toContain("2");
  });
});

// ===========================================================================
// coverUrl whitelist sanitize (P0 privacy): a book cover is loaded by every
// family member and every public-shelf visitor, so an attacker-chosen cover
// host is a tracking beacon. The write paths keep only "" (the scraper's
// no-cover placeholder) and Readmoo-hosted https URLs; everything else is
// blanked. Blanking, never rejecting — one crafted entry must not fail a sync.
// ===========================================================================

describe("parseBooks — coverUrl whitelist sanitize", () => {
  function storedCoverUrl(rawCover: unknown): string {
    const result = parseBooks(
      [{ bookId: "b1", coverUrl: rawCover }],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("payload was rejected, not sanitized");
    return result.books[0].coverUrl;
  }

  // Values that reach KV byte-identical. A kept URL is stored verbatim (the
  // parser is only consulted for the verdict), so `:443` and an uppercase host
  // survive in their original spelling.
  it.each<{ label: string; input: string }>([
    {
      label: "an apex readmoo.com https URL",
      input: "https://readmoo.com/x.jpg",
    },
    {
      label: "a cdn.readmoo.com subdomain URL",
      input: "https://cdn.readmoo.com/x.jpg",
    },
    {
      label: "a cdn.readmoo.tw subdomain URL (second cover domain)",
      input: "https://cdn.readmoo.tw/x.jpg",
    },
    {
      label: "a deeper subdomain of a cover domain",
      input: "https://img.cdn.readmoo.com/x.jpg",
    },
    {
      label: "an explicit :443, which the URL parser normalises away",
      input: "https://cdn.readmoo.com:443/x.jpg",
    },
    {
      label: "an uppercase scheme and host, which the URL parser lowercases",
      input: "HTTPS://CDN.READMOO.COM/x.jpg",
    },
    { label: "the empty-string scraper placeholder", input: "" },
  ])("keeps $label unchanged", ({ input }) => {
    expect(storedCoverUrl(input)).toBe(input);
  });

  // Everything else is replaced by "", which renders as the normal no-cover
  // state. Each row is a way an off-whitelist host could otherwise sneak past.
  it.each<{ label: string; input: unknown }>([
    {
      label: "a plain-http URL on an allowed host",
      input: "http://cdn.readmoo.com/x.jpg",
    },
    {
      label: "an allowed host on a non-default port",
      input: "https://cdn.readmoo.com:8443/x.jpg",
    },
    {
      label: "a look-alike registrable domain",
      input: "https://evilreadmoo.com/x.jpg",
    },
    {
      label: "a cover domain used as a leading label of another domain",
      input: "https://readmoo.com.evil.com/x.jpg",
    },
    {
      label: "a cover domain smuggled into the userinfo segment",
      input: "https://cdn.readmoo.com@evil.example.com/x.jpg",
    },
    { label: "an outright foreign host", input: BEACON_COVER },
    { label: "an unparseable string", input: "not a url" },
    {
      label: "a protocol-relative URL",
      input: "//cdn.readmoo.com/x.jpg",
    },
    { label: "a javascript: URL", input: "javascript:alert(1)" },
    {
      label: "a data: URL",
      input: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    },
    { label: "a number", input: 123 },
    { label: "null", input: null },
    {
      label: "an object wrapping a whitelisted URL",
      input: { href: "https://cdn.readmoo.com/x.jpg" },
    },
    {
      label: "an array wrapping a whitelisted URL",
      input: ["https://cdn.readmoo.com/x.jpg"],
    },
  ])("blanks $label", ({ input }) => {
    expect(storedCoverUrl(input)).toBe("");
  });

  it("blanks a missing coverUrl field to the empty string", () => {
    const result = parseBooks([{ bookId: "b1" }], MAX_PUT_BOOKS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books[0].coverUrl).toBe("");
  });

  it("sanitizes every entry in the payload, not only the first", () => {
    const result = parseBooks(
      [
        { bookId: "b1", coverUrl: ALLOWED_COVER },
        { bookId: "b2", coverUrl: BEACON_COVER },
        { bookId: "b3", coverUrl: "https://evilreadmoo.com/x.jpg" },
      ],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books.map((b) => b.coverUrl)).toEqual([
      ALLOWED_COVER,
      "",
      "",
    ]);
  });

  it("keeps the rest of an entry intact while blanking its coverUrl", () => {
    const result = parseBooks(
      [
        {
          bookId: "b1",
          title: "T",
          author: "A",
          isbn: "I",
          coverUrl: BEACON_COVER,
          readmooUrl: "https://readmoo.com/book/b1",
          category: "cat",
          isShared: BoolFlag.TRUE,
        },
      ],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books[0]).toEqual({
      bookId: "b1",
      title: "T",
      author: "A",
      isbn: "I",
      coverUrl: "",
      readmooUrl: "https://readmoo.com/book/b1",
      category: "cat",
      isShared: BoolFlag.TRUE,
    });
  });
});

// ===========================================================================
// readmooUrl whitelist sanitize (P0 privacy): the other attacker-controlled URL
// field of a book. It is rendered as a clickable `<a href>` by the Extension
// and the PWA, so an off-whitelist value is a phishing / arbitrary-redirect
// lure served under a legitimate book title, and the destination host learns
// the clicking viewer's IP and User-Agent. Not the referer: both clients render
// the link with `rel="noopener noreferrer"`, and `noreferrer` suppresses the
// Referer header outright — a client-side attribute this server-side check must
// not lean on, but one whose removal would widen the exposure. Same verdict
// rule and same blank-never-reject policy as the cover above; the difference is
// only that it needs a user click to fire, which lowers the rate but not the
// severity.
//
// WIRING level only. The keep/blank matrix for the shared helper is pinned once
// in `tests/unit/validation.test.ts` → `sanitizeReadmooUrl`; what these cases
// add is that `parseBooks` actually CALLS it — on every entry, on the
// missing-field shape, and without disturbing the rest of the entry.
// ===========================================================================

describe("parseBooks — readmooUrl whitelist sanitize", () => {
  function storedReadmooUrl(rawUrl: unknown): string {
    const result = parseBooks(
      [{ bookId: "b1", readmooUrl: rawUrl }],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("payload was rejected, not sanitized");
    return result.books[0].readmooUrl;
  }

  it.each<{ label: string; input: string }>([
    { label: "a whitelisted Readmoo book link", input: ALLOWED_BOOK_URL },
    { label: "the empty-string scraper placeholder", input: "" },
  ])("keeps $label unchanged", ({ input }) => {
    expect(storedReadmooUrl(input)).toBe(input);
  });

  it.each<{ label: string; input: unknown }>([
    { label: "an off-whitelist host", input: PHISHING_BOOK_URL },
    { label: "a javascript: URL", input: "javascript:alert(1)" },
    { label: "a non-string value", input: 123 },
  ])("blanks $label", ({ input }) => {
    expect(storedReadmooUrl(input)).toBe("");
  });

  it("blanks a missing readmooUrl field to the empty string", () => {
    const result = parseBooks([{ bookId: "b1" }], MAX_PUT_BOOKS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books[0].readmooUrl).toBe("");
  });

  it("sanitizes every entry in the payload, not only the first", () => {
    const result = parseBooks(
      [
        { bookId: "b1", readmooUrl: ALLOWED_BOOK_URL },
        { bookId: "b2", readmooUrl: PHISHING_BOOK_URL },
        { bookId: "b3", readmooUrl: "https://evilreadmoo.com/book/1" },
      ],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books.map((b) => b.readmooUrl)).toEqual([
      ALLOWED_BOOK_URL,
      "",
      "",
    ]);
  });

  it("keeps the rest of an entry intact while blanking its readmooUrl", () => {
    const result = parseBooks(
      [
        {
          bookId: "b1",
          title: "T",
          author: "A",
          isbn: "I",
          coverUrl: ALLOWED_COVER,
          readmooUrl: PHISHING_BOOK_URL,
          category: "cat",
          isShared: BoolFlag.TRUE,
        },
      ],
      MAX_PUT_BOOKS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The two URL fields are sanitized independently: a blanked book link must
    // not take the whitelisted cover beside it down with it.
    expect(result.books[0]).toEqual({
      bookId: "b1",
      title: "T",
      author: "A",
      isbn: "I",
      coverUrl: ALLOWED_COVER,
      readmooUrl: "",
      category: "cat",
      isShared: BoolFlag.TRUE,
    });
  });
});

// ===========================================================================
// BE-1 (integration): PUT /api/user/:id/books allowlist + prefs routing
// ===========================================================================

describe("PUT /api/user/:id/books — allowlist & familyShelfPrefs", () => {
  async function auth(userId = USER1): Promise<string> {
    return generateAuthToken(kv, userId);
  }

  it("does NOT persist unknown top-level body fields (round-trip GET is clean)", async () => {
    const token = await auth();
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        books: [{ bookId: "b1", title: "Book 1", isShared: BoolFlag.TRUE }],
        // junk top-level fields that must never reach KV:
        isAdmin: true,
        publicSharing: { shelves: [{ shareToken: "hax" }] },
        arbitrary: "nope",
      },
      token,
    );
    expect(res.status).toBe(200);

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored).not.toBeNull();
    const rec = stored as unknown as Record<string, unknown>;
    expect("isAdmin" in rec).toBe(false);
    expect("arbitrary" in rec).toBe(false);
    // publicSharing is an allowlisted field but is taken from the EXISTING record,
    // never from the client body — so a fresh record has it undefined, not the junk.
    expect(rec.publicSharing).toBeUndefined();
  });

  it("does NOT persist unknown fields inside a book entry", async () => {
    const token = await auth();
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        books: [
          {
            bookId: "b1",
            title: "T",
            isShared: BoolFlag.FALSE,
            secret: "leak",
            isShared2: 1,
          },
        ],
      },
      token,
    );
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token,
    );
    const json = (await getRes.json()) as Json;
    const book = json.data.books[0];
    expect("secret" in book).toBe(false);
    expect("isShared2" in book).toBe(false);
    expect(book.bookId).toBe("b1");
  });

  it("returns 400 INVALID_PAYLOAD when a book entry is missing bookId", async () => {
    const token = await auth();
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: [{ title: "No id here" }] },
      token,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("ignores body.userId — the authenticated path id always wins", async () => {
    const token = await auth();
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        userId: "0".repeat(64),
        books: [{ bookId: "b1", isShared: BoolFlag.TRUE }],
      },
      token,
    );
    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.userId).toBe(USER1);
    // The spoofed id must not have its own record created.
    expect(await kv.get(kvKeys.user("0".repeat(64)))).toBeNull();
  });

  it("round-trips a valid familyShelfPrefs {hidden,favorites} intact", async () => {
    const token = await auth();
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        books: [{ bookId: "b1", isShared: BoolFlag.TRUE }],
        familyShelfPrefs: { hidden: [ref("b1")], favorites: [ref("b2")] },
      },
      token,
    );
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token,
    );
    const json = (await getRes.json()) as Json;
    expect(json.data.familyShelfPrefs).toEqual({
      hidden: [ref("b1")],
      favorites: [ref("b2")],
    });
  });

  it("returns 400 INVALID_PAYLOAD when familyShelfPrefs exceeds the cap (same as /family-prefs)", async () => {
    const token = await auth();
    const tooMany = Array.from(
      { length: MAX_FAMILY_PREF_ENTRIES + 1 },
      (_v, i) => ref(`b${i}`),
    );
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: [], familyShelfPrefs: { hidden: tooMany } },
      token,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 400 for an empty familyShelfPrefs object (no kind present)", async () => {
    const token = await auth();
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: [], familyShelfPrefs: {} },
      token,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("preserves the existing familyShelfPrefs when the field is absent from the body", async () => {
    const token = await auth();
    // First save WITH prefs
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        books: [{ bookId: "b1", isShared: BoolFlag.TRUE }],
        familyShelfPrefs: { hidden: [ref("b1")] },
      },
      token,
    );
    // Second save WITHOUT prefs — existing value must survive
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: [{ bookId: "b1", isShared: BoolFlag.FALSE }] },
      token,
    );
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token,
    );
    const json = (await getRes.json()) as Json;
    expect(json.data.familyShelfPrefs.hidden).toEqual([ref("b1")]);
  });

  // NOTE: MAX_PUT_BOOKS + 1 minimal book entries serialize to > 256KB, so the
  // request is rejected by the body-size guard (413) BEFORE reaching the
  // handler's book-count check. The 400 INVALID_PAYLOAD cap branch itself is
  // exercised at the pure-function level in the `parseBooks` describe above.
  // This test documents that over-cap payloads are rejected end-to-end.
  it("rejects an over-MAX_PUT_BOOKS payload end-to-end (body-size guard fires first)", async () => {
    const token = await auth();
    const books = Array.from({ length: MAX_PUT_BOOKS + 1 }, (_v, i) => ({
      bookId: `b${i}`,
      isShared: BoolFlag.FALSE,
    }));
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books },
      token,
    );
    // Either the size guard (413) or the count cap (400) must reject it — never a 200.
    expect([400, 413]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

// ===========================================================================
// PUT /api/user/:id/books — coverUrl sanitize over the real HTTP path
// ===========================================================================

describe("PUT /api/user/:id/books — coverUrl sanitize", () => {
  /** Off-whitelist, whitelisted, and the empty placeholder, in one save. */
  const MIXED_BOOKS = [
    { bookId: "b1", title: "Beacon", coverUrl: BEACON_COVER },
    { bookId: "b2", title: "Clean", coverUrl: ALLOWED_COVER },
    { bookId: "b3", title: "No cover", coverUrl: "" },
  ];
  const EXPECTED_COVERS = ["", ALLOWED_COVER, ""];

  async function putMixedBooks(): Promise<Response> {
    const token = await generateAuthToken(kv, USER1);
    return request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: MIXED_BOOKS },
      token,
    );
  }

  it("accepts the save and keeps every book instead of rejecting the payload", async () => {
    const res = await putMixedBooks();

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books.map((b: Json) => b.bookId)).toEqual([
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("returns the off-whitelist cover blanked and the whitelisted one intact", async () => {
    const res = await putMixedBooks();

    const json = (await res.json()) as Json;
    expect(json.data.books.map((b: Json) => b.coverUrl)).toEqual(
      EXPECTED_COVERS,
    );
  });

  it("never lets the off-whitelist host reach the stored user record", async () => {
    await putMixedBooks();

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.books.map((b) => b.coverUrl)).toEqual(EXPECTED_COVERS);
    // Nothing anywhere in the record — not in a stray field, not in a title.
    expect(JSON.stringify(stored)).not.toContain(BEACON_HOST);
  });

  it("keeps the other fields of a blanked book unchanged", async () => {
    await putMixedBooks();

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    const beaconBook = stored?.books.find((b) => b.bookId === "b1");
    expect(beaconBook?.title).toBe("Beacon");
    expect(beaconBook?.isShared).toBe(BoolFlag.FALSE);
  });
});

// ===========================================================================
// PUT /api/user/:id/books — readmooUrl sanitize over the real HTTP path
//
// The write boundary for the book link. Sanitizing at the handler is what stops
// a family member who bypasses the UI from PUTting a hostile link and having it
// presented to relatives — and to anonymous public-shelf visitors — under a
// legitimate book title.
// ===========================================================================

describe("PUT /api/user/:id/books — readmooUrl sanitize", () => {
  /** Off-whitelist, whitelisted, and the empty placeholder, in one save. */
  const MIXED_BOOKS = [
    { bookId: "b1", title: "Phish", readmooUrl: PHISHING_BOOK_URL },
    { bookId: "b2", title: "Clean", readmooUrl: ALLOWED_BOOK_URL },
    { bookId: "b3", title: "No link", readmooUrl: "" },
  ];
  const EXPECTED_LINKS = ["", ALLOWED_BOOK_URL, ""];

  async function putMixedBooks(): Promise<Response> {
    const token = await generateAuthToken(kv, USER1);
    return request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: MIXED_BOOKS },
      token,
    );
  }

  it("accepts the save and keeps every book instead of rejecting the payload", async () => {
    const res = await putMixedBooks();

    // Sanitize, never reject: one crafted link must not fail the whole sync,
    // and no new error code is introduced for it.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books.map((b: Json) => b.bookId)).toEqual([
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("returns the off-whitelist book link blanked and the whitelisted one intact", async () => {
    const res = await putMixedBooks();

    const json = (await res.json()) as Json;
    expect(json.data.books.map((b: Json) => b.readmooUrl)).toEqual(
      EXPECTED_LINKS,
    );
  });

  it("never lets the off-whitelist host reach the stored user record", async () => {
    await putMixedBooks();

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.books.map((b) => b.readmooUrl)).toEqual(EXPECTED_LINKS);
    // Nothing anywhere in the record — not in a stray field, not in a title.
    expect(JSON.stringify(stored)).not.toContain(PHISHING_HOST);
  });

  it("keeps the other fields of a blanked book unchanged", async () => {
    await putMixedBooks();

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    const phishBook = stored?.books.find((b) => b.bookId === "b1");
    expect(phishBook?.title).toBe("Phish");
    expect(phishBook?.isShared).toBe(BoolFlag.FALSE);
  });

  // The end-to-end half of the base-sensitivity fix: an off-HOST link was
  // already refused, but a link whose host only changes once a browser resolves
  // it against the rendering document used to sail through every check and land
  // in `user:{id}` verbatim — from where the aggregation, the public snapshot
  // and every client render would faithfully serve it back. This is the case
  // that pins "the attacker cannot plant that string in KV in the first place".
  // The keep/blank verdict itself is pinned once in
  // `tests/unit/validation.test.ts` → BASE_SENSITIVE_URLS.
  it("blanks a base-sensitive bare-scheme link (no //) before it reaches KV", async () => {
    const token = await generateAuthToken(kv, USER1);
    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        books: [
          {
            bookId: "b1",
            title: "Lure",
            coverUrl: ALLOWED_COVER,
            readmooUrl: BASE_SENSITIVE_BOOK_URL,
          },
        ],
      },
      token,
    );
    // Sanitize, never reject — same policy as every other off-whitelist link.
    expect(res.status).toBe(200);

    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.books[0].readmooUrl).toBe("");
    // The whitelisted cover beside it is untouched: the two URL fields are
    // sanitized independently.
    expect(stored?.books[0].coverUrl).toBe(ALLOWED_COVER);
    // Nowhere in the record — not in a stray field, not in a title.
    expect(JSON.stringify(stored)).not.toContain(BASE_SENSITIVE_BOOK_URL);
    expect(JSON.stringify(stored)).not.toContain("#invite=");
  });
});
