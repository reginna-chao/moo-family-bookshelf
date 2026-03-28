/**
 * Build script for E2E testing.
 *
 * Copies the normal build output and modifies manifest.json to allow
 * the Content Script to trigger on localhost pages (for mock fixtures).
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

// Add localhost to host_permissions
if (!manifest.host_permissions) {
  manifest.host_permissions = [];
}
if (!manifest.host_permissions.includes(localhostPattern)) {
  manifest.host_permissions.push(localhostPattern);
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
console.log("[build-e2e] E2E build complete.");
