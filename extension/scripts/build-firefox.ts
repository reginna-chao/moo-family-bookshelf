/**
 * Produce the Firefox build(s) from the existing Chrome build.
 *
 * Pipeline (invoked by `pnpm build:firefox` AFTER `pnpm build`):
 *   1. Ensure dist/ exists (built by the Chrome `build` script).
 *   2. For each target, recursively copy dist/ -> dist-firefox-<target>/
 *      (fresh, no stale files).
 *   3. Transform the manifest for that Firefox target
 *      (build-firefox-manifest.ts).
 *
 * Targets:
 *   - "amo":    AMO-listed build (no update_url).
 *   - "direct": self-distributed signed .xpi (has update_url).
 * Pass `--target amo|direct` to build a single variant; with no flag both
 * variants are built sequentially.
 *
 * Cross-platform: uses Node fs APIs only (developed on Windows, CI on Linux);
 * no shell `cp`.
 */
import { cpSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildFirefoxManifest,
  type FirefoxTarget,
} from "./build-firefox-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");

function parseTargets(): FirefoxTarget[] {
  const targetArgIndex = process.argv.indexOf("--target");
  if (targetArgIndex === -1) {
    return ["amo", "direct"];
  }
  const targetArg = process.argv[targetArgIndex + 1];
  if (targetArg !== "amo" && targetArg !== "direct") {
    console.error(
      `FAIL: invalid --target "${targetArg ?? ""}" (expected amo|direct)`,
    );
    process.exit(1);
  }
  return [targetArg];
}

function buildTarget(target: FirefoxTarget): void {
  const distFirefox = resolve(root, `dist-firefox-${target}`);
  if (existsSync(distFirefox)) {
    rmSync(distFirefox, { recursive: true, force: true });
  }
  cpSync(dist, distFirefox, { recursive: true });
  console.log(`Copied dist/ -> dist-firefox-${target}/`);
  buildFirefoxManifest(target, distFirefox);
}

// 1. Chrome build must run first.
if (!existsSync(dist)) {
  console.error(
    "FAIL: dist/ does not exist. Run `pnpm build` before `pnpm build:firefox`.",
  );
  process.exit(1);
}

// 2 + 3. Build each requested target.
for (const target of parseTargets()) {
  buildTarget(target);
}
