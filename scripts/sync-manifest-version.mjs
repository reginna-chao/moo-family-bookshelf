/**
 * Sync version from extension/package.json to:
 *   - extension/public/manifest.json
 *   - package.json (root)
 *
 * Run after `changeset version` to keep non-workspace files in sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'extension/package.json'), 'utf-8'));

// Sync manifest.json
const manifestPath = resolve(root, 'extension/public/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest.json synced to ${version}`);
}

// Sync root package.json
const rootPkgPath = resolve(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
if (rootPkg.version !== version) {
  rootPkg.version = version;
  writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  console.log(`root package.json synced to ${version}`);
}

console.log(`All versions: ${version}`);
