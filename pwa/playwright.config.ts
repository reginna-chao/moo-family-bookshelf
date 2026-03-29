import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isCI = !!process.env.CI;

// CI: vite preview (HTTP, port 4173) — pre-built, stable
// Local: vite dev (HTTPS, port 5173) — HMR, self-signed cert
const PWA_PORT = isCI ? 4173 : 5173;
const WORKER_PORT = 8787;

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
    baseURL: `http://localhost:${PWA_PORT}`,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: isCI ? "pnpm preview" : "pnpm dev",
      port: PWA_PORT,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      cwd: __dirname,
      timeout: 60_000,
    },
    {
      command: `cd ../worker && pnpm exec wrangler dev --port ${WORKER_PORT}`,
      port: WORKER_PORT,
      reuseExistingServer: !isCI,
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
