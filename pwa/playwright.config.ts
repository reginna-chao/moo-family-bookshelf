import { defineConfig } from "@playwright/test";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isCI = !!process.env.CI;

// CI: vite preview (HTTP, port 4173) — pre-built, stable
// Local: vite dev (HTTPS, port 5173) — HMR, self-signed cert
const PWA_URL = isCI
  ? "http://localhost:4173"
  : "https://localhost:5173";
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
    baseURL: PWA_URL,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: isCI ? "pnpm preview" : "pnpm dev",
      url: PWA_URL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      cwd: __dirname,
      timeout: 30_000,
    },
    {
      command: "cd ../worker && npx wrangler dev --port 8787",
      port: WORKER_PORT,
      reuseExistingServer: !isCI,
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
