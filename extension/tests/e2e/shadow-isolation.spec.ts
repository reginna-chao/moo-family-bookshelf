/**
 * E2E: the Dialog's CLOSED shadow root keeps its content out of the page's main world (#362), and the
 * secrets moved into the extension-origin secure frame (#363) stay out of it entirely.
 *
 * Runs on the REAL `dist/` (`test.use({ distVariant: "closed" })`), not the open copy the other specs
 * use. Playwright locators cannot pierce a closed root, so two privileged routes are the ground truth:
 * the Shadow Root is driven and read through CDP (`helpers/closed-shadow-cdp.ts`), and the secure
 * frame — a separate document the CDP driver cannot enter — is taken by URL from `page.frames()`
 * (`secureFrameWith`; no locator reaches the iframe element itself). `page.evaluate` IS the page's main
 * world, i.e. what a Readmoo page script can do; every attack there is checked against that truth.
 *
 * Acceptance is about consequences, not `shadowRoot === null` alone: the sync code the user sees on
 * screen must not be readable from the main world (markup, text, selectors, `window.find()`,
 * `window.frames`, event paths, hit testing), keys typed into the PIN and sync-code fields must not
 * reach the page's listeners, and a main-world click at a destructive control's coordinates must not
 * operate it. Each negative assertion has a positive companion run the same way on something that
 * stays in the Shadow Root (find() hits the CreatedView heading; a click on that heading and a key on a
 * Shadow Root button reach the page's listeners as the host; Playwright sees the frames
 * `window.frames` cannot read; a real click at the button's re-settled coordinates opens the confirm
 * step), so a wrong selector, listener or coordinate cannot make it pass vacuously.
 *
 * `window.find()`: before #363 the code sat in the closed tree and Chromium's non-standard find()
 * matched it (the selection anchor retargets to `<body>`, so no node leaked); that residual was pinned
 * here. Now the code is in another document and find() misses it, while text left in the Shadow Root
 * (the heading — and the public-shelf link, docs/architecture.md → 浮動按鈕與 Dialog 外殼) is still
 * found: the residual is pinned on that heading instead, so a future change flips it consciously.
 *
 * Not covered: the invite QR Code's pixels (Settings tab) — the sync code is the same secret and is
 * mandatory here; the QR frame only counts toward the `window.frames` check. A main-world script
 * patching `Element.prototype.attachShadow` before the content script runs is out of scope (the closed
 * root is hygiene, not a security boundary — docs/architecture.md → 浮動按鈕與 Dialog 外殼).
 *
 * The PIN field is reached through Settings → 登入驗證 → PIN 碼 (a new account has no method yet, so
 * the setup PinInput opens without a current-secret step); nothing is submitted.
 *
 * `document.getAnimations()` check: an animation inside the closed tree (a real Dialog spinner class,
 * planted via CDP) must not hand its target element to the main world.
 *
 * Ids mirror `MOO_ELEMENT_IDS` in `src/utils/extensionContext.ts`, which cannot be imported here: it
 * loads `webextension-polyfill`, which throws outside an extension context.
 */

import { test, expect } from "./helpers/extension-fixture";
import {
  SECURE_FRAME_URL,
  waitForButton,
  waitForPageReady,
} from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";
import {
  createClosedShadowDriver,
  type ClosedShadowDriver,
  type ElementQuery,
} from "./helpers/closed-shadow-cdp";
import { API_ENDPOINT_KEY } from "../../src/constants";
import type { BrowserContext, Frame, Page } from "@playwright/test";

const HOST_ID = "moo-family-bookshelf-host";
const DIALOG_ID = "moo-family-bookshelf-dialog";
const SECURE_IFRAME = { selector: "iframe[src*='secure-frame.html']" };
const SYNC_CODE = "[data-testid='sync-code']";
const SYNC_CODE_INPUT = "input[placeholder='輸入家庭同步碼']";
const PIN_INPUT = "input[aria-label='PIN 碼輸入']";
const QR_IMAGE = "img";
const START_BUTTON = { selector: "button", text: "開始使用" };
const CREATE_BUTTON = { selector: "button", text: "建立家庭公開書櫃" };
const PIN_METHOD_BUTTON = { selector: "button", text: "PIN 碼" };
const CREATED_HEADING = { selector: "h2", text: "家庭公開書櫃已建立" };
const LEAVE_BUTTON = { selector: "button", text: "離開家庭" };
const LEAVE_CONFIRM_PROMPT = { selector: "div", text: "確定要離開嗎？" };
const MEMBERS_LOADING = { selector: ".moo-settings__members-loading" };
const HOST_NODE = `DIV#${HOST_ID}`;
/** Nodes a main-world event path may hold: nothing below the host. */
const MAIN_WORLD_PATH = ["window", "#document", "HTML", "BODY", HOST_NODE];
const KEY_EVENT_TYPES = [
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
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

/** The attached secure frame whose document holds `selector`. Several frames can be open at once and
 *  a frame renders only after its handshake, so this polls `page.frames()` by URL and content. */
async function secureFrameWith(
  page: Page,
  selector: string,
  timeoutMs = 30_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || !SECURE_FRAME_URL.test(frame.url())) continue;
      const count = await frame
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  const urls = page.frames().map((f) => f.url());
  throw new Error(
    `no secure frame holds ${selector} after ${timeoutMs} ms. Frames: ${urls.join(", ")}`,
  );
}

/** Onboarding up to the Idle view (create / join), where the join field's frame is mounted. */
async function reachIdleView(driver: ClosedShadowDriver): Promise<void> {
  await driver.waitFor(START_BUTTON, 30_000);
  await driver.click(START_BUTTON);
  await driver.waitFor(CREATE_BUTTON, 30_000);
}

/** Idle view → CreatedView: returns the sync code as it reads on screen, inside its secure frame. */
async function createFamily(
  page: Page,
  driver: ClosedShadowDriver,
): Promise<string> {
  await driver.click(CREATE_BUTTON);
  const frame = await secureFrameWith(page, SYNC_CODE);
  return ((await frame.locator(SYNC_CODE).textContent()) ?? "").trim();
}

/** CreatedView → Settings tab, members loaded (they push the controls below them down). */
async function openSettings(driver: ClosedShadowDriver): Promise<void> {
  await driver.click({ selector: "button", text: "繼續" });
  await driver.waitFor({ selector: "nav" }, 20_000);
  await driver.click({ selector: "nav button", text: "設定" });
  await driver.waitFor(LEAVE_BUTTON, 15_000);
  await expect
    .poll(() => driver.exists(MEMBERS_LOADING), { timeout: 15_000 })
    .toBe(false);
}

/** Records every key / input event reaching `window` or `document` (capture phase) in the main world
 *  as `type@where>target`; `takeKeyEvents` drains the record. */
async function installKeyProbe(page: Page): Promise<void> {
  await page.evaluate((types) => {
    const describe = (n: EventTarget | null): string => {
      if (n === window) return "window";
      if (n instanceof Element)
        return n.id ? `${n.nodeName}#${n.id}` : n.nodeName;
      return n instanceof Node ? n.nodeName : "?";
    };
    const seen: string[] = [];
    const listeners = [window, document].flatMap((where) =>
      types.map((type) => {
        const name = where === window ? "window" : "document";
        const fn = (e: Event) =>
          seen.push(`${type}@${name}>${describe(e.target)}`);
        where.addEventListener(type, fn, true);
        return () => where.removeEventListener(type, fn, true);
      }),
    );
    Object.assign(window, {
      __mooKeys: seen,
      __mooKeysOff: () => listeners.forEach((off) => off()),
    });
  }, KEY_EVENT_TYPES);
}

async function takeKeyEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = (window as unknown as { __mooKeys: string[] }).__mooKeys;
    return seen.splice(0, seen.length);
  });
}

async function removeKeyProbe(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mooKeysOff: () => void }).__mooKeysOff(),
  );
}

/** Positive companion: focuses a Shadow Root button (CDP) and presses a key that operates nothing. */
async function pressKeyOnShadowButton(
  page: Page,
  driver: ClosedShadowDriver,
  button: ElementQuery,
): Promise<void> {
  const focused = await driver.evaluate<boolean>(
    `function (selector, text) {
      const el = Array.from(this.querySelectorAll(selector))
        .find((b) => (b.textContent ?? "").includes(text));
      if (!el) return false;
      el.focus();
      return this.activeElement === el;
    }`,
    button.selector,
    button.text ?? "",
  );
  expect(focused).toBe(true);
  await page.keyboard.press("a");
}

const SHADOW_KEY_EVENTS = [
  `keydown@window>${HOST_NODE}`,
  `keydown@document>${HOST_NODE}`,
  `keyup@window>${HOST_NODE}`,
  `keyup@document>${HOST_NODE}`,
];

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

    // Ground truth: the code is rendered on screen, inside the secure frame.
    await reachIdleView(driver);
    const syncCode = await createFamily(page, driver);
    expect(syncCode).toMatch(/^moo-\S+$/);
    const familyPart = syncCode.split("@")[0];

    await test.step("the code lives in the secure frame, not in the closed root", async () => {
      expect(await driver!.exists(SECURE_IFRAME)).toBe(true);
      expect(await driver!.exists(CREATED_HEADING)).toBe(true);
      expect(await driver!.exists({ selector: SYNC_CODE })).toBe(false);
    });

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

    await test.step("window.find() misses the code but still finds Shadow Root text", async () => {
      const found = await page.evaluate(
        ({ code, part, heading }) => {
          // Non-standard (absent from lib.dom.d.ts); Chromium implements it. Args: case-sensitive,
          // forwards, wrap around, not whole-word, search in frames, no dialog.
          const find = (
            window as unknown as { find: (...a: unknown[]) => boolean }
          ).find;
          const probe = (text: string) => {
            const hit = find(text, true, false, true, false, true, false);
            const anchor = getSelection()?.anchorNode ?? null;
            const anchorInDocument =
              anchor === null || anchor.getRootNode() === document;
            getSelection()?.removeAllRanges();
            return { hit, anchorInDocument };
          };
          return {
            code: probe(code),
            part: probe(part),
            heading: probe(heading),
          };
        },
        { code: syncCode, part: familyPart, heading: CREATED_HEADING.text },
      );
      // See the header → "window.find()": the code moved out; the heading pins the residual.
      expect(found).toEqual({
        code: { hit: false, anchorInDocument: true },
        part: { hit: false, anchorInDocument: true },
        heading: { hit: true, anchorInDocument: true },
      });
    });

    await test.step("a click on the code never reaches a document listener; one on the heading reaches it as the host", async () => {
      await page.evaluate(() => {
        const describe = (n: EventTarget): string => {
          if (n === window) return "window";
          if (n instanceof Element)
            return n.id ? `${n.nodeName}#${n.id}` : n.nodeName;
          return n instanceof Node ? n.nodeName : "?";
        };
        const probes: { target: string; path: string[] }[] = [];
        const listener = (e: Event) => {
          probes.push({
            target: e.target ? describe(e.target) : "",
            path: e.composedPath().map(describe),
          });
        };
        document.addEventListener("mousedown", listener, true);
        Object.assign(window, {
          __mooProbes: probes,
          __mooProbeListener: listener,
        });
      });
      // Ground truth that the click lands in the frame: its own document counts the mousedown.
      const frame = await secureFrameWith(page, SYNC_CODE);
      await frame.evaluate(() => {
        const counter = { downs: 0 };
        const listener = () => (counter.downs += 1);
        document.addEventListener("mousedown", listener, true);
        Object.assign(window, {
          __mooFrameDowns: counter,
          __mooFrameOff: () =>
            document.removeEventListener("mousedown", listener, true),
        });
      });
      const takeProbes = () =>
        page.evaluate(() => {
          const w = window as unknown as {
            __mooProbes: { target: string; path: string[] }[];
          };
          return w.__mooProbes.splice(0, w.__mooProbes.length);
        });

      // A real click at the code frame's centre (coordinates from CDP).
      await driver!.click(SECURE_IFRAME);
      const frameDowns = await frame.evaluate(() => {
        const w = window as unknown as {
          __mooFrameDowns: { downs: number };
          __mooFrameOff: () => void;
        };
        w.__mooFrameOff();
        return w.__mooFrameDowns.downs;
      });
      expect(frameDowns).toBe(1);
      expect(await takeProbes()).toEqual([]);

      // Positive companion: the heading stays in the Shadow Root and reaches the listener as the host.
      await driver!.click(CREATED_HEADING);
      const probes = await takeProbes();
      await page.evaluate(() => {
        const w = window as unknown as { __mooProbeListener: EventListener };
        document.removeEventListener("mousedown", w.__mooProbeListener, true);
      });
      expect(probes).toHaveLength(1);
      expect(probes[0].target).toBe(HOST_NODE);
      expect(probes[0].path).toContain(HOST_NODE);
      expect(
        probes[0].path.filter((n) => !MAIN_WORLD_PATH.includes(n)),
      ).toEqual([]);
    });

    await test.step("hit testing at the code frame and the dialog centre returns the host", async () => {
      const points = [
        await driver!.center(SECURE_IFRAME),
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

    await openSettings(driver);
    // Settings shows two frames at once: the sync code and the invite QR Code.
    await secureFrameWith(page, SYNC_CODE);
    await secureFrameWith(page, QR_IMAGE);

    await test.step("window.frames hands out no readable secure-frame document", async () => {
      const secureFrames = page
        .frames()
        .filter((f) => !f.isDetached() && SECURE_FRAME_URL.test(f.url()));
      expect(secureFrames.length).toBeGreaterThanOrEqual(2);

      // Positive companion: a same-origin light-DOM iframe planted for the probe must read as "readable".
      const reads = await page.evaluate(() => {
        const planted = document.createElement("iframe");
        document.body.appendChild(planted);
        const out: string[] = [];
        for (let i = 0; i < window.frames.length; i++) {
          try {
            void window.frames[i].document;
            out.push(
              window.frames[i] === planted.contentWindow
                ? "planted"
                : "readable",
            );
          } catch (e) {
            out.push((e as { name?: string }).name ?? String(e));
          }
        }
        planted.remove();
        return out;
      });
      expect(reads).toContain("planted");
      // Chromium keeps shadow-tree frames out of window.frames (only "planted" today); any listed must throw.
      expect(
        reads.filter((r) => r !== "SecurityError" && r !== "planted"),
      ).toEqual([]);
    });

    await test.step("a main-world click at 離開家庭 does not operate it", async () => {
      // Sections above the button (members, toggles, frames) settle async and push it down: take only
      // settled coordinates — here and again right before the real click.
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

  test("keys typed into the secure frames never reach the page's listeners", async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    const page = await openDialogOnMockPage(context, extensionId, "keys");
    driver = await createClosedShadowDriver(page, HOST_ID);
    await reachIdleView(driver);
    await installKeyProbe(page);

    await test.step("the join field's sync code", async () => {
      const typed = "moo-0123456789abcdef";
      const field = (await secureFrameWith(page, SYNC_CODE_INPUT)).locator(
        SYNC_CODE_INPUT,
      );
      await field.pressSequentially(typed);
      await expect(field).toHaveValue(typed);
      expect(await takeKeyEvents(page)).toEqual([]);
      await field.fill("");
      await expect(field).toHaveValue("");
      expect(await takeKeyEvents(page)).toEqual([]);

      // Positive companions: a key on a Shadow Root button reaches the page as the host, and a
      // light-DOM field shows the probe records `input` too.
      await pressKeyOnShadowButton(page, driver!, CREATE_BUTTON);
      expect(await takeKeyEvents(page)).toEqual(
        expect.arrayContaining(SHADOW_KEY_EVENTS),
      );
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.id = "moo-probe-input";
        document.body.appendChild(input);
      });
      await page.locator("#moo-probe-input").pressSequentially("a");
      await page.evaluate(() =>
        document.getElementById("moo-probe-input")?.remove(),
      );
      expect(await takeKeyEvents(page)).toEqual(
        expect.arrayContaining([
          "keydown@document>INPUT#moo-probe-input",
          "input@document>INPUT#moo-probe-input",
          "input@window>INPUT#moo-probe-input",
        ]),
      );
    });

    await createFamily(page, driver);
    await openSettings(driver);

    await test.step("the PIN being set", async () => {
      await driver!.click(PIN_METHOD_BUTTON);
      const field = (await secureFrameWith(page, PIN_INPUT)).locator(PIN_INPUT);
      expect(await takeKeyEvents(page)).toEqual([]);
      await field.pressSequentially("1234");
      await expect(field).toHaveValue("1234");
      expect(await takeKeyEvents(page)).toEqual([]);

      await pressKeyOnShadowButton(page, driver!, PIN_METHOD_BUTTON);
      expect(await takeKeyEvents(page)).toEqual(
        expect.arrayContaining(SHADOW_KEY_EVENTS),
      );
    });

    await removeKeyProbe(page);
    await page.close();
  });

  test("document.getAnimations() does not hand out elements inside the closed root", async ({
    context,
    extensionId,
  }) => {
    const page = await openDialogOnMockPage(context, extensionId, "anim");
    driver = await createClosedShadowDriver(page, HOST_ID);
    await driver.waitFor(START_BUTTON, 30_000);

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
