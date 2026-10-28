/** Interactive checks: open Readmoo's filter, search and lend UI just far enough to check their selectors,
 *  never applying, submitting or lending anything. See .claude/rules/test.md → E2E tooling (extension/scripts). */

import type { Dialog, Locator, Page } from "@playwright/test";
import { READMOO_LEND_DIALOG_TITLE } from "moo-family-bookshelf-shared/config/readmoo";
import {
  checkSelectors,
  failSpecs,
  recordResult,
  reloadLibrary,
  skipSpecs,
  type Site,
} from "./verify-selectors-page";
import type {
  CheckResult,
  SelectorKey,
  SelectorMap,
  SelectorSpec,
} from "./verify-selectors-specs";

/** `waitForElement(filterModalOpen, 3000)` in extension/src/content/scraper-archive.ts. */
const FILTER_MODAL_MS = 3000;
/** `READMOO_SEARCH_DEFAULTS.searchModalOpenTimeoutMs` in extension/src/content/readmoo-search.ts. */
const SEARCH_MODAL_MS = 5000;
/** `READMOO_LEND_DEFAULTS.modalOpenTimeoutMs` in extension/src/content/readmoo-lend-dialog.ts. */
const DETAIL_MODAL_MS = 5000;
/** `READMOO_LEND_DEFAULTS.lendDialogOpenTimeoutMs` in extension/src/content/readmoo-lend-dialog.ts. */
const LEND_DIALOG_MS = 5000;
/** `READMOO_LEND_DEFAULTS.hoverSettleMs` in extension/src/content/readmoo-lend-dialog.ts. */
const HOVER_SETTLE_MS = 300;
/** Poll interval of `waitForLendDialog` in extension/src/content/readmoo-lend.ts. */
const LEND_DIALOG_POLL_MS = 100;

/** Run one flow with every native dialog dismissed, then reload the library whatever happened.
 *  A thrown flow reports its `specs` ❌ instead of aborting the run. */
async function runFlow(
  page: Page,
  site: Site,
  title: string,
  specs: readonly SelectorSpec[],
  body: () => Promise<CheckResult[]>,
): Promise<CheckResult[]> {
  console.log(`\n--- [${site.label}] ${title} ---\n`);
  const dismiss = (dialog: Dialog): void => {
    void dialog.dismiss().catch(() => undefined);
  };
  page.on("dialog", dismiss);
  try {
    return await body();
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`  ⚠️  流程中斷：${reason}`);
    return failSpecs(specs, site);
  } finally {
    await reloadLibrary(page, site).catch(() => false);
    page.off("dialog", dismiss);
  }
}

/** The specs covering any of `keys`, in list order. */
function specsWith(
  specs: readonly SelectorSpec[],
  ...keys: SelectorKey[]
): SelectorSpec[] {
  return specs.filter((spec) => spec.keys.some((key) => keys.includes(key)));
}

/** Resolve true once `selector` is in the DOM (the content scripts poll for attachment too). */
function waitAttached(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** Click the top-nav button holding `icon` and wait for `modal`; false when the button is missing. */
async function openNavModal(
  page: Page,
  s: SelectorMap,
  icon: string,
  modal: string,
  timeoutMs: number,
): Promise<boolean> {
  const button = page
    .locator(s.topNavBtn)
    .filter({ has: page.locator(icon) })
    .first();
  if ((await button.count()) === 0) return false;
  await button.dispatchEvent("click");
  await waitAttached(page, modal, timeoutMs);
  return true;
}

/** Open the filter modal and check it; 「確定」 and the filter options are never clicked. */
export function checkArchiveFlow(
  page: Page,
  site: Site,
  selectors: SelectorMap,
  specs: readonly SelectorSpec[],
): Promise<CheckResult[]> {
  return runFlow(
    page,
    site,
    "封存流程（只打開篩選視窗，不套用）",
    specs,
    async () => {
      const opened = await openNavModal(
        page,
        selectors,
        selectors.filterIcon,
        selectors.filterModalOpen,
        FILTER_MODAL_MS,
      );
      if (!opened) return failSpecs(specs, site);
      return checkSelectors(page, specs, site, "attr");
    },
  );
}

/** Open the search modal and check it; nothing is typed and the search is never submitted. */
export function checkSearchFlow(
  page: Page,
  site: Site,
  selectors: SelectorMap,
  specs: readonly SelectorSpec[],
): Promise<CheckResult[]> {
  return runFlow(
    page,
    site,
    "搜尋流程（只打開搜尋視窗，不送出）",
    specs,
    async () => {
      const opened = await openNavModal(
        page,
        selectors,
        selectors.searchIcon,
        selectors.searchModal,
        SEARCH_MODAL_MS,
      );
      if (!opened) return failSpecs(specs, site);
      return checkSelectors(page, specs, site, "attr");
    },
  );
}

/** The lend list split by the state each row needs; every row lands in exactly one stage. */
interface LendStages {
  card: SelectorSpec[];
  detail: SelectorSpec[];
  host: SelectorSpec[];
  dialog: SelectorSpec[];
  member: SelectorSpec[];
  leftover: SelectorSpec[];
}

function splitLendSpecs(specs: readonly SelectorSpec[]): LendStages {
  return {
    card: specsWith(
      specs,
      "libraryItem",
      "detailTrigger",
      "detailTriggerLegacy",
      "detailTriggerLoose",
      "detailTriggerLooseLegacy",
    ),
    detail: specsWith(specs, "bookDetailModal", "lendIcon"),
    host: specsWith(specs, "lendButtonHost"),
    dialog: specsWith(specs, "dialogTitle", "dialogClose"),
    member: specsWith(specs, "lendMemberName", "lendMemberAvatar"),
    leftover: specsWith(specs, "anyDialogClose"),
  };
}

/** Dispatch a click on the card's 「⋯」 button, as `openBookDetailModal` does; false when absent. */
async function clickDetailTrigger(
  card: Locator,
  site: Site,
  s: SelectorMap,
): Promise<boolean> {
  const candidates =
    site.id === "next"
      ? [s.detailTrigger, s.detailTriggerLoose]
      : [s.detailTriggerLegacy, s.detailTriggerLooseLegacy];
  for (const selector of candidates) {
    const trigger = card.locator(selector).first();
    if ((await trigger.count()) === 0) continue;
    await trigger.dispatchEvent("click");
    return true;
  }
  return false;
}

/** Click `closest(lendButtonHost)` of the detail modal's lend icon, as `clickLendButton` does. */
async function clickLendButton(page: Page, s: SelectorMap): Promise<boolean> {
  const icon = page.locator(`${s.bookDetailModal} ${s.lendIcon}`).first();
  if ((await icon.count()) === 0) return false;
  return icon.evaluate((el, hostSelector) => {
    const button = el.closest<HTMLElement>(hostSelector);
    button?.click();
    return button !== null;
  }, s.lendButtonHost);
}

interface LendDialogQuery {
  dialog: string;
  title: string;
  detail: string;
  text: string;
}

/** Runs in the page: index of the dialog titled `text` that is not the detail modal, or -1. */
function lendDialogIndex(q: LendDialogQuery): number {
  const detail = document.querySelector(q.detail);
  return Array.from(document.querySelectorAll(q.dialog)).findIndex(
    (c) =>
      c !== detail && c.querySelector(q.title)?.textContent?.trim() === q.text,
  );
}

/** Poll for the lend dialog the way `waitForLendDialog` does; null on timeout. */
async function findLendDialog(
  page: Page,
  s: SelectorMap,
): Promise<Locator | null> {
  const query: LendDialogQuery = {
    dialog: s.dialog,
    title: s.dialogTitle,
    detail: s.bookDetailModal,
    text: READMOO_LEND_DIALOG_TITLE,
  };
  const deadline = Date.now() + LEND_DIALOG_MS;
  while (Date.now() < deadline) {
    const index = await page.evaluate(lendDialogIndex, query);
    if (index >= 0) return page.locator(s.dialog).nth(index);
    await page.waitForTimeout(LEND_DIALOG_POLL_MS);
  }
  return null;
}

/** Card → detail modal → lend dialog; rows of a state that was never reached are reported missing. */
async function openLendDialog(
  page: Page,
  site: Site,
  s: SelectorMap,
  stage: LendStages,
  card: Locator,
): Promise<{ results: CheckResult[]; lendDialog: Locator | null }> {
  if (!(await clickDetailTrigger(card, site, s))) {
    const results = failSpecs([...stage.detail, ...stage.host], site);
    return { results, lendDialog: null };
  }
  await waitAttached(page, s.bookDetailModal, DETAIL_MODAL_MS);
  const results = await checkSelectors(page, stage.detail, site, "attr");
  const clicked = await clickLendButton(page, s);
  for (const spec of stage.host) {
    const count = clicked ? 1 : 0;
    results.push(recordResult(spec, site, { found: clicked, count }));
  }
  const lendDialog = clicked ? await findLendDialog(page, s) : null;
  return { results, lendDialog };
}

/** Check the open lend dialog; an empty member list makes the member rows not checkable. */
async function checkLendDialog(
  page: Page,
  site: Site,
  s: SelectorMap,
  stage: LendStages,
  lendDialog: Locator,
): Promise<CheckResult[]> {
  const memberCount = await lendDialog.locator(s.lendMemberItem).count();
  const results = await checkSelectors(page, stage.dialog, site, "attr");
  if (memberCount === 0) {
    return [...results, ...skipSpecs(stage.member, site, "讀墨借出名單是空的")];
  }
  return [
    ...results,
    ...(await checkSelectors(page, stage.member, site, "attr")),
  ];
}

/** Close the lend dialog with its close button, else Escape — as `closeLendDialog` does. */
async function closeLendDialog(
  lendDialog: Locator,
  s: SelectorMap,
): Promise<void> {
  const close = lendDialog.locator(s.dialogClose).first();
  if ((await close.count()) > 0) {
    await close.dispatchEvent("click");
    return;
  }
  await lendDialog.dispatchEvent("keydown", { key: "Escape", bubbles: true });
}

/** Runs in the page: click every match of `selector`, as `dismissOpenDialogs` does. */
function clickAll(selector: string): void {
  const buttons = document.querySelectorAll<HTMLElement>(selector);
  buttons.forEach((btn) => btn.click());
}

/** Close the lend dialog and every other dialog, then count the close buttons still present. */
async function closeLendFlow(
  page: Page,
  site: Site,
  s: SelectorMap,
  leftover: readonly SelectorSpec[],
  lendDialog: Locator | null,
): Promise<CheckResult[]> {
  if (lendDialog) await closeLendDialog(lendDialog, s);
  await page.evaluate(clickAll, s.anyDialogClose);
  await page
    .locator(s.anyDialogClose)
    .first()
    .waitFor({ state: "detached", timeout: DETAIL_MODAL_MS })
    .catch(() => undefined);
  const count = await page.locator(s.anyDialogClose).count();
  return leftover.map((spec) =>
    recordResult(spec, site, { found: count === 0, count }),
  );
}

/** Open an own book's lend dialog and check it; no member is ever clicked, so nothing can be lent. */
export function checkLendFlow(
  page: Page,
  site: Site,
  selectors: SelectorMap,
  specs: readonly SelectorSpec[],
): Promise<CheckResult[]> {
  const s = selectors;
  return runFlow(
    page,
    site,
    "借出流程（只打開借出對話框，不選成員）",
    specs,
    async () => {
      const stage = splitLendSpecs(specs);
      const card = page
        .locator(`${s.libraryItem}:not(:has(${s.borrowedBadge}))`)
        .first();
      if ((await card.count()) === 0) {
        return skipSpecs(specs, site, "書櫃裡沒有自己買的書");
      }
      await card.hover();
      await page.waitForTimeout(HOVER_SETTLE_MS);
      const cardResults = await checkSelectors(page, stage.card, site, "attr");
      const opened = await openLendDialog(page, site, s, stage, card);
      const dialogResults = opened.lendDialog
        ? await checkLendDialog(page, site, s, stage, opened.lendDialog)
        : failSpecs([...stage.dialog, ...stage.member], site);
      const closeResults = await closeLendFlow(
        page,
        site,
        s,
        stage.leftover,
        opened.lendDialog,
      );
      return [
        ...cardResults,
        ...opened.results,
        ...dialogResults,
        ...closeResults,
      ];
    },
  );
}
