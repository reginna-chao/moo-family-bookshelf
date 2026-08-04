import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// openLendDialogForBook drives the library search (readmoo-search) before it
// touches any DOM. Mock that module so the orchestrator tests control whether a
// card is "found" (via waitForBookCard) and can assert the restore ordering
// (restoreLibrarySearch → submitSearch). The DOM-helper tests below do not use
// readmoo-search, so the mock is inert for them.
vi.mock("@/content/readmoo-search", () => ({
  submitSearch: vi.fn(),
  waitForBookCard: vi.fn(),
  READMOO_SEARCH_DEFAULTS: {
    searchModalOpenTimeoutMs: 5000,
    searchModalCloseTimeoutMs: 5000,
    bookCardPollTimeoutMs: 5000,
    bookCardPollIntervalMs: 200,
  },
}));

import {
  findBookCardInLibrary,
  extractReadmooMembers,
  selectMemberByName,
  waitForLendDialogClose,
  closeLendDialog,
  ensureOnLibraryPage,
  openBookDetailModal,
  openLendDialogForBook,
  ReadmooLendError,
  READMOO_LEND_DEFAULTS,
} from "@/content/readmoo-lend";
import { resetScrapeWarnings } from "@/content/readmoo-dom";
import { submitSearch, waitForBookCard } from "@/content/readmoo-search";

const realLocation = window.location;

/**
 * Replace window.location with a minimal stub the lend flow can read.
 *
 * `pathname` matters: the new host only serves the web app under `/read`, so the
 * library gate reads all three parts. Callers must pass the pathname that goes
 * with the host they are simulating (`/read/` for next, `/` for legacy).
 */
function stubLocation(hostname: string, pathname: string, hash: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { hostname, pathname, hash },
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
}

describe("readmoo-lend", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    // queryWithLegacyFallback de-duplicates its warning in a module-scoped Set;
    // reset it around every case so warning assertions are order-independent.
    resetScrapeWarnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetScrapeWarnings();
    document.body.innerHTML = "";
  });

  describe("findBookCardInLibrary", () => {
    it("finds a library item by data-moo-book-id", () => {
      document.body.innerHTML = `
        <div class="library-item" data-moo-book-id="abc123"></div>
        <div class="library-item" data-moo-book-id="xyz789"></div>
      `;
      const found = findBookCardInLibrary("xyz789");
      expect(found).not.toBeNull();
      expect(found?.getAttribute("data-moo-book-id")).toBe("xyz789");
    });

    it("returns null when bookId is not in DOM", () => {
      document.body.innerHTML = `<div class="library-item" data-moo-book-id="abc123"></div>`;
      expect(findBookCardInLibrary("missing")).toBeNull();
    });

    it("returns null when DOM is empty", () => {
      expect(findBookCardInLibrary("anything")).toBeNull();
    });

    it("escapes special CSS characters in bookId to avoid selector injection", () => {
      document.body.innerHTML = `<div class="library-item" data-moo-book-id="weird&quot;id"></div>`;
      // The escaping should not throw and should still match correctly
      expect(() => findBookCardInLibrary('weird"id')).not.toThrow();
    });
  });

  describe("extractReadmooMembers", () => {
    it("extracts member name + avatar from list-group items", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item">
          <img src="https://example.com/cry.png" alt="CRY" />
          <span class="fw-bold">CRY</span>
        </div>
        <div class="list-group-item">
          <img src="https://example.com/alice.png" alt="Alice" />
          <span class="fw-bold">Alice</span>
        </div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members).toEqual([
        { name: "CRY", avatar: "https://example.com/cry.png" },
        { name: "Alice", avatar: "https://example.com/alice.png" },
      ]);
    });

    it("skips items without a name", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item"><span class="fw-bold"></span></div>
        <div class="list-group-item"><span class="fw-bold">Bob</span></div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members).toHaveLength(1);
      expect(members[0].name).toBe("Bob");
    });

    it("returns empty array when dialog has no member items", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `<div class="other"></div>`;
      expect(extractReadmooMembers(dialog)).toEqual([]);
    });

    it("returns empty avatar when img is missing", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <div class="list-group-item">
          <span class="fw-bold">NoAvatar</span>
        </div>
      `;
      const members = extractReadmooMembers(dialog);
      expect(members[0]).toEqual({ name: "NoAvatar", avatar: "" });
    });
  });

  describe("selectMemberByName", () => {
    it("clicks the matching member's list-group-item and returns true", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">CRY</span></button>
        <button class="list-group-item"><span class="fw-bold">Alice</span></button>
      `;
      document.body.appendChild(dialog);
      const aliceBtn = dialog.querySelectorAll("button")[1];
      const clickSpy = vi.fn();
      aliceBtn.addEventListener("click", clickSpy);

      const result = selectMemberByName(dialog, "Alice");

      expect(result).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("returns false when no match (does not throw)", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">CRY</span></button>
      `;
      expect(() => selectMemberByName(dialog, "Missing")).not.toThrow();
      expect(selectMemberByName(dialog, "Missing")).toBe(false);
    });

    it("trims whitespace when comparing names", () => {
      const dialog = document.createElement("div");
      dialog.innerHTML = `
        <button class="list-group-item"><span class="fw-bold">  CRY  </span></button>
      `;
      const btn = dialog.querySelector("button")!;
      const clickSpy = vi.fn();
      btn.addEventListener("click", clickSpy);

      const result = selectMemberByName(dialog, "CRY");

      expect(result).toBe(true);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("closeLendDialog", () => {
    it("clicks the dialog's .btn-close when present", () => {
      const dialog = document.createElement("div");
      const close = document.createElement("button");
      close.className = "btn-close";
      const clickSpy = vi.fn();
      close.addEventListener("click", clickSpy);
      dialog.appendChild(close);
      document.body.appendChild(dialog);

      closeLendDialog(dialog);

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to dispatching Escape keydown when no .btn-close", () => {
      const dialog = document.createElement("div");
      const keySpy = vi.fn();
      dialog.addEventListener("keydown", keySpy);
      document.body.appendChild(dialog);

      closeLendDialog(dialog);

      expect(keySpy).toHaveBeenCalledTimes(1);
      expect((keySpy.mock.calls[0][0] as KeyboardEvent).key).toBe("Escape");
    });

    it("does nothing when the dialog is already disconnected", () => {
      const dialog = document.createElement("div");
      // never appended → not connected
      expect(() => closeLendDialog(dialog)).not.toThrow();
    });
  });

  describe("waitForLendDialogClose", () => {
    it("resolves true when dialog is removed from DOM", async () => {
      const dialog = document.createElement("div");
      document.body.appendChild(dialog);
      const promise = waitForLendDialogClose(dialog, 1000);
      // Schedule removal on next tick
      queueMicrotask(() => dialog.remove());
      const result = await promise;
      expect(result).toBe(true);
    });

    it("resolves true immediately when dialog is already disconnected", async () => {
      const dialog = document.createElement("div");
      // never appended → not connected
      const result = await waitForLendDialogClose(dialog, 100);
      expect(result).toBe(true);
    });

    it("resolves false when timeout elapses with dialog still in DOM", async () => {
      const dialog = document.createElement("div");
      document.body.appendChild(dialog);
      const result = await waitForLendDialogClose(dialog, 50);
      expect(result).toBe(false);
    });
  });

  describe("constants", () => {
    it("exports default timeouts", () => {
      expect(READMOO_LEND_DEFAULTS.modalOpenTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_LEND_DEFAULTS.lendDialogOpenTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_LEND_DEFAULTS.lendDialogCloseTimeoutMs).toBeGreaterThan(0);
      expect(READMOO_LEND_DEFAULTS.hoverSettleMs).toBeGreaterThan(0);
    });
  });

  describe("openBookDetailModal", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // jsdom does not implement scrollIntoView; the detail flow calls it.
      Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Overlay markup keyed by the ⋯ button shape we want the card to expose. */
    const OVERLAY_MARKUP = {
      span: `<div class="openbook-overlay"><div class="detail"><span>⋯</span></div></div>`,
      "detail-only": `<div class="openbook-overlay"><div class="detail">⋯</div></div>`,
      // Legacy host: the overlay is named `.openbook`, not `.openbook-overlay`.
      "legacy-span": `<div class="openbook"><div class="detail"><span>⋯</span></div></div>`,
      "legacy-detail-only": `<div class="openbook"><div class="detail">⋯</div></div>`,
      none: "",
    } as const;

    /** Build a library card; `withTrigger` controls the ⋯ overlay button shape. */
    function buildCard(withTrigger: keyof typeof OVERLAY_MARKUP): {
      card: HTMLElement;
      readerLinkClick: ReturnType<typeof vi.fn>;
    } {
      const card = document.createElement("div");
      card.className = "library-item";
      card.innerHTML = `
        <a class="reader-link"><img class="cover-img" /></a>
        ${OVERLAY_MARKUP[withTrigger]}
      `;
      document.body.appendChild(card);
      const readerLinkClick = vi.fn();
      card
        .querySelector("a.reader-link")!
        .addEventListener("click", readerLinkClick);
      return { card, readerLinkClick };
    }

    it("clicks '.openbook-overlay .detail span' and never the reader-link, returning the modal", async () => {
      const { card, readerLinkClick } = buildCard("span");
      const span = card.querySelector<HTMLElement>(
        ".openbook-overlay .detail span",
      )!;
      const spanClick = vi.fn();
      span.addEventListener("click", spanClick);
      const modal = document.createElement("div");
      modal.className = "book-detail-modal";
      document.body.appendChild(modal);

      const promise = openBookDetailModal(card);
      await vi.advanceTimersByTimeAsync(700); // past 300ms scroll settle + 300ms hover settle
      const result = await promise;

      expect(result).toBe(modal);
      expect(spanClick).toHaveBeenCalledTimes(1);
      // The cover sits inside a.reader-link (opens the reader) — must never fire.
      expect(readerLinkClick).not.toHaveBeenCalled();
    });

    it("falls back to '.openbook-overlay .detail' when the inner span is absent", async () => {
      const { card } = buildCard("detail-only");
      const detail = card.querySelector<HTMLElement>(
        ".openbook-overlay .detail",
      )!;
      const detailClick = vi.fn();
      detail.addEventListener("click", detailClick);
      const modal = document.createElement("div");
      modal.className = "book-detail-modal";
      document.body.appendChild(modal);

      const promise = openBookDetailModal(card);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(detailClick).toHaveBeenCalledTimes(1);
    });

    it("falls back to the legacy '.openbook .detail span' and warns once", async () => {
      const { card, readerLinkClick } = buildCard("legacy-span");
      const span = card.querySelector<HTMLElement>(".openbook .detail span")!;
      const spanClick = vi.fn();
      span.addEventListener("click", spanClick);
      const modal = document.createElement("div");
      modal.className = "book-detail-modal";
      document.body.appendChild(modal);

      const promise = openBookDetailModal(card);
      await vi.advanceTimersByTimeAsync(700);
      const result = await promise;

      expect(result).toBe(modal);
      expect(spanClick).toHaveBeenCalledTimes(1);
      expect(readerLinkClick).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'legacy selector fallback hit for "lend:detail-trigger"',
        ),
      );
    });

    it("falls back to the legacy '.openbook .detail' when the inner span is absent", async () => {
      const { card } = buildCard("legacy-detail-only");
      const detail = card.querySelector<HTMLElement>(".openbook .detail")!;
      const detailClick = vi.fn();
      detail.addEventListener("click", detailClick);
      const modal = document.createElement("div");
      modal.className = "book-detail-modal";
      document.body.appendChild(modal);

      const promise = openBookDetailModal(card);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(detailClick).toHaveBeenCalledTimes(1);
      // Both the strict and the loose lookup fell through to the legacy host.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'legacy selector fallback hit for "lend:detail-trigger-loose"',
        ),
      );
    });

    it("throws DETAIL_TRIGGER_NOT_FOUND when no overlay detail trigger exists", async () => {
      const { card } = buildCard("none");

      const promise = openBookDetailModal(card);
      const expectation = expect(promise).rejects.toMatchObject({
        code: "DETAIL_TRIGGER_NOT_FOUND",
      });
      await vi.advanceTimersByTimeAsync(700);
      await expectation;
    });
  });

  describe("ensureOnLibraryPage", () => {
    afterEach(() => {
      restoreLocation();
    });

    const alreadyThere: Array<{
      hostname: string;
      pathname: string;
      hash: string;
    }> = [
      { hostname: "next.readmoo.com", pathname: "/read/", hash: "#/library" },
      // The new host also serves the app at `/read` with no trailing slash.
      { hostname: "next.readmoo.com", pathname: "/read", hash: "#/library" },
      { hostname: "read.readmoo.com", pathname: "/", hash: "#/library" },
      {
        hostname: "next.readmoo.com",
        pathname: "/read/",
        hash: "#/library/all",
      },
    ];

    for (const { hostname, pathname, hash } of alreadyThere) {
      it(`returns true without navigating on ${hostname}${pathname}${hash}`, () => {
        stubLocation(hostname, pathname, hash);

        expect(ensureOnLibraryPage()).toBe(true);
        expect(window.location.href).toBeUndefined();
      });
    }

    const redirects: Array<{
      name: string;
      hostname: string;
      pathname: string;
      hash: string;
      expectedHref: string;
    }> = [
      {
        name: "keeps a new-site user on the new site (with the /read prefix)",
        hostname: "next.readmoo.com",
        pathname: "/read/",
        hash: "#/me",
        expectedHref: "https://next.readmoo.com/read/#/library",
      },
      {
        name: "keeps a legacy-site user on the legacy site (no prefix)",
        hostname: "read.readmoo.com",
        pathname: "/",
        hash: "#/me",
        expectedHref: "https://read.readmoo.com/#/library",
      },
      {
        name: "sends an unrecognised host to the legacy library URL",
        hostname: "localhost",
        pathname: "/",
        hash: "",
        expectedHref: "https://read.readmoo.com/#/library",
      },
      {
        // The new host's root serves the storefront, not the web app, so the
        // library hash alone must not open the gate there.
        name: "rejects the new site's root path even with the library hash",
        hostname: "next.readmoo.com",
        pathname: "/",
        hash: "#/library",
        expectedHref: "https://next.readmoo.com/read/#/library",
      },
      {
        // `#/librarything` merely prefixes `#/library`; only the exact route or
        // a `#/library/…` sub-route counts.
        name: "rejects a sibling hash route that only prefixes #/library",
        hostname: "next.readmoo.com",
        pathname: "/read/",
        hash: "#/librarything",
        expectedHref: "https://next.readmoo.com/read/#/library",
      },
    ];

    for (const { name, hostname, pathname, hash, expectedHref } of redirects) {
      it(`returns false and ${name}`, () => {
        stubLocation(hostname, pathname, hash);

        expect(ensureOnLibraryPage()).toBe(false);
        expect(window.location.href).toBe(expectedHref);
      });
    }
  });

  describe("openLendDialogForBook", () => {
    beforeEach(() => {
      vi.mocked(submitSearch).mockReset();
      vi.mocked(waitForBookCard).mockReset();
      Element.prototype.scrollIntoView = vi.fn();
      stubLocation("read.readmoo.com", "/", "#/library");
    });

    afterEach(() => {
      vi.useRealTimers();
      restoreLocation();
    });

    it("throws NOT_ON_LIBRARY without searching when not on the library page", async () => {
      stubLocation("localhost", "/", "");

      const err = await openLendDialogForBook("bk-1", "書名").catch((e) => e);

      expect(err).toBeInstanceOf(ReadmooLendError);
      expect((err as ReadmooLendError).code).toBe("NOT_ON_LIBRARY");
      // Pins the shipped copy: BorrowTab renders this message verbatim in its
      // error alert, so a wording change must be a deliberate edit here too.
      expect((err as Error).message).toBe(
        "請先切換到讀墨的「書櫃」頁面後再試一次",
      );
      // Bailing before the search means no library filter was ever applied.
      expect(submitSearch).not.toHaveBeenCalled();
    });

    it("throws NOT_ON_LIBRARY on a host that merely looks like Readmoo", async () => {
      stubLocation("next.readmoo.com.evil.com", "/read/", "#/library");

      const err = await openLendDialogForBook("bk-1", "書名").catch((e) => e);

      expect((err as ReadmooLendError).code).toBe("NOT_ON_LIBRARY");
      expect(submitSearch).not.toHaveBeenCalled();
    });

    it("proceeds past the host gate on the new next.readmoo.com library page", async () => {
      stubLocation("next.readmoo.com", "/read/", "#/library");
      vi.mocked(submitSearch).mockResolvedValue("");
      vi.mocked(waitForBookCard).mockResolvedValue(null);

      const err = await openLendDialogForBook("bk-1", "書名").catch((e) => e);

      // Reaching BOOK_NOT_FOUND proves the new host cleared the library gate.
      expect((err as ReadmooLendError).code).toBe("BOOK_NOT_FOUND");
      expect(submitSearch).toHaveBeenCalled();
    });

    it("returns the lend dialog + members + previousQuery on the success path", async () => {
      vi.useFakeTimers();
      const card = document.createElement("div");
      card.className = "library-item";
      card.innerHTML = `<div class="openbook-overlay"><div class="detail"><span>⋯</span></div></div>`;
      document.body.appendChild(card);

      const detailModal = document.createElement("div");
      detailModal.className = "book-detail-modal";
      detailModal.innerHTML = `<button class="cursor-pointer"><i class="mo mo-envelope"></i></button>`;
      document.body.appendChild(detailModal);

      const lendDialog = document.createElement("div");
      lendDialog.setAttribute("role", "dialog");
      lendDialog.innerHTML = `
        <div class="modal-title">借出書籍</div>
        <div class="list-group-item"><span class="fw-bold">Alice</span></div>
      `;
      document.body.appendChild(lendDialog);

      vi.mocked(submitSearch).mockResolvedValue("科幻");
      vi.mocked(waitForBookCard).mockResolvedValue(card);

      const promise = openLendDialogForBook("bk-1", "書名");
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.previousQuery).toBe("科幻");
      expect(result.lendDialog).toBe(lendDialog);
      expect(result.members).toEqual([{ name: "Alice", avatar: "" }]);
      // Success path must NOT restore mid-flow (would detach the card node).
      expect(submitSearch).toHaveBeenCalledTimes(1);
    });

    it("throws BOOK_NOT_FOUND (message with title) and dismisses dialogs BEFORE restoring on miss", async () => {
      const order: string[] = [];
      vi.mocked(submitSearch).mockImplementation(async () => {
        order.push("search");
        return "推理";
      });
      vi.mocked(waitForBookCard).mockResolvedValue(null);

      // A lingering Readmoo dialog that dismissOpenDialogs should close first.
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const btnClose = document.createElement("button");
      btnClose.className = "btn-close";
      btnClose.addEventListener("click", () => order.push("dismiss"));
      dialog.appendChild(btnClose);
      document.body.appendChild(dialog);

      const err = await openLendDialogForBook("bk-1", "測試書名").catch(
        (e) => e,
      );

      expect((err as ReadmooLendError).code).toBe("BOOK_NOT_FOUND");
      expect((err as Error).message).toContain("《測試書名》");
      // Initial search, then dismiss-before-restore, then the restore search.
      expect(order).toEqual(["search", "dismiss", "search"]);
    });
  });
});
