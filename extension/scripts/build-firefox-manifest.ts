/**
 * Build the Firefox-flavored manifest from the already-produced Chrome
 * dist/manifest.json, writing it to dist-firefox/manifest.json.
 *
 * Run AFTER dist/ has been copied to dist-firefox/ (see build-firefox.ts).
 *
 * Transforms applied:
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
 * AMO extension id. Placeholder using the project's homepage domain —
 * the maintainer can confirm/replace this with the id registered on AMO.
 */
export const GECKO_ID = "moo-family-bookshelf@reginna-chao.github.io";

/**
 * Firefox 121 is the first release with stable MV3 support enabled by
 * default (event pages, host_permissions, MV3 content scripts). Picking
 * 121 keeps the floor at a sound MV3-capable baseline.
 */
export const STRICT_MIN_VERSION = "121.0";

interface BackgroundMv3 {
  service_worker?: string;
  type?: string;
  scripts?: string[];
}

interface Manifest {
  version: string;
  background?: BackgroundMv3;
  browser_specific_settings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Transform a Chrome MV3 manifest object into the Firefox-flavored one.
 * Pure function: takes the Chrome manifest + version, returns a new manifest.
 */
export function toFirefoxManifest(chrome: Manifest, version: string): Manifest {
  const swFile = chrome.background?.service_worker ?? "background.js";
  return {
    ...chrome,
    version,
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: STRICT_MIN_VERSION,
      },
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

export function buildFirefoxManifest(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");

  const pkg = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf-8"),
  ) as { version: string };

  const chromeManifest = JSON.parse(
    readFileSync(resolve(root, "dist", "manifest.json"), "utf-8"),
  ) as Manifest;

  const firefoxManifest = toFirefoxManifest(chromeManifest, pkg.version);

  const outPath = resolve(root, "dist-firefox", "manifest.json");
  writeFileSync(outPath, JSON.stringify(firefoxManifest, null, 2) + "\n");

  console.log(`dist-firefox/manifest.json written (version ${pkg.version})`);
  console.log(`  gecko.id=${GECKO_ID} strict_min_version=${STRICT_MIN_VERSION}`);
  console.log(
    `  background.scripts=["${firefoxManifest.background?.scripts?.[0]}"] (event page)`,
  );
}

// Run when invoked directly (tsx scripts/build-firefox-manifest.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildFirefoxManifest();
}
