/** Readmoo lending automation (Scope B): clicks through Readmoo's native lending flow on an approved
 *  borrow; never intercepts window.confirm. See docs/architecture.md → 讀墨借出自動化. */

import {
  LIBRARY_HASH,
  READMOO_LEND_DIALOG_TITLE,
  READMOO_SELECTORS,
  isLibraryUrl,
  readmooAppUrl,
} from "moo-family-bookshelf-shared/config/readmoo";
import { submitSearch, waitForBookCard } from "./readmoo-search";
import {
  ReadmooLendError,
  queryWithLegacyFallback,
  waitForElement,
} from "./readmoo-dom";
import {
  READMOO_LEND_DEFAULTS,
  dismissOpenDialogs,
  extractReadmooMembers,
  type ReadmooMember,
} from "./readmoo-lend-dialog";

// Re-exported so importers (tests, BorrowTab) keep using "./readmoo-lend"; defined in readmoo-dom to
// break the readmoo-lend ↔ readmoo-search module cycle.
export {
  ReadmooLendError,
  findBookCardInLibrary,
  waitForElement,
} from "./readmoo-dom";

// Re-exported so importers keep using "./readmoo-lend"; split out to keep this file under its line cap.
export {
  READMOO_LEND_DEFAULTS,
  closeLendDialog,
  decideLendAction,
  dismissOpenDialogs,
  extractReadmooMembers,
  selectMemberByName,
  waitForLendDialogClose,
} from "./readmoo-lend-dialog";
export type {
  DecideLendActionResult,
  ReadmooMember,
} from "./readmoo-lend-dialog";

/** Library URL on the CURRENT host, resolved per call so new and legacy hosts keep the user where they
 *  started (`/read/#/library` vs `/#/library`). */
function libraryUrlForCurrentHost(): string {
  return readmooAppUrl(window.location.hostname, LIBRARY_HASH);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOnLibraryPage(): boolean {
  const { hostname, pathname, hash } = window.location;
  return isLibraryUrl(hostname, pathname, hash);
}

/**
 * Ensure the user is on the Readmoo library page. If not, navigate there.
 * Caller must wait for navigation + library to render before continuing.
 */
export function ensureOnLibraryPage(): boolean {
  if (isOnLibraryPage()) return true;
  // Cross-page navigation unmounts the Dialog, so the caller flow needs a different strategy (e.g. a
  // new tab, or instructing the user).
  window.location.href = libraryUrlForCurrentHost();
  return false;
}

/**
 * Open Readmoo's `.book-detail-modal` for a library card.
 *
 * Verified against production read.readmoo.com (2026-07-11) and
 * next.readmoo.com (2026-08-04): the modal is opened by the hover-revealed
 * 「⋯」 overlay button, NOT the title/cover. The card's `.cover-img` sits
 * inside `a.reader-link` (opens the reader) and must never be clicked. Working
 * sequence: dispatch `mouseenter`+`mouseover` on the card to reveal
 * `.openbook-overlay`, wait ~300ms for it to render, then dispatch a single
 * `click` on `.openbook-overlay .detail span` (the ellipsis button). The legacy
 * host names that layer `.openbook`, hence the fallback below.
 *
 * Returns the modal element once it appears, or throws on timeout.
 */
export async function openBookDetailModal(
  bookCard: HTMLElement,
  timeoutMs: number = READMOO_LEND_DEFAULTS.modalOpenTimeoutMs,
): Promise<HTMLElement> {
  bookCard.scrollIntoView({ block: "center", behavior: "instant" });
  await wait(READMOO_LEND_DEFAULTS.hoverSettleMs);

  // Reveal the hover overlay by hovering the card itself.
  bookCard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  bookCard.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await wait(READMOO_LEND_DEFAULTS.hoverSettleMs);

  // Click the 「⋯」 detail button inside the overlay. NEVER target a.reader-link
  // or .cover-img — those open the Readmoo reader.
  const trigger =
    queryWithLegacyFallback<HTMLElement>(
      bookCard,
      READMOO_SELECTORS.detailTrigger,
      READMOO_SELECTORS.detailTriggerLegacy,
      "lend:detail-trigger",
    ) ??
    queryWithLegacyFallback<HTMLElement>(
      bookCard,
      READMOO_SELECTORS.detailTriggerLoose,
      READMOO_SELECTORS.detailTriggerLooseLegacy,
      "lend:detail-trigger-loose",
    );
  if (!trigger) {
    throw new ReadmooLendError(
      "DETAIL_TRIGGER_NOT_FOUND",
      "找不到書籍詳情按鈕，可能是讀墨已改版，請改用「手動借出」",
    );
  }
  trigger.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );

  return waitForElement<HTMLElement>(
    READMOO_SELECTORS.bookDetailModal,
    timeoutMs,
  );
}

/**
 * Within the open `.book-detail-modal`, click the 「借出」 menu item
 * (identified by a child `<i class="mo mo-envelope">`).
 *
 * Resolves with the resulting 「借出書籍」 dialog element.
 */
export async function clickLendButton(
  modal: HTMLElement,
  timeoutMs: number = READMOO_LEND_DEFAULTS.lendDialogOpenTimeoutMs,
): Promise<HTMLElement> {
  const envelopeIcon = modal.querySelector<HTMLElement>(
    READMOO_SELECTORS.lendIcon,
  );
  const button = envelopeIcon?.closest<HTMLElement>(
    READMOO_SELECTORS.lendButtonHost,
  );
  if (!button) {
    throw new ReadmooLendError(
      "LEND_BUTTON_NOT_FOUND",
      "找不到讀墨「借出」按鈕，可能是讀墨已改版",
    );
  }
  button.click();

  // The book-detail-modal stays open; a NEW modal with title「借出書籍」 appears.
  return waitForLendDialog(modal, timeoutMs);
}

async function waitForLendDialog(
  excluding: HTMLElement,
  timeoutMs: number,
): Promise<HTMLElement> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidates = document.querySelectorAll<HTMLElement>(
      READMOO_SELECTORS.dialog,
    );
    for (const candidate of candidates) {
      if (candidate === excluding) continue;
      const title = candidate.querySelector(READMOO_SELECTORS.dialogTitle);
      if (title?.textContent?.trim() === READMOO_LEND_DIALOG_TITLE) {
        return candidate;
      }
    }
    await wait(100);
  }
  throw new ReadmooLendError(
    "LEND_DIALOG_TIMEOUT",
    "讀墨「借出書籍」對話框未開啟",
  );
}

/**
 * High-level orchestrator: open detail modal → click 借出 → return the
 * lending dialog element + the member options inside it.
 *
 * Returns the lending dialog so callers can either:
 *   a) selectMemberByName + waitForLendDialogClose (auto-lend flow)
 *   b) extractReadmooMembers + show selection UI (readmooName setup flow)
 */
export async function openLendDialogForBook(
  bookId: string,
  bookTitle: string,
): Promise<{
  lendDialog: HTMLElement;
  detailModal: HTMLElement;
  members: ReadmooMember[];
  previousQuery: string;
}> {
  if (!isOnLibraryPage()) {
    throw new ReadmooLendError(
      "NOT_ON_LIBRARY",
      "請先切換到讀墨的「書櫃」頁面後再試一次",
    );
  }
  // The infinite-scroll grid may not render the book: filter by title via Readmoo's search, then match
  // by exact bookId; `previousQuery` lets the caller restore the user's search afterwards.
  const previousQuery = await submitSearch(bookTitle);
  try {
    const bookCard = await waitForBookCard(bookId);
    if (!bookCard) {
      // Strict mode: even if the search returned a single card, we require an
      // exact data-moo-book-id match — no title fallback (product decision).
      throw new ReadmooLendError(
        "BOOK_NOT_FOUND",
        `在書庫中搜尋不到《${bookTitle}》，請改用「手動借出」`,
      );
    }
    // TIMING: no restore on the success path — it re-renders the grid and detaches the card the click
    // below needs; the caller restores after the full flow. docs/architecture.md → 讀墨借出自動化.
    const detailModal = await openBookDetailModal(bookCard);
    const lendDialog = await clickLendButton(detailModal);
    const members = extractReadmooMembers(lendDialog);
    return { lendDialog, detailModal, members, previousQuery };
  } catch (err) {
    // A failure after the search owns the restore (no filtered library left behind): dismiss modals
    // FIRST, then restore (best-effort, never masks the rethrow). docs/architecture.md → 讀墨借出自動化.
    dismissOpenDialogs();
    await restoreLibrarySearch(previousQuery);
    throw err;
  }
}

/**
 * Restore the library grid to the user's previous search state after the lending
 * flow completes. If the user had a keyword, re-applies it; otherwise submits an
 * empty query to clear Readmoo's filter and restore the full library.
 *
 * TIMING: MUST run only after the lending flow has fully finished (detail modal
 * opened, member clicked, dialog closed). Restoring mid-flow re-renders the grid
 * and detaches the card node any pending click depends on.
 *
 * Best-effort: swallows all errors so a restore failure never masks the primary
 * lending result.
 */
export async function restoreLibrarySearch(
  previousQuery: string,
  timeoutMs?: number,
): Promise<void> {
  try {
    await submitSearch(previousQuery, timeoutMs);
  } catch {
    // Ignore — restoring the library view is non-critical.
  }
}
