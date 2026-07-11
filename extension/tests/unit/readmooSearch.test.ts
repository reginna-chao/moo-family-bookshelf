import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The fiber bridge injects a main-world <script> and dispatches CustomEvents.
// In jsdom none of that works, so mock the whole module: waitForBookCard only
// needs `requestFiberData` to resolve (the "stamp" step), and we assert it is
// called each poll round rather than actually stamping DOM.
vi.mock("@/content/fiber-data", () => ({
  requestFiberData: vi.fn().mockResolvedValue(undefined),
  injectFiberBridge: vi.fn(),
}));

import {
  openSearchModal,
  submitSearch,
  waitForBookCard,
  READMOO_SEARCH_DEFAULTS,
} from "@/content/readmoo-search";
import { requestFiberData } from "@/content/fiber-data";

/** Render Readmoo's top-nav search button (i.mo-search inside a nav button). */
function renderSearchButton(): void {
  document.body.innerHTML = `
    <nav class="desktop-top-nav">
      <button class="desktop-top-nav-btn"><i class="mo-search"></i></button>
    </nav>
  `;
}

/** Render a complete search modal (button + modal + input + submit). */
function renderSearchUi(initialQuery = ""): {
  modal: HTMLElement;
  input: HTMLInputElement;
  submit: HTMLButtonElement;
} {
  document.body.innerHTML = `
    <nav class="desktop-top-nav">
      <button class="desktop-top-nav-btn"><i class="mo-search"></i></button>
    </nav>
    <div class="search-modal">
      <input class="form-control" value="${initialQuery}" />
      <button type="submit">搜尋</button>
    </div>
  `;
  const modal = document.querySelector<HTMLElement>(".search-modal")!;
  const input = modal.querySelector<HTMLInputElement>("input.form-control")!;
  const submit = modal.querySelector<HTMLButtonElement>("button[type='submit']")!;
  return { modal, input, submit };
}

describe("readmoo-search", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(requestFiberData).mockClear();
    vi.mocked(requestFiberData).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("openSearchModal", () => {
    it("throws SEARCH_UI_NOT_FOUND when the search button is absent", async () => {
      await expect(openSearchModal(50)).rejects.toMatchObject({
        code: "SEARCH_UI_NOT_FOUND",
      });
    });

    it("throws SEARCH_UI_NOT_FOUND when the modal input never appears", async () => {
      renderSearchButton(); // button exists but no modal ever renders
      await expect(openSearchModal(50)).rejects.toMatchObject({
        code: "SEARCH_UI_NOT_FOUND",
      });
    });

    it("throws SEARCH_UI_NOT_FOUND when the submit button is missing", async () => {
      document.body.innerHTML = `
        <nav class="desktop-top-nav">
          <button class="desktop-top-nav-btn"><i class="mo-search"></i></button>
        </nav>
        <div class="search-modal">
          <input class="form-control" />
        </div>
      `;
      await expect(openSearchModal(50)).rejects.toMatchObject({
        code: "SEARCH_UI_NOT_FOUND",
      });
    });

    it("returns modal refs when the full search UI is present", async () => {
      const { input, submit } = renderSearchUi("舊關鍵字");
      const refs = await openSearchModal();
      expect(refs.input).toBe(input);
      expect(refs.submitButton).toBe(submit);
      expect(refs.modal).toBe(document.querySelector(".search-modal"));
    });
  });

  describe("submitSearch", () => {
    it("returns the previous keyword and fills the new query via native setter + input event", async () => {
      const { modal, input, submit } = renderSearchUi("舊關鍵字");
      const inputEventValues: string[] = [];
      input.addEventListener("input", () => inputEventValues.push(input.value));
      // Readmoo auto-closes the modal on submit; simulate that so waitForModalGone resolves.
      submit.addEventListener("click", () => modal.remove());

      const previousQuery = await submitSearch("新關鍵字");

      expect(previousQuery).toBe("舊關鍵字");
      expect(input.value).toBe("新關鍵字");
      // A React `input` event must fire AFTER the native setter set the new value.
      expect(inputEventValues).toContain("新關鍵字");
    });

    it("returns an empty previousQuery when there was no prior keyword", async () => {
      const { modal, submit } = renderSearchUi("");
      submit.addEventListener("click", () => modal.remove());

      const previousQuery = await submitSearch("關鍵字");

      expect(previousQuery).toBe("");
    });
  });

  describe("waitForBookCard", () => {
    it("stamps fiber data then returns the card when the book is already present", async () => {
      document.body.innerHTML = `<div class="library-item" data-moo-book-id="bk-1"></div>`;

      const card = await waitForBookCard("bk-1", 5000);

      expect(card).not.toBeNull();
      expect(card?.getAttribute("data-moo-book-id")).toBe("bk-1");
      // A stamp round must run before matching.
      expect(requestFiberData).toHaveBeenCalled();
    });

    it("returns null after the timeout and re-stamps fiber data every poll round", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = ""; // book never appears

      const promise = waitForBookCard("missing", 1000);
      // Drive the ~200ms poll loop past the 1000ms deadline.
      await vi.advanceTimersByTimeAsync(1200);
      const card = await promise;

      expect(card).toBeNull();
      // Multiple poll rounds → fiber data stamped more than once.
      expect(vi.mocked(requestFiberData).mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe("constants", () => {
    it("exposes positive default timeouts", () => {
      expect(READMOO_SEARCH_DEFAULTS.searchModalOpenTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_SEARCH_DEFAULTS.bookCardPollTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_SEARCH_DEFAULTS.bookCardPollIntervalMs).toBeGreaterThan(0);
    });
  });
});
