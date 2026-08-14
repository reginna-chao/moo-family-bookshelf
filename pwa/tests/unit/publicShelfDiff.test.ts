import { describe, it, expect } from "vitest";
import {
  divergentFields,
  hasDivergentFields,
  reconcileTitle,
} from "moo-family-bookshelf-shared/publicShelf/diff";
import type { PublicShelf } from "@/api/client";

/**
 * The module lives in `shared/` so the Extension and the PWA cannot drift on
 * what "diverged" means. Its parameters are structural, but the fixtures below
 * stay full `PublicShelf` objects on purpose: that also pins the PWA's own
 * type as assignable to the shared snapshot shape.
 */

const SHELF: PublicShelf = {
  shelfId: "shelf-1",
  shareToken: "tok-abc",
  title: "小明 的公開書櫃",
  expiresDays: 30,
  createdAt: 1_700_000_000_000,
  expiresAt: null,
  selectionMode: "all-shared",
};

/** Shelf that never expires — the other side of the `expiresDays` null case. */
const PERMANENT_SHELF: PublicShelf = { ...SHELF, expiresDays: null };

describe("divergentFields", () => {
  it.each([
    {
      name: "nothing changed",
      shelf: SHELF,
      title: SHELF.title,
      expiresDays: 30,
      expected: {},
    },
    {
      name: "only surrounding whitespace differs (server stores it trimmed)",
      shelf: SHELF,
      title: `  ${SHELF.title}  `,
      expiresDays: 30,
      expected: {},
    },
    {
      name: "the title changed",
      shelf: SHELF,
      title: "新標題",
      expiresDays: 30,
      expected: { title: "新標題" },
    },
    {
      name: "the expiry changed to another window",
      shelf: SHELF,
      title: SHELF.title,
      expiresDays: 7,
      expected: { expiresDays: 7 },
    },
    {
      name: "the expiry changed to 永久",
      shelf: SHELF,
      title: SHELF.title,
      expiresDays: null,
      expected: { expiresDays: null },
    },
    {
      name: "a permanent shelf gained an expiry",
      shelf: PERMANENT_SHELF,
      title: PERMANENT_SHELF.title,
      expiresDays: 90,
      expected: { expiresDays: 90 },
    },
    {
      name: "both fields changed",
      shelf: SHELF,
      title: "新標題",
      expiresDays: 7,
      expected: { title: "新標題", expiresDays: 7 },
    },
  ])(
    "returns $expected when $name",
    ({ shelf, title, expiresDays, expected }) => {
      expect(divergentFields(shelf, title, expiresDays)).toEqual(expected);
    },
  );

  // The API recomputes `expiresAt` whenever `expiresDays` is present, so an
  // echoed-but-unchanged value silently extends the shelf's lifetime.
  it("omits the expiresDays key entirely when only the title diverged", () => {
    const body = divergentFields(SHELF, "新標題", SHELF.expiresDays);

    expect(Object.keys(body)).toEqual(["title"]);
    expect("expiresDays" in body).toBe(false);
  });

  it("omits the title key entirely when only the expiry diverged", () => {
    const body = divergentFields(SHELF, SHELF.title, 7);

    expect(Object.keys(body)).toEqual(["expiresDays"]);
    expect("title" in body).toBe(false);
  });

  // Comparison is trimmed, but the payload keeps what the user typed — the
  // server does the trimming, so the client must not silently rewrite input.
  it("sends the untrimmed title once it genuinely diverges", () => {
    expect(divergentFields(SHELF, "  新標題  ", 30)).toEqual({
      title: "  新標題  ",
    });
  });
});

describe("hasDivergentFields", () => {
  it.each([
    {
      name: "there is no shelf yet",
      shelf: null,
      title: "任何標題",
      expiresDays: 7,
      expected: false,
    },
    {
      name: "local values match the server",
      shelf: SHELF,
      title: SHELF.title,
      expiresDays: 30,
      expected: false,
    },
    {
      name: "only whitespace differs",
      shelf: SHELF,
      title: `${SHELF.title} `,
      expiresDays: 30,
      expected: false,
    },
    {
      name: "the title diverged",
      shelf: SHELF,
      title: "新標題",
      expiresDays: 30,
      expected: true,
    },
    {
      name: "the expiry diverged",
      shelf: SHELF,
      title: SHELF.title,
      expiresDays: null,
      expected: true,
    },
  ])("is $expected when $name", ({ shelf, title, expiresDays, expected }) => {
    expect(hasDivergentFields(shelf, title, expiresDays)).toBe(expected);
  });
});

describe("reconcileTitle", () => {
  /** Zero-width space: survives `trim()`, but the server strips it. */
  const ZWSP = "\u200b";

  it.each([
    {
      name: "the write carried no title at all (expiry-only write)",
      current: "使用者正在編輯",
      sent: undefined,
      stored: "伺服器的標題",
      expected: "使用者正在編輯",
    },
    {
      name: "the user typed again while the write was in flight",
      current: "新標題 v2",
      sent: "新標題",
      stored: "新標題",
      expected: "新標題 v2",
    },
    {
      name: "the server sanitized the title it stored",
      current: `書櫃${ZWSP}`,
      sent: `書櫃${ZWSP}`,
      stored: "書櫃",
      expected: "書櫃",
    },
    {
      name: "the server trimmed the surrounding whitespace",
      current: "  書櫃  ",
      sent: "  書櫃  ",
      stored: "書櫃",
      expected: "書櫃",
    },
    {
      name: "the server echoed the sent title back unchanged",
      current: "書櫃",
      sent: "書櫃",
      stored: "書櫃",
      expected: "書櫃",
    },
  ])("returns $expected when $name", ({ current, sent, stored, expected }) => {
    expect(reconcileTitle(current, sent, stored)).toBe(expected);
  });

  // Why the server-adoption branch exists: the server strips characters
  // `trim()` does not, so without adopting its value the field would read as
  // permanently unsaved on a title the user can never retype.
  it("clears the divergence that a server-side sanitization would otherwise strand", () => {
    const stored = { title: "書櫃", expiresDays: 30 };

    expect(hasDivergentFields(stored, `書櫃${ZWSP}`, 30)).toBe(true);
    expect(
      hasDivergentFields(
        stored,
        reconcileTitle(`書櫃${ZWSP}`, `書櫃${ZWSP}`, stored.title),
        30,
      ),
    ).toBe(false);
  });
});
