import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SYNC_PAUSED_MESSAGE,
  assertSyncNotPaused,
  evaluateSyncBreaker,
} from "@/sync/syncBreaker";
import { BoolFlag, type BookEntry } from "@/api/client";

/**
 * Sync circuit breaker (#236): a scrape that finds fewer than half of the
 * server's real-id books (once the server holds 50+) looks like a Readmoo
 * redesign, not like the user's library, and must not be uploaded.
 */

/** A real 15-digit Readmoo book id, unique per `n`. */
function realId(n: number): string {
  return `2100000${String(n).padStart(8, "0")}`;
}

function makeBook(
  bookId: string,
  overrides: Partial<BookEntry> = {},
): BookEntry {
  return {
    bookId,
    title: `書 ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

/** `count` real-id server books, ids 0..count-1. */
function serverBooks(count: number, overrides: Partial<BookEntry> = {}) {
  return Array.from({ length: count }, (_, i) =>
    makeBook(realId(i), overrides),
  );
}

/** The first `count` server ids, i.e. a scrape that found exactly those again. */
function scraped(count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, i) => realId(i)));
}

describe("evaluateSyncBreaker", () => {
  const cases: Array<{
    name: string;
    server: number;
    overlap: number;
    paused: boolean;
  }> = [
    { name: "an empty server", server: 0, overlap: 0, paused: false },
    {
      name: "49 server books, none found",
      server: 49,
      overlap: 0,
      paused: false,
    },
    {
      name: "50 server books, none found",
      server: 50,
      overlap: 0,
      paused: true,
    },
    {
      name: "50 server books, 24 found (48%)",
      server: 50,
      overlap: 24,
      paused: true,
    },
    {
      name: "50 server books, 25 found (exactly 50%)",
      server: 50,
      overlap: 25,
      paused: false,
    },
    {
      name: "50 server books, all found",
      server: 50,
      overlap: 50,
      paused: false,
    },
    {
      name: "200 server books, 99 found",
      server: 200,
      overlap: 99,
      paused: true,
    },
    {
      name: "200 server books, 100 found",
      server: 200,
      overlap: 100,
      paused: false,
    },
  ];

  for (const { name, server, overlap, paused } of cases) {
    it(`${paused ? "pauses" : "does not pause"} for ${name}`, () => {
      expect(
        evaluateSyncBreaker(serverBooks(server), scraped(overlap), true),
      ).toEqual({ paused, serverValid: server, overlap });
    });
  }

  it("leaves short (non-book) ids out of the server count", () => {
    // 49 real + 30 legacy 8-digit ids: below the 50 real-id floor → no pause,
    // even though nothing at all was found again.
    const books = [
      ...serverBooks(49),
      ...Array.from({ length: 30 }, (_, i) => makeBook(String(10000000 + i))),
    ];

    expect(evaluateSyncBreaker(books, new Set(), true)).toEqual({
      paused: false,
      serverValid: 49,
      overlap: 0,
    });
  });

  it("leaves archived server books out when the archive was not covered", () => {
    // 40 active (all found) + 60 archived (cannot be found without the archive).
    const active = serverBooks(40);
    const archived = Array.from({ length: 60 }, (_, i) =>
      makeBook(realId(100 + i), { isArchived: BoolFlag.TRUE }),
    );

    expect(
      evaluateSyncBreaker([...active, ...archived], scraped(40), false),
    ).toEqual({ paused: false, serverValid: 40, overlap: 40 });
  });

  it("counts archived server books when the archive was covered", () => {
    const active = serverBooks(40);
    const archived = Array.from({ length: 60 }, (_, i) =>
      makeBook(realId(100 + i), { isArchived: BoolFlag.TRUE }),
    );

    // Covered archive scrape that still missed every archived book → 40/100.
    expect(
      evaluateSyncBreaker([...active, ...archived], scraped(40), true),
    ).toEqual({ paused: true, serverValid: 100, overlap: 40 });
  });

  it("ignores scraped ids that were never on the server", () => {
    const extra = new Set([...scraped(10), realId(900), realId(901)]);

    expect(evaluateSyncBreaker(serverBooks(50), extra, true)).toEqual({
      paused: true,
      serverValid: 50,
      overlap: 10,
    });
  });
});

describe("assertSyncNotPaused", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws the production pause copy and warns with counts only", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const books = serverBooks(50, { title: "私密書名" });

    expect(() => assertSyncNotPaused(books, scraped(10), true)).toThrow(
      new Error(SYNC_PAUSED_MESSAGE),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toEqual({ serverValid: 50, overlap: 10 });
    // Counts only: no book id or title may reach the console.
    const logged = JSON.stringify(warnSpy.mock.calls[0]);
    expect(logged).not.toContain(realId(0));
    expect(logged).not.toContain("私密書名");
  });

  it("pins the user-visible pause copy", () => {
    expect(SYNC_PAUSED_MESSAGE).toBe("讀墨可能改版了，已暫停同步書櫃");
  });

  it("returns quietly when the breaker does not trip", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      assertSyncNotPaused(serverBooks(50), scraped(25), true),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
