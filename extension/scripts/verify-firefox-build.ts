/**
 * Verify the Firefox build output(s) are correct.
 *
 * For each target (dist-firefox-<target>/) checks:
 *  - all expected bundle files exist;
 *  - the manifest declares browser_specific_settings.gecko.id, and it matches
 *    the expected id for the variant (amo -> GECKO_ID_AMO,
 *    direct -> GECKO_ID_DIRECT);
 *  - gecko.strict_min_version and gecko_android.strict_min_version present;
 *  - the manifest uses an event page (background.scripts) and NOT a
 *    service_worker (which Firefox for Android does not reliably support);
 *  - update_url policy per target:
 *      amo    -> gecko MUST NOT carry update_url;
 *      direct -> gecko.update_url MUST equal UPDATE_URL.
 *
 * Pass `--target amo|direct` to verify a single variant; with no flag both
 * variants are verified.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  UPDATE_URL,
  GECKO_ID_AMO,
  GECKO_ID_DIRECT,
  type FirefoxTarget,
} from "./build-firefox-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

interface FirefoxManifest {
  background?: { scripts?: string[]; service_worker?: string };
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      update_url?: string;
      data_collection_permissions?: { required?: string[] };
    };
    gecko_android?: { strict_min_version?: string };
  };
}

function parseTargets(): FirefoxTarget[] {
  const targetArgIndex = process.argv.indexOf("--target");
  if (targetArgIndex === -1) {
    return ["amo", "direct"];
  }
  const targetArg = process.argv[targetArgIndex + 1];
  if (targetArg !== "amo" && targetArg !== "direct") {
    console.error(
      `FAIL: invalid --target "${targetArg ?? ""}" (expected amo|direct)`,
    );
    process.exit(1);
  }
  return [targetArg];
}

/**
 * Run all checks for a single target. Returns true when every check passed.
 */
function verifyTarget(target: FirefoxTarget): boolean {
  const dist = resolve(root, `dist-firefox-${target}`);
  let failed = false;

  console.log(`\n--- Verifying target "${target}" (${dist}) ---`);

  function check(filePath: string, label: string): void {
    if (!existsSync(filePath)) {
      console.error(`FAIL: ${label} does not exist at ${filePath}`);
      failed = true;
    } else {
      console.log(`OK: ${label} exists`);
    }
  }

  // Required bundle files.
  check(resolve(dist, "content.js"), `${target} content.js`);
  check(resolve(dist, "background.js"), `${target} background.js`);
  check(resolve(dist, "popup.js"), `${target} popup.js`);
  check(resolve(dist, "fiber-bridge.js"), `${target} fiber-bridge.js`);
  check(resolve(dist, "manifest.json"), `${target} manifest.json`);

  // Manifest-specific Firefox checks.
  const manifestPath = resolve(dist, "manifest.json");
  if (!existsSync(manifestPath)) {
    return !failed;
  }

  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as FirefoxManifest;
  const gecko = manifest.browser_specific_settings?.gecko;

  const geckoId = gecko?.id;
  const expectedId = target === "direct" ? GECKO_ID_DIRECT : GECKO_ID_AMO;
  if (!geckoId) {
    console.error("FAIL: manifest missing browser_specific_settings.gecko.id");
    failed = true;
  } else if (geckoId !== expectedId) {
    console.error(
      `FAIL: ${target} gecko.id mismatch (expected ${expectedId}, found ${geckoId})`,
    );
    failed = true;
  } else {
    console.log(`OK: gecko.id present (${geckoId})`);
  }

  const geckoMinVersion = gecko?.strict_min_version;
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

  const dataCollectionRequired =
    gecko?.data_collection_permissions?.required;
  if (
    !dataCollectionRequired ||
    !dataCollectionRequired.includes("websiteContent")
  ) {
    console.error(
      "FAIL: manifest missing browser_specific_settings.gecko.data_collection_permissions.required containing \"websiteContent\"",
    );
    failed = true;
  } else {
    console.log(
      `OK: gecko.data_collection_permissions.required present (${dataCollectionRequired.join(", ")})`,
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

  // Per-target update_url policy.
  const updateUrl = gecko?.update_url;
  if (target === "amo") {
    if (updateUrl) {
      console.error(
        `FAIL: amo manifest must not carry gecko.update_url (found ${updateUrl})`,
      );
      failed = true;
    } else {
      console.log("OK: amo manifest has no gecko.update_url");
    }
  } else {
    if (!updateUrl) {
      console.error("FAIL: direct manifest missing gecko.update_url");
      failed = true;
    } else if (updateUrl !== UPDATE_URL) {
      console.error(
        `FAIL: direct gecko.update_url mismatch (expected ${UPDATE_URL}, found ${updateUrl})`,
      );
      failed = true;
    } else {
      console.log(`OK: direct gecko.update_url present (${updateUrl})`);
    }
  }

  return !failed;
}

let anyFailed = false;
for (const target of parseTargets()) {
  if (!verifyTarget(target)) {
    anyFailed = true;
  }
}

if (anyFailed) {
  console.error("\nFirefox build verification FAILED");
  process.exit(1);
} else {
  console.log("\nFirefox build verification passed");
}
