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
    // push a slow suite past Vitest's 5s default, and the content-script
    // teardown/hover tests budget 10s wall-clock polls against this value.
    // Pagination suites inject a small pageSize (see each `Load More (Wave G)`
    // describe), so no component test renders more than ~20 rows.
    // That same reasoning applies verbatim to hooks, which Vitest budgets
    // SEPARATELY: `hookTimeout` has its own 10s default and does not follow
    // `testTimeout`, so it has to be raised explicitly. The hooks that actually
    // hit the ceiling are the `beforeEach`es doing `vi.resetModules()` + a
    // dynamic `await import(...)` (`tests/unit/scraper.test.ts`,
    // `tests/unit/syncBooks.test.ts`), which re-transform and re-evaluate a
    // fresh module graph for every case. The symptom is
    // `Hook timed out in 10000ms` on a file that changes from run to run —
    // contention decides the victim, not the test — so it reads like a flaky
    // test when it is really this setting.
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/component/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
        // Per-directory gate for the API client (lines + statements only —
        // functions stays on the global 70 since it sits at ~80% and a strict
        // 80 gate would be razor-thin). Matches the documented
        // `extension/src/api ≥ 80%` target.
        "src/api/**": { lines: 80, statements: 80 },
      },
    },
  },
});
