import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "@/api/client";
import type { ScrapeResult } from "@/content/scraper";
import { installListTotalPublisher } from "../../helpers/listTotalBridge";

/**
 * Pins the `finally` contract of `scrapeArchivedBooks` (scraper-archive.ts):
 * whatever happens during the archived scrape, the user's normal Readmoo
 * library view is restored — by clearing the filter through the dialog, or by
 * falling back to `#/library` when the dialog cannot be driven.
 */

type Click = "filter" | "archive" | "confirm" | "clear";

interface FakeLibrary {
  clicks: Click[];
}

interface FakeLibraryOptions {
  /** Whether the filter dialog opens again when the cleanup re-clicks the filter button. */
  reopenOnCleanup: boolean;
}

// Budget covers: modal poll + selection pause + two library-reload windows
// (10s each) + fiber-bridge timeout + cleanup waits, with clear margin.
const FULL_RUN_MS = 40_000;

/** A minimal Readmoo library whose filter dialog reacts like the real one (filter
 *  button opens it, 確定 closes it); every click is recorded in order. */
function mountFakeLibrary(options: FakeLibraryOptions): FakeLibrary {
  const clicks: Click[] = [];
  document.body.innerHTML = `
    <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
    <div class="filter-modal modal">
      <div data-key="archive" data-value="true">已封存書籍</div>
      <div class="modal-footer">
        <button class="btn-primary">確定</button>
        <button class="btn-outline-primary">清除篩選</button>
      </div>
    </div>
    <div class="library-item">
      <div class="info"><div class="title" title="Archived Book">Archived Book</div></div>
      <img class="cover-img" src="https://example.com/cover.jpg" />
      <div class="privacy" id="privacy-210439468000107"></div>
    </div>
  `;

  const query = <T extends Element>(selector: string): T => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`fixture missing ${selector}`);
    return el;
  };
  const modal = query<HTMLElement>(".filter-modal");
  let opens = 0;

  query(".desktop-top-nav-btn").addEventListener("click", () => {
    clicks.push("filter");
    if (opens === 0 || options.reopenOnCleanup) modal.classList.add("show");
    opens++;
  });
  query('[data-key="archive"]').addEventListener("click", () => {
    clicks.push("archive");
  });
  query(".modal-footer .btn-primary").addEventListener("click", () => {
    clicks.push("confirm");
    modal.classList.remove("show");
  });
  query(".modal-footer .btn-outline-primary").addEventListener("click", () => {
    clicks.push("clear");
  });

  return { clicks };
}

async function loadScrapeArchivedBooks(): Promise<() => Promise<ScrapeResult>> {
  vi.resetModules();
  const mod = await import("@/content/scraper");
  return mod.scrapeArchivedBooks;
}

function resetPageState(): void {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-moo-fiber-bridge");
  document
    .querySelectorAll('script[src*="fiber-bridge"]')
    .forEach((s) => s.remove());
  window.location.hash = "";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scrapeArchivedBooks", () => {
  let cleanupTotal: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetPageState();
    // jsdom does not implement scrollTo; scrapeBooks restores scroll in its finally.
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanupTotal?.();
    cleanupTotal = null;
    vi.doUnmock("@/content/fiber-data");
    vi.restoreAllMocks();
    resetPageState();
  });

  it("clears the filter (清除篩選 then 確定) after a successful archived scrape", async () => {
    cleanupTotal = installListTotalPublisher("cards");
    const { clicks } = mountFakeLibrary({ reopenOnCleanup: true });
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    expect(result.complete).toBe(true);
    expect(result.books).toHaveLength(1);
    expect(result.books[0].isArchived).toBe(BoolFlag.TRUE);
    expect(clicks).toEqual([
      "filter",
      "archive",
      "confirm",
      "filter",
      "clear",
      "confirm",
    ]);
    // The dialog path succeeded, so the hash fallback must not be taken.
    expect(window.location.hash).toBe("");
  });

  it("falls back to #/library when the filter button is missing", async () => {
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    // A failed archive scrape is incomplete — never "zero archived books".
    expect(result).toEqual({ books: [], complete: false });
    expect(window.location.hash).toBe("#/library");
  });

  it("falls back to #/library when the filter dialog does not reopen during cleanup", async () => {
    cleanupTotal = installListTotalPublisher("cards");
    const { clicks } = mountFakeLibrary({ reopenOnCleanup: false });
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    // A failed restore must not discard books already scraped.
    expect(result.complete).toBe(true);
    expect(result.books).toHaveLength(1);
    expect(result.books[0].isArchived).toBe(BoolFlag.TRUE);
    expect(clicks).toEqual(["filter", "archive", "confirm", "filter"]);
    expect(window.location.hash).toBe("#/library");
  });

  it("returns an incomplete empty result and still clears the filter when the scrape itself throws", async () => {
    const requestFiberData = vi
      .fn()
      .mockRejectedValue(new Error("fiber bridge unavailable"));
    vi.doMock("@/content/fiber-data", () => ({
      requestFiberData,
      requestLibraryListTotal: vi.fn().mockResolvedValue(1),
      injectFiberBridge: () => false,
    }));
    const { clicks } = mountFakeLibrary({ reopenOnCleanup: true });
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    // Positive companion: the failure really came from inside the scrape step.
    expect(requestFiberData).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ books: [], complete: false });
    expect(clicks).toEqual([
      "filter",
      "archive",
      "confirm",
      "filter",
      "clear",
      "confirm",
    ]);
    expect(window.location.hash).toBe("");
  });

  it("reports zero archived books as COMPLETE when Readmoo's total confirms 0", async () => {
    cleanupTotal = installListTotalPublisher(0);
    mountFakeLibrary({ reopenOnCleanup: true });
    document.querySelector(".library-item")?.remove();
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    expect(result).toEqual({ books: [], complete: true });
  });

  it("reports zero archived books as INCOMPLETE when no total is published", async () => {
    // An empty grid with an unreadable count could equally be a page that has
    // not rendered yet — never "the archive is empty".
    mountFakeLibrary({ reopenOnCleanup: true });
    document.querySelector(".library-item")?.remove();
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    expect(result).toEqual({ books: [], complete: false });
  });

  it("reports zero rendered archived books as INCOMPLETE when the total says some exist", async () => {
    cleanupTotal = installListTotalPublisher(4);
    mountFakeLibrary({ reopenOnCleanup: true });
    document.querySelector(".library-item")?.remove();
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    expect(result).toEqual({ books: [], complete: false });
  });

  it("passes through an incomplete archive scrape (an unreadable archived card)", async () => {
    cleanupTotal = installListTotalPublisher("cards");
    mountFakeLibrary({ reopenOnCleanup: true });
    const extra = document.createElement("div");
    extra.className = "library-item";
    extra.innerHTML = `
      <div class="info"><div class="title" title="短碼書">短碼書</div></div>
      <div class="privacy" id="privacy-18548672"></div>
    `;
    document.body.appendChild(extra);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scrapeArchivedBooks = await loadScrapeArchivedBooks();

    const promise = scrapeArchivedBooks();
    await vi.advanceTimersByTimeAsync(FULL_RUN_MS);
    const result = await promise;

    expect(result.books.map((b) => b.bookId)).toEqual(["210439468000107"]);
    expect(result.complete).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'rejected .privacy fallback bookId "privacy-18548672"',
      ),
    );
  });
});
