/**
 * Readmoo lending automation (Scope B).
 *
 * Orchestrates clicks through Readmoo's native lending flow when the book
 * owner approves a MooFamily borrow request:
 *   1. Locate the book card in `read.readmoo.com/#/library`
 *   2. Open the book detail modal
 *   3. Click the 「借出」 button to open the lending dialog
 *   4. Select the family member matching `readmooName`
 *   5. The user manually confirms Readmoo's native window.confirm
 *   6. Wait for the lending dialog to close (signals lending completed)
 *
 * Each function is stateless to keep them independently testable.
 *
 * The native confirm alert is intentionally NOT intercepted — overriding
 * window.confirm globally would break unrelated Readmoo functionality.
 * Letting the user click OK manually keeps the integration safe.
 */

const ATTR_BOOK_ID = "data-moo-book-id";
const LIBRARY_HASH = "#/library";
const READMOO_LIBRARY_URL = "https://read.readmoo.com/#/library";

/** Default timeouts (ms) — exposed for testing. */
export const READMOO_LEND_DEFAULTS = {
  modalOpenTimeoutMs: 5000,
  lendDialogOpenTimeoutMs: 5000,
  lendDialogCloseTimeoutMs: 60000,
  bookCardSettleMs: 200,
} as const;

export interface ReadmooMember {
  name: string;
  avatar: string;
}

export class ReadmooLendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ReadmooLendError";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOnLibraryPage(): boolean {
  return (
    window.location.hostname === "read.readmoo.com" &&
    window.location.hash.startsWith(LIBRARY_HASH)
  );
}

/**
 * Ensure the user is on the Readmoo library page. If not, navigate there.
 * Caller must wait for navigation + library to render before continuing.
 */
export function ensureOnLibraryPage(): boolean {
  if (isOnLibraryPage()) return true;
  // Cross-page navigation; caller flow needs a different strategy
  // (e.g. open a new tab, or instruct user). We do NOT auto-navigate
  // here because it would unmount the Dialog UI immediately.
  window.location.href = READMOO_LIBRARY_URL;
  return false;
}

/**
 * Find the `.library-item` element matching the given bookId.
 *
 * Relies on the fiber-bridge having stamped `data-moo-book-id` on
 * library-item nodes. If the book is not on the currently-rendered
 * page (lazy loading / pagination), returns null.
 */
export function findBookCardInLibrary(bookId: string): HTMLElement | null {
  const selector = `.library-item[${ATTR_BOOK_ID}="${cssEscape(bookId)}"]`;
  return document.querySelector<HTMLElement>(selector);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

/**
 * Click the book card to open Readmoo's `.book-detail-modal`.
 * Returns the modal element once it appears, or throws on timeout.
 */
export async function openBookDetailModal(
  bookCard: HTMLElement,
  timeoutMs: number = READMOO_LEND_DEFAULTS.modalOpenTimeoutMs,
): Promise<HTMLElement> {
  bookCard.scrollIntoView({ block: "center", behavior: "instant" });
  await wait(READMOO_LEND_DEFAULTS.bookCardSettleMs);

  // Trigger Readmoo's "open detail" UI: hover then click typical title/cover area
  const target =
    bookCard.querySelector<HTMLElement>(".info .title") ??
    bookCard.querySelector<HTMLElement>(".cover-img") ??
    bookCard;
  target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

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
  const button = envelopeIcon?.closest<HTMLElement>(".cursor-pointer, button, [role='button']");
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

async function waitForLendDialog(excluding: HTMLElement, timeoutMs: number): Promise<HTMLElement> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidates = document.querySelectorAll<HTMLElement>("div[role='dialog']");
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
export function extractReadmooMembers(lendDialog: HTMLElement): ReadmooMember[] {
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
 * Throws ReadmooLendError("MEMBER_NOT_FOUND") if no match.
 *
 * After click, Readmoo shows a native window.confirm — the user must accept
 * it manually. This function returns immediately after the click.
 */
export function selectMemberByName(
  lendDialog: HTMLElement,
  readmooName: string,
): void {
  const items = lendDialog.querySelectorAll<HTMLElement>(".list-group-item");
  for (const item of items) {
    const nameEl = item.querySelector<HTMLElement>(".fw-bold");
    const name = nameEl?.textContent?.trim();
    if (name === readmooName) {
      item.click();
      return;
    }
  }
  throw new ReadmooLendError(
    "MEMBER_NOT_FOUND",
    `在讀墨借出書籍清單中找不到「${readmooName}」`,
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
 * Wait for an element matching `selector` to appear in the DOM.
 * Used by openBookDetailModal.
 */
function waitForElement<T extends HTMLElement>(
  selector: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const found = document.querySelector<T>(selector);
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new ReadmooLendError("ELEMENT_TIMEOUT", `等待元素逾時：${selector}`));
    }, timeoutMs);
  });
}

/**
 * Close any open Readmoo modal/dialog gracefully.
 * Used as cleanup if our automation needs to abort partway.
 */
export function dismissOpenDialogs(): void {
  const closes = document.querySelectorAll<HTMLElement>("[role='dialog'] .btn-close");
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
export async function openLendDialogForBook(bookId: string): Promise<{
  lendDialog: HTMLElement;
  detailModal: HTMLElement;
  members: ReadmooMember[];
}> {
  if (!isOnLibraryPage()) {
    throw new ReadmooLendError(
      "NOT_ON_LIBRARY",
      "請先前往讀墨書庫頁面（read.readmoo.com）",
    );
  }
  const bookCard = findBookCardInLibrary(bookId);
  if (!bookCard) {
    throw new ReadmooLendError(
      "BOOK_NOT_FOUND",
      "在書庫中找不到此書，可能在其他頁面或已歸還",
    );
  }
  const detailModal = await openBookDetailModal(bookCard);
  const lendDialog = await clickLendButton(detailModal);
  const members = extractReadmooMembers(lendDialog);
  return { lendDialog, detailModal, members };
}
