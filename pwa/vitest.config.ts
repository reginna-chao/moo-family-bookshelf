import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    // CI runs `test:coverage`; jsdom + v8 instrumentation on shared runners can
    // push a slow suite past Vitest's 5s default, so 30s is general headroom,
    // not a measured need. Pagination suites inject a small pageSize (see each
    // `Load More (Wave G)` describe), so no component test renders >~20 rows.
    testTimeout: 30000,
    setupFiles: [],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/env.d.ts", "src/main.tsx"],
      thresholds: {
        lines: 70,
        statements: 70,
        branches: 70,
        functions: 70,
        // Per-directory gate for the API client (lines + statements only —
        // functions is intentionally left to inherit the global 70 to avoid a
        // razor-thin gate). Matches the documented `pwa/src/api ≥ 80%` target.
        "src/api/**": { lines: 80, statements: 80 },
      },
    },
  },
});
