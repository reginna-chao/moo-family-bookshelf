import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    // Chrome is launched via the custom fixture in helpers/extension-fixture.ts
    // with --load-extension flags. Do NOT set launchOptions here.
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx serve tests/e2e/fixtures -l 4173 --no-clipboard",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      cwd: __dirname,
    },
    {
      command: "cd ../worker && npx wrangler dev --port 8787",
      port: 8787,
      reuseExistingServer: !process.env.CI,
      cwd: __dirname,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
