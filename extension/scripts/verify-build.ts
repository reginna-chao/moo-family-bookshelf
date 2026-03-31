/**
 * Verify build output is correct.
 * Checks that all expected files exist and content.js is in IIFE format.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
check(resolve(dist, "background.js"), "dist/background.js");
check(resolve(dist, "popup.js"), "dist/popup.js");
check(resolve(dist, "fiber-bridge.js"), "dist/fiber-bridge.js");
check(resolve(dist, "manifest.json"), "dist/manifest.json");

// Check content.js is IIFE format (not ESM)
const contentPath = resolve(dist, "content.js");
if (existsSync(contentPath)) {
  const head = readFileSync(contentPath, "utf-8").slice(0, 200);
  const trimmed = head.trimStart();
  if (trimmed.startsWith("import ") || trimmed.startsWith("import{")) {
    console.error(
      "FAIL: dist/content.js starts with 'import' — expected IIFE format (var or (function)",
    );
    console.error(`  First 200 chars: ${head}`);
    failed = true;
  } else {
    console.log("OK: dist/content.js is not ESM (no leading import)");
  }
}

if (failed) {
  console.error("\nBuild verification FAILED");
  process.exit(1);
} else {
  console.log("\nBuild verification passed");
}
