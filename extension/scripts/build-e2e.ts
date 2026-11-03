/** E2E build: `pnpm build`, patch dist/manifest.json in place so the content script runs on localhost,
 *  then write the open-shadow-root copy dist-e2e-open/. Rationale: .claude/rules/test.md → E2E tooling. */

import { cpSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");
const manifestPath = resolve(distDir, "manifest.json");

// Step 1: Run the normal production build
console.log("[build-e2e] Running production build...");
execSync("pnpm build", {
  cwd: resolve(__dirname, ".."),
  stdio: "inherit",
});

// Step 2: Patch manifest.json for E2E
console.log("[build-e2e] Patching manifest.json for E2E...");

interface ManifestContentScript {
  matches: string[];
  js: string[];
  css?: string[];
  run_at?: string;
}

interface ManifestWebAccessibleResource {
  resources: string[];
  matches: string[];
}

interface Manifest {
  manifest_version: number;
  name: string;
  content_scripts?: ManifestContentScript[];
  host_permissions?: string[];
  web_accessible_resources?: ManifestWebAccessibleResource[];
  [key: string]: unknown;
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const localhostPattern = "http://localhost:*/*";

// Add localhost to content_scripts matches
if (manifest.content_scripts && manifest.content_scripts.length > 0) {
  for (const cs of manifest.content_scripts) {
    if (!cs.matches.includes(localhostPattern)) {
      cs.matches.push(localhostPattern);
    }
  }
}

// Store-page chip: production registers content-store.js at runtime after a permission prompt E2E
// cannot click, so register it statically for the localhost store fixture. See .claude/rules/test.md.
manifest.content_scripts ??= [];
manifest.content_scripts.push({
  matches: ["http://localhost:*/book/*"],
  js: ["content-store.js"],
  run_at: "document_idle",
});

// Add localhost to host_permissions
if (!manifest.host_permissions) {
  manifest.host_permissions = [];
}
if (!manifest.host_permissions.includes(localhostPattern)) {
  manifest.host_permissions.push(localhostPattern);
}
// Grant the store pattern at install (E2E cannot click the optional prompt) so the background's permission
// mirror reads TRUE; verify-build already checked the unpatched manifest, so its equality check is unaffected.
for (const pattern of READMOO_STORE_MATCH_PATTERNS) {
  if (!manifest.host_permissions.includes(pattern)) {
    manifest.host_permissions.push(pattern);
  }
}

// Add localhost to web_accessible_resources matches
if (manifest.web_accessible_resources) {
  for (const war of manifest.web_accessible_resources) {
    if (!war.matches.includes(localhostPattern)) {
      war.matches.push(localhostPattern);
    }
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("[build-e2e] manifest.json patched successfully.");

// Step 3: copy dist/ to dist-e2e-open/ with OPEN shadow roots (the Dialog's and the store-page chip's),
// since Playwright cannot pierce a closed one. Which spec loads which: .claude/rules/test.md → E2E tooling.
const openDistDir = resolve(__dirname, "..", "dist-e2e-open");
const CLOSED_TOKEN = 'mode:"closed"';
const OPEN_TOKEN = 'mode:"open"';

function countToken(source: string, token: string): number {
  return source.split(token).length - 1;
}

function failBuild(message: string): never {
  console.error(`[build-e2e] ${message}`);
  process.exit(1);
}

/** Swap the single closed shadow-root call in dist-e2e-open/<fileName> for an open one. */
function openShadowRootIn(fileName: string): void {
  const filePath = resolve(openDistDir, fileName);
  const closedSource = readFileSync(filePath, "utf-8");
  const closedCount = countToken(closedSource, CLOSED_TOKEN);
  console.log(`[build-e2e] ${fileName} holds ${closedCount} x ${CLOSED_TOKEN}`);
  if (closedCount !== 1) {
    failBuild(
      `expected exactly 1 x ${CLOSED_TOKEN} in ${fileName}, found ${closedCount}; update build-e2e.ts to match the minified shadow-root call`,
    );
  }

  const openSource = closedSource.replace(CLOSED_TOKEN, OPEN_TOKEN);
  if (
    countToken(openSource, OPEN_TOKEN) !==
      countToken(closedSource, OPEN_TOKEN) + 1 ||
    countToken(openSource, CLOSED_TOKEN) !== 0
  ) {
    failBuild(
      `dist-e2e-open/${fileName} was not switched to an open shadow root`,
    );
  }
  writeFileSync(filePath, openSource);
  console.log(
    `[build-e2e] dist-e2e-open/${fileName} switched to an open shadow root.`,
  );
}

console.log("[build-e2e] Copying dist/ to dist-e2e-open/...");
rmSync(openDistDir, { recursive: true, force: true });
cpSync(distDir, openDistDir, { recursive: true });

openShadowRootIn("content.js");
openShadowRootIn("content-store.js");
console.log("[build-e2e] E2E build complete.");
