/**
 * E2E: the Readmoo store-page chip (#313) on a real Chrome with the E2E build loaded.
 *
 * Production registers `content-store.js` at runtime, only after the user grants the optional host
 * permission on the options page — a browser prompt Playwright cannot click. `pnpm build:e2e` therefore
 * registers it statically for `http://localhost:*\/book/*` (see .claude/rules/test.md → E2E tooling),
 * and these specs seed the state the switch + Dialog would have produced: the stored account, a family,
 * the switch on, the host-permission mirror `moo:storePageHostGranted` on, and the index (built for
 * that account AND that family, at `new Date()` so it is fresh). `build:e2e` also lists the store host
 * in the E2E manifest's `host_permissions`, so the background's own reconcile keeps the mirror TRUE
 * rather than overwriting the seed with FALSE. The fixture page is `tests/e2e/fixtures/book/{bookId}.html`, served with
 * clean URLs at `/book/{bookId}`.
 *
 * The page's account is confirmed through Readmoo's login cookie, so each spec sets it on localhost with
 * the value format Readmoo writes (`encodeURIComponent(base64(email))`), for the email whose
 * `deriveUserId` is the seeded userId. `content.js` also runs on this page (the build adds localhost to
 * its matches), so the floating button is present too; the specs assert on the chip only.
 *
 * The chip renders inside a CLOSED shadow root under the light-DOM host `#moo-store-chip-host`;
 * `build:e2e` opens that root in `dist-e2e-open/` (the fixture's default), so a CSS locator pierces it.
 *
 * The "switched off" spec ends by switching on and seeing the chip appear: that proves the script was
 * live and listening, so the earlier "no chip" was not vacuous.
 */

import { test, expect } from "./helpers/extension-fixture";
import type { BrowserContext, Locator, Page, Worker } from "@playwright/test";
import { FIXTURES_BASE_URL, WORKER_API_URL } from "./helpers/mock-server";
import {
  API_ENDPOINT_KEY,
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "../../src/constants";
import { READMOO_EMAIL_COOKIE } from "../../src/content/pageAccountCookie";
import { STORE_CHIP_HOST_ID } from "../../src/content/storePage/chip";
// Relative paths, not the `moo-family-bookshelf-shared/*` alias (see book-sharing.spec.ts).
import { deriveUserId } from "../../../shared/src/crypto/hash";
import {
  buildStorePageIndex,
  formatStoreChipText,
} from "../../../shared/src/storePage/index";

const BOOK_ID = "210000000000001";
const BOOK_URL = `${FIXTURES_BASE_URL}/book/${BOOK_ID}`;
const EMAIL = "store-chip@example.com";
// The index is bound to this family; the store page shows nothing for an index of another family.
const FAMILY_ID = "fam-store-chip";
// Mirrors BoolFlag (shared/src/api/types.ts); a numeric literal keeps this spec off the enum import.
const FLAG_TRUE = 1;
const FLAG_FALSE = 0;

/** The chip inside its host's shadow root (opened in dist-e2e-open/; see the header). */
function chipIn(page: Page): Locator {
  return page.locator(`#${STORE_CHIP_HOST_ID} .moo-store-chip`);
}

async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  return (
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  );
}

async function seedStorage(
  context: BrowserContext,
  items: Record<string, unknown>,
): Promise<void> {
  const worker = await serviceWorkerOf(context);
  await worker.evaluate(async (toStore) => {
    await chrome.storage.local.set(toStore);
  }, items);
}

/** Log `EMAIL` in on the fixture host, as Readmoo's login would. */
async function setLoginCookie(context: BrowserContext): Promise<void> {
  const value = encodeURIComponent(
    Buffer.from(EMAIL, "utf8").toString("base64"),
  );
  await context.addCookies([
    { name: READMOO_EMAIL_COOKIE, value, url: FIXTURES_BASE_URL },
  ]);
}

/** The index the Dialog would write for `EMAIL`'s account: two members share the book, and so does
 *  the viewer, who must never be named. */
async function indexForViewer(): Promise<
  ReturnType<typeof buildStorePageIndex>
> {
  const userId = await deriveUserId(EMAIL);
  return buildStorePageIndex(
    [
      { userId, displayName: "我自己", books: [{ bookId: BOOK_ID }] },
      { userId: "member-a", displayName: "小明", books: [{ bookId: BOOK_ID }] },
      { userId: "member-b", displayName: "小華", books: [{ bookId: BOOK_ID }] },
    ],
    userId,
    FAMILY_ID,
    new Date(),
  );
}

async function seedEligibleState(
  context: BrowserContext,
  switchFlag: number,
): Promise<void> {
  await seedStorage(context, {
    [API_ENDPOINT_KEY]: WORKER_API_URL,
    [USER_ID_KEY]: await deriveUserId(EMAIL),
    [FAMILY_ID_KEY]: FAMILY_ID,
    [STORE_PAGE_CHIP_ENABLED_KEY]: switchFlag,
    [STORE_PAGE_HOST_GRANTED_KEY]: FLAG_TRUE,
    [STORE_PAGE_INDEX_KEY]: await indexForViewer(),
  });
  await setLoginCookie(context);
}

test.describe("Store-page chip", () => {
  test("names the family members who shared the book, under the title", async ({
    context,
    extensionId,
  }) => {
    expect(extensionId).toBeTruthy();
    await seedEligibleState(context, FLAG_TRUE);

    const page = await context.newPage();
    await page.goto(BOOK_URL);

    const chip = chipIn(page);
    await expect(chip).toHaveText(formatStoreChipText(["小明", "小華"]), {
      timeout: 15_000,
    });
    // The host sits right after the title; the viewer's own name is never listed.
    await expect(
      page.locator(`h1.book-detail-title + #${STORE_CHIP_HOST_ID}`),
    ).toHaveCount(1);
    await expect(page.locator(`#${STORE_CHIP_HOST_ID}`)).toHaveCount(1);
    await expect(chip).not.toContainText("我自己");

    await page.close();
  });

  test("shows nothing while the switch is off, and appears once switched on", async ({
    context,
    extensionId,
  }) => {
    expect(extensionId).toBeTruthy();
    await seedEligibleState(context, FLAG_FALSE);

    const page = await context.newPage();
    await page.goto(BOOK_URL);
    await page.waitForLoadState("load");
    // Give the document_idle script time to run and decide.
    await page.waitForTimeout(1_500);
    await expect(page.locator(`#${STORE_CHIP_HOST_ID}`)).toHaveCount(0);

    // As the Dialog does: switch on, then write the index (the background clears it while off).
    await seedStorage(context, {
      [STORE_PAGE_CHIP_ENABLED_KEY]: FLAG_TRUE,
      [STORE_PAGE_INDEX_KEY]: await indexForViewer(),
    });

    await expect(chipIn(page)).toHaveText(
      formatStoreChipText(["小明", "小華"]),
      { timeout: 15_000 },
    );

    await page.close();
  });
});
