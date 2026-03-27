/**
 * Sync version from package.json to manifest.json.
 * Run as part of the build process.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as {
  version: string;
};

const manifestPath = resolve(root, "public/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  version: string;
  [key: string]: unknown;
};

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest.json version synced to ${pkg.version}`);
} else {
  console.log(`manifest.json version already at ${pkg.version}`);
}
