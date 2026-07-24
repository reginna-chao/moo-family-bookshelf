/**
 * Generate the Firefox self-distribution update manifest (updates.json).
 *
 * Firefox polls the URL declared in the direct-install manifest's
 * browser_specific_settings.gecko.update_url (see build-firefox-manifest.ts
 * UPDATE_URL) and, if a newer version is offered here, downloads the signed
 * .xpi from update_link. The .xpi name must match the asset uploaded to the
 * GitHub Release by the CD job.
 *
 * Pure builder + thin CLI wrapper. Reads the version from package.json
 * (same source of truth as sync-version.ts).
 *
 * updates.json serves only the self-distributed build, so its `addons` map
 * is keyed by the direct id (GECKO_ID_DIRECT), not the AMO-listed id.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { GECKO_ID_DIRECT, STRICT_MIN_VERSION } from "./build-firefox-manifest";

interface UpdateEntry {
  version: string;
  update_link: string;
  applications: {
    gecko: {
      strict_min_version: string;
    };
  };
}

interface UpdatesManifest {
  addons: {
    [geckoId: string]: {
      updates: UpdateEntry[];
    };
  };
}

/**
 * Build the updates.json object for a given version. Pure function.
 */
export function buildUpdatesManifest(version: string): UpdatesManifest {
  const updateLink =
    `https://github.com/reginna-chao/moo-family-bookshelf/releases/download/` +
    `v${version}/moo-family-bookshelf-firefox-v${version}-direct-install.xpi`;
  return {
    addons: {
      [GECKO_ID_DIRECT]: {
        updates: [
          {
            version,
            update_link: updateLink,
            applications: {
              gecko: {
                strict_min_version: STRICT_MIN_VERSION,
              },
            },
          },
        ],
      },
    },
  };
}

// Run when invoked directly (tsx scripts/build-updates-json.ts [--out <path>]).
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");

  const pkg = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf-8"),
  ) as { version: string };

  const outArgIndex = process.argv.indexOf("--out");
  const outPath =
    outArgIndex !== -1 && process.argv[outArgIndex + 1]
      ? resolve(process.argv[outArgIndex + 1])
      : resolve(root, "dist-firefox-updates.json");

  const manifest = buildUpdatesManifest(pkg.version);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

  const updateLink = manifest.addons[GECKO_ID_DIRECT].updates[0].update_link;
  console.log(`${outPath} written (version ${pkg.version})`);
  console.log(`  update_link=${updateLink}`);
}
