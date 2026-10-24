/**
 * E2E: the Dialog's CLOSED shadow root keeps its content out of the page's main world (#362).
 *
 * Runs on the REAL `dist/` (`test.use({ distVariant: "closed" })`), not the open copy the other specs
 * use. Playwright locators cannot pierce a closed root, so the Dialog is driven and read through CDP
 * (`helpers/closed-shadow-cdp.ts`) — DevTools privilege, the ground truth. `page.evaluate` IS the page's
 * main world, i.e. what a Readmoo page script can do; every attack there is checked against that truth.
 *
 * Acceptance is about consequences, not `shadowRoot === null` alone: the sync code the user sees on
 * screen must not be readable from the main world (markup, text, selectors, event paths, hit testing),
 * and a main-world click at a destructive control's coordinates must not operate it. Each negative
 * assertion has a positive companion (CDP reads the code / a real click at the button's re-settled
 * coordinates opens the confirm step), so a wrong selector or coordinate cannot make it pass vacuously.
 *
 * Not covered: the invite QR Code (Settings tab) — the sync code is the same secret and is mandatory
 * here; a main-world script patching `Element.prototype.attachShadow` before the content script runs
 * is out of scope (the closed root is hygiene, not a security boundary — docs/architecture.md →
 * 浮動按鈕與 Dialog 外殼).
 *
 * Accepted residual, pinned on purpose: Chromium's non-standard `window.find()` does search text in a
 * closed tree (the selection anchor retargets to `<body>`, so no node leaks). It is documented in
 * docs/architecture.md → 浮動按鈕與 Dialog 外殼; the assertion makes a future change flip it consciously.
 *
 * `document.getAnimations()` check: an animation inside the closed tree (a real Dialog spinner class,
 * planted via CDP) must not hand its target element to the main world.
 *
 * Ids mirror `MOO_ELEMENT_IDS` in `src/utils/extensionContext.ts`, which cannot be imported here: it
 * loads `webextension-polyfill`, which throws outside an extension context.
 */

import { test, expect } from "./helpers/extension-fixture";
import { waitForButton, waitForPageReady } from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";
import {
  createClosedShadowDriver,
  type ClosedShadowDriver,
} from "./helpers/closed-shadow-cdp";
import { API_ENDPOINT_KEY } from "../../src/constants";
import type { BrowserContext, Page } from "@playwright/test";

const HOST_ID = "moo-family-bookshelf-host";
const DIALOG_ID = "moo-family-bookshelf-dialog";
const SYNC_CODE = { selector: "[data-testid='sync-code']" };
const LEAVE_BUTTON = { selector: "button", text: "離開家庭" };
const LEAVE_CONFIRM_PROMPT = { selector: "div", text: "確定要離開嗎？" };
const MEMBERS_LOADING = { selector: ".moo-settings__members-loading" };
/** Nodes a main-world event path may hold: nothing below the host. */
const MAIN_WORLD_PATH = [
  "window",
  "#document",
  "HTML",
  "BODY",
  `DIV#${HOST_ID}`,
];

/** Points the Extension at the local Worker, loads the mock page with a unique account and opens the
 *  Dialog via the light-DOM floating button. */
async function openDialogOnMockPage(
  context: BrowserContext,
  extensionId: string,
  emailTag: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/background.js`);
  await page.evaluate(
    ({ apiUrl, key }) => chrome.storage.local.set({ [key]: apiUrl }),
    { apiUrl: WORKER_API_URL, key: API_ENDPOINT_KEY },
  );
  await page.goto(MOCK_READMOO_URL);
  await waitForPageReady(page);
  await page.evaluate((email) => {
    const emailDiv = document
      .getElementById("me-view")
      ?.querySelector('div[style*="14px"]');
    if (emailDiv) emailDiv.textContent = email;
  }, `test-${emailTag}-${Date.now()}@readmoo.com`);
  await (await waitForButton(page)).click();
  await page.waitForFunction((id) => !!document.getElementById(id), HOST_ID);
  return page;
}

/** Onboarding up to the CreatedView: returns the sync code as CDP reads it on screen. */
async function createFamily(driver: ClosedShadowDriver): Promise<string> {
  await driver.waitFor({ selector: "button", text: "開始使用" }, 30_000);
  await driver.click({ selector: "button", text: "開始使用" });
  const create = { selector: "button", text: "建立家庭公開書櫃" };
  await driver.waitFor(create, 30_000);
  await driver.click(create);
  await driver.waitFor(SYNC_CODE, 30_000);
  return (await driver.text(SYNC_CODE)).trim();
}

test.describe("Dialog shadow root isolation (real closed dist/)", () => {
  test.use({ distVariant: "closed" });

  let driver: ClosedShadowDriver | null = null;

  test.afterEach(async () => {
    await driver?.dispose().catch(() => {});
    driver = null;
  });

  test("the sync code on screen is unreachable from the page main world", async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    const page = await openDialogOnMockPage(context, extensionId, "iso");
    driver = await createClosedShadowDriver(page, HOST_ID);
    expect(await driver.rootType()).toBe("closed");

    // Ground truth: the code is rendered inside the closed root.
    const syncCode = await createFamily(driver);
    expect(syncCode).toMatch(/^moo-\S+$/);
    const familyPart = syncCode.split("@")[0];

    await test.step("markup, text and selectors do not expose it", async () => {
      const seen = await page.evaluate(
        ({ hostId, dialogId, code, part }) => {
          const host = document.getElementById(hostId);
          const html = document.documentElement.outerHTML;
          const text = document.body.innerText;
          return {
            hostFound: host !== null,
            shadowRootIsNull: host?.shadowRoot === null,
            htmlHasHost: html.includes(hostId),
            htmlHasCode: html.includes(code) || html.includes(part),
            textHasCode: text.includes(code) || text.includes(part),
            syncCodeQueried:
              document.querySelector("[data-testid='sync-code']") !== null,
            dialogQueried: document.querySelector(`#${dialogId}`) !== null,
          };
        },
        {
          hostId: HOST_ID,
          dialogId: DIALOG_ID,
          code: syncCode,
          part: familyPart,
        },
      );
      expect(seen).toEqual({
        hostFound: true,
        shadowRootIsNull: true,
        htmlHasHost: true,
        htmlHasCode: false,
        textHasCode: false,
        syncCodeQueried: false,
        dialogQueried: false,
      });
    });

    await test.step("window.find() confirms the text but hands out no inner node", async () => {
      const found = await page.evaluate((code) => {
        // Non-standard (absent from lib.dom.d.ts); Chromium implements it.
        const find = (
          window as unknown as { find: (...a: unknown[]) => boolean }
        ).find;
        const hit = find(code, true, false, true, false, false, false);
        const anchor = getSelection()?.anchorNode ?? null;
        const result = {
          hit,
          anchorInDocument:
            anchor === null || anchor.getRootNode() === document,
        };
        getSelection()?.removeAllRanges();
        return result;
      }, syncCode);
      // Pins the DOCUMENTED residual (docs/architecture.md → 浮動按鈕與 Dialog 外殼): find() searches
      // closed trees in Chromium; a future change (e.g. an iframe) must flip this consciously.
      expect(found).toEqual({ hit: true, anchorInDocument: true });
    });

    await test.step("a document capture listener sees only the host in the event path", async () => {
      await page.evaluate(() => {
        const describe = (n: EventTarget): string => {
          if (n === window) return "window";
          if (n instanceof Element)
            return n.id ? `${n.nodeName}#${n.id}` : n.nodeName;
          return n instanceof Node ? n.nodeName : "?";
        };
        const probe = { target: "", path: [] as string[] };
        const listener = (e: Event) => {
          probe.target = e.target ? describe(e.target) : "";
          probe.path = e.composedPath().map(describe);
        };
        document.addEventListener("mousedown", listener, true);
        Object.assign(window, {
          __mooProbe: probe,
          __mooProbeListener: listener,
        });
      });
      // A real click on the sync code element itself (coordinates from CDP).
      await driver!.click(SYNC_CODE);
      const probe = await page.evaluate(() => {
        const w = window as unknown as {
          __mooProbe: { target: string; path: string[] };
          __mooProbeListener: EventListener;
        };
        document.removeEventListener("mousedown", w.__mooProbeListener, true);
        return w.__mooProbe;
      });
      expect(probe.target).toBe(`DIV#${HOST_ID}`);
      expect(probe.path).toContain(`DIV#${HOST_ID}`);
      expect(probe.path.filter((n) => !MAIN_WORLD_PATH.includes(n))).toEqual(
        [],
      );
    });

    await test.step("hit testing at the code and the dialog centre returns the host", async () => {
      const points = [
        await driver!.center(SYNC_CODE),
        await driver!.center({ selector: `#${DIALOG_ID}` }),
      ];
      const hits = await page.evaluate(
        ({ pts, hostId }) =>
          pts.map(({ x, y }) => ({
            top: document.elementFromPoint(x, y)?.id ?? null,
            insideElements: document
              .elementsFromPoint(x, y)
              .filter((el) => el.getRootNode() !== document)
              .map((el) => el.nodeName),
            hostInStack: document
              .elementsFromPoint(x, y)
              .some((el) => el.id === hostId),
          })),
        { pts: points, hostId: HOST_ID },
      );
      for (const hit of hits) {
        expect(hit).toEqual({
          top: HOST_ID,
          insideElements: [],
          hostInStack: true,
        });
      }
    });

    await test.step("a main-world click at 離開家庭 does not operate it", async () => {
      await driver!.click({ selector: "button", text: "繼續" });
      await driver!.waitFor({ selector: "nav" }, 20_000);
      await driver!.click({ selector: "nav button", text: "設定" });
      await driver!.waitFor(LEAVE_BUTTON, 15_000);
      // Sections above the button (members, toggles) load async and push it down: wait for the member
      // list, then take only settled coordinates — here and again right before the real click.
      await expect
        .poll(() => driver!.exists(MEMBERS_LOADING), { timeout: 15_000 })
        .toBe(false);
      const { x, y } = await driver!.stableCenter(LEAVE_BUTTON);

      // Two main-world routes: hit testing at the button, and walking `.shadowRoot` to it.
      const clicked = await page.evaluate(
        ({ px, py, hostId, label }) => {
          const el = document.elementFromPoint(px, py);
          if (el instanceof HTMLElement) el.click();
          const viaRoot = Array.from(
            document
              .getElementById(hostId)
              ?.shadowRoot?.querySelectorAll("button") ?? [],
          ).find((b) => b.textContent?.includes(label));
          viaRoot?.click();
          return { fromPoint: el?.id ?? null, viaShadowRoot: !!viaRoot };
        },
        { px: x, py: y, hostId: HOST_ID, label: LEAVE_BUTTON.text },
      );
      expect(clicked).toEqual({ fromPoint: HOST_ID, viaShadowRoot: false });
      await page.waitForTimeout(1_000);
      expect(await driver!.exists(LEAVE_CONFIRM_PROMPT)).toBe(false);
      expect(await driver!.exists(LEAVE_BUTTON)).toBe(true);
      expect(await driver!.exists({ selector: "nav" })).toBe(true);

      // Positive companion: a real click at the button's (re-settled) coordinates opens the confirm step.
      const settled = await driver!.stableCenter(LEAVE_BUTTON);
      await page.mouse.click(settled.x, settled.y);
      await driver!.waitFor(LEAVE_CONFIRM_PROMPT, 5_000);
      await driver!.click({ selector: "button", text: "取消" });
      await driver!.waitFor(LEAVE_BUTTON, 5_000);
    });

    await page.close();
  });

  test("document.getAnimations() does not hand out elements inside the closed root", async ({
    context,
    extensionId,
  }) => {
    const page = await openDialogOnMockPage(context, extensionId, "anim");
    driver = await createClosedShadowDriver(page, HOST_ID);
    await driver.waitFor({ selector: "button", text: "開始使用" }, 30_000);

    // A real Dialog spinner class (its keyframes live in the root's stylesheet), outside React's tree.
    const runningInside = await driver.evaluate<number>(
      `function (dialogId) {
      const probe = document.createElement("div");
      probe.className = "moo-loading-state__spinner";
      probe.setAttribute("data-moo-probe", "");
      this.getElementById(dialogId).appendChild(probe);
      return probe.getAnimations().length;
    }`,
      DIALOG_ID,
    );
    expect(runningInside).toBeGreaterThan(0);

    const leaked = await page.evaluate(() =>
      document
        .getAnimations()
        .map((a) =>
          a.effect instanceof KeyframeEffect ? a.effect.target : null,
        )
        .filter((t): t is Element => t !== null && t.getRootNode() !== document)
        .map((t) => `${t.nodeName}.${t.className}`),
    );
    expect(leaked).toEqual([]);

    await driver.evaluate(
      `function () { this.querySelector("[data-moo-probe]")?.remove(); }`,
    );
    await page.close();
  });
});

test.describe("Open E2E copy (dist-e2e-open/)", () => {
  // Sanity for the build guard: the copy the other specs load really is open.
  test("exposes the Dialog shadow root to page scripts", async ({
    context,
    extensionId,
  }) => {
    const page = await openDialogOnMockPage(context, extensionId, "open");
    const mode = await page.evaluate(
      (id) => document.getElementById(id)?.shadowRoot?.mode ?? null,
      HOST_ID,
    );
    expect(mode).toBe("open");
    await page.close();
  });
});
