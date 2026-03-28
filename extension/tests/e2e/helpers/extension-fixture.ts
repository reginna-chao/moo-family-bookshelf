/**
 * Playwright fixture that launches Chrome with the E2E-built extension loaded.
 *
 * Provides a `context` and `extensionId` for interacting with the extension
 * in E2E tests.
 */

import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionPath = resolve(__dirname, "..", "..", "..", "dist");

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
      ],
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
