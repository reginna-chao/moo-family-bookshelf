/** Readmoo lending automation (Scope B): clicks through Readmoo's native lending flow on an approved
 *  borrow; never intercepts window.confirm. See docs/architecture.md → 讀墨借出自動化. */

import {
  LIBRARY_HASH,
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

// Re-exported so importers (tests, BorrowTab) keep using "./readmoo-lend"; defined in readmoo-dom to
// break the readmoo-lend ↔ readmoo-search module cycle.
export {
  ReadmooLendError,
  findBookCardInLibrary,
  waitForElement,
} from "./readmoo-dom";

/** Library URL on the CURRENT host, resolved per call so new and legacy hosts keep the user where they
 *  started (`/read/#/library` vs `/#/library`). */
function libraryUrlForCurrentHost(): string {
  return readmooAppUrl(window.location.hostname, LIBRARY_HASH);
}

/** Default timeouts (ms) — exposed for testing. */
export const READMOO_LEND_DEFAULTS = {
  modalOpenTimeoutMs: 5000,
  lendDialogOpenTimeoutMs: 5000,
  lendDialogCloseTimeoutMs: 60000,
  hoverSettleMs: 300,
} as const;

export interface ReadmooMember {
  name: string;
  avatar: string;
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

  return waitForElement<HTMLElement>(".book-detail-modal", timeoutMs);
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
  const envelopeIcon = modal.querySelector<HTMLElement>("i.mo-envelope");
  const button = envelopeIcon?.closest<HTMLElement>(
    ".cursor-pointer, button, [role='button']",
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
    const candidates =
      document.querySelectorAll<HTMLElement>("div[role='dialog']");
    for (const candidate of candidates) {
      if (candidate === excluding) continue;
      const title = candidate.querySelector(".modal-title");
      if (title?.textContent?.trim() === "借出書籍") {
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
 * Read the family member options shown inside Readmoo's 「借出書籍」 dialog.
 * Used both for matching by `readmooName` and for the readmooName setup flow.
 */
export function extractReadmooMembers(
  lendDialog: HTMLElement,
): ReadmooMember[] {
  const items = lendDialog.querySelectorAll<HTMLElement>(".list-group-item");
  const members: ReadmooMember[] = [];
  for (const item of items) {
    const nameEl = item.querySelector<HTMLElement>(".fw-bold");
    const avatarEl = item.querySelector<HTMLImageElement>("img");
    const name = nameEl?.textContent?.trim() ?? "";
    if (!name) continue;
    members.push({
      name,
      avatar: avatarEl?.getAttribute("src") ?? "",
    });
  }
  return members;
}

/**
 * Click the lending dialog's member button whose name matches `readmooName`.
 *
 * Returns `true` if a matching member was found and clicked, `false` otherwise.
 * Callers that need a UI fallback (e.g., show a picker) can act on `false`
 * without catching a thrown error.
 *
 * After click, Readmoo shows a native window.confirm — the user must accept
 * it manually. This function returns immediately after the click.
 */
export function selectMemberByName(
  lendDialog: HTMLElement,
  readmooName: string,
): boolean {
  const items = lendDialog.querySelectorAll<HTMLElement>(".list-group-item");
  for (const item of items) {
    const nameEl = item.querySelector<HTMLElement>(".fw-bold");
    const name = nameEl?.textContent?.trim();
    if (name === readmooName) {
      item.click();
      return true;
    }
  }
  return false;
}

/**
 * Lend action mode resolved before any UI is shown to the owner.
 *
 *  - "auto-single": exactly one option in Readmoo's dialog — click it directly,
 *     no readmooName persistence needed.
 *  - "auto-match": n ≥ 2 AND a stored `readmooName` matches one of the options —
 *     click the matched option, no picker needed.
 *  - "needs-pick": n ≥ 2 AND (no stored `readmooName` OR no match) — surface
 *     the picker UI so the owner can choose; on confirm we PATCH readmooName.
 */
export interface DecideLendActionResult {
  mode: "auto-single" | "auto-match" | "needs-pick";
  target?: ReadmooMember;
}

/**
 * Pure decision helper: given the Readmoo dialog's current member list and the
 * (optional) cached `readmooName`, return the action the caller should take.
 * Side-effect free so it is trivial to table-test.
 */
export function decideLendAction(
  members: ReadmooMember[],
  readmooName?: string,
): DecideLendActionResult {
  if (members.length === 1) {
    return { mode: "auto-single", target: members[0] };
  }
  const trimmed = readmooName?.trim();
  if (trimmed) {
    const match = members.find((m) => m.name === trimmed);
    if (match) return { mode: "auto-match", target: match };
  }
  return { mode: "needs-pick" };
}

/**
 * Close the Readmoo lending dialog if it is still open.
 *
 * Used when the owner cancels the readmoo member picker — we should not leave
 * the user staring at Readmoo's dialog after our UI closes.
 *
 * Strategy: prefer the dialog's own close button; fall back to dispatching
 * Escape against the dialog. Best-effort; if neither works the dialog will
 * close on the next user interaction.
 */
export function closeLendDialog(lendDialog: HTMLElement): void {
  if (!lendDialog.isConnected) return;
  const closeBtn = lendDialog.querySelector<HTMLElement>(".btn-close");
  if (closeBtn) {
    closeBtn.click();
    return;
  }
  lendDialog.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

/**
 * Wait for the lending dialog to disappear from the DOM. A successful
 * lending closes the dialog; cancel keeps it open. Returns true if the
 * dialog closed within the timeout, false on timeout.
 *
 * Uses MutationObserver for efficiency (vs. polling).
 */
export function waitForLendDialogClose(
  lendDialog: HTMLElement,
  timeoutMs: number = READMOO_LEND_DEFAULTS.lendDialogCloseTimeoutMs,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!lendDialog.isConnected) {
      resolve(true);
      return;
    }
    let resolved = false;
    const finish = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(success);
    };

    const observer = new MutationObserver(() => {
      if (!lendDialog.isConnected) finish(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Close any open Readmoo modal/dialog gracefully.
 * Used as cleanup if our automation needs to abort partway.
 */
export function dismissOpenDialogs(): void {
  const closes = document.querySelectorAll<HTMLElement>(
    "[role='dialog'] .btn-close",
  );
  for (const btn of closes) {
    btn.click();
  }
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
