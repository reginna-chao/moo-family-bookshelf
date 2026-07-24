/**
 * Readmoo library search automation (Scope B lending support).
 *
 * Readmoo's library grid is infinite-scroll, so a book the owner wants to lend
 * may not be in the currently-rendered DOM at all. This module drives Readmoo's
 * built-in search modal to filter the library down to a target book by title,
 * then re-stamps fiber ids so the card can be matched exactly by `bookId`.
 *
 * Each function is stateless to keep them independently testable; timeouts are
 * injectable and failures throw `ReadmooLendError`.
 */

import { requestFiberData } from "./fiber-data";
import {
  ReadmooLendError,
  findBookCardInLibrary,
  waitForElement,
} from "./readmoo-dom";

/** Default timeouts (ms) — exposed for testing. */
export const READMOO_SEARCH_DEFAULTS = {
  searchModalOpenTimeoutMs: 5000,
  searchModalCloseTimeoutMs: 5000,
  bookCardPollTimeoutMs: 5000,
  bookCardPollIntervalMs: 200,
} as const;

const SEARCH_MODAL_SELECTOR = ".search-modal";
const SEARCH_INPUT_SELECTOR = ".search-modal input.form-control";
const SEARCH_SUBMIT_SELECTOR = "button[type='submit']";
const SEARCH_ICON_SELECTOR = "i.mo-search";
const SEARCH_BUTTON_SELECTOR = ".desktop-top-nav-btn";

export interface SearchModalRefs {
  modal: HTMLElement;
  input: HTMLInputElement;
  submitButton: HTMLButtonElement;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function searchUiNotFound(): ReadmooLendError {
  return new ReadmooLendError(
    "SEARCH_UI_NOT_FOUND",
    "找不到讀墨搜尋功能，可能是讀墨已改版，請改用「手動借出」",
  );
}

function findSearchButton(): HTMLElement | null {
  const icon = document.querySelector<HTMLElement>(SEARCH_ICON_SELECTOR);
  return icon?.closest<HTMLElement>(SEARCH_BUTTON_SELECTOR) ?? null;
}

/**
 * Click the top-nav search button and wait for the search modal's input to
 * render. Throws `SEARCH_UI_NOT_FOUND` if the search UI is missing (Readmoo
 * redesign) or the modal never appears.
 */
export async function openSearchModal(
  timeoutMs: number = READMOO_SEARCH_DEFAULTS.searchModalOpenTimeoutMs,
): Promise<SearchModalRefs> {
  const button = findSearchButton();
  if (!button) throw searchUiNotFound();
  button.click();

  let input: HTMLInputElement;
  try {
    input = await waitForElement<HTMLInputElement>(
      SEARCH_INPUT_SELECTOR,
      timeoutMs,
    );
  } catch {
    throw searchUiNotFound();
  }

  const modal = input.closest<HTMLElement>(SEARCH_MODAL_SELECTOR);
  const submitButton = modal?.querySelector<HTMLButtonElement>(
    SEARCH_SUBMIT_SELECTOR,
  );
  if (!modal || !submitButton) throw searchUiNotFound();

  return { modal, input, submitButton };
}

/**
 * Set a React-controlled input's value using the native value setter, then
 * dispatch an `input` event so React's onChange fires. Directly assigning
 * `input.value` would be ignored by React's controlled-input tracking.
 */
function setControlledInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Wait for the search modal to leave the DOM (Readmoo auto-closes it on submit).
 * Best-effort: resolves on timeout too, since the grid re-render — not the modal
 * removal — is what the caller actually depends on.
 */
function waitForModalGone(
  modal: HTMLElement,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (!modal.isConnected) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (!modal.isConnected) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Open the search modal, submit `query`, and wait for the modal to close.
 *
 * Returns the input's PRE-EXISTING value (Readmoo preserves the last keyword
 * across opens) so the caller can restore the user's original search state
 * after the lending flow completes.
 */
export async function submitSearch(
  query: string,
  timeoutMs: number = READMOO_SEARCH_DEFAULTS.searchModalOpenTimeoutMs,
): Promise<string> {
  const { modal, input, submitButton } = await openSearchModal(timeoutMs);
  const previousQuery = input.value;
  setControlledInputValue(input, query);
  submitButton.click();
  await waitForModalGone(
    modal,
    READMOO_SEARCH_DEFAULTS.searchModalCloseTimeoutMs,
  );
  return previousQuery;
}

/** Re-stamp fiber ids then look for the target card in the filtered grid. */
async function stampAndFind(bookId: string): Promise<HTMLElement | null> {
  await requestFiberData();
  return findBookCardInLibrary(bookId);
}

/**
 * Poll for the target book card after a search re-renders the grid. Each round
 * re-stamps `data-moo-book-id` (the grid may still be rendering) before matching
 * by exact `bookId`. Returns the card element, or `null` once `timeoutMs` elapses.
 */
export async function waitForBookCard(
  bookId: string,
  timeoutMs: number = READMOO_SEARCH_DEFAULTS.bookCardPollTimeoutMs,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  let card = await stampAndFind(bookId);
  while (!card && Date.now() < deadline) {
    await wait(READMOO_SEARCH_DEFAULTS.bookCardPollIntervalMs);
    card = await stampAndFind(bookId);
  }
  return card;
}
