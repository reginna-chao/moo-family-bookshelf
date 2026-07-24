/**
 * Build the Firefox-flavored manifest from the already-produced Chrome
 * dist/manifest.json, writing it to dist-firefox-<target>/manifest.json.
 *
 * Run AFTER dist/ has been copied to dist-firefox-<target>/ (see build-firefox.ts).
 *
 * Two targets, each with its OWN gecko.id and differing update_url:
 *  - "amo":    AMO-listed build. Uses GECKO_ID_AMO (the AMO-listed id).
 *              MUST NOT carry update_url (AMO rejects it; AMO serves its own
 *              updates for listed add-ons).
 *  - "direct": self-distributed signed .xpi. Uses GECKO_ID_DIRECT (the
 *              self-distributed id). Carries update_url pointing at the
 *              project's updates.json so installs auto-update.
 *
 * The two ids are kept DISTINCT to avoid an AMO same-version dual-channel
 * conflict: a listed and a self-distributed build sharing one id cannot both
 * publish the same version.
 *
 * Transforms applied (both targets):
 *  - version: re-synced from package.json (same source of truth as the
 *    Chrome sync-version.ts) so the Firefox build never drifts.
 *  - browser_specific_settings.gecko: adds the AMO extension id and a
 *    strict_min_version, plus a gecko_android entry for Firefox for Android.
 *  - background: Firefox for Android (Fenix) does NOT reliably support an
 *    MV3 background `service_worker`; an event page (`background.scripts`)
 *    works on both desktop and Android. We therefore replace
 *    `service_worker` + `type:module` with `scripts: ["background.js"]`.
 *
 * Everything else (permissions, content_scripts, host_permissions,
 * web_accessible_resources, action, icons) is left identical to Chrome.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Firefox extension ids. The two distribution channels use DIFFERENT ids so
 * they never collide on AMO's same-version dual-channel rule:
 *  - GECKO_ID_AMO:    the AMO-listed id (used by the "amo" target).
 *  - GECKO_ID_DIRECT: the self-distributed id (used by the "direct" target).
 */
export const GECKO_ID_AMO = "moo-family-bookshelf@reginna-chao.github.io";
export const GECKO_ID_DIRECT =
  "moo-family-bookshelf-direct@reginna-chao.github.io";

/**
 * Firefox 121 is the first release with stable MV3 support enabled by
 * default (event pages, host_permissions, MV3 content scripts). Picking
 * 121 keeps the floor at a sound MV3-capable baseline.
 */
export const STRICT_MIN_VERSION = "121.0";

/**
 * Update manifest URL for the self-distributed (direct-install) build.
 * Points at the `updates.json` attached to the latest GitHub Release.
 * Only the "direct" target embeds this; the AMO build must omit it.
 */
export const UPDATE_URL =
  "https://github.com/reginna-chao/moo-family-bookshelf/releases/latest/download/updates.json";

/**
 * Firefox built-in data-consent declaration (required by AMO for all new
 * Firefox extensions; see mzl.la/firefox-builtin-data-consent).
 *
 * The extension syncs book-list content scraped from read.readmoo.com, so it
 * declares the "websiteContent" data category. Email is hashed client-side
 * (no PII category) and there is no tracking/telemetry. Applied to BOTH
 * channels (Mozilla will require it for unlisted builds too).
 */
export const DATA_COLLECTION_PERMISSIONS: { required: string[] } = {
  required: ["websiteContent"],
};

export type FirefoxTarget = "amo" | "direct";

interface BackgroundMv3 {
  service_worker?: string;
  type?: string;
  scripts?: string[];
}

interface GeckoSettings {
  id: string;
  strict_min_version: string;
  update_url?: string;
  data_collection_permissions: { required: string[] };
}

interface Manifest {
  version: string;
  background?: BackgroundMv3;
  browser_specific_settings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Transform a Chrome MV3 manifest object into the Firefox-flavored one.
 * Pure function: takes the Chrome manifest + version + target, returns a new
 * manifest. The "direct" target embeds update_url inside gecko; "amo" omits it.
 */
export function toFirefoxManifest(
  chrome: Manifest,
  version: string,
  target: FirefoxTarget,
): Manifest {
  const swFile = chrome.background?.service_worker ?? "background.js";
  const id = target === "direct" ? GECKO_ID_DIRECT : GECKO_ID_AMO;
  const gecko: GeckoSettings = {
    id,
    strict_min_version: STRICT_MIN_VERSION,
    data_collection_permissions: DATA_COLLECTION_PERMISSIONS,
  };
  if (target === "direct") {
    gecko.update_url = UPDATE_URL;
  }
  return {
    ...chrome,
    version,
    browser_specific_settings: {
      gecko,
      gecko_android: {
        strict_min_version: STRICT_MIN_VERSION,
      },
    },
    // Event page instead of service worker (Firefox for Android compatibility).
    background: {
      scripts: [swFile],
    },
  };
}

export function buildFirefoxManifest(
  target: FirefoxTarget,
  outDir: string,
): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");

  const pkg = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf-8"),
  ) as { version: string };

  const chromeManifest = JSON.parse(
    readFileSync(resolve(root, "dist", "manifest.json"), "utf-8"),
  ) as Manifest;

  const firefoxManifest = toFirefoxManifest(
    chromeManifest,
    pkg.version,
    target,
  );

  const outPath = resolve(outDir, "manifest.json");
  writeFileSync(outPath, JSON.stringify(firefoxManifest, null, 2) + "\n");

  const gecko = firefoxManifest.browser_specific_settings?.gecko as
    GeckoSettings | undefined;
  console.log(`${outPath} written (version ${pkg.version}, target ${target})`);
  console.log(
    `  gecko.id=${gecko?.id} strict_min_version=${STRICT_MIN_VERSION}`,
  );
  console.log(`  update_url=${gecko?.update_url ?? "(none)"}`);
  console.log(
    `  background.scripts=["${firefoxManifest.background?.scripts?.[0]}"] (event page)`,
  );
}

// Run when invoked directly (tsx scripts/build-firefox-manifest.ts [--target amo|direct]).
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");
  const targetArgIndex = process.argv.indexOf("--target");
  const targetArg =
    targetArgIndex !== -1 ? process.argv[targetArgIndex + 1] : "amo";
  if (targetArg !== "amo" && targetArg !== "direct") {
    console.error(
      `FAIL: invalid --target "${targetArg}" (expected amo|direct)`,
    );
    process.exit(1);
  }
  const target: FirefoxTarget = targetArg;
  const outDir = resolve(root, `dist-firefox-${target}`);
  buildFirefoxManifest(target, outDir);
}
