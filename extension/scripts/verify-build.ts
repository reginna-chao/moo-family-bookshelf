/** Verify dist/: expected files exist, content scripts are IIFE, the manifest grants exactly the Readmoo hosts.
 *  See docs/architecture.md → Chrome 建置檢查（verify-build.ts）. */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { checkManifest, type DistManifestFields } from "./verify-build-checks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "..", "dist");

let failed = false;

function check(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    console.error(`FAIL: ${label} does not exist at ${filePath}`);
    failed = true;
  } else {
    console.log(`OK: ${label} exists`);
  }
}

// Check required files exist
check(resolve(dist, "content.js"), "dist/content.js");
check(resolve(dist, "content-store.js"), "dist/content-store.js");
check(resolve(dist, "background.js"), "dist/background.js");
check(resolve(dist, "popup.js"), "dist/popup.js");
check(resolve(dist, "fiber-bridge.js"), "dist/fiber-bridge.js");
check(resolve(dist, "secure-frame.html"), "dist/secure-frame.html");
check(resolve(dist, "secure-frame.js"), "dist/secure-frame.js");
check(resolve(dist, "options.html"), "dist/options.html");
check(resolve(dist, "options.js"), "dist/options.js");
check(resolve(dist, "manifest.json"), "dist/manifest.json");

/** FAIL when a classic content script starts with `import` — it must be IIFE, not ESM. */
function checkNotEsm(fileName: string): void {
  const filePath = resolve(dist, fileName);
  if (!existsSync(filePath)) return;
  const head = readFileSync(filePath, "utf-8").slice(0, 200);
  const trimmed = head.trimStart();
  if (trimmed.startsWith("import ") || trimmed.startsWith("import{")) {
    console.error(
      `FAIL: dist/${fileName} starts with 'import' — expected IIFE format (var or (function)`,
    );
    console.error(`  First 200 chars: ${head}`);
    failed = true;
  } else {
    console.log(`OK: dist/${fileName} is not ESM (no leading import)`);
  }
}

checkNotEsm("content.js");
checkNotEsm("content-store.js");

// Check the manifest: Readmoo patterns in all three places, the store-page chip's permissions,
// and the pages that must stay out of web_accessible_resources.
const manifestPath = resolve(dist, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as DistManifestFields;
  const failures = checkManifest(manifest);
  for (const message of failures) {
    console.error(`FAIL: ${message}`);
  }
  if (failures.length > 0) {
    failed = true;
  } else {
    console.log(
      "OK: manifest host / content-script / web-accessible patterns, optional_host_permissions, scripting and options_ui",
    );
  }
}

if (failed) {
  console.error("\nBuild verification FAILED");
  process.exit(1);
} else {
  console.log("\nBuild verification passed");
}
