import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PWA_PORT = 5173;
const WORKER_PORT = 8787;

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
    baseURL: `https://localhost:${PWA_PORT}`,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm dev",
      url: `https://localhost:${PWA_PORT}`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      cwd: __dirname,
      timeout: 30_000,
    },
    {
      command: "cd ../worker && npx wrangler dev --port 8787",
      port: WORKER_PORT,
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
