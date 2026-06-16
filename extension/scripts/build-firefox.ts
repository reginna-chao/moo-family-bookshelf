/**
 * Produce the Firefox build (dist-firefox/) from the existing Chrome build.
 *
 * Pipeline (invoked by `pnpm build:firefox` AFTER `pnpm build`):
 *   1. Ensure dist/ exists (built by the Chrome `build` script).
 *   2. Recursively copy dist/ -> dist-firefox/ (fresh, no stale files).
 *   3. Transform the manifest for Firefox (build-firefox-manifest.ts).
 *
 * Cross-platform: uses Node fs APIs only (developed on Windows, CI on Linux);
 * no shell `cp`.
 */
import { cpSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { buildFirefoxManifest } from "./build-firefox-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const distFirefox = resolve(root, "dist-firefox");

// 1. Chrome build must run first.
if (!existsSync(dist)) {
  console.error(
    "FAIL: dist/ does not exist. Run `pnpm build` before `pnpm build:firefox`.",
  );
  process.exit(1);
}

// 2. Fresh copy dist/ -> dist-firefox/.
if (existsSync(distFirefox)) {
  rmSync(distFirefox, { recursive: true, force: true });
}
cpSync(dist, distFirefox, { recursive: true });
console.log("Copied dist/ -> dist-firefox/");

// 3. Transform manifest for Firefox.
buildFirefoxManifest();
