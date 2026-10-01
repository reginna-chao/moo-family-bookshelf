import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncBooks } from "@/sync/syncBooks";
import {
  BoolFlag,
  type ApiClient,
  type BookEntry,
  type PersonalBooks,
} from "@/api/client";
import { installListTotalPublisher } from "../helpers/listTotalBridge";

/**
 * F1 regression (#236), end to end through the REAL scraper: a slow next page
 * makes scrolling stop growing before every book has rendered. The scrape must
 * then be incomplete — and an incomplete sync must neither replace the saved
 * old id with a same-title brand-new one on the loaded page, nor upload that
 * new id (it is held back for a sync that can judge).
 *
 * Only the network (ApiClient) and the main-world bridge are stubbed; the DOM
 * scrape, merge, breaker and id-change resolution all run for real.
 */

const USER_ID = "user-123";
const KEPT_ID = "210000000000003";
const OLD_ID = "210000000000001";
const NEW_ID = "210000000000002";
const KEPT_TITLE = "沒變的書";
const RENAMED_TITLE = "改了編號的書";

function savedBook(
  bookId: string,
  title: string,
  isShared = BoolFlag.FALSE,
): BookEntry {
  return {
    bookId,
    title,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared,
    isArchived: BoolFlag.FALSE,
  };
}

function card(title: string): string {
  return `
    <div class="library-item">
      <div class="info"><div class="title" title="${title}">${title}</div></div>
    </div>
  `;
}

/** Stamps ids by title and answers, like the bridge's stamping half. */
function installStamper(byTitle: Record<string, string>): () => void {
  const handler = () => {
    for (const item of document.querySelectorAll(".library-item")) {
      const title = item.querySelector(".title[title]")?.getAttribute("title");
      const id = title ? byTitle[title] : undefined;
      if (id) item.setAttribute("data-moo-book-id", id);
    }
    document.dispatchEvent(new CustomEvent("moo-fiber-data"));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  return () => document.removeEventListener("moo-request-fiber-data", handler);
}

function createApi(serverBooks: BookEntry[]) {
  const updatePersonalBooks = vi.fn().mockResolvedValue({ data: { ok: true } });
  const client = {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: { books: serverBooks },
    }),
    updatePersonalBooks,
  } as unknown as ApiClient;
  return { client, updatePersonalBooks };
}

describe("syncBooks — delayed next page (real scraper)", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await chrome.storage.local.clear();
    vi.mocked(chrome.storage.local.set).mockClear();
    document.body.innerHTML = card(KEPT_TITLE) + card(RENAMED_TITLE);
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    window.location.hash = "#/library";
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(
      installStamper({ [KEPT_TITLE]: KEPT_ID, [RENAMED_TITLE]: NEW_ID }),
    );
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    document
      .querySelectorAll('script[src*="fiber-bridge"]')
      .forEach((s) => s.remove());
    window.location.hash = "";
    await chrome.storage.local.clear();
  });

  async function runSync(client: ApiClient) {
    const promise = syncBooks({
      navigate: false,
      userId: USER_ID,
      apiClient: client,
    });
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(100);
    return promise;
  }

  function uploaded(
    updatePersonalBooks: ReturnType<typeof vi.fn>,
  ): BookEntry[] {
    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
    return (updatePersonalBooks.mock.calls[0][1] as PersonalBooks).books;
  }

  it("does not rename, keeps OLD, and holds back NEW when Readmoo holds more items than rendered", async () => {
    // Readmoo knows of 3 items; only 2 rendered before scrolling stalled.
    cleanups.push(installListTotalPublisher(3));
    const { client, updatePersonalBooks } = createApi([
      savedBook(KEPT_ID, KEPT_TITLE),
      savedBook(OLD_ID, RENAMED_TITLE, BoolFlag.TRUE),
    ]);

    const result = await runSync(client);

    expect(result.success).toBe(true);
    expect(result.renamedBookCount).toBe(0);
    const books = uploaded(updatePersonalBooks);
    expect(books.map((b) => b.bookId)).toEqual([KEPT_ID, OLD_ID]);
    // OLD is not removed and keeps its share; NEW is neither shared nor sent.
    expect(books.find((b) => b.bookId === OLD_ID)?.isShared).toBe(
      BoolFlag.TRUE,
    );
    expect(books.some((b) => b.bookId === NEW_ID)).toBe(false);
    expect(result.books).toEqual(books);
  });

  it("renames OLD → NEW (positive control) once the total confirms every item rendered", async () => {
    cleanups.push(installListTotalPublisher("cards"));
    const { client, updatePersonalBooks } = createApi([
      savedBook(KEPT_ID, KEPT_TITLE),
      savedBook(OLD_ID, RENAMED_TITLE, BoolFlag.TRUE),
    ]);

    const result = await runSync(client);

    expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
    const books = uploaded(updatePersonalBooks);
    expect(books.map((b) => b.bookId)).toEqual([KEPT_ID, NEW_ID]);
    expect(books[1].isShared).toBe(BoolFlag.TRUE);
  });
});
