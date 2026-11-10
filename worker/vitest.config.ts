import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` exists only inside workerd; src/durable/ imports DurableObject from it.
      "cloudflare:workers": fileURLToPath(
        new URL("./vitest/cloudflareWorkersStub.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The kv_ops telemetry line (src/middleware/kvOpCounting.ts
    // withKvOpCounting) fires on every /api/* request; keep it out of the
    // runner output. Printing only — a vi.spyOn(console, "log") still sees
    // the call, so assertions on it work
    // (tests/integration/kvOpCountLog.test.ts).
    //
    // Matched on the quoted value alone, NOT on "event: 'kv_ops'": vitest
    // formats the object through node's Console with `colorMode:
    // c.isColorSupported`, so when colour is on an ANSI escape sits between
    // "event:" and "'kv_ops'". The quoted form appears either way.
    onConsoleLog(log) {
      if (log.includes("'kv_ops'")) return false;
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
