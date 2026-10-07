/** Verify dist/: expected files exist, content.js is IIFE, the manifest grants exactly the Readmoo hosts.
 *  See docs/architecture.md → Chrome 建置檢查（verify-build.ts）. */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { READMOO_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmoo";

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

/** Only the fields this script asserts on, all optional, so a malformed or
 *  renamed field surfaces as a FAIL instead of a crash. */
interface DistManifest {
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  web_accessible_resources?: { matches?: string[] }[];
}

/** FAIL unless `patterns` equals READMOO_MATCH_PATTERNS exactly — nothing missing, nothing extra.
 *  Why exact, and why build-e2e's localhost is safe: docs/architecture.md → Chrome 建置檢查（verify-build.ts）. */
function checkMatchPatterns(
  patterns: string[] | undefined,
  label: string,
): void {
  const found = patterns ?? [];
  const missing = READMOO_MATCH_PATTERNS.filter(
    (pattern) => !found.includes(pattern),
  );
  const extra = found.filter(
    (pattern) => !READMOO_MATCH_PATTERNS.includes(pattern),
  );

  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) {
      console.error(`FAIL: ${label} is missing ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      console.error(
        `FAIL: ${label} has unexpected pattern(s) ${extra.join(", ")}`,
      );
    }
    console.error(`  Found: ${JSON.stringify(patterns ?? null)}`);
    failed = true;
    return;
  }
  console.log(`OK: ${label} matches the Readmoo match patterns exactly`);
}

/** Run `checkMatchPatterns` over EVERY entry: checking only `[0]` would let a second
 *  entry ship a wrong or over-broad match list unnoticed. */
function checkEntryMatches(
  entries: { matches?: string[] }[] | undefined,
  label: string,
): void {
  if (!entries || entries.length === 0) {
    console.error(`FAIL: ${label} is missing or empty`);
    failed = true;
    return;
  }
  entries.forEach((entry, index) => {
    checkMatchPatterns(entry.matches, `${label}[${index}].matches`);
  });
}

// Check the manifest grants exactly the supported Readmoo hosts in all three places
const manifestPath = resolve(dist, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as DistManifest;
  checkMatchPatterns(manifest.host_permissions, "manifest host_permissions");
  checkEntryMatches(manifest.content_scripts, "manifest content_scripts");
  checkEntryMatches(
    manifest.web_accessible_resources,
    "manifest web_accessible_resources",
  );
}

if (failed) {
  console.error("\nBuild verification FAILED");
  process.exit(1);
} else {
  console.log("\nBuild verification passed");
}
