/**
 * Verify the Firefox build output (dist-firefox/) is correct.
 *
 * Checks:
 *  - all expected bundle files exist;
 *  - the manifest declares browser_specific_settings.gecko.id;
 *  - the manifest uses an event page (background.scripts) and NOT a
 *    service_worker (which Firefox for Android does not reliably support).
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "..", "dist-firefox");

let failed = false;

function check(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    console.error(`FAIL: ${label} does not exist at ${filePath}`);
    failed = true;
  } else {
    console.log(`OK: ${label} exists`);
  }
}

// Required bundle files.
check(resolve(dist, "content.js"), "dist-firefox/content.js");
check(resolve(dist, "background.js"), "dist-firefox/background.js");
check(resolve(dist, "popup.js"), "dist-firefox/popup.js");
check(resolve(dist, "fiber-bridge.js"), "dist-firefox/fiber-bridge.js");
check(resolve(dist, "manifest.json"), "dist-firefox/manifest.json");

// Manifest-specific Firefox checks.
const manifestPath = resolve(dist, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    background?: { scripts?: string[]; service_worker?: string };
    browser_specific_settings?: {
      gecko?: { id?: string; strict_min_version?: string };
      gecko_android?: { strict_min_version?: string };
    };
  };

  const geckoId = manifest.browser_specific_settings?.gecko?.id;
  if (!geckoId) {
    console.error(
      "FAIL: manifest missing browser_specific_settings.gecko.id",
    );
    failed = true;
  } else {
    console.log(`OK: gecko.id present (${geckoId})`);
  }

  const geckoMinVersion =
    manifest.browser_specific_settings?.gecko?.strict_min_version;
  if (!geckoMinVersion) {
    console.error(
      "FAIL: manifest missing browser_specific_settings.gecko.strict_min_version",
    );
    failed = true;
  } else {
    console.log(`OK: gecko.strict_min_version present (${geckoMinVersion})`);
  }

  const geckoAndroidMinVersion =
    manifest.browser_specific_settings?.gecko_android?.strict_min_version;
  if (!geckoAndroidMinVersion) {
    console.error(
      "FAIL: manifest missing browser_specific_settings.gecko_android.strict_min_version",
    );
    failed = true;
  } else {
    console.log(
      `OK: gecko_android.strict_min_version present (${geckoAndroidMinVersion})`,
    );
  }

  if (manifest.background?.service_worker) {
    console.error(
      "FAIL: Firefox manifest must not declare background.service_worker",
    );
    failed = true;
  } else if (
    !manifest.background?.scripts ||
    manifest.background.scripts.length === 0
  ) {
    console.error("FAIL: Firefox manifest missing background.scripts");
    failed = true;
  } else {
    console.log(
      `OK: background.scripts present (${manifest.background.scripts.join(", ")}), no service_worker`,
    );
  }
}

if (failed) {
  console.error("\nFirefox build verification FAILED");
  process.exit(1);
} else {
  console.log("\nFirefox build verification passed");
}
