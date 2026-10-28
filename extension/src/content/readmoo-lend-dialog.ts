/** Readmoo 「借出書籍」 dialog helpers: read and pick its member options, then close it. Re-exported by
 *  `./readmoo-lend`, the single import entry. See docs/architecture.md → 讀墨借出自動化. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

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

/**
 * Read the family member options shown inside Readmoo's 「借出書籍」 dialog.
 * Used both for matching by `readmooName` and for the readmooName setup flow.
 */
export function extractReadmooMembers(
  lendDialog: HTMLElement,
): ReadmooMember[] {
  const items = lendDialog.querySelectorAll<HTMLElement>(
    READMOO_SELECTORS.lendMemberItem,
  );
  const members: ReadmooMember[] = [];
  for (const item of items) {
    const nameEl = item.querySelector<HTMLElement>(
      READMOO_SELECTORS.lendMemberName,
    );
    const avatarEl = item.querySelector<HTMLImageElement>(
      READMOO_SELECTORS.lendMemberAvatar,
    );
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
  const items = lendDialog.querySelectorAll<HTMLElement>(
    READMOO_SELECTORS.lendMemberItem,
  );
  for (const item of items) {
    const nameEl = item.querySelector<HTMLElement>(
      READMOO_SELECTORS.lendMemberName,
    );
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
  const closeBtn = lendDialog.querySelector<HTMLElement>(
    READMOO_SELECTORS.dialogClose,
  );
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
    READMOO_SELECTORS.anyDialogClose,
  );
  for (const btn of closes) {
    btn.click();
  }
}
