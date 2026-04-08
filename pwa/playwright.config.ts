import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isCI = !!process.env.CI;

// E2E uses dedicated ports to avoid conflicts with other dev servers.
// CI: vite preview (HTTP) / Local: vite dev (HTTPS, self-signed cert)
const PWA_PORT = isCI ? 4173 : 5277;
const WORKER_PORT = 8688;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? "github" : "list",
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
      command: isCI
        ? "pnpm preview"
        : `pnpm exec vite dev --port ${PWA_PORT}`,
      port: PWA_PORT,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      cwd: __dirname,
      timeout: 60_000,
    },
    {
      command: `cd ../worker && pnpm exec wrangler dev --port ${WORKER_PORT} --var DEV_MODE:1`,
      port: WORKER_PORT,
      reuseExistingServer: false,
      cwd: __dirname,
      timeout: 60_000,
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
