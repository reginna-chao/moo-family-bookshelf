/** Playwright fixture that launches Chrome with the E2E-built extension loaded, providing a `context`
 *  and `extensionId` for E2E tests. */

import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Which `pnpm build:e2e` artifact a spec loads. `"open"` (the default) is `dist-e2e-open/`, the copy
 * whose Dialog shadow root is switched to open so Playwright locators can pierce it; `"closed"` is the
 * real shipped `dist/` (closed root, #362), loaded only by specs that test what a page script can
 * reach. Opt in per file / describe with `test.use({ distVariant: "closed" })`.
 * See `.claude/rules/test.md` → E2E tooling.
 */
export type DistVariant = "open" | "closed";

const DIST_DIRS: Record<DistVariant, string> = {
  open: "dist-e2e-open",
  closed: "dist",
};

/** Absolute path of the unpacked extension for `variant`; throws when `pnpm build:e2e` has not
 *  produced it, so a missing copy fails loudly instead of loading nothing. */
export function extensionPathFor(variant: DistVariant): string {
  const path = resolve(__dirname, "..", "..", "..", DIST_DIRS[variant]);
  if (!existsSync(resolve(path, "manifest.json"))) {
    throw new Error(`${path} is missing: run \`pnpm build:e2e\` first.`);
  }
  return path;
}

export interface ExtensionOptions {
  distVariant: DistVariant;
}

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
}

export const test = base.extend<ExtensionOptions & ExtensionFixtures>({
  distVariant: ["open", { option: true }],

  context: async ({ distVariant }, use) => {
    const extensionPath = extensionPathFor(distVariant);
    const useHeadedMode = process.env.E2E_HEADED === "1";
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        "--window-size=1280,720",
        ...(useHeadedMode ? [] : ["--headless=new"]),
      ],
      viewport: { width: 1280, height: 720 },
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // Wait for the service worker to register
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }

    // Extract extension ID from the service worker URL
    // URL format: chrome-extension://{extensionId}/background.js
    const extensionId = serviceWorker.url().split("/")[2];
    await use(extensionId);
  },
});

export { expect } from "@playwright/test";
