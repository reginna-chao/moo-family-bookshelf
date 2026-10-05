import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BoolFlag,
  type ApiClient,
  type BookEntry,
  type PersonalBooks,
} from "@/api/client";
import {
  SYNC_BREAKER_MIN_SERVER_BOOKS,
  SYNC_PAUSED_MESSAGE,
} from "@/sync/syncBreaker";
import { installListTotalPublisher } from "../helpers/listTotalBridge";

/**
 * Manual sync right after an account re-check (PR #278 review): the check
 * visits `#/me` and puts the hash back on `#/library` without waiting, so the
 * library is still re-rendering. syncBooks must wait out the rest of
 * NAV_SETTLE_MS before scraping — before the fix it scraped the empty list,
 * found none of the saved books and tripped the sync circuit breaker.
 *
 * Real code end to end: readMePageProfile, syncBooks, the DOM scraper, merge,
 * breaker and upload. Stubbed: the ApiClient (network), the main-world fiber
 * bridge (stamps ids by title), and Readmoo's SPA, modelled as a hashchange
 * listener that unmounts the list off `#/library` and re-renders it
 * RENDER_DELAY_MS after coming back. The bridge is marked as already loaded,
 * so the first `moo-request-fiber-data` marks the instant the scrape starts.
 *
 * `lastRestoreAt` is module state, so each case imports a fresh module graph.
 */

const USER_ID = "user-123";
/** Library re-render time after landing on #/library — well inside NAV_SETTLE_MS. */
const RENDER_DELAY_MS = 400;
/** Time between the account check finishing and the sync starting. */
const GAP_MS = 200;

// Exactly the breaker's minimum, so a scrape of the unrendered list pauses.
const LIBRARY = Array.from(
  { length: SYNC_BREAKER_MIN_SERVER_BOOKS },
  (_, i) => ({ bookId: String(210000000000000 + i), title: `書 ${i}` }),
);

function savedBook({ bookId, title }: (typeof LIBRARY)[number]): BookEntry {
  return {
    bookId,
    title,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
  };
}

function renderLibrary(): void {
  document.body.innerHTML = LIBRARY.map(
    ({ title }) => `
    <div class="library-item">
      <div class="info"><div class="title" title="${title}">${title}</div></div>
    </div>`,
  ).join("");
}

function libraryItemCount(): number {
  return document.querySelectorAll(".library-item").length;
}

/** Put the jsdom URL on `hash` without firing hashchange. */
function setHash(hash: string): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${hash}`,
  );
}

/** Readmoo's SPA in miniature: the list unmounts off #/library and re-renders late. */
function installLibraryRoute(): () => void {
  let render: ReturnType<typeof setTimeout> | undefined;
  const onHashChange = () => {
    clearTimeout(render);
    document.body.innerHTML = "";
    if (location.hash.includes("#/library")) {
      render = setTimeout(renderLibrary, RENDER_DELAY_MS);
    }
  };
  window.addEventListener("hashchange", onHashChange);
  return () => {
    clearTimeout(render);
    window.removeEventListener("hashchange", onHashChange);
  };
}

/** The fiber bridge's stamping half; also records when each request arrived. */
function installStamper(requestedAt: number[]): () => void {
  const idByTitle = new Map(LIBRARY.map((b) => [b.title, b.bookId]));
  const handler = () => {
    requestedAt.push(Date.now());
    for (const item of document.querySelectorAll(".library-item")) {
      const title = item.querySelector(".title[title]")?.getAttribute("title");
      const id = title ? idByTitle.get(title) : undefined;
      if (id) item.setAttribute("data-moo-book-id", id);
    }
    document.dispatchEvent(new CustomEvent("moo-fiber-data"));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  return () => document.removeEventListener("moo-request-fiber-data", handler);
}

function createApi() {
  const updatePersonalBooks = vi.fn().mockResolvedValue({ data: { ok: true } });
  const client = {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: { books: LIBRARY.map(savedBook) },
    }),
    updatePersonalBooks,
  } as unknown as ApiClient;
  return { client, updatePersonalBooks };
}

function uploadedIds(updatePersonalBooks: ReturnType<typeof vi.fn>): string[] {
  expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
  const record = updatePersonalBooks.mock.calls[0][1] as PersonalBooks;
  return record.books.map((b) => b.bookId);
}

describe("syncBooks — right after an account check restored the hash", () => {
  let nav: typeof import("@/content/hashNavigation");
  let sync: typeof import("@/sync/syncBooks");
  const cleanups: Array<() => void> = [];
  /** Date.now() of every `moo-request-fiber-data`; [0] = the scrape start. */
  let scrapeRequests: number[];

  beforeEach(async () => {
    vi.resetModules();
    nav = await import("@/content/hashNavigation");
    sync = await import("@/sync/syncBooks");
    vi.useFakeTimers();
    await chrome.storage.local.clear();
    scrapeRequests = [];
    document.documentElement.setAttribute("data-moo-fiber-bridge", "1");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(
      installStamper(scrapeRequests),
      installListTotalPublisher("cards"),
      installLibraryRoute(),
    );
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    setHash("");
    await chrome.storage.local.clear();
  });

  /** The real #/me account check; returns the instant it restored the hash. */
  async function checkAccount(): Promise<number> {
    const check = nav.readMePageProfile();
    expect(location.hash).toBe("#/me");
    await vi.advanceTimersByTimeAsync(nav.NAV_SETTLE_MS);
    await check;
    return Date.now();
  }

  function startSync(client: ApiClient) {
    return sync.syncBooks({
      navigate: true,
      userId: USER_ID,
      apiClient: client,
    });
  }

  /** Let the (timer-free) scrape, merge and upload run to the end. */
  async function finish<T>(result: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(nav.NAV_SETTLE_MS);
    return result;
  }

  it("waits out the rest of NAV_SETTLE_MS, then uploads the re-rendered library", async () => {
    setHash("#/library");
    renderLibrary();
    const { client, updatePersonalBooks } = createApi();
    const restoredAt = await checkAccount();
    await vi.advanceTimersByTimeAsync(GAP_MS);
    // The scenario under test: back on #/library, list not rendered yet.
    expect(location.hash).toBe("#/library");
    expect(libraryItemCount()).toBe(0);

    const result = startSync(client);
    await vi.advanceTimersByTimeAsync(nav.NAV_SETTLE_MS - GAP_MS - 1);
    expect(scrapeRequests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(scrapeRequests[0]).toBe(restoredAt + nav.NAV_SETTLE_MS);

    const outcome = await finish(result);
    expect(outcome.error).toBeUndefined();
    expect(outcome.success).toBe(true);
    expect(uploadedIds(updatePersonalBooks)).toEqual(
      LIBRARY.map((b) => b.bookId),
    );
    expect(location.hash).toBe("#/library");
  });

  it("control: a scrape that starts before the list renders trips the breaker", async () => {
    // What the sync did before the fix: scrape at once, while still rendering.
    setHash("#/library");
    setTimeout(renderLibrary, RENDER_DELAY_MS);
    const { client, updatePersonalBooks } = createApi();
    const startedAt = Date.now();

    const result = startSync(client);
    expect(scrapeRequests[0]).toBe(startedAt);

    const outcome = await finish(result);
    expect(outcome).toMatchObject({
      success: false,
      error: SYNC_PAUSED_MESSAGE,
    });
    expect(updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("scrapes at once, with no timer, when no account check ran this page load", async () => {
    setHash("#/library");
    renderLibrary();
    const { client, updatePersonalBooks } = createApi();
    expect(nav.settleMsLeft()).toBe(0);
    const startedAt = Date.now();

    const result = startSync(client);
    expect(scrapeRequests[0]).toBe(startedAt);
    expect(vi.getTimerCount()).toBe(0);

    const outcome = await finish(result);
    expect(outcome.success).toBe(true);
    expect(uploadedIds(updatePersonalBooks)).toHaveLength(LIBRARY.length);
  });

  it("waits exactly one NAV_SETTLE_MS when it navigates itself after a recent check", async () => {
    setHash("#/store");
    const { client, updatePersonalBooks } = createApi();
    await checkAccount();
    await vi.advanceTimersByTimeAsync(GAP_MS);
    // The restore is still fresh, so a doubled wait would be observable.
    expect(location.hash).toBe("#/store");
    expect(nav.settleMsLeft()).toBe(nav.NAV_SETTLE_MS - GAP_MS);
    const startedAt = Date.now();

    const result = startSync(client);
    expect(location.hash).toBe("#/library");
    await vi.advanceTimersByTimeAsync(nav.NAV_SETTLE_MS - 1);
    expect(scrapeRequests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(scrapeRequests[0]).toBe(startedAt + nav.NAV_SETTLE_MS);

    const outcome = await finish(result);
    expect(outcome.success).toBe(true);
    expect(uploadedIds(updatePersonalBooks)).toHaveLength(LIBRARY.length);
    expect(location.hash).toBe("#/store");
  });
});
