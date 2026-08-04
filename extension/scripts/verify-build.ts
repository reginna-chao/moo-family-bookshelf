/**
 * Verify build output is correct.
 * Checks that all expected files exist, content.js is in IIFE format, and the
 * shipped manifest still grants every Readmoo host the code targets.
 */
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

/**
 * Only the fields this script asserts on — the manifest has many more.
 * Everything is optional so a malformed/renamed field surfaces as a FAIL
 * instead of a crash.
 */
interface DistManifest {
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  web_accessible_resources?: { matches?: string[] }[];
}

/**
 * Assert that `patterns` (the manifest field under test) is EXACTLY the set of
 * hosts the code targets — neither missing nor extra. `READMOO_MATCH_PATTERNS`
 * is the single source of truth for supported Readmoo hosts.
 *
 * Missing entry → adding a host to `READMOO_MATCH_PATTERNS` without updating
 *   `public/manifest.json` ships an extension that silently never runs on it.
 * Extra entry → an over-broad pattern (`<all_urls>`, a leftover `http://localhost`
 *   dev pattern, a typo'd host) silently widens the install-time permission
 *   prompt and the content script's reach in the SHIPPED manifest.
 *
 * The E2E build deliberately appends `http://localhost:*` — that is safe here
 * because `scripts/build-e2e.ts` patches `dist/manifest.json` AFTER running
 * `pnpm build` (which is what invokes this script), so the localhost pattern is
 * never present at verification time.
 */
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

/**
 * Run `checkMatchPatterns` over EVERY entry of a manifest array field.
 * Checking only `[0]` would let a second content script / web-accessible
 * resource entry ship with a wrong or over-broad match list unnoticed.
 */
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
