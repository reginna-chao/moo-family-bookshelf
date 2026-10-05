import { webcrypto } from "node:crypto";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  READMOO_EMAIL_COOKIE,
  parsePageAccountEmail,
  readPageAccountEmail,
  cookieConfirmsAccount,
} from "@/content/pageAccountCookie";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import {
  encodeReadmooEmail,
  setRawReadmooEmailCookie,
  setReadmooEmailCookie,
  clearReadmooEmailCookie,
} from "../../helpers/readmooEmailCookie";

/**
 * Readmoo's login cookie as a no-navigation identity signal (issue #275).
 *
 * The page can write any cookie, so the parser's contract is "an email only
 * when the cookie unambiguously names one; null for everything else", and
 * cookieConfirmsAccount can only CONFIRM the stored user: another account, no
 * usable cookie and a hashing failure are all `false`, and it never rejects.
 * Runs the real deriveUserId; `document.cookie` is jsdom's real cookie jar.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

const EMAIL = "owner@example.com";
const OTHER_EMAIL = "someone-else@example.com";
const NAME = READMOO_EMAIL_COOKIE;

/** `NAME=<encoded email>` — one cookie pair as `document.cookie` lists it. */
function pair(email: string): string {
  return `${NAME}=${encodeReadmooEmail(email)}`;
}

/** Base64 of raw bytes (not UTF-8 text), percent-encoded like Readmoo does. */
function encodeBytes(bytes: number[]): string {
  return encodeURIComponent(btoa(String.fromCharCode(...bytes)));
}

/** An email-shaped address of exactly `length` characters. */
function emailOfLength(length: number): string {
  const domain = "@example.com";
  return `${"a".repeat(length - domain.length)}${domain}`;
}

describe("parsePageAccountEmail", () => {
  it("pins the cookie name Readmoo writes", () => {
    expect(READMOO_EMAIL_COOKIE).toBe("ReadmooNext.email");
  });

  describe("returns the email", () => {
    const VALID_CASES: Array<{ name: string; cookie: string; email: string }> =
      [
        { name: "the cookie alone", cookie: pair(EMAIL), email: EMAIL },
        {
          name: "the cookie among other cookies",
          cookie: `_ga=GA1.2.3; ${pair(EMAIL)}; lang=zh-TW`,
          email: EMAIL,
        },
        {
          name: "whitespace around every part",
          cookie: `  _ga=1  ;   ${NAME}  =  ${encodeReadmooEmail(EMAIL)}   ;lang=zh`,
          email: EMAIL,
        },
        {
          name: "a base64 value that was not percent-encoded (raw `=` padding)",
          // "ab@c.co" is 7 bytes, so its base64 ends in a literal "=".
          cookie: `${NAME}=${btoa("ab@c.co")}`,
          email: "ab@c.co",
        },
        {
          name: "whitespace around the decoded email",
          cookie: `${NAME}=${encodeReadmooEmail(`  ${EMAIL}\n`)}`,
          email: EMAIL,
        },
        {
          name: "the same value listed twice (one cookie per path)",
          cookie: `${pair(EMAIL)}; other=1; ${pair(EMAIL)}`,
          email: EMAIL,
        },
        {
          name: "lookalike cookie names next to the real one",
          cookie: `x${pair(OTHER_EMAIL)}; ${NAME}.bak=${encodeReadmooEmail(OTHER_EMAIL)}; ${pair(EMAIL)}`,
          email: EMAIL,
        },
        {
          name: "a part with no `=` among the cookies",
          cookie: `flag; ${pair(EMAIL)}`,
          email: EMAIL,
        },
        {
          name: "a Latin non-ASCII email, decoded as UTF-8 (not Latin-1)",
          cookie: pair("josé@exämple.com"),
          email: "josé@exämple.com",
        },
        {
          name: "a CJK email, decoded as UTF-8",
          cookie: pair("測試@例子.台灣"),
          email: "測試@例子.台灣",
        },
        {
          name: "an email of exactly 254 characters",
          cookie: pair(emailOfLength(254)),
          email: emailOfLength(254),
        },
      ];

    it.each(VALID_CASES)("for $name", ({ cookie, email }) => {
      expect(parsePageAccountEmail(cookie)).toBe(email);
    });
  });

  describe("returns null", () => {
    const NULL_CASES: Array<{ name: string; cookie: string }> = [
      { name: "an empty cookie string", cookie: "" },
      { name: "no login cookie (logged out)", cookie: "_ga=1; lang=zh-TW" },
      { name: "the login cookie with an empty value", cookie: `${NAME}=` },
      { name: "the cookie name with no `=` at all", cookie: NAME },
      { name: "malformed percent-encoding", cookie: `${NAME}=%E0%A4%A` },
      { name: "a lone percent sign", cookie: `${NAME}=%` },
      { name: "invalid base64 characters", cookie: `${NAME}=!!!not*base64` },
      {
        name: "base64 of bytes that are not UTF-8",
        cookie: `${NAME}=${encodeBytes([0xff, 0xfe, 0x40, 0x61, 0x2e, 0x62])}`,
      },
      {
        name: "base64 of a truncated UTF-8 sequence",
        // "a@b.c" followed by the first two bytes of a three-byte character.
        cookie: `${NAME}=${encodeBytes([0x61, 0x40, 0x62, 0x2e, 0x63, 0xe6, 0xb8])}`,
      },
      {
        name: "an email-shaped value longer than 254 characters",
        cookie: pair(emailOfLength(255)),
      },
      { name: "a value with no @", cookie: pair("not-an-email") },
      { name: "a value with no dot in the domain", cookie: pair("a@b") },
      { name: "a value with two @", cookie: pair("a@b@c.com") },
      { name: "a value with inner whitespace", cookie: pair("a b@c.com") },
      { name: "a value that is only @", cookie: pair("@") },
      {
        name: "the name listed twice with DIFFERENT values (ambiguous)",
        cookie: `${pair(EMAIL)}; ${pair(OTHER_EMAIL)}`,
      },
      {
        name: "the name listed twice, one valid and one garbage",
        cookie: `${pair(EMAIL)}; ${NAME}=%%%`,
      },
      {
        name: "only a cookie whose name ENDS with the login cookie's",
        cookie: `x${pair(EMAIL)}`,
      },
      {
        name: "only a cookie whose name STARTS with the login cookie's",
        cookie: `${NAME}.bak=${encodeReadmooEmail(EMAIL)}`,
      },
      {
        name: "only a cookie whose name CONTAINS the login cookie's",
        cookie: `old_${NAME}_v1=${encodeReadmooEmail(EMAIL)}`,
      },
      {
        name: "the name in another case",
        cookie: `readmoonext.email=${encodeReadmooEmail(EMAIL)}`,
      },
      {
        name: "the login cookie's name appearing only inside another value",
        cookie: `ref=${pair(EMAIL)}`,
      },
    ];

    it.each(NULL_CASES)("for $name", ({ cookie }) => {
      expect(parsePageAccountEmail(cookie)).toBeNull();
    });
  });
});

describe("readPageAccountEmail", () => {
  afterEach(() => {
    clearReadmooEmailCookie();
    document.cookie = "other=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("reads the email of the account logged in on the page", () => {
    document.cookie = "other=1; path=/";
    setReadmooEmailCookie(EMAIL);

    expect(readPageAccountEmail()).toBe(EMAIL);
  });

  it("returns null when the page has no login cookie", () => {
    document.cookie = "other=1; path=/";

    expect(readPageAccountEmail()).toBeNull();
  });

  it("returns null once the login cookie is gone (logged out)", () => {
    setReadmooEmailCookie(EMAIL);
    clearReadmooEmailCookie();

    expect(readPageAccountEmail()).toBeNull();
  });

  it("returns null for an undecodable login cookie", () => {
    setRawReadmooEmailCookie("%%%");

    expect(readPageAccountEmail()).toBeNull();
  });

  it("returns null instead of throwing when reading document.cookie throws", () => {
    setReadmooEmailCookie(EMAIL);
    const getter = vi
      .spyOn(document, "cookie", "get")
      .mockImplementation(() => {
        throw new DOMException("sandboxed", "SecurityError");
      });

    try {
      expect(readPageAccountEmail()).toBeNull();
      expect(getter).toHaveBeenCalled();
    } finally {
      getter.mockRestore();
    }
    // Restored: the same jar reads normally again.
    expect(readPageAccountEmail()).toBe(EMAIL);
  });
});

describe("cookieConfirmsAccount", () => {
  let storedUserId: string;

  beforeAll(async () => {
    storedUserId = await deriveUserId(EMAIL);
  });

  beforeEach(() => {
    clearReadmooEmailCookie();
  });

  afterEach(() => {
    clearReadmooEmailCookie();
  });

  it("confirms when the login cookie names the stored account", async () => {
    setReadmooEmailCookie(EMAIL);

    await expect(cookieConfirmsAccount(storedUserId)).resolves.toBe(true);
  });

  it("confirms regardless of the email's case (deriveUserId normalizes it)", async () => {
    setReadmooEmailCookie("Owner@Example.COM");

    await expect(cookieConfirmsAccount(storedUserId)).resolves.toBe(true);
  });

  const REFUSE_CASES: Array<{ name: string; arrange: () => void }> = [
    {
      name: "the login cookie names another account",
      arrange: () => setReadmooEmailCookie(OTHER_EMAIL),
    },
    { name: "there is no login cookie", arrange: () => {} },
    {
      name: "the login cookie is undecodable",
      arrange: () => setRawReadmooEmailCookie("%%%"),
    },
    {
      name: "the login cookie is not an email",
      arrange: () => setReadmooEmailCookie("not-an-email"),
    },
  ];

  it.each(REFUSE_CASES)("does not confirm when $name", async ({ arrange }) => {
    arrange();

    await expect(cookieConfirmsAccount(storedUserId)).resolves.toBe(false);
  });

  it("does not confirm a userId no email derives to", async () => {
    setReadmooEmailCookie(EMAIL);

    await expect(cookieConfirmsAccount("f".repeat(64))).resolves.toBe(false);
  });

  it("resolves false (never rejects) when hashing fails", async () => {
    setReadmooEmailCookie(EMAIL);
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("no crypto"));

    try {
      await expect(cookieConfirmsAccount(storedUserId)).resolves.toBe(false);
      expect(digest).toHaveBeenCalledOnce();
    } finally {
      digest.mockRestore();
    }
  });
});
